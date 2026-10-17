import { Plugin } from "@opencode/plugin/effect"
import { Effect, Schema, Stream } from "effect"

// Linkup returns { results: [...] } with no body-level error envelope: failures
// are HTTP status codes only. Text and image results share one list; image
// entries carry no content, so they are dropped on the way out. Every field is
// optional -- a missing one means "the source provided none", not an error.
const LinkupResult = Schema.Struct({
  name: Schema.optional(Schema.String),
  url: Schema.String,
  content: Schema.optional(Schema.String),
  favicon: Schema.optional(Schema.String),
  type: Schema.optional(Schema.String),
})

const LinkupResponse = Schema.Struct({
  results: Schema.optional(Schema.Array(LinkupResult)),
})

// The /connect integration ID, and the websearch provider ID it binds to.
// The `osp-` prefix is this package's namespace: OpenCode's built-ins and a
// vendor plugin's own entry are bare vendor names, so `linkup` would collide
// with them, and with the opencode.db row keyed by integration ID.
const ID = "osp-linkup"

function toResult(item: typeof LinkupResult.Type) {
  return {
    url: item.url,
    title: item.name || item.url,
    content: item.content ?? "",
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

// Linkup bills per request on credits and has no anonymous tier. A repeat
// query is a fresh billed dispatch, so responses are cached per normalized
// query. Knobs are read once at load time, restart after changing them.
//
//   LINKUP_CACHE_TTL     ms to reuse a response for the same query (0 disables)
//   LINKUP_DEPTH         "flash" (few hundred ms), "fast" (~1s one-shot, the
//                        vendor's recommended default for agents), "standard"
//                        (single agentic pass) or "deep" (several iterations)
//   LINKUP_MAX_RESULTS   results per search, clamped to 1-100
//   LINKUP_API_KEY       required; from https://app.linkup.so
const CACHE_TTL = envInt("LINKUP_CACHE_TTL", 600_000)
const SEARCH_SIZE = Math.min(Math.max(envInt("LINKUP_MAX_RESULTS", 10), 1), 100)
const DEPTH = ["flash", "fast", "standard", "deep"].includes(envStr("LINKUP_DEPTH"))
  ? envStr("LINKUP_DEPTH")
  : "fast"

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

export const effect = (ctx: Plugin.Context) =>
  Effect.gen(function* () {
    // Make "Linkup" show up in /connect with an API-key method.
    yield* ctx.integration.transform((editor) => {
      editor.update(ID, (integration) => {
        integration.name = "Linkup"
      })
      editor.method.update({
        integrationID: ID,
        method: { type: "key", label: "Linkup API key" },
      })
      editor.method.update({
        integrationID: ID,
        method: { type: "env", names: ["LINKUP_API_KEY"] },
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
        return credential?.type === "key" ? credential.key : process.env.LINKUP_API_KEY
      })

    // Linkup is bound to websearch only while a key exists. Deleting the key
    // unbinds the provider, so `random` can never pick a keyless Linkup.
    // The transform replays on reload and reads `bound` as it stands then.
    let bound = Boolean(yield* resolveKey())

    yield* ctx.websearch.transform((editor) => {
      if (!bound) return
      editor.add({
        id: ID,
        name: "Linkup",
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
                new Error("Connect Linkup in /connect, or set LINKUP_API_KEY"),
              )
            }

            const response = yield* Effect.tryPromise({
              try: () =>
                fetch("https://api.linkup.so/v1/search", {
                  method: "POST",
                  headers: {
                    Accept: "application/json",
                    "Content-Type": "application/json",
                    Authorization: "Bearer " + key,
                  },
                  body: JSON.stringify({
                    q: queryKey,
                    depth: DEPTH,
                    outputType: "searchResults",
                    maxResults: SEARCH_SIZE,
                  }),
                }),
              catch: (error) => new Error("Linkup request failed: " + String(error)),
            })

            if (!response.ok) {
              const detail = yield* Effect.tryPromise({
                try: () => response.text(),
                catch: () => new Error("response body unavailable"),
              })
              return yield* Effect.fail(
                new Error("Linkup API error " + response.status + ": " + detail),
              )
            }

            const json = yield* Effect.tryPromise({
              try: () => response.json(),
              catch: (error) => new Error("Invalid Linkup response: " + String(error)),
            })

            const body = yield* Schema.decodeUnknownEffect(LinkupResponse)(json)
            const results = (body.results ?? []).flatMap((item) =>
              item.url && item.type !== "image" ? [toResult(item)] : [],
            )

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
  })

export default Plugin.define({ id: "linkup-search", effect })
