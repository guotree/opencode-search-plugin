import { Plugin } from "@opencode/plugin/effect"
import { Effect, Schema, Stream } from "effect"

const BraveResponse = Schema.Struct({
  web: Schema.optional(
    Schema.Struct({
      results: Schema.Array(
        Schema.Struct({
          title: Schema.String,
          url: Schema.String,
          description: Schema.optional(Schema.String),
          page_age: Schema.optional(Schema.String),
        }),
      ),
    }),
  ),
})

// The /connect integration ID, and the websearch provider ID it binds to.
const ID = "brave"

export default Plugin.define({
  id: "brave-search",
  effect: (ctx) =>
    Effect.gen(function* () {
      // Make "Brave Search" show up in /connect with an API-key method.
      yield* ctx.integration.transform((editor) => {
        editor.update(ID, (integration) => {
          integration.name = "Brave Search"
        })
        editor.method.update({
          integrationID: ID,
          method: { type: "key", label: "Brave Search API key" },
        })
        editor.method.update({
          integrationID: ID,
          method: { type: "env", names: ["BRAVE_SEARCH_API_KEY"] },
        })
      })

      // The key comes from the /connect credential, falling back to the
      // environment. Resolved per call so a rotated key needs no restart.
      const resolveKey = () =>
        Effect.gen(function* () {
          const connection = yield* ctx.integration.connection.active(ID)
          const credential = connection
            ? yield* ctx.integration.connection.resolve(connection)
            : undefined
          return credential?.type === "key" ? credential.key : process.env.BRAVE_SEARCH_API_KEY
        })

      // Brave is bound to websearch only while a key exists. Deleting the key
      // unbinds the provider, so `random` can never pick a keyless Brave.
      // The transform replays on reload and reads `bound` as it stands then.
      let bound = Boolean(yield* resolveKey())

      yield* ctx.websearch.transform((editor) => {
        if (!bound) return
        editor.add({
          id: ID,
          name: "Brave Search",
          execute: ({ query }) =>
            Effect.gen(function* () {
              // Rechecked per call: the binding can lag a key deletion by the
              // event round-trip, and this keeps that window explicit.
              const key = yield* resolveKey()
              if (!key) {
                return yield* Effect.fail(
                  new Error("Connect Brave in /connect, or set BRAVE_SEARCH_API_KEY"),
                )
              }

              const url = new URL("https://api.search.brave.com/res/v1/web/search")
              url.searchParams.set("q", query)
              url.searchParams.set("count", "8")

              const response = yield* Effect.tryPromise({
                try: () =>
                  fetch(url, {
                    headers: {
                      Accept: "application/json",
                      "X-Subscription-Token": key,
                    },
                  }),
                catch: (error) => new Error("Brave request failed: " + String(error)),
              })

              if (!response.ok) {
                const detail = yield* Effect.tryPromise({
                  try: () => response.text(),
                  catch: () => new Error("response body unavailable"),
                })
                return yield* Effect.fail(
                  new Error("Brave API error " + response.status + ": " + detail),
                )
              }

              const json = yield* Effect.tryPromise({
                try: () => response.json(),
                catch: (error) => new Error("Invalid Brave response: " + String(error)),
              })

              const body = yield* Schema.decodeUnknownEffect(BraveResponse)(json)

              return (body.web?.results ?? []).map((result) => {
                const published = result.page_age ? Date.parse(result.page_age) : NaN
                return {
                  url: result.url,
                  title: result.title,
                  content: result.description ?? "",
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
