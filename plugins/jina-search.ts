import { Plugin } from "@opencode/plugin/effect"
import { Effect, Schema, Stream } from "effect"

// Jina wraps the SERP in an envelope ({ code, status, data }) but failures
// still arrive as HTTP status codes with a `detail` body, so the envelope is
// read for results only. Every result field is optional -- a missing one means
// "Jina provided none", not an error. With `X-Respond-With: no-content` each
// hit carries only title/url/description; `content` (full page markdown)
// appears only when it was explicitly requested.
const JinaResponse = Schema.Struct({
  data: Schema.optional(
    Schema.Array(
      Schema.Struct({
        title: Schema.optional(Schema.String),
        url: Schema.optional(Schema.String),
        description: Schema.optional(Schema.String),
        content: Schema.optional(Schema.String),
      }),
    ),
  ),
})

// The /connect integration ID, and the websearch provider ID it binds to.
// The `osp-` prefix is this package's namespace: OpenCode's built-ins and a
// vendor plugin's own entry are bare vendor names, so `jina` would collide
// with them, and with the opencode.db row keyed by integration ID.
const ID = "osp-jina"

// Jina returns no publication date on search hits, so results carry an empty
// time record rather than a parsed one.
function toResult(
  item: {
    title?: string | undefined
    url?: string | undefined
    description?: string | undefined
    content?: string | undefined
  },
  includeContent: boolean,
) {
  const text = includeContent
    ? item.content ?? item.description ?? ""
    : item.description ?? ""
  return {
    url: item.url ?? "",
    title: item.title || item.url || "",
    content: text,
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

// Jina meters s.jina.ai at 100 RPM on a free key and bills the page content
// it returns per token, so a repeat query is worth avoiding and content is
// off unless asked for. Knobs are read once at load time, restart after
// changing them.
//
//   JINA_CACHE_TTL       ms to reuse a response for the same query (0 disables)
//   JINA_INCLUDE_CONTENT true returns each hit's full page markdown: same search,
//                        far more context tokens and billed tokens. Only worth it
//                        when you would otherwise webfetch those hits anyway.
//                        Default (off) asks Jina for titles and snippets only.
//   JINA_NUM             results per search, clamped 1-100; 0 (default) omits the
//                        parameter -- Jina warns num adds latency and drops
//                        specialized result types, so use its page size
//   JINA_GL              country code for results, e.g. "us", "cn"
//   JINA_HL              language code for results, e.g. "en", "zh-cn"
//   JINA_LOCATION        city-level origin to simulate, e.g. "Berlin"
//   JINA_API_KEY         required; free key at https://jina.ai/?sui=apikey
const CACHE_TTL = envInt("JINA_CACHE_TTL", 600_000)
const INCLUDE_CONTENT = envStr("JINA_INCLUDE_CONTENT") === "true"
const SEARCH_SIZE = Math.min(Math.max(envInt("JINA_NUM", 0), 0), 100)
const GL = envStr("JINA_GL")
const HL = envStr("JINA_HL")
const LOCATION = envStr("JINA_LOCATION")

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
    // Make "Jina" show up in /connect with an API-key method.
    yield* ctx.integration.transform((editor) => {
      editor.update(ID, (integration) => {
        integration.name = "Jina"
      })
      editor.method.update({
        integrationID: ID,
        method: { type: "key", label: "Jina API key" },
      })
      editor.method.update({
        integrationID: ID,
        method: { type: "env", names: ["JINA_API_KEY"] },
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
        return credential?.type === "key" ? credential.key : process.env.JINA_API_KEY
      })

    // Jina is bound to websearch only while a key exists. Deleting the key
    // unbinds the provider, so `random` can never pick a keyless Jina.
    // The transform replays on reload and reads `bound` as it stands then.
    let bound = Boolean(yield* resolveKey())

    yield* ctx.websearch.transform((editor) => {
      if (!bound) return
      editor.add({
        id: ID,
        name: "Jina",
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
                new Error("Connect Jina in /connect, or set JINA_API_KEY"),
              )
            }

            const response = yield* Effect.tryPromise({
              try: () =>
                fetch("https://s.jina.ai/", {
                  method: "POST",
                  headers: {
                    Accept: "application/json",
                    "Content-Type": "application/json",
                    Authorization: "Bearer " + key,
                    // Snippets only unless full page text was asked for: the
                    // content Jina returns is token-billed and lands in the
                    // agent's context verbatim.
                    ...(INCLUDE_CONTENT ? {} : { "X-Respond-With": "no-content" }),
                  },
                  body: JSON.stringify({
                    q: queryKey,
                    ...(SEARCH_SIZE >= 1 ? { num: SEARCH_SIZE } : {}),
                    ...(GL ? { gl: GL } : {}),
                    ...(HL ? { hl: HL } : {}),
                    ...(LOCATION ? { location: LOCATION } : {}),
                  }),
                }),
              catch: (error) => new Error("Jina request failed: " + String(error)),
            })

            if (!response.ok) {
              const detail = yield* Effect.tryPromise({
                try: () => response.text(),
                catch: () => new Error("response body unavailable"),
              })
              return yield* Effect.fail(
                new Error("Jina API error " + response.status + ": " + detail),
              )
            }

            const json = yield* Effect.tryPromise({
              try: () => response.json(),
              catch: (error) => new Error("Invalid Jina response: " + String(error)),
            })

            const body = yield* Schema.decodeUnknownEffect(JinaResponse)(json)
            const results = (body.data ?? []).flatMap((item) =>
              item.url ? [toResult(item, INCLUDE_CONTENT)] : [],
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

export default Plugin.define({ id: "jina-search", effect })
