import { Plugin } from "@opencode/plugin/effect"
import { Effect, Schema, Stream } from "effect"

// Zhipu answers with `search_result` at the top level, alongside passengers
// this provider never reads: `id`/`created`/`request_id` name the call and
// `search_intent` echoes the query rewrite (present only when intent
// recognition ran). Each hit carries `media` (site name), `icon` and `refer`
// (the citation index the chat product stamps its answers with) next to the
// four fields mapped below. The docs show every hit with a `link`, but a
// search list is only as good as its worst hit: all four decode as nullable
// and a hit without a URL is dropped, so one malformed row cannot fail the
// whole list.
//
// This file is the cn site only (open.bigmodel.cn). The international site
// (api.z.ai) is a separate account system with separate keys and prices, so
// it registers as its own provider in `zai-search.ts` rather than a site
// knob here: a key from either site answers 401 against the other, and a
// config default should never be able to aim a key at the wrong host.
const ZhipuHit = Schema.Struct({
  title: Schema.optional(Schema.NullOr(Schema.String)),
  content: Schema.optional(Schema.NullOr(Schema.String)),
  link: Schema.optional(Schema.NullOr(Schema.String)),
  // "2025-05-23" in the documented examples, or absent when unknown.
  publish_date: Schema.optional(Schema.NullOr(Schema.String)),
})

const ZhipuResponse = Schema.Struct({
  // Absent or null when the search found nothing.
  search_result: Schema.optional(Schema.NullOr(Schema.Array(ZhipuHit))),
})

// The /connect integration ID, and the websearch provider ID it binds to.
// The `osp-` prefix is this package's namespace: OpenCode's built-ins and a
// vendor plugin's own entry are bare vendor names, so `zhipu` would collide
// with them, and with the opencode.db row keyed by integration ID.
const ID = "osp-zhipu"

function envInt(name: string, fallback: number): number {
  const raw = (process.env[name] ?? "").trim()
  if (raw === "") return fallback
  const value = Number(raw)
  return Number.isInteger(value) && value >= 0 ? value : fallback
}

function envStr(name: string): string {
  return (process.env[name] ?? "").trim()
}

// Zhipu stamps `publish_date` as a bare calendar date ("2025-05-23"), a shape
// the parser below already accepts as-is. The relative-date tables still ship
// byte-identical with the other providers in this package -- the parser comes
// from the same shared block, and `test/structure.test.ts` compares it byte
// for byte.
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

// `publish_date` is the only time field in a hit, and it is a bare calendar
// date in the documented examples -- parsed by the shared block above, and
// left as no `time` at all when absent or unparseable.
function toResult(item: {
  title?: string | null | undefined
  content?: string | null | undefined
  link?: string | null | undefined
  publish_date?: string | null | undefined
}) {
  // A hit without a URL cannot be opened, cited, or read as a source, so it
  // leaves the list instead of reaching the agent as a dead card.
  if (!item.link) return undefined
  const published = parseSearchDate(item.publish_date ?? undefined)
  return {
    url: item.link,
    // The docs always fill `title` in their examples, but `link` is the field
    // the mapping insists on, so it is also the one thing a title can fall
    // back to rather than leave the result untitled.
    title: item.title || item.link,
    // `content` is the excerpt Zhipu derived for the hit. `||`, not `??`: an
    // empty string means there was no excerpt worth reading, and an empty
    // string is not an answer worth handing the agent.
    content: item.content || "",
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



// Zhipu bills per search -- ¥0.01 on Search-Std, ¥0.03 on Search-Pro, ¥0.05 on
// the Sogou and Quark engines -- with no free tier and no anonymous tier, so a
// repeat query is a dispatch worth skipping. Knobs are read once at load time,
// so restart after changing them.
//
//   ZHIPU_CACHE_TTL     ms to reuse a response for the same query (0 disables)
//   ZHIPU_COUNT         results per search, clamped to 1-50 (the API's range)
//   ZHIPU_ENGINE        search_std (default, ¥0.01/search), search_pro (¥0.03,
//                       higher recall), search_pro_sogou, search_pro_quark
//                       (¥0.05 each)
//   ZHIPU_RECENCY       oneDay, oneWeek, oneMonth, oneYear, noLimit; unset
//                       omits the parameter, which is the API's noLimit default
//   ZHIPU_CONTENT_SIZE  medium or high; unset omits it (the API defaults to
//                       medium). high sends fuller excerpts at the same price
//   ZHIPU_TIMEOUT       ms to wait before failing (0 removes the deadline)
//   OSP_ZHIPU_API_KEY   required; from https://bigmodel.cn/usercenter/proj-mgmt/apikeys
const CACHE_TTL = envInt("ZHIPU_CACHE_TTL", 600_000)
// OpenCode's own providers each bounded themselves at 25s, and the host adds
// no deadline of its own around `execute`, so this is the only one that exists.
const SEARCH_TIMEOUT = envInt("ZHIPU_TIMEOUT", 25_000)
const COUNT = Math.min(Math.max(envInt("ZHIPU_COUNT", 10), 1), 50)
const ENGINE = envStr("ZHIPU_ENGINE") || "search_std"
const RECENCY = envStr("ZHIPU_RECENCY")
const CONTENT_SIZE = envStr("ZHIPU_CONTENT_SIZE")

const SEARCH_URL = "https://open.bigmodel.cn/api/paas/v4/web_search"

// The spec caps `search_query` at 70 characters (`maxLength: 70`), so a longer
// query is cut here rather than sent to fail as a 400. Cut by code point, so
// a CJK character or an emoji is never sliced through its halves. The cache
// still keys on the full query: two queries that differ only past character
// 70 are two separate answers the agent gave, even if they bill alike.
function toSearchQuery(queryKey: string): string {
  return [...queryKey].slice(0, 70).join("")
}

// `count` is documented for `search_std`, `search_pro` and `search_pro_sogou`
// on the cn endpoint, and for every engine on the intl one, so it is omitted
// on `search_pro_quark` -- whose row omits it -- rather than sent to be
// ignored. Sogou accepts only five sizes (10/20/30/40/50), so a knob value
// snaps to the nearest of them instead of arriving as a rejected 15.
function countFor(engine: string, count: number): number | undefined {
  if (engine === "search_pro_quark") return undefined
  if (engine === "search_pro_sogou") {
    return Math.min(Math.max(Math.round(count / 10) * 10, 10), 50)
  }
  return count
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

// Zhipu does not document this endpoint's refusal body, so the detail is read
// for whichever shape it actually arrives in: the OpenAI-compatible
// `{"error":{"code","message"}}` the platform's chat API answers with, or a
// flat `{"code","message"}` carrying the search-specific codes (1701: search
// concurrency at its cap, 1702: no usable engine, 1703: the engine returned
// nothing). A body in any other shape stands in as the detail verbatim.
function describeFailure(detail: string): string {
  try {
    const body: unknown = JSON.parse(detail)
    if (typeof body === "object" && body !== null) {
      const record = body as Record<string, unknown>
      const source = (
        typeof record.error === "object" && record.error !== null ? record.error : record
      ) as Record<string, unknown>
      const message =
        typeof source.message === "string" && source.message !== ""
          ? source.message
          : typeof source.msg === "string" && source.msg !== ""
            ? source.msg
            : ""
      if (message !== "") {
        const code = source.code
        const named =
          code === undefined || code === null || code === "" ? "" : ` (code ${String(code)})`
        return message + named
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
    // Make "Zhipu" show up in /connect with an API-key method.
    yield* ctx.integration.transform((editor) => {
      editor.update(ID, (integration) => {
        integration.name = "Zhipu Search (osp)"
      })
      editor.method.update({
        integrationID: ID,
        method: { type: "key", label: "Zhipu API key" },
      })
      editor.method.update({
        integrationID: ID,
        method: { type: "env", names: ["OSP_ZHIPU_API_KEY"] },
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
        return credential?.type === "key" ? credential.key : process.env.OSP_ZHIPU_API_KEY
      })

    // Zhipu has no anonymous tier, so the provider binds only while a key
    // exists. Deleting the key unbinds it, and `random` can never pick a
    // keyless Zhipu. The transform replays on reload and reads `bound` as it
    // stands then.
    let bound = Boolean(yield* resolveKey())

    yield* ctx.websearch.transform((editor) => {
      if (!bound) return
      editor.add({
        id: ID,
        name: "Zhipu Search",
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
                new Error("Connect Zhipu Search in /connect, or set OSP_ZHIPU_API_KEY"),
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
                    // Cut to the spec's 70-character ceiling (`maxLength: 70`)
                    // before dispatch.
                    search_query: toSearchQuery(queryKey),
                    search_engine: ENGINE,
                    // Intent recognition rewrites a query into a search phrase;
                    // the agent already writes one, and the spec marks this
                    // field required with a documented default of `false`.
                    search_intent: false,
                    // Omitted where the engine's own docs leave `count` out
                    // (Quark), and snapped to Sogou's five accepted sizes.
                    ...(countFor(ENGINE, COUNT) === undefined
                      ? {}
                      : { count: countFor(ENGINE, COUNT) }),
                    // Omitted rather than sent as "noLimit": the two mean the
                    // same thing, and noLimit is the documented default.
                    ...(RECENCY ? { search_recency_filter: RECENCY } : {}),
                    // Snippet length, not price -- `high` sends fuller excerpts
                    // for the same per-search fee.
                    ...(CONTENT_SIZE ? { content_size: CONTENT_SIZE } : {}),
                  }),
                  signal: timedSignal(signal, SEARCH_TIMEOUT),
                }),
              // A timeout is its own failure: naming it stops the user hunting
              // for a key problem that was never there.
              catch: (error) =>
                error instanceof Error && error.name === "TimeoutError"
                  ? new Error("Zhipu search timed out after " + SEARCH_TIMEOUT + "ms")
                  : new Error("Zhipu request failed: " + String(error)),
            })

            if (!response.ok) {
              const detail = yield* Effect.tryPromise({
                try: () => response.text(),
                catch: () => new Error("response body unavailable"),
              })
              const described = boundDetail(describeFailure(String(detail)))

              // The two below carry a fix the user can act on -- a bare status
              // code would send them hunting for an auth problem that was
              // really a cap, or the other way round.
              if (response.status === 401) {
                return yield* Effect.fail(
                  new Error(
                    "Zhipu rejected the API key (HTTP 401): " +
                      described +
                      ". Connect Zhipu Search in /connect or set OSP_ZHIPU_API_KEY to a key from https://bigmodel.cn/usercenter/proj-mgmt/apikeys. A key issued on z.ai belongs to Z.ai Search (osp-zai) instead",
                  ),
                )
              }
              if (response.status === 429) {
                const retry = response.headers.get("Retry-After")
                return yield* Effect.fail(
                  new Error(
                    "Zhipu rate limited the request (HTTP 429)" +
                      retryHint(retry) +
                      ": " +
                      described +
                      ". Concurrent searches are capped per account (the API's code 1701); retry shortly or run fewer searches at once",
                  ),
                )
              }
              return yield* Effect.fail(
                new Error("Zhipu API error " + response.status + ": " + described),
              )
            }

            const json = yield* Effect.tryPromise({
              try: () => response.json(),
              catch: (error) => new Error("Invalid Zhipu response: " + String(error)),
            })

            const body = yield* Schema.decodeUnknownEffect(ZhipuResponse)(json)
            const results = (body.search_result ?? [])
              .map(toResult)
              .filter((result): result is SearchResult => result !== undefined)

            // Zhipu charges per dispatch, so a result that never enters the
            // cache is a query paid for again on every repeat.
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

export default Plugin.define({ id: "zhipu-search", effect })
