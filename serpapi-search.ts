import { Plugin } from "@opencode/plugin/effect"
import { Effect, Schema, Stream } from "effect"

const SerpApiResponse = Schema.Struct({
  organic_results: Schema.optional(
    Schema.Array(
      Schema.Struct({
        title: Schema.String,
        link: Schema.String,
        snippet: Schema.optional(Schema.String),
        date: Schema.optional(Schema.String),
      }),
    ),
  ),
})

export default Plugin.define({
  id: "serpapi-search",
  effect: (ctx) =>
    Effect.gen(function* () {
      // Make "SerpApi" show up in /connect with an API-key method.
      yield* ctx.integration.transform((editor) => {
        editor.update("serpapi", (integration) => {
          integration.name = "SerpApi"
        })
        editor.method.update({
          integrationID: "serpapi",
          method: { type: "key", label: "SerpApi API key" },
        })
        editor.method.update({
          integrationID: "serpapi",
          method: { type: "env", names: ["SERPAPI_API_KEY"] },
        })
      })

      // The key comes from the /connect credential, falling back to the
      // environment. Resolved per call so a rotated key needs no restart.
      const resolveKey = () =>
        Effect.gen(function* () {
          const connection = yield* ctx.integration.connection.active("serpapi")
          const credential = connection
            ? yield* ctx.integration.connection.resolve(connection)
            : undefined
          return credential?.type === "key" ? credential.key : process.env.SERPAPI_API_KEY
        })

      // SerpApi is bound to websearch only while a key exists. Deleting the key
      // unbinds the provider, so `random` can never pick a keyless SerpApi.
      // The transform replays on reload and reads `bound` as it stands then.
      let bound = Boolean(yield* resolveKey())

      yield* ctx.websearch.transform((editor) => {
        if (!bound) return
        editor.add({
          id: "serpapi",
          name: "SerpApi",
          execute: ({ query }) =>
            Effect.gen(function* () {
              // Rechecked per call: binding can lag a key deletion by the
              // event round-trip, so this keeps that window explicit.
              const key = yield* resolveKey()
              if (!key) {
                return yield* Effect.fail(
                  new Error("Connect SerpApi in /connect, or set SERPAPI_API_KEY"),
                )
              }

              const url = new URL("https://serpapi.com/search.json")
              url.searchParams.set("engine", "google")
              url.searchParams.set("q", query)
              url.searchParams.set("num", "8")
              url.searchParams.set("api_key", key)

              const response = yield* Effect.tryPromise({
                try: () =>
                  fetch(url, {
                    headers: {
                      Accept: "application/json",
                    },
                  }),
                catch: (error) => new Error("SerpApi request failed: " + String(error)),
              })

              if (!response.ok) {
                const detail = yield* Effect.tryPromise({
                  try: () => response.text(),
                  catch: () => new Error("response body unavailable"),
                })
                return yield* Effect.fail(
                  new Error("SerpApi API error " + response.status + ": " + detail),
                )
              }

              const json = yield* Effect.tryPromise({
                try: () => response.json(),
                catch: (error) => new Error("Invalid SerpApi response: " + String(error)),
              })

              const body = yield* Schema.decodeUnknownEffect(SerpApiResponse)(json)

              return (body.organic_results ?? []).map((result) => {
                const published = result.date ? Date.parse(result.date) : NaN
                return {
                  url: result.link,
                  title: result.title,
                  content: result.snippet ?? "",
                  time: Number.isFinite(published) ? { published } : {},
                }
              })
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
