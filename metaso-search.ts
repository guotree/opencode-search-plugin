import { Plugin } from "@opencode/plugin/effect"
import { Effect, Schema, Stream } from "effect"

const MetasoResponse = Schema.Struct({
  webpages: Schema.optional(
    Schema.Array(
      Schema.Struct({
        title: Schema.String,
        link: Schema.String,
        snippet: Schema.optional(Schema.String),
        date: Schema.optional(Schema.String),
        rawContent: Schema.optional(Schema.String),
      }),
    ),
  ),
})

function toResult(item: {
  title: string
  link: string
  snippet?: string
  date?: string
  rawContent?: string
}) {
  const published = item.date ? Date.parse(item.date) : NaN
  return {
    url: item.link,
    title: item.title,
    content: item.rawContent ?? item.snippet ?? "",
    time: Number.isFinite(published) ? { published } : {},
  }
}

type SearchResult = ReturnType<typeof toResult>

function envInt(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

// Metaso bills per search, not per result, which cuts two ways: a repeat query is
// a search you can avoid paying for, and a fuller page of results costs exactly the
// same as a thin one. Knobs are read once at load time, so restart after changing them.
//
//   METASO_CACHE_TTL            ms to reuse a response for the same query (0 disables)
//   METASO_SEARCH_SIZE          results per search, clamped to 1-100
//   METASO_INCLUDE_RAW_CONTENT  true returns the full source text of every hit: same
//                               search cost, far more context tokens. Only worth it
//                               when you would otherwise webfetch those hits anyway.
const CACHE_TTL = envInt("METASO_CACHE_TTL", 600_000)
const SEARCH_SIZE = Math.min(Math.max(envInt("METASO_SEARCH_SIZE", 20), 1), 100)
const INCLUDE_RAW_CONTENT = process.env.METASO_INCLUDE_RAW_CONTENT === "true"

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
  id: "metaso-search",
  effect: (ctx) =>
    Effect.gen(function* () {
      // Make "Metaso" show up in /connect with an API-key method.
      yield* ctx.integration.transform((editor) => {
        editor.update("metaso", (integration) => {
          integration.name = "Metaso Search"
        })
        editor.method.update({
          integrationID: "metaso",
          method: { type: "key", label: "Metaso API key" },
        })
        editor.method.update({
          integrationID: "metaso",
          method: { type: "env", names: ["METASO_API_KEY"] },
        })
      })

      // The key comes from the /connect credential, falling back to the
      // environment. Resolved per call so a rotated key needs no restart.
      const resolveKey = () =>
        Effect.gen(function* () {
          const connection = yield* ctx.integration.connection.active("metaso")
          const credential = connection
            ? yield* ctx.integration.connection.resolve(connection)
            : undefined
          return credential?.type === "key" ? credential.key : process.env.METASO_API_KEY
        })

      // Metaso is bound to websearch only while a key exists. Deleting the key
      // unbinds the provider, so `random` can never pick a keyless Metaso.
      // The transform replays on reload and reads `bound` as it stands then.
      let bound = Boolean(yield* resolveKey())

      yield* ctx.websearch.transform((editor) => {
        if (!bound) return
        editor.add({
          id: "metaso",
          name: "Metaso Search",
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
                  new Error("Connect Metaso in /connect, or set METASO_API_KEY"),
                )
              }

              const response = yield* Effect.tryPromise({
                try: () =>
                  fetch("https://metaso.cn/api/v1/search", {
                    method: "POST",
                    headers: {
                      Accept: "application/json",
                      "Content-Type": "application/json",
                      Authorization: "Bearer " + key,
                    },
                    body: JSON.stringify({
                      q: queryKey,
                      scope: "webpage",
                      size: SEARCH_SIZE,
                      includeSummary: false,
                      includeRawContent: INCLUDE_RAW_CONTENT,
                      conciseSnippet: true,
                    }),
                  }),
                catch: (error) => new Error("Metaso request failed: " + String(error)),
              })

              if (!response.ok) {
                const detail = yield* Effect.tryPromise({
                  try: () => response.text(),
                  catch: () => new Error("response body unavailable"),
                })
                return yield* Effect.fail(
                  new Error("Metaso API error " + response.status + ": " + detail),
                )
              }

              const json = yield* Effect.tryPromise({
                try: () => response.json(),
                catch: (error) => new Error("Invalid Metaso response: " + String(error)),
              })

              const body = yield* Schema.decodeUnknownEffect(MetasoResponse)(json)
              const results = (body.webpages ?? []).map(toResult)

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
