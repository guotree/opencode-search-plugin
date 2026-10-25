import { Plugin } from "@opencode/plugin/effect"
import { Effect, Schema, Stream } from "effect"

// Kagi returns { meta, data }: data separates results by kind, and only
// data.search (html pages) is read here -- the news, image, video and other
// collections ride along unread, as does `meta`, which Kagi documents as a
// debugging passenger. Failures arrive as HTTP status codes carrying an
// `error[]` detail array. Of the mapped fields only `url` and `title` are
// required: a missing `snippet` or `time` means "Kagi provided none", not an
// error.
const KagiResponse = Schema.Struct({
  data: Schema.optional(
    Schema.Struct({
      search: Schema.optional(
        Schema.Array(
          Schema.Struct({
            url: Schema.optional(Schema.String),
            title: Schema.optional(Schema.String),
            snippet: Schema.optional(Schema.String),
            time: Schema.optional(Schema.String),
          }),
        ),
      ),
    }),
  ),
})

// The /connect integration ID, and the websearch provider ID it binds to.
// The `osp-` prefix is this package's namespace: OpenCode's built-ins and a
// vendor plugin's own entry are bare vendor names, so `kagi` would collide
// with them, and with the opencode.db row keyed by integration ID.
const ID = "osp-kagi"

function envInt(name: string, fallback: number): number {
  const raw = (process.env[name] ?? "").trim()
  if (raw === "") return fallback
  const value = Number(raw)
  return Number.isInteger(value) && value >= 0 ? value : fallback
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
  // ISO 8601 with a time component, which Kagi returns verbatim on `time`.
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
  url?: string | undefined
  title?: string | undefined
  snippet?: string | undefined
  time?: string | undefined
}) {
  // A hit without a URL cannot be opened or cited, so it is dropped rather
  // than failing the whole page; a missing title falls back to the URL the
  // way the other providers' mappings already do.
  if (!item.url) return undefined
  const published = parseSearchDate(item.time)
  return {
    url: item.url,
    title: item.title || item.url,
    content: item.snippet ?? "",
    time: Number.isFinite(published) ? { published } : {},
  }
}

type SearchResult = NonNullable<ReturnType<typeof toResult>>
// An error body is diagnostic, not content: a WAF or CDN interposing an HTML
// page can make it tens of kilobytes, and every byte would land in the tool
// result and the model's context. API refusal bodies are JSON of a few hundred
// characters, so a bound sized above them loses nothing. Counted in code
// points, never UTF-16 units, so no surrogate pair is sliced in half.
const ERROR_DETAIL_CHARS = 300

function boundDetail(detail: string): string {
  if (detail.length <= ERROR_DETAIL_CHARS) return detail
  const points = [...detail]
  if (points.length <= ERROR_DETAIL_CHARS) return detail
  return points.slice(0, ERROR_DETAIL_CHARS).join("") + "… [truncated]"
}


// Kagi bills per request with no anonymous tier and no free API credit: $12
// per 1,000 search requests. Every dispatch is assumed billed, so a repeat
// query is a fresh billed dispatch and responses are cached per normalized
// query. (The search endpoint can also inline Extract-API page fetches at
// extra cost via `extract`; this provider never asks for them.) Knobs are
// read once at load time, restart after changing them.
//
//   KAGI_CACHE_TTL    ms to reuse a response for the same query (0 disables)
//   KAGI_NUM          results per search, clamped to 1-1024 (the API's range).
//                     Kagi itself returns as many results as one pass can
//                     gather; 8 matches this package's other providers
//   KAGI_LENS         lens to apply: the identifier of a built-in lens, or a
//                     shareable lens ID (the ID portion of its URL, or the
//                     full URL) from https://kagi.com/settings/lenses
//   KAGI_RECENT       recency filter: day, week or month. Sent as an inline
//                     lens, so it is ignored when KAGI_LENS is set; an unknown
//                     value is reported and dropped rather than sent to earn a
//                     400.
//   KAGI_REGION       ISO 3166-1 alpha-2 region code, e.g. "us", "cn"
//   KAGI_TIMEOUT      ms to wait for Kagi before failing (0 removes the
//                     deadline; cancellation still applies)
//   OSP_KAGI_API_KEY  required; from https://kagi.com/api/keys
const CACHE_TTL = envInt("KAGI_CACHE_TTL", 600_000)
const SEARCH_SIZE = Math.min(Math.max(envInt("KAGI_NUM", 8), 1), 1024)
const LENS = envStr("KAGI_LENS")
const REGION = envStr("KAGI_REGION")
// OpenCode's own providers each bounded themselves at 25s, and the host adds
// no deadline of its own around `execute`, so this is the only one that exists.
const SEARCH_TIMEOUT = envInt("KAGI_TIMEOUT", 25_000)

// The three values Kagi's lens.time_relative accepts. Anything else is
// dropped with a warning: an out-of-enum value is a 400, and a typo in one
// knob should cost that knob, not every search.
const RECENT_VALUES = ["day", "week", "month"]
const RECENT_RAW = envStr("KAGI_RECENT")
const RECENT = RECENT_VALUES.includes(RECENT_RAW) ? RECENT_RAW : ""
if (RECENT_RAW !== "" && RECENT === "") {
  console.warn(
    "[opencode-search-plugin] KAGI_RECENT " +
      JSON.stringify(RECENT_RAW) +
      " is not one of " +
      RECENT_VALUES.join(", ") +
      "; searching without a recency filter instead",
  )
}

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

// A hung upstream must not hang the agent: the deadline bounds it, and the
// thunk's signal carries host cancellation into the socket. `timeout <= 0`
// removes the deadline but never the cancellation, because
// `AbortSignal.timeout(0)` aborts instantly rather than "never".
function timedSignal(signal: AbortSignal, timeout: number): AbortSignal {
  return timeout > 0 ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : signal
}

export const effect = (ctx: Plugin.Context) =>
  Effect.gen(function* () {
    // Make "Kagi" show up in /connect with an API-key method.
    yield* ctx.integration.transform((editor) => {
      editor.update(ID, (integration) => {
        integration.name = "Kagi (osp)"
      })
      editor.method.update({
        integrationID: ID,
        method: { type: "key", label: "Kagi API key" },
      })
      editor.method.update({
        integrationID: ID,
        method: { type: "env", names: ["OSP_KAGI_API_KEY"] },
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
        return credential?.type === "key" ? credential.key : process.env.OSP_KAGI_API_KEY
      })

    // Kagi is bound to websearch only while a key exists. Deleting the key
    // unbinds the provider, so `random` can never pick a keyless Kagi.
    // The transform replays on reload and reads `bound` as it stands then.
    let bound = Boolean(yield* resolveKey())

    yield* ctx.websearch.transform((editor) => {
      if (!bound) return
      editor.add({
        id: ID,
        name: "Kagi",
        execute: ({ query }) =>
          Effect.gen(function* () {
            const queryKey = cacheKey(query)
            const cached = readCache(queryKey)
            if (cached) return cached

            // Rechecked per call: the binding can lag a key deletion by the
            // event round-trip, and this keeps that window explicit.
            const key = yield* resolveKey()
            if (!key) {
              return yield* Effect.fail(
                new Error("Connect Kagi in /connect, or set OSP_KAGI_API_KEY"),
              )
            }

            const response = yield* Effect.tryPromise({
              try: (signal) =>
                fetch("https://kagi.com/api/v1/search", {
                  method: "POST",
                  headers: {
                    Accept: "application/json",
                    "Content-Type": "application/json",
                    Authorization: "Bearer " + key,
                  },
                  body: JSON.stringify({
                    query: queryKey,
                    workflow: "search",
                    limit: SEARCH_SIZE,
                    ...(LENS ? { lens_id: LENS } : {}),
                    // `lens_id` and an inline `lens` are two lenses at once,
                    // which the spec does not define: a named lens wins, and
                    // the recency filter rides along only when none was named.
                    ...(RECENT && !LENS ? { lens: { time_relative: RECENT } } : {}),
                    ...(REGION ? { filters: { region: REGION } } : {}),
                  }),
                  signal: timedSignal(signal, SEARCH_TIMEOUT),
                }),
              // A timeout is its own failure: naming it stops the user hunting
              // for a key problem that was never there.
              catch: (error) =>
                error instanceof Error && error.name === "TimeoutError"
                  ? new Error("Kagi search timed out after " + SEARCH_TIMEOUT + "ms")
                  : new Error("Kagi request failed: " + String(error)),
            })

            if (!response.ok) {
              const detail = yield* Effect.tryPromise({
                try: () => response.text(),
                catch: () => new Error("response body unavailable"),
              })
              return yield* Effect.fail(
                new Error("Kagi API error " + response.status + ": " + boundDetail(detail)),
              )
            }

            const json = yield* Effect.tryPromise({
              try: () => response.json(),
              catch: (error) => new Error("Invalid Kagi response: " + String(error)),
            })

            const body = yield* Schema.decodeUnknownEffect(KagiResponse)(json)
            const results = (body.data?.search ?? [])
              .map(toResult)
              .filter((result): result is SearchResult => result !== undefined)

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
          // One failed rebind must not kill the subscription: the next
          // credential event still has to reach the reload. `bound` moves
          // before the reload so the transforms it replays build with the
          // new state, and rolls back when the reload dies so the next
          // event retries the binding instead of treating it as done. A
          // defect is named on stderr and the stream moves on; an
          // interruption is teardown rather than failure, and catchDefect
          // propagates it untouched so shutdown never waits behind a warning.
          Effect.gen(function* () {
            const next = Boolean(yield* resolveKey())
            if (next === bound) return
            const previous = bound
            bound = next
            yield* Effect.suspend(() => ctx.websearch.reload()).pipe(
              Effect.catchDefect((defect) =>
                Effect.sync(() => {
                  bound = previous
                  console.warn(
                    "[opencode-search-plugin] " +
                      ID +
                      " failed to rebind: " +
                      (defect instanceof Error ? defect.message : String(defect)),
                  )
                }),
              ),
            )
          }).pipe(
            // The credential read can die on its own (a host-side throw
            // before any reload); the subscription survives that too.
            Effect.catchDefect((defect) =>
              Effect.sync(() =>
                console.warn(
                  "[opencode-search-plugin] " +
                    ID +
                    " failed to rebind: " +
                    (defect instanceof Error ? defect.message : String(defect)),
                ),
              ),
            ),
          ),
        ),
        Stream.runDrain,
      ),
    )
  })

export default Plugin.define({ id: "kagi-search", effect })
