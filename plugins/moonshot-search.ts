import { Plugin } from "@opencode/plugin/effect"
import { Effect, Schema, Stream } from "effect"

// Moonshot AI (Kimi) publishes the same search tool on two sites with two
// consoles, two price lists and two currencies: the international site
// (platform.kimi.ai, api.moonshot.ai, dollars) and the China site
// (platform.kimi.com, api.moonshot.cn, renminbi). Keys are issued per site,
// so -- as with Zhipu's cn/intl split -- each site is its own provider rather
// than one provider with a site knob: a config default must never aim one
// site's key at the other site's host. This file is the international site;
// the China site is `moonshot-cn-search.ts`.
//
// This is the Basic search endpoint: one POST with a query returns
// `search_results[]` of titled, linkable hits, with no model call in the
// loop. The Pro endpoint (`/v1/tools/search_pro`) is deliberately not used:
// it trades snippets for relevance-scored `chunks` and bills 50% more, and
// its `sites`/`time_window` filters exist nowhere on Basic -- there is
// therefore no engine or filter knob here. Each hit also carries `authority`
// (a source grade whose enum the docs never spell out), `icon`, `mime` and
// `site_name`, which ride along unread. All fields decode as nullable and a
// hit without a URL is dropped, so one malformed row cannot fail the whole
// list. `text` is the full page body and reads as "" unless `include_content`
// was sent.
const MoonshotHit = Schema.Struct({
  title: Schema.optional(Schema.NullOr(Schema.String)),
  url: Schema.optional(Schema.NullOr(Schema.String)),
  snippet: Schema.optional(Schema.NullOr(Schema.String)),
  // "2026-06-01" in the docs' own example, or "" when the crawl found none.
  date: Schema.optional(Schema.NullOr(Schema.String)),
  // The full page body, present only with include_content=true.
  text: Schema.optional(Schema.NullOr(Schema.String)),
})

const MoonshotResponse = Schema.Struct({
  // Absent or null when the search found nothing.
  search_results: Schema.optional(Schema.NullOr(Schema.Array(MoonshotHit))),
})

// The /connect integration ID, and the websearch provider ID it binds to.
// The `osp-` prefix is this package's namespace: OpenCode's built-ins and a
// vendor plugin's own entry are bare vendor names, so `moonshot` would
// collide with them, and with the opencode.db row keyed by integration ID.
const ID = "osp-moonshot"

function envInt(name: string, fallback: number): number {
  const raw = (process.env[name] ?? "").trim()
  if (raw === "") return fallback
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

function envStr(name: string): string {
  return (process.env[name] ?? "").trim()
}

// Moonshot stamps `date` as a bare calendar date ("2026-06-01" in the docs'
// own example), or "" when the crawl found none -- shapes the parser below
// already handles as-is. The relative-date tables still ship byte-identical
// with the other providers in this package -- the parser comes from the same
// shared block, and `test/structure.test.ts` compares it byte for byte.
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

// `date` is the only time field in a hit, and it is a bare calendar date in
// the documented example -- parsed by the shared block above, and left as no
// `time` at all when absent, empty, or unparseable.
function toResult(item: {
  title?: string | null | undefined
  url?: string | null | undefined
  snippet?: string | null | undefined
  date?: string | null | undefined
  text?: string | null | undefined
}) {
  // A hit without a URL cannot be opened, cited, or read as a source, so it
  // leaves the list instead of reaching the agent as a dead card.
  if (!item.url) return undefined
  const published = parseSearchDate(item.date ?? undefined)
  return {
    url: item.url,
    // The docs always fill `title` in their examples, but `url` is the field
    // the mapping insists on, so it is also the one thing a title can fall
    // back to rather than leave the result untitled.
    title: item.title || item.url,
    // `text` is the full page body, returned only when include_content was
    // sent; `snippet` is the excerpt otherwise, and reads as "" when the
    // crawl found neither. `||`, not `??`: an empty string means there was
    // nothing worth reading, and an empty string is not an answer worth
    // handing the agent.
    content: item.text || item.snippet || "",
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


// Moonshot bills per search -- $0.002 on this site's Basic endpoint -- and
// bills only for a dispatch that returned at least one result: a failed or
// empty search is free. There is no anonymous tier, so the provider binds
// only while a key exists. Knobs are read once at load time, so restart
// after changing them.
//
//   MOONSHOT_CACHE_TTL        ms to reuse a response for the same query (0 disables)
//   MOONSHOT_COUNT            results per search, clamped to 1-20 (the API's
//                             range; 5 is the API's own default)
//   MOONSHOT_INCLUDE_CONTENT  true sends `include_content` and reads each
//                             hit's full-page `text` instead of its snippet
//   MOONSHOT_TIMEOUT          ms to wait before failing (0 removes the deadline)
//   OSP_MOONSHOT_API_KEY      required; from https://platform.kimi.ai/console/api-keys
const CACHE_TTL = envInt("MOONSHOT_CACHE_TTL", 600_000)
// OpenCode's own providers each bounded themselves at 25s, and the host adds
// no deadline of its own around `execute`, so this is the only one that exists.
const SEARCH_TIMEOUT = envInt("MOONSHOT_TIMEOUT", 25_000)
const COUNT = Math.min(Math.max(envInt("MOONSHOT_COUNT", 5), 1), 20)
const INCLUDE_CONTENT = envStr("MOONSHOT_INCLUDE_CONTENT") === "true"

// One endpoint, one account system. The key comes from
// https://platform.kimi.ai, and the China site's key is a separate
// credential under `osp-moonshot-cn`.
const SEARCH_URL = "https://api.moonshot.ai/v1/tools/search"

// `text_query` goes out as the agent wrote it: the reference documents no
// length ceiling and says the query is searched verbatim -- no rewriting,
// completion or expansion. `limit` is always sent (5 is the API's default,
// and naming it keeps the knob honest). `timeout_seconds` is left to the
// client deadline above. `include_content` is sent only when its knob is on.
// The endpoint takes no paging parameter -- `limit`'s 20 is the whole reach
// of one call -- and no site or time filter either: those belong to the Pro
// endpoint, which bills 50% more and returns scored `chunks` where Basic
// returns snippets.

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

// The reference documents this endpoint's refusal body as
// `{"error":{"message","type","code"}}` with `message` required -- and
// documents 401/403 as arriving with no body at all. The detail is therefore
// read for the documented shape, with a flat `{"message",...}` fallback in
// case a gateway answers in the platform's older flat style; a body in any
// other shape stands in as the detail verbatim.
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
        // `type` ("rate_limited", "invalid_request") and `code` name the
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
    // Make "Moonshot Search" show up in /connect with an API-key method.
    yield* ctx.integration.transform((editor) => {
      editor.update(ID, (integration) => {
        integration.name = "Moonshot Search (osp)"
      })
      editor.method.update({
        integrationID: ID,
        method: { type: "key", label: "Moonshot API key" },
      })
      editor.method.update({
        integrationID: ID,
        method: { type: "env", names: ["OSP_MOONSHOT_API_KEY"] },
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
        return credential?.type === "key" ? credential.key : process.env.OSP_MOONSHOT_API_KEY
      })

    // Moonshot has no anonymous tier, so the provider binds only while a key
    // exists. Deleting the key unbinds it, and `random` can never pick a
    // keyless Moonshot. The transform replays on reload and reads `bound` as
    // it stands then.
    let bound = Boolean(yield* resolveKey())

    yield* ctx.websearch.transform((editor) => {
      if (!bound) return
      editor.add({
        id: ID,
        name: "Moonshot Search",
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
                new Error("Connect Moonshot Search in /connect, or set OSP_MOONSHOT_API_KEY"),
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
                    text_query: queryKey,
                    limit: COUNT,
                    // Sent only when asked: the snippet is the cheap default,
                    // and the full page body behind it costs context tokens.
                    ...(INCLUDE_CONTENT ? { include_content: true } : {}),
                  }),
                  signal: timedSignal(signal, SEARCH_TIMEOUT),
                }),
              // A timeout is its own failure: naming it stops the user hunting
              // for a key problem that was never there.
              catch: (error) =>
                error instanceof Error && error.name === "TimeoutError"
                  ? new Error("Moonshot search timed out after " + SEARCH_TIMEOUT + "ms")
                  : new Error("Moonshot request failed: " + String(error)),
            })

            if (!response.ok) {
              const detail = yield* Effect.tryPromise({
                try: () => response.text(),
                catch: () => new Error("response body unavailable"),
              })
              const described = describeFailure(String(detail))
              // 401 and 403 are documented to arrive with no error body, so
              // the detail is quoted only when there is any.
              const quoted = described === "" ? "" : ": " + boundDetail(described)

              // A 401 here is most often the other site's key: the two sites
              // issue keys from separate consoles, and the fix is a different
              // provider, not a different string in the same box.
              if (response.status === 401) {
                return yield* Effect.fail(
                  new Error(
                    "Moonshot rejected the API key (HTTP 401)" +
                      quoted +
                      ". Connect Moonshot Search in /connect or set OSP_MOONSHOT_API_KEY to a key from https://platform.kimi.ai/console/api-keys. If the key was issued on the China site (https://platform.kimi.com), it belongs to Moonshot CN Search (osp-moonshot-cn) instead",
                  ),
                )
              }
              // The reference lists 403 as "account not activated or
              // disabled", with no body: the fix is at the console, not in
              // the request.
              if (response.status === 403) {
                return yield* Effect.fail(
                  new Error(
                    "Moonshot reports the account as not activated or disabled (HTTP 403)" +
                      quoted +
                      ". Activate or top up the account in the console: https://platform.kimi.ai",
                  ),
                )
              }
              if (response.status === 429) {
                // The refusal headers are `X-RateLimit-*`; `X-RateLimit-Reset`
                // is a Unix-seconds timestamp, reported here as the seconds
                // until the window reopens.
                const reset = response.headers.get("X-RateLimit-Reset")
                const wait =
                  reset !== null && /^\d+$/.test(reset)
                    ? Math.max(0, Number(reset) - Math.floor(Date.now() / 1000))
                    : undefined
                return yield* Effect.fail(
                  new Error(
                    "Moonshot rate limited the search (HTTP 429)" +
                      (wait !== undefined ? ", retry in " + wait + "s" : "") +
                      quoted +
                      ". The search QPS cap is tiered by the account's cumulative recharge (1 QPS at Tier0, up to 50); wait for the window to reset or run fewer searches at once",
                  ),
                )
              }
              return yield* Effect.fail(
                new Error("Moonshot API error " + response.status + quoted),
              )
            }

            const json = yield* Effect.tryPromise({
              try: () => response.json(),
              catch: (error) => new Error("Invalid Moonshot response: " + String(error)),
            })

            const body = yield* Schema.decodeUnknownEffect(MoonshotResponse)(json)
            const results = (body.search_results ?? [])
              .map(toResult)
              .filter((result): result is SearchResult => result !== undefined)

            // A non-empty search is billed per dispatch, so a result that
            // never enters the cache is a query paid for again on every
            // repeat. An empty one is free but is cached too: the retry would
            // cost a round trip for nothing.
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

export default Plugin.define({ id: "moonshot-search", effect })
