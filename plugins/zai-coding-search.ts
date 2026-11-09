import { Plugin } from "@opencode/plugin/effect"
import { Effect, Stream } from "effect"
import { HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http"

// Z.ai's Coding Plan exposes a Remote MCP search tool (`web_search_prime`)
// separate from the metered REST endpoint used by `osp-zai`. The two access
// paths use different credentials: a Coding Plan key is not a Standard API key,
// and a Standard key answers 401 here. The plan's search MCP has no documented
// REST equivalent, so this provider never falls back to the metered endpoint.
//
// The MCP transport is Streamable HTTP. A result-cache miss performs one
// session: initialize, notifications/initialized, tools/list, tools/call, then
// a best-effort DELETE. The whole lifecycle shares one timeout budget; cleanup
// has its own short budget so it cannot hide the search result. Requests reject
// redirects, carry the key only in the Authorization header, and do not read
// HTTP refusal bodies, so reflected keys or session IDs cannot reach errors.
//
// The official pages describe use by compatible MCP clients but do not list
// this plugin as a supported client. Treat this provider as experimental until
// that policy question is resolved.
const ID = "osp-zai-coding"

function envInt(name: string, fallback: number): number {
  const raw = (process.env[name] ?? "").trim()
  if (raw === "") return fallback
  const value = Number(raw)
  return Number.isInteger(value) && value >= 0 ? value : fallback
}

function envStr(name: string): string {
  return (process.env[name] ?? "").trim()
}

// Z.ai stamps `publish_date` as a bare calendar date ("2025-05-23"), a shape
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

function toResult(item: unknown) {
  if (!isRecord(item)) return undefined
  const record = item
  // A non-null `link` wins even when it is unusable, matching the documented
  // `link ?? url` precedence. A hit with neither cannot be opened or cited.
  const rawURL = record.link !== undefined && record.link !== null ? record.link : record.url
  if (typeof rawURL !== "string" || rawURL.trim() === "") return undefined
  const url = rawURL.trim()
  const text =
    typeof record.content === "string"
      ? record.content
      : typeof record.snippet === "string"
        ? record.snippet
        : ""
  const published = parseSearchDate(
    typeof record.publish_date === "string" ? record.publish_date : undefined,
  )
  return {
    url,
    // `url` is the one field the mapping insists on, so it is also the one
    // thing a title can fall back to rather than leave the result untitled.
    title: typeof record.title === "string" && record.title.trim() ? record.title.trim() : url,
    content: trimContent(text),
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

// Coding Plan MCP calls consume the plan's shared credits (the documented
// coefficient at implementation time is 1.2 credits per call), so a repeat
// query is a billed dispatch worth skipping. Knobs are read once at load time,
// so restart after changing them.
//
//   ZAI_CODING_CACHE_TTL       ms to reuse a response for the same query (0 disables)
//   ZAI_CODING_COUNT           results per search, clamped to 1-50
//   ZAI_CODING_RECENCY         oneDay, oneWeek, oneMonth, oneYear, noLimit; unset
//                                omits the field
//   ZAI_CODING_DOMAIN_FILTER   one domain to include, when the server schema
//                                advertises search_domain_filter
//   ZAI_CODING_CONTENT_SIZE    medium or high, when the server schema
//                                advertises content_size
//   ZAI_CODING_CONTENT_CHARS   code points kept from each hit's content
//                                (0 keeps all)
//   ZAI_CODING_TIMEOUT         ms covering initialize through tools/call;
//                                cleanup has a separate one-second budget
//   OSP_ZAI_CODING_API_KEY     required; a Coding Plan key from
//                                https://z.ai/manage-apikey/apikey-list
const CACHE_TTL = envInt("ZAI_CODING_CACHE_TTL", 600_000)
// OpenCode's own providers each bounded themselves at 25s, and the host adds
// no deadline of its own around `execute`, so this is the only one that exists.
// Unlike a single REST request, one search can take four round trips, so this
// is a budget for the whole MCP lifecycle rather than per request.
const SEARCH_TIMEOUT = envInt("ZAI_CODING_TIMEOUT", 25_000)
// The MCP page does not publish a result ceiling. The sibling REST search
// accepts at most 50, so the local knob is clamped to the same range rather
// than forwarding an unbounded value.
const COUNT = Math.min(Math.max(envInt("ZAI_CODING_COUNT", 10), 1), 50)
const RECENCY_VALUES = ["oneDay", "oneWeek", "oneMonth", "oneYear", "noLimit"]
const RECENCY_RAW = envStr("ZAI_CODING_RECENCY")
const RECENCY = RECENCY_VALUES.includes(RECENCY_RAW) ? RECENCY_RAW : ""
if (RECENCY_RAW !== "" && RECENCY === "") {
  // A recency value is a closed set; a typo must not be forwarded to earn a
  // server-side schema or validation error on every search.
  console.warn(
    "[opencode-search-plugin] ZAI_CODING_RECENCY " +
      JSON.stringify(RECENCY_RAW) +
      " is not one of " +
      RECENCY_VALUES.join(", ") +
      "; searching every recency range instead",
  )
}
const DOMAIN_FILTER = envStr("ZAI_CODING_DOMAIN_FILTER")
const CONTENT_SIZE_VALUES = ["medium", "high"]
const CONTENT_SIZE_RAW = envStr("ZAI_CODING_CONTENT_SIZE")
const CONTENT_SIZE = CONTENT_SIZE_VALUES.includes(CONTENT_SIZE_RAW) ? CONTENT_SIZE_RAW : ""
if (CONTENT_SIZE_RAW !== "" && CONTENT_SIZE === "") {
  // The excerpt size is a closed set; report a typo instead of silently
  // dropping a setting the user believed was active.
  console.warn(
    "[opencode-search-plugin] ZAI_CODING_CONTENT_SIZE " +
      JSON.stringify(CONTENT_SIZE_RAW) +
      " is not one of " +
      CONTENT_SIZE_VALUES.join(", ") +
      "; omitting content_size instead",
  )
}
const CONTENT_CHARS = envInt("ZAI_CODING_CONTENT_CHARS", 4_000)

const ENDPOINT = "https://api.z.ai/api/mcp/web_search_prime/mcp"
const ENV_KEY = "OSP_ZAI_CODING_API_KEY"
const LABEL = "Z.ai Coding Plan"
const SITE_HINT =
  "A key issued on open.bigmodel.cn belongs to Zhipu Coding Plan (osp-zhipu-coding) instead"

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

function trimContent(text: string): string {
  if (CONTENT_CHARS <= 0 || text.length <= CONTENT_CHARS) return text
  const points = [...text]
  if (points.length <= CONTENT_CHARS) return text
  return points.slice(0, CONTENT_CHARS).join("") + "…"
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

// === BEGIN SHARED MCP SESSION CLIENT ===
// Streamable HTTP MCP client: JSON-RPC framing, JSON/SSE decoding, one
// initialized session per search, and schema-driven argument construction.
// This block is copied byte-for-byte into every Coding Plan provider; change it
// in both files and update `test/structure.test.ts`.
const MCP_PROTOCOL_VERSIONS = new Set([
  "2024-11-05",
  "2025-03-26",
  "2025-06-18",
  "2025-11-25",
])
const MCP_PROTOCOL_VERSION = "2025-11-25"
const MCP_MAX_BYTES = 10 * 1024 * 1024
// The MCP initialize request requires a client name and version. This value is
// informational and not used for capability negotiation; keeping it fixed
// avoids coupling a copied provider file to package.json at runtime.
const MCP_CLIENT_INFO = { name: "opencode-search-plugin", version: "1" }
const MCP_TOOL_NAMES = ["web_search_prime", "webSearchPrime"]

type JSONRecord = Record<string, unknown>

const isRecord = (value: unknown): value is JSONRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value)

// A short, stable fingerprint keeps raw credentials out of cache keys. Two
// independent 32-bit hashes make an accidental cross-key hit far less likely
// than one hash while staying synchronous and dependency-free.
function fingerprint(value: string): string {
  let first = 0x811c9dc5
  let second = 5381
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    first = Math.imul(first ^ code, 0x01000193)
    second = Math.imul(second, 33) ^ code
  }
  return (first >>> 0).toString(16) + (second >>> 0).toString(16)
}

function mcpFailure(error: unknown, signal: AbortSignal, label: string, timeout: number): Error {
  if (HttpClientError.isHttpClientError(error)) return error
  const reason = signal.aborted ? signal.reason : undefined
  if (
    (error instanceof Error && error.name === "TimeoutError") ||
    (reason as { name?: string } | undefined)?.name === "TimeoutError"
  ) {
    return new Error(label + " search timed out after " + timeout + "ms")
  }
  return error instanceof Error ? error : new Error(label + " request failed: " + String(error))
}

function redactMCPError(error: Error, secrets: ReadonlyArray<string | undefined>): Error {
  if (HttpClientError.isHttpClientError(error)) return error
  let message = error.message
  for (const secret of secrets) {
    if (secret) message = message.replaceAll(secret, "[redacted]")
  }
  // A fresh Error avoids mutating a host/DOM exception whose message may be
  // read-only, and keeps the bounded message as the only copy.
  const safe = new Error(boundDetail(message))
  safe.name = error.name
  return safe
}

async function httpRefusal(
  response: Response,
  endpoint: string,
  label: string,
  envKey: string,
  siteHint: string,
): Promise<Error> {
  // A refusal body is diagnostic only: it can echo the Authorization header or
  // a session identifier, so it is consumed for the socket's benefit and never
  // included in the error. A 429 is the exception: skipping its body keeps the
  // typed throttle intact even when the body is damaged or stalled.
  if (response.status === 429) {
    void response.body?.cancel().catch(() => {})
    const retry = response.headers.get("Retry-After")
    return rateLimitError(
      response,
      endpoint,
      "POST",
      label +
        " rate limited the MCP request (HTTP 429)" +
        retryHint(retry) +
        ". Coding Plan calls share plan credits; retry shortly or run fewer searches at once",
    )
  }
  // Consume the body under the caller's signal: a stalled refusal must hit the
  // same deadline as a stalled success, not hang the adapter.
  await response.text()
  if (response.status === 401) {
    return new Error(
      label +
        " rejected the Coding Plan key (HTTP 401). Connect " +
        label +
        " in /connect or set " +
        envKey +
        ". " +
        siteHint,
    )
  }
  if (response.status === 403) {
    return new Error(
      label +
        " refused the request (HTTP 403). Check that the key belongs to an active Coding Plan and that this client is allowed by the plan's usage policy",
    )
  }
  return new Error(label + " MCP API error " + response.status)
}

async function readMCPResult(
  response: Response,
  signal: AbortSignal,
  id: number,
  label: string,
): Promise<JSONRecord> {
  if (!response.body) throw new Error("Invalid " + label + " MCP response: missing body")
  const sse = (response.headers.get("Content-Type") ?? "").toLowerCase().includes("text/event-stream")
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let data: string[] = []
  let skipLF = false
  let receivedBytes = 0
  const parse = (raw: string): JSONRecord | undefined => {
    let message: unknown
    try {
      message = JSON.parse(raw)
    } catch {
      throw new Error("Invalid " + label + " MCP response: malformed JSON")
    }
    if (!isRecord(message) || message.id !== id) return undefined
    if (message.jsonrpc !== "2.0") {
      throw new Error("Invalid " + label + " MCP response: expected JSON-RPC 2.0")
    }
    if (message.error !== undefined) {
      const detail = isRecord(message.error) ? message.error.message : undefined
      throw new Error(
        label + " MCP error: " + boundDetail(typeof detail === "string" ? detail : "unknown error"),
      )
    }
    if (!isRecord(message.result)) throw new Error("Invalid " + label + " MCP response: missing result")
    return message.result
  }
  const dispatch = (): JSONRecord | undefined => {
    const raw = data.join("\n")
    data = []
    return raw && raw !== "[DONE]" ? parse(raw) : undefined
  }
  const line = (value: string): JSONRecord | undefined => {
    if (value === "") return dispatch()
    if (value.startsWith("data:")) data.push(value.slice(5).replace(/^ /, ""))
    return undefined
  }
  const cancel = () => {
    void reader.cancel().catch(() => {})
  }
  signal.addEventListener("abort", cancel, { once: true })
  try {
    while (true) {
      signal.throwIfAborted()
      const { value, done } = await reader.read()
      signal.throwIfAborted()
      receivedBytes += value?.byteLength ?? 0
      if (receivedBytes > MCP_MAX_BYTES) {
        throw new Error(
          "Invalid " + label + " MCP payload: exceeds " + MCP_MAX_BYTES + "-byte limit",
        )
      }
      buffer += decoder.decode(value, { stream: !done })
      if (sse) {
        if (skipLF && buffer.length > 0) {
          if (buffer.startsWith("\n")) buffer = buffer.slice(1)
          skipLF = false
        }
        let end
        while ((end = /[\r\n]/.exec(buffer))) {
          skipLF = end[0] === "\r" && end.index === buffer.length - 1
          const width = buffer.slice(end.index, end.index + 2) === "\r\n" ? 2 : 1
          const result = line(buffer.slice(0, end.index))
          buffer = buffer.slice(end.index + width)
          if (result !== undefined) return result
        }
      }
      if (done) break
    }
    if (!sse) {
      const result = parse(buffer)
      if (result !== undefined) return result
    }
    throw new Error("Invalid " + label + " MCP response: no matching response before stream ended")
  } finally {
    signal.removeEventListener("abort", cancel)
    cancel()
    reader.releaseLock()
  }
}

function buildMCPArguments(
  schema: unknown,
  query: string,
  limit: number,
  recency: string,
  domainFilter: string,
  contentSize: string,
  label: string,
): JSONRecord {
  const properties =
    isRecord(schema) && isRecord(schema.properties) ? schema.properties : {}
  const args: JSONRecord = { search_query: query }
  if (Object.hasOwn(properties, "count")) args.count = limit
  const optional: ReadonlyArray<readonly [string, string, string]> = [
    ["search_recency_filter", recency === "noLimit" ? "" : recency, "RECENCY"],
    ["search_domain_filter", domainFilter, "DOMAIN_FILTER"],
    ["content_size", contentSize, "CONTENT_SIZE"],
  ]
  for (const [wire, value, knob] of optional) {
    if (!value) continue
    if (!Object.hasOwn(properties, wire)) {
      throw new Error(
        label +
          " cannot send " +
          knob +
          ": the MCP server's current input schema does not advertise " +
          wire,
      )
    }
    args[wire] = value
  }
  return args
}

function extractMCPPages(result: JSONRecord, label: string, limit: number): SearchResult[] {
  const extract = (value: unknown, depth: number): unknown[] | undefined => {
    let decoded = value
    for (let index = 0; index < depth && typeof decoded === "string"; index += 1) {
      if (Buffer.byteLength(decoded, "utf8") > MCP_MAX_BYTES) {
        throw new Error(
          "Invalid " + label + " MCP payload: exceeds " + MCP_MAX_BYTES + "-byte limit",
        )
      }
      try {
        decoded = JSON.parse(decoded)
      } catch {
        return undefined
      }
    }
    if (Array.isArray(decoded)) return decoded
    if (!isRecord(decoded)) return undefined
    for (const key of ["results", "search_result"]) {
      if (Array.isArray(decoded[key])) return decoded[key] as unknown[]
    }
    return undefined
  }

  const structured = extract(result.structuredContent, 3)
  let upstream = structured
  if (upstream === undefined) {
    for (const part of Array.isArray(result.content) ? result.content : []) {
      if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") continue
      upstream = extract(part.text, 3)
      if (upstream !== undefined) break
    }
  }
  if (upstream === undefined) {
    throw new Error("Invalid " + label + " MCP search result: expected results array")
  }

  const pages = upstream
    .map((item) => toResult(item))
    .filter((page): page is SearchResult => page !== undefined)
  if (upstream.length > 0 && pages.length === 0) {
    throw new Error("Invalid " + label + " MCP search result: no usable search results in payload")
  }
  return pages.slice(0, limit)
}

interface MCPSessionRequest {
  readonly endpoint: string
  readonly apiKey: string
  readonly query: string
  readonly limit: number
  readonly recency: string
  readonly domainFilter: string
  readonly contentSize: string
  readonly label: string
  readonly envKey: string
  readonly siteHint: string
  readonly timeout: number
  readonly signal: AbortSignal
}

async function runMCPSession(request: MCPSessionRequest): Promise<SearchResult[]> {
  const {
    endpoint,
    apiKey,
    query,
    limit,
    recency,
    domainFilter,
    contentSize,
    label,
    envKey,
    siteHint,
    timeout,
    signal,
  } = request
  let sessionID: string | undefined
  let protocolVersion: string | undefined
  let requestID = 0

  const headers = (): Record<string, string> => ({
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
    Authorization: "Bearer " + apiKey,
    ...(sessionID ? { "Mcp-Session-Id": sessionID } : {}),
    ...(protocolVersion ? { "MCP-Protocol-Version": protocolVersion } : {}),
  })
  const post = async (body: unknown): Promise<Response> => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(body),
      redirect: "error",
      signal,
    })
    if (!response.ok) throw await httpRefusal(response, endpoint, label, envKey, siteHint)
    return response
  }

  try {
    const initializeID = ++requestID
    const initializeResponse = await post({
      jsonrpc: "2.0",
      id: initializeID,
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: MCP_CLIENT_INFO,
      },
    })
    const initialized = await readMCPResult(initializeResponse, signal, initializeID, label)
    const receivedSessionID = initializeResponse.headers.get("Mcp-Session-Id")?.trim()
    if (!receivedSessionID) {
      throw new Error("Invalid " + label + " MCP response: missing session ID")
    }
    sessionID = receivedSessionID
    const receivedVersion = initialized.protocolVersion
    if (typeof receivedVersion !== "string" || !MCP_PROTOCOL_VERSIONS.has(receivedVersion)) {
      throw new Error("Invalid " + label + " MCP response: unsupported protocol version")
    }
    protocolVersion = receivedVersion

    const notification = await fetch(endpoint, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      redirect: "error",
      signal,
    })
    if (!notification.ok) {
      throw await httpRefusal(notification, endpoint, label, envKey, siteHint)
    }
    void notification.body?.cancel().catch(() => {})

    const listID = ++requestID
    const listed = await readMCPResult(
      await post({ jsonrpc: "2.0", id: listID, method: "tools/list", params: {} }),
      signal,
      listID,
      label,
    )
    if (!Array.isArray(listed.tools)) {
      throw new Error("Invalid " + label + " MCP response: tools must be an array")
    }
    const tools = listed.tools.filter(isRecord)
    let tool: JSONRecord | undefined
    for (const name of MCP_TOOL_NAMES) {
      tool = tools.find((entry) => entry.name === name)
      if (tool) break
    }
    if (!tool || typeof tool.name !== "string") {
      const available = tools
        .map((entry) => (typeof entry.name === "string" ? entry.name : ""))
        .filter(Boolean)
        .slice(0, 8)
        .join(", ")
      throw new Error(
        label +
          " MCP server did not publish a supported Web Search tool" +
          (available ? " (available: " + available + ")" : ""),
      )
    }
    const args = buildMCPArguments(
      tool.inputSchema,
      query,
      limit,
      recency,
      domainFilter,
      contentSize,
      label,
    )

    const callID = ++requestID
    const result = await readMCPResult(
      await post({
        jsonrpc: "2.0",
        id: callID,
        method: "tools/call",
        params: { name: tool.name, arguments: args },
      }),
      signal,
      callID,
      label,
    )
    if (result.isError === true) throw new Error(label + " MCP search tool failed")
    return extractMCPPages(result, label, limit)
  } catch (error) {
    throw redactMCPError(mcpFailure(error, signal, label, timeout), [
      apiKey,
      "Bearer " + apiKey,
      sessionID,
    ])
  } finally {
    if (sessionID) {
      // Cleanup uses its own budget and must not hide the search result or
      // failure. It also must not inherit a host signal that is already
      // aborted, or a cancelled search would leave the session open.
      try {
        const cleanup = await fetch(endpoint, {
          method: "DELETE",
          headers: headers(),
          redirect: "error",
          signal: AbortSignal.timeout(1_000),
        })
        void cleanup.body?.cancel().catch(() => {})
      } catch {
        // A session that cannot be deleted expires server-side.
      }
    }
  }
}
// === END SHARED MCP SESSION CLIENT ===

// The cache identity includes the key fingerprint and every knob that changes
// the request, so rotating a key or changing a filter cannot serve another
// configuration's result. The raw key never becomes a Map key.
function searchIdentity(queryKey: string, key: string): string {
  return [
    queryKey,
    COUNT,
    RECENCY,
    DOMAIN_FILTER,
    CONTENT_SIZE,
    CONTENT_CHARS,
    fingerprint(key),
  ].join("\u0000")
}

export const effect = (ctx: Plugin.Context) =>
  Effect.gen(function* () {
    // Make "Z.ai Coding Plan" show up in /connect with an API-key method.
    yield* ctx.integration.transform((editor) => {
      editor.update(ID, (integration) => {
        integration.name = "Z.ai Coding Plan (osp)"
      })
      editor.method.update({
        integrationID: ID,
        method: { type: "key", label: "Z.ai Coding Plan key" },
      })
      editor.method.update({
        integrationID: ID,
        method: { type: "env", names: [ENV_KEY] },
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
        return credential?.type === "key" ? credential.key : process.env.OSP_ZAI_CODING_API_KEY
      })

    // The Coding Plan has no anonymous tier, so the provider binds only while a
    // key exists. Deleting the key unbinds it, and `random` can never pick a
    // keyless Coding Plan. The transform replays on reload and reads `bound` as
    // it stands then.
    let bound = Boolean((yield* resolveKey())?.trim())

    yield* ctx.websearch.transform((editor) => {
      if (!bound) return
      editor.add({
        id: ID,
        name: LABEL,
        execute: ({ query }) =>
          Effect.gen(function* () {
            // Resolved before the cache: the key is part of the cache identity,
            // so a rotated key must not be served the previous key's results.
            const key = (yield* resolveKey())?.trim()
            if (!key) {
              return yield* Effect.fail(
                new Error("Connect " + LABEL + " in /connect, or set " + ENV_KEY),
              )
            }
            const queryKey = cacheKey(query)
            if (queryKey === "") {
              return yield* Effect.fail(new Error(LABEL + " query must not be empty"))
            }
            const identity = searchIdentity(queryKey, key)
            const cached = readCache(identity)
            if (cached) return cached

            const results = yield* withRequestSignal(SEARCH_TIMEOUT, (signal) =>
              Effect.tryPromise({
                try: () =>
                  runMCPSession({
                    endpoint: ENDPOINT,
                    apiKey: key,
                    query: queryKey,
                    limit: COUNT,
                    recency: RECENCY,
                    domainFilter: DOMAIN_FILTER,
                    contentSize: CONTENT_SIZE,
                    label: LABEL,
                    envKey: ENV_KEY,
                    siteHint: SITE_HINT,
                    timeout: SEARCH_TIMEOUT,
                    signal,
                  }),
                catch: (error) =>
                  error instanceof Error ? error : new Error(LABEL + " request failed: " + String(error)),
              }),
            )

            // Coding Plan calls consume shared credits, so a result that never
            // enters the cache is a query paid for again on every repeat.
            writeCache(identity, results)
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

export default Plugin.define({ id: "zai-coding-search", effect })
