import { Plugin } from "@opencode/plugin/effect"
import { Effect, Schema, Stream } from "effect"

// Bocha answers inside a Bing-compatible envelope: `code` and `msg` mirror the
// HTTP status, `log_id` names the call in Bocha's own logs, and
// `data.webPages.value` carries the hits. A live response carries every
// documented page key -- nulls on the nullable ones, and no `summary` key at
// all unless it was asked for -- so the fields this provider reads decode as
// nullable, and one bad page must not fail the whole list.
const BochaPage = Schema.Struct({
  name: Schema.optional(Schema.NullOr(Schema.String)),
  url: Schema.String,
  snippet: Schema.optional(Schema.NullOr(Schema.String)),
  summary: Schema.optional(Schema.NullOr(Schema.String)),
  datePublished: Schema.optional(Schema.NullOr(Schema.String)),
  dateLastCrawled: Schema.optional(Schema.NullOr(Schema.String)),
})

const BochaResponse = Schema.Struct({
  data: Schema.optional(
    Schema.Struct({
      webPages: Schema.optional(
        Schema.Struct({
          value: Schema.optional(Schema.Array(BochaPage)),
        }),
      ),
    }),
  ),
})

// The /connect integration ID, and the websearch provider ID it binds to.
// The `osp-` prefix is this package's namespace: OpenCode's built-ins and a
// vendor plugin's own entry are bare vendor names, so `bocha` would collide
// with them, and with the opencode.db row keyed by integration ID.
const ID = "osp-bocha"

function envInt(name: string, fallback: number): number {
  const raw = (process.env[name] ?? "").trim()
  if (raw === "") return fallback
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

function envStr(name: string): string {
  return (process.env[name] ?? "").trim()
}

// Bocha stamps both of its date fields in ISO 8601, which the parser below
// accepts as-is. The relative-date tables still ship byte-identical with the
// other providers in this package -- the parser comes from the same shared
// block, and `test/structure.test.ts` compares it byte for byte.
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
  // ISO 8601 with a time component, which Bocha stamps on both of its date
  // fields -- with a UTC+8 offset on `datePublished`, and with a "Z" that
  // lies on `dateLastCrawled`.
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

// `dateLastCrawled` is Bocha's misnamed publish time: the field name is a Bing
// compatibility shim, and Bocha's docs date the correction to a v2 that has not
// shipped. It also stamps a UTC+8 wall clock with a "Z" -- live responses carry
// both date fields on the same wall clock, one honest (`datePublished`, with
// its `+08:00` offset) and one lying (`dateLastCrawled`, with a `Z`), which is
// why the honest one is preferred above and this fallback rewrites the "Z" to
// "+08:00" before parsing, the workaround the docs themselves recommend. When
// v2 lands, this rewrite is what has to go with it.
function publishedAt(item: {
  datePublished?: string | null | undefined
  dateLastCrawled?: string | null | undefined
}): number {
  const fromPublishDate = parseSearchDate(item.datePublished ?? undefined)
  if (Number.isFinite(fromPublishDate)) return fromPublishDate
  return parseSearchDate(item.dateLastCrawled?.replace(/Z$/, "+08:00"))
}

function toResult(item: {
  name?: string | null | undefined
  url: string
  snippet?: string | null | undefined
  summary?: string | null | undefined
  datePublished?: string | null | undefined
  dateLastCrawled?: string | null | undefined
}) {
  const published = publishedAt(item)
  return {
    url: item.url,
    // Bocha always fills `name` in its examples, but the URL is the one field
    // the schema insists on, so it is also the one thing a title can fall back
    // to rather than leave the result untitled.
    title: item.name ?? item.url,
    // `summary` is the generated abstract, present only when it was asked for
    // and could be written; `snippet` is the excerpt that is always there.
    // `||`, not `??`: an empty `summary` means Bocha declined to write one,
    // and an empty string is not an answer worth handing the agent.
    content: item.summary || item.snippet || "",
    time: Number.isFinite(published) ? { published } : {},
  }
}

type SearchResult = ReturnType<typeof toResult>

// Bocha bills per search, at a tiered rate, so a repeat query is a dispatch
// worth skipping. The knobs trade money for context: `BOCHA_SUMMARY` in
// particular swaps the free snippet for a generated summary, which is dearer
// per call than the search that produced it. Knobs are read once at load time,
// so restart after changing them.
//
//   BOCHA_CACHE_TTL    ms to reuse a response for the same query (0 disables)
//   BOCHA_COUNT        results per search, clamped to 1-50 (the API's range)
//   BOCHA_FRESHNESS    "noLimit", "oneDay", "oneWeek", "oneMonth", "oneYear",
//                      a "YYYY-MM-DD" date, or a "YYYY-MM-DD..YYYY-MM-DD"
//                      range. Unset omits the parameter, which is the same
//                      thing: the docs recommend noLimit because the search
//                      rewrites time ranges itself, and a pinned range often
//                      finds nothing within it.
//   BOCHA_SUMMARY      true swaps each snippet for a generated summary --
//                      more context to read, at the higher per-call price
//   BOCHA_TIMEOUT      ms to wait before failing (0 removes the deadline)
//   OSP_BOCHA_API_KEY      required; from https://open.bocha.cn
const CACHE_TTL = envInt("BOCHA_CACHE_TTL", 600_000)
// OpenCode's own providers each bounded themselves at 25s, and the host adds
// no deadline of its own around `execute`, so this is the only one that exists.
const SEARCH_TIMEOUT = envInt("BOCHA_TIMEOUT", 25_000)
const COUNT = Math.min(Math.max(envInt("BOCHA_COUNT", 10), 1), 50)
const FRESHNESS = envStr("BOCHA_FRESHNESS")
const SUMMARY = envStr("BOCHA_SUMMARY") === "true"

const SEARCH_URL = "https://api.bocha.cn/v1/web-search"

const CACHE_LIMIT = 200
// A transient upstream wobble can produce an empty answer, and locking
// retries out for the full TTL turns one bad minute into ten. Empty sets
// are therefore pinned for a short beat instead.
const EMPTY_RESULT_TTL = 30_000
const cache = new Map<string, { at: number; ttl: number; results: SearchResult[] }>()

function cacheKey(query: string): string {
  return query.trim().replace(/\s+/g, " ")
}

function readCache(queryKey: string): SearchResult[] | undefined {
  if (CACHE_TTL <= 0) return undefined
  const hit = cache.get(queryKey)
  if (hit === undefined || Date.now() - hit.at >= hit.ttl) return undefined
  // A hit moves the entry to the tail, so eviction spends the least
  // recently used query rather than whichever one was searched first.
  cache.delete(queryKey)
  cache.set(queryKey, hit)
  return hit.results
}

function writeCache(queryKey: string, results: SearchResult[]): void {
  if (CACHE_TTL <= 0) return
  // A non-empty answer earns the full TTL; an empty one is pinned for the
  // short beat above so a wobble upstream cannot lock retries out.
  const ttl = results.length > 0 ? CACHE_TTL : Math.min(CACHE_TTL, EMPTY_RESULT_TTL)
  cache.delete(queryKey) // a rewrite is a use: it belongs at the tail too
  cache.set(queryKey, { at: Date.now(), ttl, results })
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
}

// Bocha's failures arrive as `{"code","message","log_id"}`, and the `log_id`
// is what their support needs to find the call again. A body in any other
// shape still stands in as the detail verbatim.
function describeFailure(detail: string): string {
  try {
    const body: unknown = JSON.parse(detail)
    if (typeof body === "object" && body !== null) {
      const { message, log_id: logID } = body as { message?: unknown; log_id?: unknown }
      if (typeof message === "string" && message !== "") {
        return message + (typeof logID === "string" && logID !== "" ? ` (log_id ${logID})` : "")
      }
    }
  } catch {
    // Not JSON: the raw body is the only detail there is.
  }
  return detail
}

// A hung upstream must not hang the agent: the deadline bounds it, and the
// thunk's signal carries host cancellation into the socket. `timeout <= 0`
// removes the deadline but never the cancellation, because
// `AbortSignal.timeout(0)` aborts instantly rather than "never".
function timedSignal(signal: AbortSignal, timeout: number): AbortSignal {
  return timeout > 0 ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : signal
}

export const effect = (ctx: Plugin.Context) =>
  Effect.gen(function* () {
    // Make "Bocha" show up in /connect with an API-key method.
    yield* ctx.integration.transform((editor) => {
      editor.update(ID, (integration) => {
        integration.name = "Bocha Search (osp)"
      })
      editor.method.update({
        integrationID: ID,
        method: { type: "key", label: "Bocha API key" },
      })
      editor.method.update({
        integrationID: ID,
        method: { type: "env", names: ["OSP_BOCHA_API_KEY"] },
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
        return credential?.type === "key" ? credential.key : process.env.OSP_BOCHA_API_KEY
      })

    // Bocha has no anonymous tier, so the provider binds only while a key
    // exists. Deleting the key unbinds it, and `random` can never pick a
    // keyless Bocha. The transform replays on reload and reads `bound` as it
    // stands then.
    let bound = Boolean(yield* resolveKey())

    yield* ctx.websearch.transform((editor) => {
      if (!bound) return
      editor.add({
        id: ID,
        name: "Bocha Search",
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
                new Error("Connect Bocha in /connect, or set OSP_BOCHA_API_KEY"),
              )
            }

            const response = yield* Effect.tryPromise({
              try: (signal) =>
                fetch(SEARCH_URL, {
                  method: "POST",
                  headers: {
                    Accept: "application/json",
                    "Content-Type": "application/json",
                    Authorization: "Bearer " + key,
                  },
                  body: JSON.stringify({
                    query: queryKey,
                    count: COUNT,
                    summary: SUMMARY,
                    // Omitted rather than sent as "noLimit": the two mean the
                    // same thing, and the docs describe noLimit as the search
                    // rewriting time ranges on its own.
                    ...(FRESHNESS ? { freshness: FRESHNESS } : {}),
                  }),
                  signal: timedSignal(signal, SEARCH_TIMEOUT),
                }),
              // A timeout is its own failure: naming it stops the user hunting
              // for a key problem that was never there.
              catch: (error) =>
                error instanceof Error && error.name === "TimeoutError"
                  ? new Error("Bocha search timed out after " + SEARCH_TIMEOUT + "ms")
                  : new Error("Bocha request failed: " + String(error)),
            })

            if (!response.ok) {
              const detail = yield* Effect.tryPromise({
                try: () => response.text(),
                catch: () => new Error("response body unavailable"),
              })
              const described = describeFailure(String(detail))

              // Bocha names each refusal in its own body, and the three below
              // carry a fix the user can act on -- a status code would send
              // them hunting for an auth problem that was really a balance.
              if (response.status === 401) {
                return yield* Effect.fail(
                  new Error(
                    "Bocha rejected the API key (HTTP 401): " +
                      described +
                      ". Connect Bocha in /connect or set OSP_BOCHA_API_KEY to a key from https://open.bocha.cn",
                  ),
                )
              }
              if (response.status === 403) {
                return yield* Effect.fail(
                  new Error(
                    "Bocha balance is exhausted (HTTP 403): " +
                      described +
                      ". Top up at https://open.bocha.cn",
                  ),
                )
              }
              if (response.status === 429) {
                const retry = response.headers.get("Retry-After")
                return yield* Effect.fail(
                  new Error(
                    "Bocha rate limited the request (HTTP 429)" +
                      (retry ? ", retry after " + retry + "s" : "") +
                      ": " +
                      described +
                      ". The request cap scales with the account's recharge amount",
                  ),
                )
              }
              return yield* Effect.fail(
                new Error("Bocha API error " + response.status + ": " + described),
              )
            }

            const json = yield* Effect.tryPromise({
              try: () => response.json(),
              catch: (error) => new Error("Invalid Bocha response: " + String(error)),
            })

            const body = yield* Schema.decodeUnknownEffect(BochaResponse)(json)
            const results = (body.data?.webPages?.value ?? []).map(toResult)

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

export default Plugin.define({ id: "bocha-search", effect })
