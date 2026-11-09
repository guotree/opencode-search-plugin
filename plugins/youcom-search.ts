import { Plugin } from "@opencode/plugin/effect"
import { Effect, Schema } from "effect"
import { HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http"

// You.com returns { results: { web, news }, metadata } with no body-level error
// envelope: failures are HTTP status codes only. Every result field is
// optional -- a missing one means "the source provided none", not an error.
// search_uuid is the only handle support has on a request, so it rides along
// on decode failures.
const YouResult = Schema.Struct({
  url: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  snippets: Schema.optional(Schema.Array(Schema.String)),
  page_age: Schema.optional(Schema.String),
  contents: Schema.optional(
    Schema.Struct({
      html: Schema.optional(Schema.String),
      markdown: Schema.optional(Schema.String),
      highlights: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
})

const YouResponse = Schema.Struct({
  results: Schema.optional(
    Schema.Struct({
      web: Schema.optional(Schema.Array(YouResult)),
      news: Schema.optional(Schema.Array(YouResult)),
    }),
  ),
  metadata: Schema.optional(
    Schema.Struct({
      search_uuid: Schema.optional(Schema.String),
      query: Schema.optional(Schema.String),
      latency: Schema.optional(Schema.Number),
    }),
  ),
})

type YouHit = typeof YouResult.Type

// The /connect integration ID, and the websearch provider ID it binds to.
// The `osp-` prefix is this package's namespace: OpenCode's built-ins and a
// vendor plugin's own entry are bare vendor names, so `youcom` would collide
// with them, and with the opencode.db row keyed by integration ID.
const ID = "osp-youcom"

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

function nonBlank(text: string | undefined): string | undefined {
  return text !== undefined && /\S/.test(text) ? text : undefined
}

// Web and news live in separate sections; an agent asking "what's new" wants
// both, so they merge into one list with web first.
function toResult(item: YouHit) {
  const published = parseSearchDate(item.page_age)
  const extracted =
    nonBlank(item.contents?.highlights?.join("\n")) ??
    nonBlank(item.contents?.markdown) ??
    nonBlank(item.snippets?.join(" ")) ??
    nonBlank(item.description) ??
    ""
  return {
    url: item.url ?? "",
    title: item.title || item.url || "",
    content: extracted,
    time: Number.isFinite(published) ? { published } : {},
  }
}

type SearchResult = ReturnType<typeof toResult>
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

// You.com has two tiers: a commercial pay-as-you-go REST API ($5 per 1k searches)
// requiring an API key, and an official keyless free tier accessed via its hosted
// Model Context Protocol (MCP) server (profile=free). With a key, requests route
// to the commercial REST endpoint (ydc-index.io). Without a key, requests route
// to the hosted MCP endpoint, providing daily free queries without registration.
// A missing key therefore routes to the free tier rather than failing, which is
// why this provider never gates on `bound`. Repeat queries are cached per
// normalized query. Knobs are read once at load time, restart after changing them.
//
//   YOUCOM_CACHE_TTL     ms to reuse a response for the same query (0 disables)
//   YOUCOM_COUNT         results per section (web and news each), clamped 1-100
//   YOUCOM_EXTRACTION    "highlights" (default) returns the passages that answer
//                        the query, "none" returns bare snippets, "full_page"
//                        crawls every hit and is billed per live-fetched page
//                        ($1 per 1k) on top of the search -- cached pages are free
//   YOUCOM_LANGUAGE      result language, e.g. "EN", "ZH-HANS"
//   YOUCOM_COUNTRY       geographic focus, e.g. "US", "CN"
//   YOUCOM_FRESHNESS     "day" | "week" | "month" | "year" or "YYYY-MM-DDtoYYYY-MM-DD"
//   YOUCOM_TIMEOUT       ms to wait before failing (0 removes the deadline)
//   OSP_YDC_API_KEY      optional; You.com's canonical env var, shared with its SDKs.
//                        When omitted, You.com uses the hosted MCP free tier.
const SEARCH_URL = "https://ydc-index.io/v1/search"
const FREE_MCP_URL = "https://api.you.com/mcp?profile=free"

const CACHE_TTL = envInt("YOUCOM_CACHE_TTL", 600_000)
// OpenCode's own providers each bounded themselves at 25s, and the host adds
// no deadline of its own around `execute`, so this is the only one that exists.
const SEARCH_TIMEOUT = envInt("YOUCOM_TIMEOUT", 25_000)
const SEARCH_SIZE = Math.min(Math.max(envInt("YOUCOM_COUNT", 10), 1), 100)
const EXTRACTION_VALUES = ["none", "highlights", "full_page"]
const EXTRACTION_RAW = envStr("YOUCOM_EXTRACTION")
const EXTRACTION = EXTRACTION_VALUES.includes(EXTRACTION_RAW) ? EXTRACTION_RAW : "highlights"
if (EXTRACTION_RAW !== "" && !EXTRACTION_VALUES.includes(EXTRACTION_RAW)) {
  // An unknown value is reported rather than dropped silently: a typo in a
  // knob should cost that knob, and the user should hear about it.
  console.warn(
    "[opencode-search-plugin] YOUCOM_EXTRACTION " +
      JSON.stringify(EXTRACTION_RAW) +
      " is not one of " +
      EXTRACTION_VALUES.join(", ") +
      "; extracting highlights instead",
  )
}
const LANGUAGE = envStr("YOUCOM_LANGUAGE")
const COUNTRY = envStr("YOUCOM_COUNTRY")
const FRESHNESS = envStr("YOUCOM_FRESHNESS")

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

function withRequestSignal<A, E>(
  timeout: number,
  run: (signal: AbortSignal) => Effect.Effect<A, E>,
): Effect.Effect<A, E> {
  return Effect.scoped(Effect.gen(function* () {
    const controller = yield* Effect.acquireRelease(
      Effect.sync(() => new AbortController()),
      (controller) => Effect.sync(() => controller.abort()),
    )
    return yield* run(timedSignal(controller.signal, timeout))
  }))
}

function rateLimitError(
  response: Response,
  endpoint: string,
  method: "GET" | "POST",
  description: string,
) {
  const request = method === "GET"
    ? HttpClientRequest.get(endpoint)
    : HttpClientRequest.post(endpoint)
  const retry = response.headers.get("Retry-After")
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

function extractMcpMessage(msg: unknown): { result?: unknown; error?: string } {
  if (typeof msg !== "object" || msg === null) return {}
  const rec = msg as Record<string, unknown>

  if (typeof rec.error === "object" && rec.error !== null) {
    const err = rec.error as Record<string, unknown>
    const errorMsg = typeof err.message === "string" ? err.message : JSON.stringify(err)
    return { error: errorMsg }
  }

  if (
    rec.method === "notifications/message" &&
    typeof rec.params === "object" &&
    rec.params !== null
  ) {
    const params = rec.params as Record<string, unknown>
    if (params.level === "error" && typeof params.data === "string") {
      return { error: params.data }
    }
  }

  if (typeof rec.result === "object" && rec.result !== null) {
    const result = rec.result as Record<string, unknown>
    const isError = Boolean(result.isError)
    if (Array.isArray(result.content)) {
      for (const item of result.content) {
        if (
          typeof item === "object" &&
          item !== null &&
          (item as Record<string, unknown>).type === "text" &&
          typeof (item as Record<string, unknown>).text === "string"
        ) {
          const text = (item as Record<string, unknown>).text as string
          if (isError) {
            return { error: text }
          }
          try {
            return { result: JSON.parse(text) }
          } catch {
            if (text.startsWith("Error:") || text.startsWith("Error ")) {
              return { error: text }
            }
          }
        }
      }
    }
  }

  if (rec.results !== undefined) {
    return { result: msg }
  }

  return {}
}

function formatMcpError(message: string): string {
  const isRateLimit = /rate\s*limit|limit\s*exceeded|quota/i.test(message)
  return (
    "You.com MCP error: " +
    message +
    (isRateLimit
      ? ". The keyless free tier is rate limited; connect You.com in /connect or set OSP_YDC_API_KEY to spend your own dedicated allowance."
      : "")
  )
}

function parseMcpResponse(raw: string): unknown {
  try {
    const direct: unknown = JSON.parse(raw)
    const extracted = extractMcpMessage(direct)
    if (extracted.result !== undefined) return extracted.result
    if (extracted.error !== undefined) throw new Error(formatMcpError(extracted.error))
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("You.com MCP error:")) {
      throw error
    }
  }

  let eventData: string[] = []
  let lastError: string | undefined

  const processEvent = (dataLines: string[]) => {
    if (dataLines.length === 0) return undefined
    const payload = dataLines.join("\n").trim()
    if (!payload) return undefined
    try {
      const msg: unknown = JSON.parse(payload)
      const extracted = extractMcpMessage(msg)
      if (extracted.result !== undefined) return extracted.result
      if (extracted.error !== undefined) {
        lastError = extracted.error
      }
    } catch {
      // Ignore unparseable data chunks (heartbeats, comments)
    }
    return undefined
  }

  const lines = raw.split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === "") {
      const res = processEvent(eventData)
      if (res !== undefined) return res
      eventData = []
      continue
    }
    if (trimmed.startsWith("data:")) {
      eventData.push(trimmed.slice(5).replace(/^\s/, ""))
    }
  }

  const trailing = processEvent(eventData)
  if (trailing !== undefined) return trailing

  if (lastError !== undefined) {
    throw new Error(formatMcpError(lastError))
  }

  throw new Error("Invalid You.com MCP response: no search result found in payload")
}

// Unlike the key-requiring providers in this repo, You.com never gates on
// `bound`: keyless access is a first-class mode via You.com's hosted MCP
// free profile, so the provider is always in the pool. The key is still read
// per call, which is why no credential-event subscription is needed -- a
// rotated key takes effect on the next search without a reload.
export const effect = (ctx: Plugin.Context) =>
  Effect.gen(function* () {
    // Make "You.com" show up in /connect with an API-key method.
    yield* ctx.integration.transform((editor) => {
      editor.update(ID, (integration) => {
        integration.name = "You.com (osp)"
      })
      editor.method.update({
        integrationID: ID,
        method: { type: "key", label: "You.com API key" },
      })
      editor.method.update({
        integrationID: ID,
        method: { type: "env", names: ["OSP_YDC_API_KEY"] },
      })
    })

    // The host instantiates this API's failure channel as `unknown`, which would
    // make the whole plugin effect unrunnable. A credential read must never take
    // the plugin down: a failed read degrades to "no stored key", and the
    // environment fallback below applies exactly as it does when the credential
    // simply does not exist.
    const soften = <A>(read: Effect.Effect<A, unknown>): Effect.Effect<A | undefined, never> =>
      read.pipe(Effect.catch(() => Effect.succeed(undefined)))

    yield* ctx.websearch.transform((editor) => {
      editor.add({
        id: ID,
        name: "You.com",
        execute: ({ query }) =>
          Effect.gen(function* () {
            const queryKey = cacheKey(query)
            const cached = readCache(queryKey)
            if (cached) return cached

            // Keyless access is a first-class mode: a missing key routes to the
            // hosted MCP free tier instead of failing.
            const connection = yield* soften(ctx.integration.connection.active(ID))
            const credential = connection
              ? yield* soften(ctx.integration.connection.resolve(connection))
              : undefined
            const key =
              credential?.type === "key" ? credential.key : process.env.OSP_YDC_API_KEY

            const extraction =
              EXTRACTION === "highlights"
                ? { extraction_mode: "highlights" }
                : EXTRACTION === "full_page"
                  ? {
                      extraction_mode: "full_page",
                      full_page: { extraction_formats: ["markdown"] },
                    }
                  : undefined

            return yield* withRequestSignal(SEARCH_TIMEOUT, (signal) => Effect.gen(function* () {
              const endpoint = key ? SEARCH_URL : FREE_MCP_URL
              const headers: Record<string, string> = {
                Accept: key ? "application/json" : "application/json, text/event-stream",
                "Content-Type": "application/json",
              }
              if (key) headers["X-API-Key"] = key

              const bodyJson = key
                ? JSON.stringify({
                    query: queryKey,
                    count: SEARCH_SIZE,
                    ...(LANGUAGE ? { language: LANGUAGE } : {}),
                    ...(COUNTRY ? { country: COUNTRY } : {}),
                    ...(FRESHNESS ? { freshness: FRESHNESS } : {}),
                    ...(extraction ? { extraction } : {}),
                  })
                : JSON.stringify({
                    jsonrpc: "2.0",
                    id: 1,
                    method: "tools/call",
                    params: {
                      name: "you-search",
                      arguments: {
                        query: queryKey,
                        count: SEARCH_SIZE,
                        extraction: EXTRACTION,
                        ...(FRESHNESS ? { freshness: FRESHNESS } : {}),
                      },
                      ...(LANGUAGE || COUNTRY
                        ? {
                            _meta: {
                              "com.you.com/search": {
                                ...(LANGUAGE ? { language: LANGUAGE } : {}),
                                ...(COUNTRY ? { country: COUNTRY } : {}),
                              },
                            },
                          }
                        : {}),
                    },
                  })

              const response = yield* Effect.tryPromise({
                try: () =>
                  fetch(endpoint, {
                    method: "POST",
                    headers,
                    body: bodyJson,
                    signal,
                  }),
                catch: (error) =>
                  ((error instanceof Error && error.name === "TimeoutError") || (signal.aborted && signal.reason?.name === "TimeoutError"))
                    ? new Error("You.com search timed out after " + SEARCH_TIMEOUT + "ms")
                    : new Error("You.com request failed: " + String(error)),
              })

              if (!response.ok) {
                const detail = yield* Effect.tryPromise({
                  try: () => response.text(),
                  catch: (error) => ((error instanceof Error && error.name === "TimeoutError") || (signal.aborted && signal.reason?.name === "TimeoutError"))
                    ? new Error("You.com search timed out after " + SEARCH_TIMEOUT + "ms")
                    : new Error("response body unavailable"),
                }).pipe(Effect.catch((error) => response.status === 429
                  ? Effect.succeed("response body unavailable")
                  : Effect.fail(error)))
                const message =
                  "You.com API error " +
                  response.status +
                  ": " +
                  boundDetail(detail) +
                  (key
                    ? ""
                    : ". The keyless free tier is rate limited; connect You.com in /connect or set OSP_YDC_API_KEY to spend your own dedicated allowance.")
                return yield* Effect.fail(response.status === 429
                  ? rateLimitError(response, endpoint, "POST", message)
                  : new Error(message))
              }

              const json = yield* Effect.tryPromise({
                try: async () => {
                  if (key) {
                    return await response.json()
                  }
                  const rawText = await response.text()
                  return parseMcpResponse(rawText)
                },
                catch: (error) => ((error instanceof Error && error.name === "TimeoutError") || (signal.aborted && signal.reason?.name === "TimeoutError"))
                  ? new Error("You.com search timed out after " + SEARCH_TIMEOUT + "ms")
                  : (error instanceof Error && (error.message.startsWith("You.com ") || error instanceof HttpClientError.HttpClientError))
                    ? error
                    : new Error("Invalid You.com response: " + String(error)),
              })

              const body = yield* Schema.decodeUnknownEffect(YouResponse)(json)
              const hits = [...(body.results?.web ?? []), ...(body.results?.news ?? [])]
              const results = hits.flatMap((item) => (item.url ? [toResult(item)] : []))

              writeCache(queryKey, results)
              return results
            }))
          }),
      })
    })
  })

export default Plugin.define({ id: "youcom-search", effect })
