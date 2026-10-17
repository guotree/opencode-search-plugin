import { Plugin } from "@opencode/plugin/effect"
import { Effect, Schema, Stream } from "effect"

// Every field on a result is optional -- a missing one means "body text
// unavailable", not an error.
const QueritResponse = Schema.Struct({
  error_code: Schema.optional(Schema.Number),
  error_msg: Schema.optional(Schema.String),
  results: Schema.optional(
    Schema.Struct({
      result: Schema.optional(
        Schema.Array(
          Schema.Struct({
            url: Schema.optional(Schema.String),
            title: Schema.optional(Schema.String),
            snippet: Schema.optional(Schema.String),
            page_age: Schema.optional(Schema.String),
            sentence: Schema.optional(Schema.Array(Schema.String)),
          }),
        ),
      ),
    }),
  ),
})

// The /connect integration ID, and the websearch provider ID it binds to.
// The `osp-` prefix is this package's namespace: OpenCode's built-ins and a
// vendor plugin's own entry are bare vendor names, so `querit` would collide
// with them, and with the opencode.db row keyed by integration ID.
const ID = "osp-querit"

// search_id is documented as both a string and an integer, so read it loosely
// rather than letting a strict decode reject an otherwise good response.
function searchIdOf(json: unknown): string {
  const value = (json as { search_id?: unknown } | null)?.search_id
  return typeof value === "string" || typeof value === "number" ? String(value) : "unknown"
}

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

// Querit carries no snippet on every hit, in which case the sentence-level
// matches are the only body text available.
function toResult(item: {
  url: string
  title?: string | undefined
  snippet?: string | undefined
  page_age?: string | undefined
  sentence?: readonly string[] | undefined
}) {
  const published = parseSearchDate(item.page_age)
  return {
    url: item.url,
    title: item.title ?? item.url,
    content: item.snippet ?? (item.sentence ?? []).join(" "),
    time: Number.isFinite(published) ? { published } : {},
  }
}

type SearchResult = ReturnType<typeof toResult>

// Querit bills per search, so a repeat query is a charge that a cache can
// avoid. Knobs are read once at load time, restart after changing them.
//
//   QUERIT_CACHE_TTL   ms to reuse a response for the same query (0 disables)
//   QUERIT_COUNT       results per search; Querit's own limit applies
//   QUERIT_API_KEY     required; from https://querit.ai
const CACHE_TTL = envInt("QUERIT_CACHE_TTL", 600_000)
const SEARCH_SIZE = envInt("QUERIT_COUNT", 8)

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
    // Make "Querit" show up in /connect with an API-key method.
    yield* ctx.integration.transform((editor) => {
      editor.update(ID, (integration) => {
        integration.name = "Querit"
      })
      editor.method.update({
        integrationID: ID,
        method: { type: "key", label: "Querit API key" },
      })
      editor.method.update({
        integrationID: ID,
        method: { type: "env", names: ["QUERIT_API_KEY"] },
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
        return credential?.type === "key" ? credential.key : process.env.QUERIT_API_KEY
      })

    // Querit is bound to websearch only while a key exists. Deleting the key
    // unbinds the provider, so `random` can never pick a keyless Querit.
    // The transform replays on reload and reads `bound` as it stands then.
    let bound = Boolean(yield* resolveKey())

    yield* ctx.websearch.transform((editor) => {
      if (!bound) return
      editor.add({
        id: ID,
        name: "Querit",
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
                new Error("Connect Querit in /connect, or set QUERIT_API_KEY"),
              )
            }

            const response = yield* Effect.tryPromise({
              try: () =>
                fetch("https://api.querit.ai/v1/search", {
                  method: "POST",
                  headers: {
                    Accept: "application/json",
                    "Content-Type": "application/json",
                    Authorization: "Bearer " + key,
                  },
                  body: JSON.stringify({ query: queryKey, count: SEARCH_SIZE }),
                }),
              catch: (error) => new Error("Querit request failed: " + String(error)),
            })

            if (!response.ok) {
              const detail = yield* Effect.tryPromise({
                try: () => response.text(),
                catch: () => new Error("response body unavailable"),
              })
              return yield* Effect.fail(
                new Error("Querit API error " + response.status + ": " + detail),
              )
            }

            const json = yield* Effect.tryPromise({
              try: () => response.json(),
              catch: (error) => new Error("Invalid Querit response: " + String(error)),
            })

            const body = yield* Schema.decodeUnknownEffect(QueritResponse)(json)

            // Querit reports failures in the body too, even on an HTTP 200.
            // search_id is what support needs to trace the request.
            if (body.error_code !== undefined && body.error_code !== 200) {
              return yield* Effect.fail(
                new Error(
                  "Querit API error " +
                    body.error_code +
                    ": " +
                    (body.error_msg ?? "unknown error") +
                    " (search_id " +
                    searchIdOf(json) +
                    ")",
                ),
              )
            }

            const results = (body.results?.result ?? []).flatMap((item) =>
              item.url ? [toResult({ ...item, url: item.url })] : [],
            )

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

export default Plugin.define({ id: "querit-search", effect })
