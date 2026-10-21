import { Plugin } from "@opencode/plugin/effect"
import { Effect, Schema } from "effect"

// AnySearch wraps every response in an envelope: code 0 / "success" on the happy
// path, code -1 with a human-readable message otherwise. request_id is the only
// handle support has on a request, so it rides along on every failure. Result
// fields are optional -- a missing one means "the source provided none", not an
// error.
const AnySearchResponse = Schema.Struct({
  code: Schema.Number,
  message: Schema.optional(Schema.String),
  request_id: Schema.optional(Schema.String),
  data: Schema.optional(
    Schema.Struct({
      results: Schema.optional(
        Schema.Array(
          Schema.Struct({
            title: Schema.optional(Schema.String),
            url: Schema.String,
            snippet: Schema.optional(Schema.String),
            content: Schema.optional(Schema.String),
          }),
        ),
      ),
    }),
  ),
})

// The /connect integration ID, and the websearch provider ID it binds to.
// The `osp-` prefix is this package's namespace: OpenCode's built-ins and a
// vendor plugin's own entry are bare vendor names, so `anysearch` would collide
// with them, and with the opencode.db row keyed by integration ID.
const ID = "osp-anysearch"

// AnySearch returns no publication date, so results carry an empty time record.
function toResult(item: {
  title?: string | undefined
  url: string
  snippet?: string | undefined
  content?: string | undefined
}) {
  return {
    url: item.url,
    title: item.title || item.url,
    content: item.content ?? item.snippet ?? "",
    time: {},
  }
}

type SearchResult = ReturnType<typeof toResult>

function envInt(name: string, fallback: number): number {
  const raw = (process.env[name] ?? "").trim()
  if (raw === "") return fallback
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

function envStr(name: string): string {
  return (process.env[name] ?? "").trim()
}

// AnySearch is callable without a key: anonymous traffic is rate-limited per IP
// against the daily free quota, and a key raises the quota. Each query is a
// fresh upstream dispatch that routes intent on its own, so responses are
// cached per normalized query. Knobs are read once at load time, restart after
// changing them.
//
//   ANYSEARCH_CACHE_TTL     ms to reuse a response for the same query (0 disables)
//   ANYSEARCH_MAX_RESULTS   results per search, clamped to 1-10 (the API's range)
//   ANYSEARCH_TAG           pin the intent router to a sub-domain, e.g. "code.doc";
//                           leave unset and AnySearch routes on the query itself
//   ANYSEARCH_ZONE          "cn" or "intl"
//   ANYSEARCH_LANGUAGE      preferred result language, e.g. "zh-CN"
//   ANYSEARCH_FORMAT        "markdown" (default) or "json" for the content field
//   ANYSEARCH_TIMEOUT       ms to wait before failing (0 removes the deadline)
//   OSP_ANYSEARCH_API_KEY       optional; anonymous access works without it
const CACHE_TTL = envInt("ANYSEARCH_CACHE_TTL", 600_000)
// OpenCode's own providers each bounded themselves at 25s, and the host adds
// no deadline of its own around `execute`, so this is the only one that exists.
const SEARCH_TIMEOUT = envInt("ANYSEARCH_TIMEOUT", 25_000)
const SEARCH_SIZE = Math.min(Math.max(envInt("ANYSEARCH_MAX_RESULTS", 10), 1), 10)
const TAG = envStr("ANYSEARCH_TAG")
const ZONE_VALUES = ["cn", "intl"]
const ZONE_RAW = envStr("ANYSEARCH_ZONE")
const ZONE = ZONE_VALUES.includes(ZONE_RAW) ? ZONE_RAW : ""
if (ZONE_RAW !== "" && ZONE === "") {
  // The zone is a closed set; without this guard a typo would ride along on
  // every search instead of costing only the zone knob.
  console.warn(
    "[opencode-search-plugin] ANYSEARCH_ZONE " +
      JSON.stringify(ZONE_RAW) +
      " is not one of " +
      ZONE_VALUES.join(", ") +
      "; searching every zone instead",
  )
}
const LANGUAGE = envStr("ANYSEARCH_LANGUAGE")
const FORMAT_VALUES = ["markdown", "json"]
const FORMAT_RAW = envStr("ANYSEARCH_FORMAT")
const FORMAT = FORMAT_RAW === "json" ? "json" : "markdown"
if (FORMAT_RAW !== "" && !FORMAT_VALUES.includes(FORMAT_RAW)) {
  // An unknown value is reported rather than dropped silently: a typo in a
  // knob should cost that knob, and the user should hear about it.
  console.warn(
    "[opencode-search-plugin] ANYSEARCH_FORMAT " +
      JSON.stringify(FORMAT_RAW) +
      " is not one of " +
      FORMAT_VALUES.join(", ") +
      "; returning markdown instead",
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

// Unlike the other providers in this repo, AnySearch never gates on `bound`:
// anonymous access is a first-class mode, so the provider is always in the
// pool. The key is still read per call, which is why no credential-event
// subscription is needed -- a rotated key takes effect on the next search
// without a reload.
export const effect = (ctx: Plugin.Context) =>
  Effect.gen(function* () {
    // Make "AnySearch" show up in /connect with an API-key method.
    yield* ctx.integration.transform((editor) => {
      editor.update(ID, (integration) => {
        integration.name = "AnySearch (osp)"
      })
      editor.method.update({
        integrationID: ID,
        method: { type: "key", label: "AnySearch API key" },
      })
      editor.method.update({
        integrationID: ID,
        method: { type: "env", names: ["OSP_ANYSEARCH_API_KEY"] },
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
        name: "AnySearch",
        execute: ({ query }) =>
          Effect.gen(function* () {
            const queryKey = cacheKey(query)
            const cached = readCache(queryKey)
            if (cached) return cached

            // Anonymous access is a first-class mode, so a missing key is not
            // an error: it just means no Authorization header goes out.
            const connection = yield* soften(ctx.integration.connection.active(ID))
            const credential = connection
              ? yield* soften(ctx.integration.connection.resolve(connection))
              : undefined
            const key =
              credential?.type === "key" ? credential.key : process.env.OSP_ANYSEARCH_API_KEY

            const headers: Record<string, string> = {
              Accept: "application/json",
              "Content-Type": "application/json",
            }
            if (key) headers.Authorization = "Bearer " + key

            const response = yield* Effect.tryPromise({
              try: (signal) =>
                fetch("https://api.anysearch.com/v1/search", {
                  method: "POST",
                  headers,
                  body: JSON.stringify({
                    query: queryKey,
                    max_results: SEARCH_SIZE,
                    ...(TAG ? { tag: TAG } : {}),
                    ...(ZONE ? { zone: ZONE } : {}),
                    ...(LANGUAGE ? { language: LANGUAGE } : {}),
                    format: FORMAT,
                  }),
                  signal: timedSignal(signal, SEARCH_TIMEOUT),
                }),
              // A timeout is its own failure: naming it stops the user hunting
              // for a key problem that was never there.
              catch: (error) =>
                error instanceof Error && error.name === "TimeoutError"
                  ? new Error("AnySearch search timed out after " + SEARCH_TIMEOUT + "ms")
                  : new Error("AnySearch request failed: " + String(error)),
            })

            if (!response.ok) {
              // A 402 body can hand back freshly generated credentials, so it
              // is deliberately never echoed into the conversation.
              if (response.status === 402) {
                return yield* Effect.fail(
                  new Error(
                    "AnySearch quota exhausted (HTTP 402). Set OSP_ANYSEARCH_API_KEY " +
                      "or connect AnySearch in /connect to continue. The response " +
                      "body is withheld because it may contain credentials.",
                  ),
                )
              }
              const detail = yield* Effect.tryPromise({
                try: () => response.text(),
                catch: () => new Error("response body unavailable"),
              })
              return yield* Effect.fail(
                new Error("AnySearch API error " + response.status + ": " + detail),
              )
            }

            const json = yield* Effect.tryPromise({
              try: () => response.json(),
              catch: (error) => new Error("Invalid AnySearch response: " + String(error)),
            })

            const body = yield* Schema.decodeUnknownEffect(AnySearchResponse)(json)

            // AnySearch reports failures in the envelope too, even on HTTP
            // 200. request_id is what support needs to trace the request.
            if (body.code !== 0) {
              return yield* Effect.fail(
                new Error(
                  "AnySearch API error " +
                    body.code +
                    ": " +
                    (body.message ?? "unknown error") +
                    " (request_id " +
                    (body.request_id ?? "unknown") +
                    ")",
                ),
              )
            }

            const results = (body.data?.results ?? []).map(toResult)
            writeCache(queryKey, results)
            return results
          }),
      })
    })
  })

export default Plugin.define({ id: "anysearch-search", effect })
