import { Plugin } from "@opencode/plugin/effect"
import { Effect, Schema, Stream } from "effect"

// Doubao Search answers inside a Volcengine-style envelope: `ResponseMetadata`
// names the call (`RequestId` is what Volcengine support needs to find it
// again), and `Result.WebResults` carries the hits. A live response carries
// every documented hit key -- `SiteName`, `Position`, `AuthInfoDes` ride along
// unread -- so the fields this provider reads decode as nullable, and one bad
// hit must not fail the whole list.
//
// This provider speaks the Custom version only. Doubao Search also has a
// Global version (`/search_api/global_search`, snake_case request, fixed 10
// results, per-result token counts) with the same API key and the same shared
// free quota; the Custom version is the one chosen here because it returns
// the full page body per hit, honors `Count` server-side, and can restrict
// results to authoritative sources.
const DoubaoWebResult = Schema.Struct({
  Title: Schema.optional(Schema.NullOr(Schema.String)),
  Url: Schema.optional(Schema.NullOr(Schema.String)),
  Summary: Schema.optional(Schema.NullOr(Schema.String)),
  Snippet: Schema.optional(Schema.NullOr(Schema.String)),
  Content: Schema.optional(Schema.NullOr(Schema.String)),
  PublishTime: Schema.optional(Schema.NullOr(Schema.String)),
})

const DoubaoResponse = Schema.Struct({
  ResponseMetadata: Schema.optional(
    Schema.Struct({
      RequestId: Schema.optional(Schema.NullOr(Schema.String)),
      Error: Schema.optional(
        Schema.Struct({
          Code: Schema.optional(Schema.NullOr(Schema.String)),
          Message: Schema.optional(Schema.NullOr(Schema.String)),
        }),
      ),
    }),
  ),
  Result: Schema.optional(
    Schema.Struct({
      WebResults: Schema.optional(Schema.Array(DoubaoWebResult)),
    }),
  ),
})

// The /connect integration ID, and the websearch provider ID it binds to.
// The `osp-` prefix is this package's namespace: OpenCode's built-ins and a
// vendor plugin's own entry are bare vendor names, so `doubao` would collide
// with them, and with the opencode.db row keyed by integration ID.
const ID = "osp-doubao"

function envInt(name: string, fallback: number): number {
  const raw = (process.env[name] ?? "").trim()
  if (raw === "") return fallback
  const value = Number(raw)
  return Number.isInteger(value) && value >= 0 ? value : fallback
}

function envStr(name: string): string {
  return (process.env[name] ?? "").trim()
}

// Doubao stamps `PublishTime` in two shapes: an ISO string with an explicit
// offset ("2026-07-10T20:00:00+08:00"), and a bare wall clock
// ("2026-07-10 20:00:00") whose space instead of "T" the shared parser below
// rightly refuses to trust. The wall clock is Beijing time, and the rewrite
// names it as such before parsing -- the same way Bocha's `dateLastCrawled`
// "Z" is rewritten to the "+08:00" it actually means.
const WALL_CLOCK_DATE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/

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
  // ISO 8601 with a time component, which Doubao stamps when it does not use
  // the bare wall clock -- with an explicit "+08:00" offset.
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

// A result with no parseable date keeps no `time` at all; the agent reads the
// other results' timestamps and this one's silence.
function publishedAt(value: string | undefined): number {
  const raw = value?.trim()
  if (!raw) return NaN
  const parsed = parseSearchDate(raw)
  if (Number.isFinite(parsed)) return parsed
  return WALL_CLOCK_DATE.test(raw) ? parseSearchDate(raw.replace(" ", "T") + "+08:00") : NaN
}

// `Content` arrives in full whether or not it was wanted -- Doubao bills per
// search, not per token -- so it is cut to CONTENT_CHARS code points before
// it can reach the agent. The cut counts code points, never UTF-16 units, so
// no surrogate pair (an emoji, a rare ideograph) is sliced in half; the
// trailing ellipsis tells the model the body was clipped rather than that it
// ended there.
//
// The UTF-16 length check comes first because it is O(1) and can only
// over-estimate the code-point count: a body already inside the budget skips
// the spread entirely, which matters when a response carries ten full pages
// the caller never reads.
function trimContent(text: string): string {
  if (CONTENT_CHARS <= 0 || text.length <= CONTENT_CHARS) return text
  const points = [...text]
  if (points.length <= CONTENT_CHARS) return text
  return points.slice(0, CONTENT_CHARS).join("") + "…"
}

function toResult(item: {
  Title?: string | null | undefined
  Url?: string | null | undefined
  Summary?: string | null | undefined
  Snippet?: string | null | undefined
  Content?: string | null | undefined
  PublishTime?: string | null | undefined
}) {
  // A hit without a URL cannot be opened or cited, so it is dropped rather
  // than failing the whole page.
  if (!item.Url) return undefined
  const published = publishedAt(item.PublishTime ?? undefined)
  return {
    url: item.Url,
    // The Custom version always fills `Title` in its examples, but the URL is
    // the one field the mapping insists on, so it is also the one thing a
    // title can fall back to rather than leave the result untitled.
    title: item.Title ?? item.Url,
    // `Content` is the full page body (with `Summary` the shorter form it
    // falls back to), and `Snippet` is the query-relevant excerpt -- which
    // the live API delivers at roughly 600 characters, cut server-side. Full
    // mode reads the body first: the body is why the Custom version is the
    // one wired up here, and an agent can answer from it without a second
    // fetch. Snippet mode inverts the two to spend far less context -- the
    // trimmed body still stands in when a hit has no snippet. The budget is
    // applied to whichever branch wins, because OpenCode never truncates a
    // tool result: this cut is the only bound between Doubao's output and
    // the agent's context, and a bound that mode could slip past is no bound
    // at all. `||`, not `??`: an empty body means Doubao declined to write
    // one, and an empty string is not an answer worth handing the agent.
    content:
      trimContent(
        CONTENT === "snippet"
          ? item.Snippet || item.Content || item.Summary || ""
          : item.Content || item.Summary || item.Snippet || "",
      ) || "",
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
// `Retry-After` is delay-seconds ("3") or an HTTP-date ("Wed, 21 Oct 2026
// 07:28:00 GMT"); only the seconds form earns its "s".
function retryHint(retry: string | null): string {
  const value = retry?.trim()
  if (!value) return ""
  return ", retry after " + value + (/^\d+$/.test(value) ? "s" : "")
}



// Doubao bills per search (500 free per month per Volcengine account, shared
// with the Global version), so a repeat query is a dispatch worth skipping.
// Knobs are read once at load time, so restart after changing them.
//
//   DOUBAO_COUNT        results per search, clamped to 1-50 (the API's range)
//   DOUBAO_AUTH_LEVEL   1-4: only keep results at that source-authority level
//   DOUBAO_TIME_RANGE   OneDay, OneWeek, OneMonth or OneYear
//   DOUBAO_CONTENT      full (default) reads each hit's page body, snippet keeps
//                       only the query-relevant excerpt. The body is in every
//                       response either way -- this only decides what is spent
//                       on context tokens
//   DOUBAO_CONTENT_CHARS code points kept from the body (0 keeps all of it)
//   DOUBAO_TIMEOUT      ms to wait before failing (0 removes the deadline)
//   OSP_DOUBAO_API_KEY  required; from https://console.volcengine.com/search-infinity/web-search-exp
const CACHE_TTL = envInt("DOUBAO_CACHE_TTL", 600_000)
// OpenCode's own providers each bounded themselves at 25s, and the host adds
// no deadline of its own around `execute`, so this is the only one that exists.
const SEARCH_TIMEOUT = envInt("DOUBAO_TIMEOUT", 25_000)
const COUNT = Math.min(Math.max(envInt("DOUBAO_COUNT", 10), 1), 50)
const AUTH_LEVEL_VALUES = [1, 2, 3, 4]
const AUTH_LEVEL_RAW = envInt("DOUBAO_AUTH_LEVEL", 0)
const AUTH_LEVEL = AUTH_LEVEL_VALUES.includes(AUTH_LEVEL_RAW) ? AUTH_LEVEL_RAW : 0
if (AUTH_LEVEL_RAW !== 0 && AUTH_LEVEL === 0) {
  // The authority level is a closed set; without this guard a typo would ride
  // along on every search, and upstream rejects a level it does not know
  // instead of ignoring it. 0 means "every level" and needs no Filter entry.
  console.warn(
    "[opencode-search-plugin] DOUBAO_AUTH_LEVEL " +
      JSON.stringify(String(AUTH_LEVEL_RAW)) +
      " is not one of " +
      AUTH_LEVEL_VALUES.join(", ") +
      "; searching every authority level instead",
  )
}
const TIME_RANGE_VALUES = ["OneDay", "OneWeek", "OneMonth", "OneYear"]
const TIME_RANGE_RAW = envStr("DOUBAO_TIME_RANGE")
const TIME_RANGE = TIME_RANGE_VALUES.includes(TIME_RANGE_RAW) ? TIME_RANGE_RAW : ""
if (TIME_RANGE_RAW !== "" && TIME_RANGE === "") {
  // A time range is a closed set; a typo would cost every search instead of
  // only this knob, so it is reported and dropped rather than forwarded.
  console.warn(
    "[opencode-search-plugin] DOUBAO_TIME_RANGE " +
      JSON.stringify(TIME_RANGE_RAW) +
      " is not one of " +
      TIME_RANGE_VALUES.join(", ") +
      "; searching every time range instead",
  )
}
const CONTENT_VALUES = ["full", "snippet"]
const CONTENT_RAW = envStr("DOUBAO_CONTENT")
const CONTENT = CONTENT_VALUES.includes(CONTENT_RAW) ? CONTENT_RAW : "full"
if (CONTENT_RAW !== "" && CONTENT_RAW !== "full" && CONTENT === "full") {
  // The content mode decides how much of every hit reaches the agent's
  // context; a typo must not silently make that decision, so it is reported
  // and defaulted rather than left to guess.
  console.warn(
    "[opencode-search-plugin] DOUBAO_CONTENT " +
      JSON.stringify(CONTENT_RAW) +
      " is not one of " +
      CONTENT_VALUES.join(", ") +
      "; reading the full page body instead",
  )
}
// 2000 code points is roughly half of a typical Doubao body (measured around
// 3700 characters): the article's lead and its core, at about half the
// context cost. Doubao bills per search, not per token, so this bounds
// context rather than money -- and OpenCode never truncates a tool result,
// which makes this the only such bound in the whole chain.
const CONTENT_CHARS = envInt("DOUBAO_CONTENT_CHARS", 2_000)

const SEARCH_URL = "https://open.feedcoopapi.com/search_api/web_search"

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

// Doubao's refusals arrive as a Volcengine envelope: `ResponseMetadata.Error`
// names the failure and `ResponseMetadata.RequestId` is what Volcengine
// support needs to find the call again. A body in any other shape still
// stands in as the detail verbatim.
function describeFailure(detail: string): string {
  try {
    const body: unknown = JSON.parse(detail)
    if (typeof body === "object" && body !== null) {
      const metadata = (
        body as {
          ResponseMetadata?: { RequestId?: unknown; Error?: { Message?: unknown } }
        }
      ).ResponseMetadata
      const message = metadata?.Error?.Message
      if (typeof message === "string" && message !== "") {
        const requestID = metadata?.RequestId
        return message + (typeof requestID === "string" && requestID !== "" ? ` (request ${requestID})` : "")
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
    // Make "Doubao Search" show up in /connect with an API-key method.
    yield* ctx.integration.transform((editor) => {
      editor.update(ID, (integration) => {
        integration.name = "Doubao Search (osp)"
      })
      editor.method.update({
        integrationID: ID,
        method: { type: "key", label: "Doubao Search API key" },
      })
      editor.method.update({
        integrationID: ID,
        method: { type: "env", names: ["OSP_DOUBAO_API_KEY"] },
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
        return credential?.type === "key" ? credential.key : process.env.OSP_DOUBAO_API_KEY
      })

    // Doubao has no anonymous tier, so the provider binds only while a key
    // exists. Deleting the key unbinds it, and `random` can never pick a
    // keyless Doubao. The transform replays on reload and reads `bound` as it
    // stands then.
    let bound = Boolean(yield* resolveKey())

    yield* ctx.websearch.transform((editor) => {
      if (!bound) return
      editor.add({
        id: ID,
        name: "Doubao Search",
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
                new Error("Connect Doubao Search in /connect, or set OSP_DOUBAO_API_KEY"),
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
                  // The Custom version speaks PascalCase, not the snake_case
                  // most of these providers use. `SearchType: "web"` selects
                  // the webpage collection; `Count` is honored server-side,
                  // unlike the Global version's `doc_count`. The full page
                  // body comes back without asking for it, so nothing beyond
                  // the knobs below is sent -- `Filter` only rides when one of
                  // them asks, and `AuthInfoLevel` takes a single integer (an
                  // array is rejected as an invalid parameter).
                  body: JSON.stringify({
                    Query: queryKey,
                    SearchType: "web",
                    Count: COUNT,
                    ...(AUTH_LEVEL > 0 || TIME_RANGE !== ""
                      ? {
                          Filter: {
                            ...(AUTH_LEVEL > 0 ? { AuthInfoLevel: AUTH_LEVEL } : {}),
                            ...(TIME_RANGE !== "" ? { TimeRange: TIME_RANGE } : {}),
                          },
                        }
                      : {}),
                  }),
                  signal: timedSignal(signal, SEARCH_TIMEOUT),
                }),
              // A timeout is its own failure: naming it stops the user hunting
              // for a key problem that was never there.
              catch: (error) =>
                error instanceof Error && error.name === "TimeoutError"
                  ? new Error("Doubao search timed out after " + SEARCH_TIMEOUT + "ms")
                  : new Error("Doubao request failed: " + String(error)),
            })

            if (!response.ok) {
              const detail = yield* Effect.tryPromise({
                try: () => response.text(),
                catch: () => new Error("response body unavailable"),
              })
              const described = boundDetail(describeFailure(String(detail)))

              // Doubao names each refusal in its own envelope, and the two
              // below carry a fix the user can act on -- a status code would
              // send them hunting for a key problem that was really a quota.
              if (response.status === 401) {
                return yield* Effect.fail(
                  new Error(
                    "Doubao rejected the API key (HTTP 401): " +
                      described +
                      ". Connect Doubao Search in /connect or set OSP_DOUBAO_API_KEY to a key from https://console.volcengine.com/search-infinity/web-search-exp",
                  ),
                )
              }
              if (response.status === 429) {
                const retry = response.headers.get("Retry-After")
                return yield* Effect.fail(
                  new Error(
                    "Doubao rate limited the request (HTTP 429)" +
                      retryHint(retry) +
                      ": " +
                      described +
                      ". The free quota is 500 searches per month per Volcengine account and resets on the 1st",
                  ),
                )
              }
              return yield* Effect.fail(
                new Error("Doubao API error " + response.status + ": " + described),
              )
            }

            const json = yield* Effect.tryPromise({
              try: () => response.json(),
              catch: (error) => new Error("Invalid Doubao response: " + String(error)),
            })

            // Doubao refuses inside HTTP 200: a business error rides
            // `ResponseMetadata.Error` with a non-empty `Code`, and the call
            // is not billed for it. Reading the envelope before the schema
            // keeps that refusal from decoding into a silent empty result.
            const metadata = (
              json as {
                ResponseMetadata?: {
                  RequestId?: string | null
                  Error?: { Code?: string | null; Message?: string | null }
                }
              }
            ).ResponseMetadata
            const failure = metadata?.Error
            if (failure?.Code) {
              return yield* Effect.fail(
                new Error(
                  "Doubao search failed: " +
                    (failure.Message || failure.Code) +
                    " (code " +
                    failure.Code +
                    (metadata?.RequestId ? ", request " + metadata.RequestId : "") +
                    ")",
                ),
              )
            }

            const body = yield* Schema.decodeUnknownEffect(DoubaoResponse)(json)
            const results = (body.Result?.WebResults ?? [])
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

export default Plugin.define({ id: "doubao-search", effect })
