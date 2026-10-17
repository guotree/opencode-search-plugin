import { Plugin } from "@opencode/plugin/effect"
import { Effect, Schema, Stream } from "effect"

// SerpApi returns Google's organic results as JSON. Only `organic_results`
// carries links an agent reads; answer boxes and knowledge graphs have no
// source URL, so they stay out. Every result field is optional -- a missing one
// means "Google provided none", not an error.
const SerpApiResponse = Schema.Struct({
  organic_results: Schema.optional(
    Schema.Array(
      Schema.Struct({
        title: Schema.String,
        link: Schema.String,
        snippet: Schema.optional(Schema.String),
        date: Schema.optional(Schema.String),
      }),
    ),
  ),
})

// The /connect integration ID, and the websearch provider ID it binds to.
// The `osp-` prefix is this package's namespace: OpenCode's built-ins and a
// vendor plugin's own entry are bare vendor names, so `serpapi` would collide
// with them, and with the opencode.db row keyed by integration ID.
const ID = "osp-serpapi"

function envInt(name: string, fallback: number): number {
  const raw = (process.env[name] ?? "").trim()
  if (raw === "") return fallback
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

function envStr(name: string): string {
  return (process.env[name] ?? "").trim()
}

// Search engines hand out dates in three flavours: relative ("28 minutes ago"),
// absolute ("Sep 30, 2026" in the US, "31 Mar 2026" elsewhere), and non-English
// relative ("4天前"). Relative values are rounded upstream, so month/year use
// 30/365 days. ISO 8601 timestamps are accepted as-is.
// See https://serpapi.com/blog/how-to-parse-dates-from-google-search/
const RELATIVE_MS: Record<string, number> = {
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
  month: 2_592_000_000,
  year: 31_536_000_000,
  分钟: 60_000,
  小时: 3_600_000,
  天: 86_400_000,
  周: 604_800_000,
  个月: 2_592_000_000,
  月: 2_592_000_000,
  年: 31_536_000_000,
}

const RELATIVE_DATE =
  /^(\d+)\s*(minute|hour|day|week|month|year|分钟|小时|天|周|个月|月|年)s?\s*(?:ago|前)$/i

const ABSOLUTE_DATE = [
  /^\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}$/, // "3 Jan 2022", "31 Mar 2026"
  /^[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4}$/, // "Sep 30, 2026", "Jan 27, 2025"
  /^\d{4}-\d{2}-\d{2}$/, // "2026-10-16"
  // ISO 8601 with a time component, which some providers return verbatim.
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/,
]

function parseSearchDate(value: string | undefined): number {
  const text = value?.trim()
  if (!text) return NaN

  const relative = RELATIVE_DATE.exec(text)
  if (relative) {
    const unit = relative[2] !== undefined ? RELATIVE_MS[relative[2].toLowerCase()] : undefined
    const amount = Number(relative[1])
    if (unit === undefined || !Number.isFinite(amount)) return NaN
    return Date.now() - amount * unit
  }

  // Only trust Date.parse on shapes these providers actually emit -- its lenient
  // parser invents a year for strings like "Nov 1", which would date the result
  // to 2001.
  return ABSOLUTE_DATE.some((shape) => shape.test(text)) ? Date.parse(text) : NaN
}

function toResult(item: {
  title: string
  link: string
  snippet?: string | undefined
  date?: string | undefined
}) {
  const published = parseSearchDate(item.date)
  return {
    url: item.link,
    title: item.title,
    content: item.snippet ?? "",
    time: Number.isFinite(published) ? { published } : {},
  }
}

type SearchResult = ReturnType<typeof toResult>

// SerpApi charges per search, and a repeat query is a fresh charge. SerpApi
// also keeps its own identical-query cache for an hour, which it does not bill,
// so a client-side cache mainly saves the round trip. Knobs are read once at
// load time, restart after changing them.
//
//   SERPAPI_CACHE_TTL  ms to reuse a response for the same query (0 disables)
//   SERPAPI_GL         country code for results, e.g. "us", "cn"
//   SERPAPI_HL         language code for results, e.g. "en", "zh-cn"
//   SERPAPI_TBS        advanced filters, e.g. "qdr:d" (past day), "qdr:y"
//   SERPAPI_API_KEY    required; from https://serpapi.com
//
// There is deliberately no result-count knob: Google withdrew the `num`
// parameter, so SerpApi cannot honour one and a count would be a lie.
const CACHE_TTL = envInt("SERPAPI_CACHE_TTL", 600_000)
const GL = envStr("SERPAPI_GL")
const HL = envStr("SERPAPI_HL")
const TBS = envStr("SERPAPI_TBS")

const CACHE_LIMIT = 200
const cache = new Map<string, { at: number; results: SearchResult[] }>()

function cacheKey(query: string): string {
  return query.trim().replace(/\s+/g, " ")
}

function readCache(queryKey: string): SearchResult[] | undefined {
  if (CACHE_TTL <= 0) return undefined
  const hit = cache.get(queryKey)
  return hit && Date.now() - hit.at < CACHE_TTL ? hit.results : undefined
}

function writeCache(queryKey: string, results: SearchResult[]): void {
  if (CACHE_TTL <= 0) return
  cache.set(queryKey, { at: Date.now(), results })
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
}

export const effect = (ctx: Plugin.Context) =>
  Effect.gen(function* () {
    // Make "SerpApi" show up in /connect with an API-key method.
    yield* ctx.integration.transform((editor) => {
      editor.update(ID, (integration) => {
        integration.name = "SerpApi"
      })
      editor.method.update({
        integrationID: ID,
        method: { type: "key", label: "SerpApi API key" },
      })
      editor.method.update({
        integrationID: ID,
        method: { type: "env", names: ["SERPAPI_API_KEY"] },
      })
    })

    // The host instantiates this API's failure channel as `unknown`, which would
    // make the whole plugin effect unrunnable. A credential read must never take
    // the plugin down: a failed read degrades to "no stored key", and the
    // environment fallback below applies exactly as it does when the credential
    // simply does not exist.
    const soften = <A>(read: Effect.Effect<A, unknown>): Effect.Effect<A | undefined, never> =>
      read.pipe(Effect.catch(() => Effect.succeed(undefined)))

    // The key comes from the /connect credential, falling back to the
    // environment. Resolved per call so a rotated key needs no restart.
    const resolveKey = () =>
      Effect.gen(function* () {
        const connection = yield* soften(ctx.integration.connection.active(ID))
        const credential = connection
          ? yield* soften(ctx.integration.connection.resolve(connection))
          : undefined
        return credential?.type === "key" ? credential.key : process.env.SERPAPI_API_KEY
      })

    // SerpApi is bound to websearch only while a key exists. Deleting the key
    // unbinds the provider, so `random` can never pick a keyless SerpApi.
    // The transform replays on reload and reads `bound` as it stands then.
    let bound = Boolean(yield* resolveKey())

    yield* ctx.websearch.transform((editor) => {
      if (!bound) return
      editor.add({
        id: ID,
        name: "SerpApi",
        execute: ({ query }) =>
          Effect.gen(function* () {
            const queryKey = cacheKey(query)
            const cached = readCache(queryKey)
            if (cached) return cached

            // Rechecked per call: binding can lag a key deletion by the
            // event round-trip, so this keeps that window explicit.
            const key = yield* resolveKey()
            if (!key) {
              return yield* Effect.fail(
                new Error("Connect SerpApi in /connect, or set SERPAPI_API_KEY"),
              )
            }

            const url = new URL("https://serpapi.com/search.json")
            url.searchParams.set("engine", "google")
            url.searchParams.set("q", queryKey)
            url.searchParams.set("api_key", key)
            if (GL) url.searchParams.set("gl", GL)
            if (HL) url.searchParams.set("hl", HL)
            if (TBS) url.searchParams.set("tbs", TBS)

            const response = yield* Effect.tryPromise({
              try: () =>
                fetch(url, {
                  headers: {
                    Accept: "application/json",
                  },
                }),
              catch: (error) => new Error("SerpApi request failed: " + String(error)),
            })

            if (!response.ok) {
              const detail = yield* Effect.tryPromise({
                try: () => response.text(),
                catch: () => new Error("response body unavailable"),
              })
              return yield* Effect.fail(
                new Error("SerpApi API error " + response.status + ": " + detail),
              )
            }

            const json = yield* Effect.tryPromise({
              try: () => response.json(),
              catch: (error) => new Error("Invalid SerpApi response: " + String(error)),
            })

            const body = yield* Schema.decodeUnknownEffect(SerpApiResponse)(json)
            const results = (body.organic_results ?? []).map(toResult)

            writeCache(queryKey, results)
            return results
          }),
      })
    })

    // Rebind on credential changes: connect, delete, or rotate a key and the
    // provider joins or leaves the websearch pool without a restart. Env-var
    // keys cannot change under a running process, so they bind at startup.
    yield* Effect.forkScoped(
      ctx.event.subscribe().pipe(
        Stream.filter(
          (event) =>
            event.type === "credential.updated" ||
            event.type === "credential.switched" ||
            event.type === "integration.updated",
        ),
        Stream.mapEffect(() =>
          Effect.gen(function* () {
            const next = Boolean(yield* resolveKey())
            if (next === bound) return
            bound = next
            yield* ctx.websearch.reload()
          }),
        ),
        Stream.runDrain,
      ),
    )
  })

export default Plugin.define({ id: "serpapi-search", effect })
