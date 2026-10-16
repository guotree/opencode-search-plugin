import { Plugin } from "@opencode/plugin/effect"
import { Effect, Schema, Stream } from "effect"

// Every field on a result is optional -- a missing one means "body text
// unavailable", not an error.
const QueritResponse = Schema.Struct({
  error_code: Schema.optional(Schema.Number),
  error_msg: Schema.optional(Schema.String),
  results: Schema.optional(
    Schema.Struct({
      result: Schema.optional(
        Schema.Array(
          Schema.Struct({
            url: Schema.optional(Schema.String),
            title: Schema.optional(Schema.String),
            snippet: Schema.optional(Schema.String),
            page_age: Schema.optional(Schema.String),
            sentence: Schema.optional(Schema.Array(Schema.String)),
          }),
        ),
      ),
    }),
  ),
})

// search_id is documented as both a string and an integer, so read it loosely
// rather than letting a strict decode reject an otherwise good response.
function searchIdOf(json: unknown): string {
  const value = (json as { search_id?: unknown } | null)?.search_id
  return typeof value === "string" || typeof value === "number" ? String(value) : "unknown"
}

export default Plugin.define({
  id: "querit-search",
  effect: (ctx) =>
    Effect.gen(function* () {
      // Make "Querit" show up in /connect with an API-key method.
      yield* ctx.integration.transform((editor) => {
        editor.update("querit", (integration) => {
          integration.name = "Querit"
        })
        editor.method.update({
          integrationID: "querit",
          method: { type: "key", label: "Querit API key" },
        })
        editor.method.update({
          integrationID: "querit",
          method: { type: "env", names: ["QUERIT_API_KEY"] },
        })
      })

      // The key comes from the /connect credential, falling back to the
      // environment. Resolved per call so a rotated key needs no restart.
      const resolveKey = () =>
        Effect.gen(function* () {
          const connection = yield* ctx.integration.connection.active("querit")
          const credential = connection
            ? yield* ctx.integration.connection.resolve(connection)
            : undefined
          return credential?.type === "key" ? credential.key : process.env.QUERIT_API_KEY
        })

      // Querit is bound to websearch only while a key exists. Deleting the key
      // unbinds the provider, so `random` can never pick a keyless Querit.
      // The transform replays on reload and reads `bound` as it stands then.
      let bound = Boolean(yield* resolveKey())

      yield* ctx.websearch.transform((editor) => {
        if (!bound) return
        editor.add({
          id: "querit",
          name: "Querit",
          execute: ({ query }) =>
            Effect.gen(function* () {
              // Rechecked per call: binding can lag a key deletion by the
              // event round-trip, so this keeps that window explicit.
              const key = yield* resolveKey()
              if (!key) {
                return yield* Effect.fail(
                  new Error("Connect Querit in /connect, or set QUERIT_API_KEY"),
                )
              }

              const response = yield* Effect.tryPromise({
                try: () =>
                  fetch("https://api.querit.ai/v1/search", {
                    method: "POST",
                    headers: {
                      Accept: "application/json",
                      "Content-Type": "application/json",
                      Authorization: "Bearer " + key,
                    },
                    body: JSON.stringify({ query: query, count: 8 }),
                  }),
                catch: (error) => new Error("Querit request failed: " + String(error)),
              })

              if (!response.ok) {
                const detail = yield* Effect.tryPromise({
                  try: () => response.text(),
                  catch: () => new Error("response body unavailable"),
                })
                return yield* Effect.fail(
                  new Error("Querit API error " + response.status + ": " + detail),
                )
              }

              const json = yield* Effect.tryPromise({
                try: () => response.json(),
                catch: (error) => new Error("Invalid Querit response: " + String(error)),
              })

              const body = yield* Schema.decodeUnknownEffect(QueritResponse)(json)

              // Querit reports failures in the body too, even on an HTTP 200.
              // search_id is what support needs to trace the request.
              if (body.error_code !== undefined && body.error_code !== 200) {
                return yield* Effect.fail(
                  new Error(
                    "Querit API error " +
                      body.error_code +
                      ": " +
                      (body.error_msg ?? "unknown error") +
                      " (search_id " +
                      searchIdOf(json) +
                      ")",
                  ),
                )
              }

              return (body.results?.result ?? []).flatMap((result) => {
                if (!result.url) return []
                const published = result.page_age ? Date.parse(result.page_age) : NaN
                return [
                  {
                    url: result.url,
                    title: result.title ?? result.url,
                    content: result.snippet ?? (result.sentence ?? []).join(" "),
                    time: Number.isFinite(published) ? { published } : {},
                  },
                ]
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
