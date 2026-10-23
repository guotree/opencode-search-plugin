import { Plugin } from "@opencode/plugin/effect"
import { Effect, Schema, Stream } from "effect"

// Ollama's hosted search answers with the flattest envelope in this package:
// `results` carries the hits, each a title, a URL and a `content` that is the
// whole page -- byte-identical to `web_fetch`'s output for the same URL,
// whatever the docs' "a relevant content snippet" says: 20 hits across four
// queries ran 348 to 208,805 characters, median near 10,000 -- with no
// wrapper fields and, unlike every other provider here, no dates. Every field
// but the URL is optional, and a missing one means "Ollama provided none",
// not an error.
const OllamaResponse = Schema.Struct({
  results: Schema.optional(
    Schema.Array(
      Schema.Struct({
        title: Schema.optional(Schema.String),
        url: Schema.String,
        content: Schema.optional(Schema.String),
      }),
    ),
  ),
})

// The /connect integration ID, and the websearch provider ID it binds to.
// The `osp-` prefix is this package's namespace: OpenCode's built-ins and a
// vendor plugin's own entry are bare vendor names, and OpenCode's own `ollama`
// model provider already registers one, so the bare name is spoken for -- the
// prefix is what keeps this websearch entry and its /connect row distinct from
// that model provider, and from the opencode.db row keyed by integration ID.
const ID = "osp-ollama"

// `content` is the fetched page in full -- 348 to 208,805 characters when
// measured, median near 10,000 -- and no parameter asks for less of it
// (unknown ones are accepted and ignored), so it is cut to CONTENT_CHARS code
// points before it can reach the agent. The cut counts code points, never
// UTF-16 units, so no surrogate pair is sliced in half; the trailing ellipsis
// tells the model the body was clipped rather than that it ended there.
//
// The UTF-16 length check comes first because it is O(1) and can only
// over-estimate the code-point count: a body already inside the budget skips
// the spread entirely, which matters when a response carries ten full pages
// the caller never reads.
function trimContent(text: string): string {
  if (CONTENT_CHARS <= 0 || text.length <= CONTENT_CHARS) return text
  const points = [...text]
  if (points.length <= CONTENT_CHARS) return text
  return points.slice(0, CONTENT_CHARS).join("") + "…"
}

// Ollama returns no publication date, so results carry an empty time record.
function toResult(item: {
  title?: string | undefined
  url: string
  content?: string | undefined
}) {
  return {
    url: item.url,
    // The URL is the one field the schema insists on, so it is also the one
    // thing a title can fall back to rather than leave the result untitled.
    title: item.title || item.url,
    content: trimContent(item.content ?? ""),
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

// Web search rides on an Ollama account: the API is hosted at ollama.com, not
// served by the local model runner (the official SDKs hardcode that host, and
// the local server neither proxies this endpoint nor reads this key). A
// generous free tier covers individual use, and the API caps a search at 10
// results, which is the clamp below. Knobs are read once at load time, so
// restart after changing them.
//
//   OLLAMA_CACHE_TTL     ms to reuse a response for the same query (0 disables)
//   OLLAMA_MAX_RESULTS   results per search, clamped to 1-10 (the API's range)
//   OLLAMA_CONTENT_CHARS code points kept from each hit's `content` (0 keeps
//                        all of it). OpenCode never truncates a tool result,
//                        so this is the only bound between Ollama's output and
//                        the agent's context -- the API offers no length knob
//                        of its own, and Ollama's own agent example cuts the
//                        search output to 8k characters before the model sees it
//   OLLAMA_TIMEOUT       ms to wait before failing (0 removes the deadline)
//   OSP_OLLAMA_API_KEY   required; from https://ollama.com/settings/keys.
//                        Namespaced away from the vendor-canonical
//                        OLLAMA_API_KEY, which other tools -- and OpenCode's
//                        own config examples -- also read, sometimes holding
//                        a bearer token for an Ollama-compatible proxy
//                        rather than an account key. A /connect credential
//                        still outranks this variable.
const CACHE_TTL = envInt("OLLAMA_CACHE_TTL", 600_000)
// OpenCode's own providers each bounded themselves at 25s, and the host adds
// no deadline of its own around `execute`, so this is the only one that exists.
const SEARCH_TIMEOUT = envInt("OLLAMA_TIMEOUT", 25_000)
const MAX_RESULTS = Math.min(Math.max(envInt("OLLAMA_MAX_RESULTS", 5), 1), 10)
// 2000 code points per hit keeps five results around the 8k characters that
// Ollama's own agent example budgets for a whole search result, and matches
// Doubao's default. It clips 17 of 20 measured hits, and what it leaves out
// stays reachable: `content` is the same text `web_fetch` returns. 0 reads
// every page body whole.
const CONTENT_CHARS = envInt("OLLAMA_CONTENT_CHARS", 2_000)

const SEARCH_URL = "https://ollama.com/api/web_search"

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

export const effect = (ctx: Plugin.Context) =>
  Effect.gen(function* () {
    // Make "Ollama" show up in /connect with an API-key method.
    yield* ctx.integration.transform((editor) => {
      editor.update(ID, (integration) => {
        integration.name = "Ollama Search (osp)"
      })
      editor.method.update({
        integrationID: ID,
        method: { type: "key", label: "Ollama API key" },
      })
      editor.method.update({
        integrationID: ID,
        method: { type: "env", names: ["OSP_OLLAMA_API_KEY"] },
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
        return credential?.type === "key" ? credential.key : process.env.OSP_OLLAMA_API_KEY
      })

    // Web search requires an Ollama account, so the provider binds only while
    // a key exists. Deleting the key unbinds it, and `random` can never pick a
    // keyless Ollama. The transform replays on reload and reads `bound` as it
    // stands then.
    let bound = Boolean(yield* resolveKey())

    yield* ctx.websearch.transform((editor) => {
      if (!bound) return
      editor.add({
        id: ID,
        name: "Ollama Search",
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
                new Error("Connect Ollama in /connect, or set OSP_OLLAMA_API_KEY"),
              )
            }

            const response = yield* Effect.tryPromise({
              try: (signal) =>
                fetch(SEARCH_URL, {
                  method: "POST",
                  headers: {
                    Accept: "application/json",
                    "Content-Type": "application/json",
                    Authorization: "Bearer " + key,
                  },
                  body: JSON.stringify({
                    query: queryKey,
                    max_results: MAX_RESULTS,
                  }),
                  signal: timedSignal(signal, SEARCH_TIMEOUT),
                }),
              // A timeout is its own failure: naming it stops the user hunting
              // for a key problem that was never there.
              catch: (error) =>
                error instanceof Error && error.name === "TimeoutError"
                  ? new Error("Ollama search timed out after " + SEARCH_TIMEOUT + "ms")
                  : new Error("Ollama request failed: " + String(error)),
            })

            if (!response.ok) {
              // A bad key answers 401 with `{"error":"Unauthorized"}` (checked
              // against the live API); the body rides along verbatim, so any
              // shape Ollama adds later is reported rather than mistranslated.
              const detail = yield* Effect.tryPromise({
                try: () => response.text(),
                catch: () => new Error("response body unavailable"),
              })
              return yield* Effect.fail(
                new Error("Ollama API error " + response.status + ": " + detail),
              )
            }

            const json = yield* Effect.tryPromise({
              try: () => response.json(),
              catch: (error) => new Error("Invalid Ollama response: " + String(error)),
            })

            const body = yield* Schema.decodeUnknownEffect(OllamaResponse)(json)
            const results = (body.results ?? []).map(toResult)

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

export default Plugin.define({ id: "ollama-search", effect })
