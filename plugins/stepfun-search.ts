import { Plugin } from "@opencode/plugin/effect"
import { Effect, Schema, Stream } from "effect"

// StepFun's search endpoint is a bare retrieval call: a query in, ranked pages
// out, with no model in the loop. Its hit carries six documented fields, and
// every one this provider reads is nullable in practice -- a page with no index
// time, or a row the crawler half-filled, must not fail the whole list.
//
// `content` is the page body in full and is **always** sent: the API documents
// no `include_content`-style switch, so the only way to avoid paying for it in
// context tokens is to not read it (see INCLUDE_CONTENT below). `position` (the
// 1-based rank) and the echoed `query`/`category` ride along unread, and are
// left out of the schema on purpose: an unexpected type on a field nobody reads
// should not be able to fail the whole response.
const StepFunHit = Schema.Struct({
  url: Schema.optional(Schema.NullOr(Schema.String)),
  title: Schema.optional(Schema.NullOr(Schema.String)),
  time: Schema.optional(Schema.NullOr(Schema.String)),
  snippet: Schema.optional(Schema.NullOr(Schema.String)),
  content: Schema.optional(Schema.NullOr(Schema.String)),
})

const StepFunResponse = Schema.Struct({
  // Absent or null when the search found nothing.
  results: Schema.optional(Schema.NullOr(Schema.Array(StepFunHit))),
})

// The /connect integration ID, and the websearch provider ID it binds to.
// The `osp-` prefix is this package's namespace: OpenCode's built-ins and a
// vendor plugin's own entry are bare vendor names, so `stepfun` would collide
// with them, and with the opencode.db row keyed by integration ID.
const ID = "osp-stepfun"

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

// `time` is the page's **index** time -- when StepFun's crawler last saw it --
// not a publish date. It is the only time field the API returns, so it stands
// in for `published` the way Bocha's `dateLastCrawled` does. The wire format
// carries no offset ("2026-03-20T00:00:00"), which ECMAScript reads as the
// host's local wall clock; at worst that is a few hours of skew on a value that
// is approximate to begin with, and it beats dropping the field entirely.
//
// `content` is the full page body and arrives whether or not it was wanted, so
// it is cut to CONTENT_CHARS code points before it can reach the agent. The
// cut counts code points, never UTF-16 units, so no surrogate pair is sliced in
// half; the trailing ellipsis tells the model the body was clipped rather than
// that it ended there.
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
  url?: string | null | undefined
  title?: string | null | undefined
  time?: string | null | undefined
  snippet?: string | null | undefined
  content?: string | null | undefined
}) {
  // A hit without a URL cannot be opened, cited, or read as a source, so it
  // leaves the list instead of reaching the agent as a dead card.
  if (!item.url) return undefined
  const indexed = parseSearchDate(item.time ?? undefined)
  return {
    url: item.url,
    // The docs always fill `title` in their examples, but `url` is the field
    // the mapping insists on, so it is also the one thing a title can fall
    // back to rather than leave the result untitled.
    title: item.title || item.url,
    // `content` is the full page, and there is no parameter to ask for a
    // snippet instead -- so the snippet is the default answer and the body is
    // read only when the knob asks for it. `||`, not `??`: an empty snippet
    // means the crawler found nothing worth quoting, and an empty string is
    // not an answer worth handing the agent, so the body stands in (already
    // truncated, and already paid for by the response). The trim is inside
    // each branch so a hit whose snippet is used never spreads a 100k-char
    // body into code points it will not read.
    content: INCLUDE_CONTENT
      ? trimContent(item.content ?? "") || item.snippet || ""
      : item.snippet || trimContent(item.content ?? ""),
    time: Number.isFinite(indexed) ? { published: indexed } : {},
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



// StepFun bills per search (¥0.04 on the cn platform), and the docs promise no
// "empty searches are free" rule, so a repeat query is a dispatch worth
// skipping. Knobs are read once at load time, so restart after changing them.
//
//   STEPFUN_CACHE_TTL        ms to reuse a response for the same query (0 disables)
//   STEPFUN_COUNT            results per search, clamped to 1-20 (the API's range;
//                            10 is its own default)
//   STEPFUN_CATEGORY         scenario bias: programming, research, gov, business.
//                            Unset searches every scenario, which is the API's
//                            default; an unknown value is reported and ignored
//                            rather than sent to earn a 400.
//   STEPFUN_INCLUDE_CONTENT  true reads each hit's full-page `content` instead of
//                            its snippet. The body is in every response either
//                            way -- this only decides whether it is spent on
//                            context tokens.
//   STEPFUN_CONTENT_CHARS    code points kept from `content` (0 keeps all of it)
//   STEPFUN_TIMEOUT          ms to wait before failing (0 removes the deadline)
//   OSP_STEPFUN_API_KEY      required; from https://platform.stepfun.com/interface-key
const CACHE_TTL = envInt("STEPFUN_CACHE_TTL", 600_000)
// OpenCode's own providers each bounded themselves at 25s, and the host adds
// no deadline of its own around `execute`, so this is the only one that exists.
const SEARCH_TIMEOUT = envInt("STEPFUN_TIMEOUT", 25_000)
const COUNT = Math.min(Math.max(envInt("STEPFUN_COUNT", 10), 1), 20)
const INCLUDE_CONTENT = envStr("STEPFUN_INCLUDE_CONTENT") === "true"
// 4k code points is roughly a long article's opening: enough for the agent to
// judge a page, far short of the 100k+ a handful of full pages would cost.
const CONTENT_CHARS = envInt("STEPFUN_CONTENT_CHARS", 4_000)

// The four scenario values the API documents. Anything else is dropped with a
// warning: the endpoint answers 400 for an unknown category, and a typo in a
// knob should cost one knob, not every search.
const CATEGORIES = ["programming", "research", "gov", "business"]
const CATEGORY_RAW = envStr("STEPFUN_CATEGORY")
const CATEGORY = CATEGORIES.includes(CATEGORY_RAW) ? CATEGORY_RAW : ""
if (CATEGORY_RAW !== "" && CATEGORY === "") {
  console.warn(
    "[opencode-search-plugin] STEPFUN_CATEGORY " +
      JSON.stringify(CATEGORY_RAW) +
      " is not one of " +
      CATEGORIES.join(", ") +
      "; searching all scenarios instead",
  )
}

// Only the cn platform serves search: `api.stepfun.ai/v1/search` answers 404,
// while its chat endpoint does not, so there is no international twin to bind
// as a second provider (unlike Moonshot's two sites).
const SEARCH_URL = "https://api.stepfun.com/v1/search"

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

// StepFun's refusals are OpenAI-shaped -- `{"error":{"message","type"}}`, with
// `type` naming the class ("invalid_api_key") -- and a bare `{"message",...}`
// is accepted as a fallback in case a gateway answers in the older flat style.
// A body in any other shape stands in as the detail verbatim.
function describeFailure(detail: string): string {
  try {
    const body: unknown = JSON.parse(detail)
    if (typeof body === "object" && body !== null) {
      const record = body as Record<string, unknown>
      const source = (
        typeof record.error === "object" && record.error !== null ? record.error : record
      ) as Record<string, unknown>
      const message =
        typeof source.message === "string" && source.message !== "" ? source.message : ""
      if (message !== "") {
        // `type` ("invalid_api_key", "insufficient_credit") and `code` name the
        // refusal; either may be absent.
        const tags = [source.type, source.code]
          .filter((tag) => typeof tag === "string" && tag !== "")
          .join(", ")
        return tags === "" ? message : message + " (" + tags + ")"
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
    // Make "StepFun Search" show up in /connect with an API-key method.
    yield* ctx.integration.transform((editor) => {
      editor.update(ID, (integration) => {
        integration.name = "StepFun Search (osp)"
      })
      editor.method.update({
        integrationID: ID,
        method: { type: "key", label: "StepFun API key" },
      })
      editor.method.update({
        integrationID: ID,
        method: { type: "env", names: ["OSP_STEPFUN_API_KEY"] },
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
        return credential?.type === "key" ? credential.key : process.env.OSP_STEPFUN_API_KEY
      })

    // StepFun has no anonymous tier, so the provider binds only while a key
    // exists. Deleting the key unbinds it, and `random` can never pick a
    // keyless StepFun. The transform replays on reload and reads `bound` as it
    // stands then.
    let bound = Boolean(yield* resolveKey())

    yield* ctx.websearch.transform((editor) => {
      if (!bound) return
      editor.add({
        id: ID,
        name: "StepFun Search",
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
                new Error("Connect StepFun Search in /connect, or set OSP_STEPFUN_API_KEY"),
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
                    // Sent intact: the reference documents no length ceiling and
                    // no rewriting, so the agent's words are what get searched.
                    query: queryKey,
                    // Always sent. 10 is the API's own default, and naming it
                    // keeps the knob honest.
                    n: COUNT,
                    // Omitted rather than sent as "": the two mean the same
                    // thing (every scenario), and an empty string is not a
                    // documented value.
                    ...(CATEGORY ? { category: CATEGORY } : {}),
                  }),
                  signal: timedSignal(signal, SEARCH_TIMEOUT),
                }),
              // A timeout is its own failure: naming it stops the user hunting
              // for a key problem that was never there.
              catch: (error) =>
                error instanceof Error && error.name === "TimeoutError"
                  ? new Error("StepFun search timed out after " + SEARCH_TIMEOUT + "ms")
                  : new Error("StepFun request failed: " + String(error)),
            })

            if (!response.ok) {
              const detail = yield* Effect.tryPromise({
                try: () => response.text(),
                catch: () => new Error("response body unavailable"),
              })
              const described = describeFailure(String(detail))
              const quoted = described === "" ? "" : ": " + boundDetail(described)

              // Each refusal below carries a fix the user can act on; a bare
              // status code would send them hunting for the wrong one.
              if (response.status === 401) {
                return yield* Effect.fail(
                  new Error(
                    "StepFun rejected the API key (HTTP 401)" +
                      quoted +
                      ". Connect StepFun Search in /connect or set OSP_STEPFUN_API_KEY to a key from https://platform.stepfun.com/interface-key",
                  ),
                )
              }
              // 402 is the documented "balance insufficient" status; an
              // organization project key adds an `insufficient_credit` type.
              if (response.status === 402) {
                return yield* Effect.fail(
                  new Error(
                    "StepFun balance is insufficient (HTTP 402)" +
                      quoted +
                      ". Top up at https://platform.stepfun.com",
                  ),
                )
              }
              // 451 is StepFun's content-review refusal, and it can be raised
              // by either the query or the pages it found: rephrasing is the
              // only lever the caller has.
              if (response.status === 451) {
                return yield* Effect.fail(
                  new Error(
                    "StepFun refused the search on content review (HTTP 451)" +
                      quoted +
                      ". Rephrase the query; a moderation refusal is not a key or quota problem",
                  ),
                )
              }
              if (response.status === 429) {
                // The search endpoint publishes no quota of its own -- it shares
                // the account's tiered concurrency/RPM budget, which scales with
                // cumulative recharge -- so the advice is to wait, not to buy a
                // search-specific tier.
                const retry = response.headers.get("Retry-After")
                return yield* Effect.fail(
                  new Error(
                    "StepFun rate limited the search (HTTP 429)" +
                      retryHint(retry) +
                      quoted +
                      ". Searches share the account's rate-limit tier, so wait for the window to reset or run fewer at once",
                  ),
                )
              }
              return yield* Effect.fail(
                new Error("StepFun API error " + response.status + quoted),
              )
            }

            const json = yield* Effect.tryPromise({
              try: () => response.json(),
              catch: (error) => new Error("Invalid StepFun response: " + String(error)),
            })

            const body = yield* Schema.decodeUnknownEffect(StepFunResponse)(json)
            const results = (body.results ?? [])
              .map(toResult)
              .filter((result): result is SearchResult => result !== undefined)

            // A search is billed per dispatch, and the docs promise no refund
            // for an empty one, so a result that never enters the cache is a
            // query paid for again on every repeat.
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

export default Plugin.define({ id: "stepfun-search", effect })
