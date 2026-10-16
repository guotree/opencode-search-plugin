import { Plugin } from "@opencode/plugin/effect"
import { Effect, Schema, Stream } from "effect"

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

// Web and news live in separate sections; an agent asking "what's new" wants
// both, so they merge into one list with web first.
function toResult(item: YouHit) {
  const published = item.page_age ? Date.parse(item.page_age) : NaN
  const extracted =
    item.contents?.highlights?.join("\n") ??
    item.contents?.markdown ??
    item.snippets?.join(" ") ??
    item.description ??
    ""
  return {
    url: item.url ?? "",
    title: item.title || item.url || "",
    content: extracted,
    time: Number.isFinite(published) ? { published } : {},
  }
}

type SearchResult = ReturnType<typeof toResult>

function envInt(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

function envStr(name: string): string {
  return (process.env[name] ?? "").trim()
}

// You.com is pay-as-you-go and has no anonymous tier: $5 per 1k searches, up
// to 100 results per call. A repeat query is a fresh billed dispatch, so
// responses are cached per normalized query. Knobs are read once at load time,
// restart after changing them.
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
//   YDC_API_KEY          required; You.com's canonical env var, shared with its SDKs
const CACHE_TTL = envInt("YOUCOM_CACHE_TTL", 600_000)
const SEARCH_SIZE = Math.min(Math.max(envInt("YOUCOM_COUNT", 10), 1), 100)
const EXTRACTION = ["none", "highlights", "full_page"].includes(envStr("YOUCOM_EXTRACTION"))
  ? envStr("YOUCOM_EXTRACTION")
  : "highlights"
const LANGUAGE = envStr("YOUCOM_LANGUAGE")
const COUNTRY = envStr("YOUCOM_COUNTRY")
const FRESHNESS = envStr("YOUCOM_FRESHNESS")

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

export default Plugin.define({
  id: "youcom-search",
  effect: (ctx) =>
    Effect.gen(function* () {
      // Make "You.com" show up in /connect with an API-key method.
      yield* ctx.integration.transform((editor) => {
        editor.update("youcom", (integration) => {
          integration.name = "You.com"
        })
        editor.method.update({
          integrationID: "youcom",
          method: { type: "key", label: "You.com API key" },
        })
        editor.method.update({
          integrationID: "youcom",
          method: { type: "env", names: ["YDC_API_KEY"] },
        })
      })

      // The key comes from the /connect credential, falling back to the
      // environment. Resolved per call so a rotated key needs no restart.
      const resolveKey = () =>
        Effect.gen(function* () {
          const connection = yield* ctx.integration.connection.active("youcom")
          const credential = connection
            ? yield* ctx.integration.connection.resolve(connection)
            : undefined
          return credential?.type === "key" ? credential.key : process.env.YDC_API_KEY
        })

      // You.com is bound to websearch only while a key exists. Deleting the key
      // unbinds the provider, so `random` can never pick a keyless You.com.
      // The transform replays on reload and reads `bound` as it stands then.
      let bound = Boolean(yield* resolveKey())

      yield* ctx.websearch.transform((editor) => {
        if (!bound) return
        editor.add({
          id: "youcom",
          name: "You.com",
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
                  new Error("Connect You.com in /connect, or set YDC_API_KEY"),
                )
              }

              const extraction =
                EXTRACTION === "highlights"
                  ? { extraction_mode: "highlights" }
                  : EXTRACTION === "full_page"
                    ? {
                        extraction_mode: "full_page",
                        full_page: { extraction_formats: ["markdown"] },
                      }
                    : undefined

              const response = yield* Effect.tryPromise({
                try: () =>
                  fetch("https://ydc-index.io/v1/search", {
                    method: "POST",
                    headers: {
                      Accept: "application/json",
                      "Content-Type": "application/json",
                      "X-API-Key": key,
                    },
                    body: JSON.stringify({
                      query: queryKey,
                      count: SEARCH_SIZE,
                      ...(LANGUAGE ? { language: LANGUAGE } : {}),
                      ...(COUNTRY ? { country: COUNTRY } : {}),
                      ...(FRESHNESS ? { freshness: FRESHNESS } : {}),
                      ...(extraction ? { extraction } : {}),
                    }),
                  }),
                catch: (error) => new Error("You.com request failed: " + String(error)),
              })

              if (!response.ok) {
                const detail = yield* Effect.tryPromise({
                  try: () => response.text(),
                  catch: () => new Error("response body unavailable"),
                })
                return yield* Effect.fail(
                  new Error("You.com API error " + response.status + ": " + detail),
                )
              }

              const json = yield* Effect.tryPromise({
                try: () => response.json(),
                catch: (error) => new Error("Invalid You.com response: " + String(error)),
              })

              const body = yield* Schema.decodeUnknownEffect(YouResponse)(json)
              const hits = [...(body.results?.web ?? []), ...(body.results?.news ?? [])]
              const results = hits.flatMap((item) => (item.url ? [toResult(item)] : []))

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
            Effect.gen(function* () {
              const next = Boolean(yield* resolveKey())
              if (next === bound) return
              bound = next
              yield* ctx.websearch.reload()
            }),
          ),
          Stream.runDrain,
        ),
      )
    }),
})
