import { Plugin } from "@opencode/plugin/effect"
import { Effect, Option, Schema, Stream } from "effect"
import { HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http"

// WSA returns each page as a JSON string. Decode pages independently: a broken
// row must not discard usable sources, while a broken envelope is not an empty search.
const YuanbaoPage = Schema.Struct({
  url: Schema.optional(Schema.NullOr(Schema.String)),
  title: Schema.optional(Schema.NullOr(Schema.String)),
  content: Schema.optional(Schema.NullOr(Schema.String)),
  passage: Schema.optional(Schema.NullOr(Schema.String)),
  date: Schema.optional(Schema.NullOr(Schema.String)),
})
const YuanbaoEnvelope = Schema.Struct({
  Response: Schema.Struct({
    Error: Schema.optional(Schema.NullOr(Schema.Struct({
      Code: Schema.optional(Schema.NullOr(Schema.String)),
      Message: Schema.optional(Schema.NullOr(Schema.String)),
    }))),
    Pages: Schema.optional(Schema.Array(Schema.Unknown)),
    Msg: Schema.optional(Schema.NullOr(Schema.String)),
    RequestId: Schema.optional(Schema.NullOr(Schema.String)),
  }),
})
const decodeEnvelope = Schema.decodeUnknownOption(Schema.fromJsonString(YuanbaoEnvelope))
const decodePage = Schema.decodeUnknownOption(Schema.fromJsonString(YuanbaoPage))
const ID = "osp-yuanbao"

function envInt(name: string, fallback: number): number {
  const raw = (process.env[name] ?? "").trim()
  if (raw === "") return fallback
  const value = Number(raw)
  return Number.isInteger(value) && value >= 0 ? value : fallback
}

function envStr(name: string): string {
  return (process.env[name] ?? "").trim()
}

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
  /^\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}$/,
  /^[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4}$/,
  /^\d{4}-\d{2}-\d{2}$/,
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

function cleanHighlight(text: string): string {
  return text.replace(/<\/?strong\b[^>]*>/gi, "").trim()
}

function toResult(item: typeof YuanbaoPage.Type) {
  const url = item.url?.trim()
  if (!url) return undefined
  const date = item.date?.trim()
  // Official wall-clock examples have no zone contract. Only accept timestamps
  // with an explicit zone; never let the machine's timezone invent an instant.
  const published = date && /T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(date)
    ? parseSearchDate(date)
    : NaN
  return {
    url,
    title: cleanHighlight(item.title ?? "") || url,
    // Both fields are excerpts, not full page bodies. Lite only has passage.
    content: cleanHighlight(item.content ?? "") || cleanHighlight(item.passage ?? ""),
    time: Number.isFinite(published) ? { published } : {},
  }
}

type SearchResult = NonNullable<ReturnType<typeof toResult>>
const ERROR_DETAIL_CHARS = 300

function boundDetail(detail: string): string {
  if (detail.length <= ERROR_DETAIL_CHARS) return detail
  const points = [...detail]
  if (points.length <= ERROR_DETAIL_CHARS) return detail
  return points.slice(0, ERROR_DETAIL_CHARS).join("") + "… [truncated]"
}

function retryHint(retry: string | null): string {
  const value = retry?.trim()
  if (!value) return ""
  return ", retry after " + value + (/^\d+$/.test(value) ? "s" : "")
}

// Only Query is sent by default: even Mode=0 and Cnt=10 are unsupported on lite.
// The account's service tier is selected in the console, not in this request.
const CACHE_TTL = envInt("YUANBAO_CACHE_TTL", 600_000)
const SEARCH_TIMEOUT = envInt("YUANBAO_TIMEOUT", 25_000)
const COUNT_RAW = envStr("YUANBAO_COUNT")
const count = Schema.decodeUnknownOption(Schema.Literals(["10", "20", "30", "40", "50"]))(COUNT_RAW)
const COUNT = Option.isSome(count) ? Number(count.value) : undefined
if (COUNT_RAW !== "" && COUNT === undefined) {
  console.warn("[opencode-search-plugin] YUANBAO_COUNT must be 10, 20, 30, 40 or 50; omitting it")
}
const INDUSTRY_RAW = envStr("YUANBAO_INDUSTRY")
const INDUSTRY = Option.getOrElse(
  Schema.decodeUnknownOption(Schema.Literals(["gov", "news", "acad", "finance"]))(INDUSTRY_RAW),
  () => "",
)
if (INDUSTRY_RAW !== "" && INDUSTRY === "") {
  console.warn("[opencode-search-plugin] YUANBAO_INDUSTRY must be gov, news, acad or finance; omitting it")
}
const FRESHNESS_RAW = envStr("YUANBAO_FRESHNESS")
const FRESHNESS = Option.getOrElse(Schema.decodeUnknownOption(Schema.String.check(
  Schema.isPattern(/^(?:d(?:[1-9]|[12]\d|30)|m(?:[1-9]|1[0-2])|y[1-5])$/),
))(FRESHNESS_RAW), () => "")
if (FRESHNESS_RAW !== "" && FRESHNESS === "") {
  console.warn("[opencode-search-plugin] YUANBAO_FRESHNESS must be d1-d30, m1-m12 or y1-y5; omitting it")
}
const SITE_RAW = envStr("YUANBAO_SITE")
const domainPattern = "(?:[a-z\\d](?:[a-z\\d-]*[a-z\\d])?\\.)+[a-z\\d](?:[a-z\\d-]*[a-z\\d])?"
const SITE = Option.getOrElse(Schema.decodeUnknownOption(Schema.String.check(
  Schema.isPattern(new RegExp("^(?:" + domainPattern + "|exclude:" + domainPattern + "(?:\\|" + domainPattern + "){0,4})$", "i")),
))(SITE_RAW), () => "")
if (SITE_RAW !== "" && SITE === "") {
  console.warn("[opencode-search-plugin] YUANBAO_SITE must be one domain or exclude:domain|domain (up to five); omitting it")
}
const SEARCH_URL = "https://api.wsa.cloud.tencent.com/SearchPro"
const CONSOLE_URL = "https://console.cloud.tencent.com/wsapi/index?tab=apikey"

const CACHE_LIMIT = 200
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

function apiFailure(response: Response, body: typeof YuanbaoEnvelope.Type.Response | undefined, raw: string) {
  const code = body?.Error?.Code || ""
  const message = body?.Error?.Message || code || raw
  const detail = boundDetail(message)
  const trace = body?.RequestId ? ", request " + boundDetail(body.RequestId) : ""
  const context = " (HTTP " + response.status + (code ? ", code " + boundDetail(code) : "") + trace + ")"
  if (response.status === 429 || code === "RequestLimitExceeded") {
    const retry = response.headers.get("Retry-After")
    const description = "Yuanbao rate limited the request" + context + retryHint(retry) + ": " + detail
    // OpenCode v2.0.30's random routing checks this exact Effect HTTP error
    // contract. A plain Error with '429' in its message never triggers failover.
    // The synthetic status classifies a business throttle; context keeps the
    // actual upstream status. No key, query or raw response body is retained.
    const request = HttpClientRequest.post(SEARCH_URL)
    return new HttpClientError.HttpClientError({
      reason: new HttpClientError.StatusCodeError({
        request,
        response: HttpClientResponse.fromWeb(request, new Response(null, {
          status: 429,
          headers: retry === null ? {} : { "Retry-After": retry },
        })),
        description,
      }),
    })
  }
  let advice = ""
  if (code === "UnauthorizedOperation" || response.status === 401) {
    advice = ". Connect Yuanbao Search in /connect or set OSP_YUANBAO_API_KEY to a service key from " + CONSOLE_URL
  } else if (code === "ResourceNotFound") {
    advice = ". Enable Yuanbao Search at " + CONSOLE_URL
  } else if (code === "ResourceUnavailable") {
    advice = ". Check service availability and account status at " + CONSOLE_URL
  } else if (code === "InvalidParameter") {
    advice = ". Check optional filters and the account tier; Cnt and Industry require standard or flagship"
  }
  return new Error("Yuanbao API error " + response.status + context + ": " + detail + advice)
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
    yield* ctx.integration.transform((editor) => {
      editor.update(ID, (integration) => {
        integration.name = "Yuanbao Search (osp)"
      })
      editor.method.update({
        integrationID: ID,
        method: { type: "key", label: "Yuanbao Search service API key" },
      })
      editor.method.update({
        integrationID: ID,
        method: { type: "env", names: ["OSP_YUANBAO_API_KEY"] },
      })
    })

    const soften = <A>(read: Effect.Effect<A, unknown>): Effect.Effect<A | undefined, never> =>
      read.pipe(Effect.catch(() => Effect.succeed(undefined)))

    const resolveKey = () =>
      Effect.gen(function* () {
        const connection = yield* soften(ctx.integration.connection.active(ID))
        const credential = connection
          ? yield* soften(ctx.integration.connection.resolve(connection))
          : undefined
        return credential?.type === "key" ? credential.key : process.env.OSP_YUANBAO_API_KEY
      })

    let bound = Boolean(yield* resolveKey())
    yield* ctx.websearch.transform((editor) => {
      if (!bound) return
      editor.add({
        id: ID,
        name: "Yuanbao Search",
        execute: ({ query }) =>
          Effect.gen(function* () {
            const queryKey = cacheKey(query)
            const cached = readCache(queryKey)
            if (cached) return cached
            const key = yield* resolveKey()
            if (!key) {
              return yield* Effect.fail(new Error("Connect Yuanbao Search in /connect, or set OSP_YUANBAO_API_KEY"))
            }

            // Read the body inside the same cancellable task as fetch, so the
            // deadline also covers servers that send headers and then stall.
            const { response, text } = yield* Effect.tryPromise({
              try: async (signal) => {
                const response = await fetch(SEARCH_URL, {
                  method: "POST",
                  headers: {
                    Accept: "application/json",
                    "Content-Type": "application/json; charset=utf-8",
                    Authorization: "Bearer " + key,
                  },
                  body: JSON.stringify({
                    Query: queryKey,
                    ...(COUNT === undefined ? {} : { Cnt: COUNT }),
                    ...(SITE === "" ? {} : { Site: SITE }),
                    ...(FRESHNESS === "" ? {} : { Freshness: FRESHNESS }),
                    ...(INDUSTRY === "" ? {} : { Industry: INDUSTRY }),
                  }),
                  signal: timedSignal(signal, SEARCH_TIMEOUT),
                })
                return { response, text: await response.text() }
              },
              catch: (error) => error instanceof Error && error.name === "TimeoutError"
                ? new Error("Yuanbao search timed out after " + SEARCH_TIMEOUT + "ms")
                : new Error("Yuanbao request failed: " + boundDetail(String(error))),
            })

            const decoded = decodeEnvelope(text)
            const body = Option.isSome(decoded) ? decoded.value.Response : undefined
            if (!response.ok || body?.Error) {
              return yield* Effect.fail(apiFailure(response, body, text))
            }
            if (!body) {
              return yield* Effect.fail(new Error("Invalid Yuanbao response: expected a Response envelope"))
            }
            if (body.Msg?.trim().toLowerCase() === "hit black query") {
              return yield* Effect.fail(new Error("Yuanbao refused the query: hit black query" +
                (body.RequestId ? " (request " + boundDetail(body.RequestId) + ")" : "")))
            }
            if (!body.Pages) {
              return yield* Effect.fail(new Error("Invalid Yuanbao response: missing Pages"))
            }
            const results: SearchResult[] = []
            for (const page of body.Pages) {
              const decoded = decodePage(page)
              if (Option.isNone(decoded)) continue
              const result = toResult(decoded.value)
              if (result) results.push(result)
            }
            if (body.Pages.length > 0 && results.length === 0) {
              return yield* Effect.fail(new Error("Invalid Yuanbao response: Pages contained no usable results"))
            }
            // Unknown informational messages are not classified as refusals,
            // but an empty response with a message must not pin a retry.
            if (results.length > 0 || !body.Msg?.trim()) writeCache(queryKey, results)
            return results
          }),
      })
    })

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

export default Plugin.define({ id: "yuanbao-search", effect })
