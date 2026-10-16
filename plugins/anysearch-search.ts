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
const ID = "anysearch"

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
//   ANYSEARCH_API_KEY       optional; anonymous access works without it
const CACHE_TTL = envInt("ANYSEARCH_CACHE_TTL", 600_000)
const SEARCH_SIZE = Math.min(Math.max(envInt("ANYSEARCH_MAX_RESULTS", 10), 1), 10)
const TAG = envStr("ANYSEARCH_TAG")
const ZONE = envStr("ANYSEARCH_ZONE")
const LANGUAGE = envStr("ANYSEARCH_LANGUAGE")
const FORMAT = envStr("ANYSEARCH_FORMAT") === "json" ? "json" : "markdown"

const CACHE_LIMIT = 200
const cache = new Map<string, { at: number; results: SearchResult[] }>()

function cacheKey(query: string): string {
  return query.trim().replace(/\s+/g, " ")
}

function readCache(queryKey: string): SearchResult[] | undefined {
  if (CACHE_TTL <= 0) return undefined
  const hit = cache.get(queryKey)
  return hit && Date.now() - hit.at < CACHE_TTL ? hit.results : undefined
}

function writeCache(queryKey: string, results: SearchResult[]): void {
  if (CACHE_TTL <= 0) return
  cache.set(queryKey, { at: Date.now(), results })
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
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
        integration.name = "AnySearch"
      })
      editor.method.update({
        integrationID: ID,
        method: { type: "key", label: "AnySearch API key" },
      })
      editor.method.update({
        integrationID: ID,
        method: { type: "env", names: ["ANYSEARCH_API_KEY"] },
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
              credential?.type === "key" ? credential.key : process.env.ANYSEARCH_API_KEY

            const headers: Record<string, string> = {
              Accept: "application/json",
              "Content-Type": "application/json",
            }
            if (key) headers.Authorization = "Bearer " + key

            const response = yield* Effect.tryPromise({
              try: () =>
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
                }),
              catch: (error) => new Error("AnySearch request failed: " + String(error)),
            })

            if (!response.ok) {
              // A 402 body can hand back freshly generated credentials, so it
              // is deliberately never echoed into the conversation.
              if (response.status === 402) {
                return yield* Effect.fail(
                  new Error(
                    "AnySearch quota exhausted (HTTP 402). Set ANYSEARCH_API_KEY " +
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
