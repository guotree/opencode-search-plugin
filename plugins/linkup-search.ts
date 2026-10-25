import { Plugin } from "@opencode/plugin/effect"
import { Effect, Schema, Stream } from "effect"

// Linkup returns { results: [...] } with no body-level error envelope: failures
// are HTTP status codes only. Text and image results share one list; image
// entries carry no content, so they are dropped on the way out. Every field is
// optional -- a missing one means "the source provided none", not an error.
//
// `content` is a query-relevant excerpt, not the page -- the docs call it
// "Extracted text content associated with the resource", and whole pages are
// the separate Fetch endpoint's job. Measured across 85 hits it ran 375 to
// 4,395 characters, median near 2,000.
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

// `content` is an excerpt rather than a page, but its length is still the
// vendor's to decide and no parameter asks for less of it (unknown ones are
// accepted and ignored), so it is cut to CONTENT_CHARS code points before it
// can reach the agent. The cut counts code points, never UTF-16 units, so no
// surrogate pair is sliced in half; the trailing ellipsis tells the model the
// excerpt was clipped rather than that it ended there.
//
// The UTF-16 length check comes first because it is O(1) and can only
// over-estimate the code-point count: an excerpt already inside the budget
// skips the spread entirely.
function trimContent(text: string): string {
  if (CONTENT_CHARS <= 0 || text.length <= CONTENT_CHARS) return text
  const points = [...text]
  if (points.length <= CONTENT_CHARS) return text
  return points.slice(0, CONTENT_CHARS).join("") + "…"
}

function toResult(item: typeof LinkupResult.Type) {
  return {
    url: item.url,
    title: item.name || item.url,
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

// Linkup bills per request on credits and has no anonymous tier. A repeat
// query is a fresh billed dispatch, so responses are cached per normalized
// query. Knobs are read once at load time, restart after changing them.
//
//   LINKUP_CACHE_TTL     ms to reuse a response for the same query (0 disables)
//   LINKUP_DEPTH         "flash" (few hundred ms), "fast" (~1s one-shot, the
//                        vendor's recommended default for agents), "standard"
//                        (single agentic pass) or "deep" (several iterations).
//                        Depth buys recall and latency, not text: the three
//                        returned the same excerpt lengths when measured
//   LINKUP_MAX_RESULTS   results per search, clamped to 1-100; the API answers
//                        with at most 20 whatever is asked for (50 and 200
//                        both return 20), so the clamp only guards a typo
//   LINKUP_CONTENT_CHARS code points kept from each hit's `content` (0 keeps
//                        all of it). OpenCode never truncates a tool result,
//                        so this is the only bound on what one search spends
//                        on context
//   LINKUP_TIMEOUT       ms to wait before failing (0 removes the deadline)
//   OSP_LINKUP_API_KEY       required; from https://app.linkup.so
const CACHE_TTL = envInt("LINKUP_CACHE_TTL", 600_000)
// OpenCode's own providers each bounded themselves at 25s, and the host adds
// no deadline of its own around `execute`, so this is the only one that exists.
const SEARCH_TIMEOUT = envInt("LINKUP_TIMEOUT", 25_000)
const SEARCH_SIZE = Math.min(Math.max(envInt("LINKUP_MAX_RESULTS", 10), 1), 100)
// 4000 code points is the top of the excerpts measured here (375 to 4,395
// across 85 hits), so this trims the tail -- 4 of those 85 -- rather than the
// answer. Cutting an excerpt costs more than cutting a page does: what goes
// away is answer text, not a footer. 0 keeps every excerpt whole.
const CONTENT_CHARS = envInt("LINKUP_CONTENT_CHARS", 4_000)
const DEPTH_VALUES = ["flash", "fast", "standard", "deep"]
const DEPTH_RAW = envStr("LINKUP_DEPTH")
const DEPTH = DEPTH_VALUES.includes(DEPTH_RAW) ? DEPTH_RAW : "fast"
if (DEPTH_RAW !== "" && !DEPTH_VALUES.includes(DEPTH_RAW)) {
  // An unknown value is reported rather than dropped silently: a typo in a
  // knob should cost that knob, and the user should hear about it.
  console.warn(
    "[opencode-search-plugin] LINKUP_DEPTH " +
      JSON.stringify(DEPTH_RAW) +
      " is not one of " +
      DEPTH_VALUES.join(", ") +
      "; searching at the default depth instead",
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

export const effect = (ctx: Plugin.Context) =>
  Effect.gen(function* () {
    // Make "Linkup" show up in /connect with an API-key method.
    yield* ctx.integration.transform((editor) => {
      editor.update(ID, (integration) => {
        integration.name = "Linkup (osp)"
      })
      editor.method.update({
        integrationID: ID,
        method: { type: "key", label: "Linkup API key" },
      })
      editor.method.update({
        integrationID: ID,
        method: { type: "env", names: ["OSP_LINKUP_API_KEY"] },
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
        return credential?.type === "key" ? credential.key : process.env.OSP_LINKUP_API_KEY
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
                new Error("Connect Linkup in /connect, or set OSP_LINKUP_API_KEY"),
              )
            }

            const response = yield* Effect.tryPromise({
              try: (signal) =>
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
                    // The leanest outputType, and the only one this contract
                    // can carry: `sourcedAnswer` adds an AI answer on top of
                    // source snippets that are the same text `results[].content`
                    // already holds (measured -- the lengths came back
                    // identical), and WebSearch.Result has no field for an
                    // answer to live in. `structured` hands back the same
                    // sources again.
                    outputType: "searchResults",
                    maxResults: SEARCH_SIZE,
                  }),
                  signal: timedSignal(signal, SEARCH_TIMEOUT),
                }),
              // A timeout is its own failure: naming it stops the user hunting
              // for a key problem that was never there.
              catch: (error) =>
                error instanceof Error && error.name === "TimeoutError"
                  ? new Error("Linkup search timed out after " + SEARCH_TIMEOUT + "ms")
                  : new Error("Linkup request failed: " + String(error)),
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
          // One failed rebind must not kill the subscription: the next
          // credential event still has to reach the reload. `bound` moves
          // before the reload so the transforms it replays build with the
          // new state, and rolls back when the reload dies so the next
          // event retries the binding instead of treating it as done. A
          // defect is named on stderr and the stream moves on; an
          // interruption is teardown rather than failure, and catchDefect
          // propagates it untouched so shutdown never waits behind a warning.
          Effect.gen(function* () {
            const next = Boolean(yield* resolveKey())
            if (next === bound) return
            const previous = bound
            bound = next
            yield* Effect.suspend(() => ctx.websearch.reload()).pipe(
              Effect.catchDefect((defect) =>
                Effect.sync(() => {
                  bound = previous
                  console.warn(
                    "[opencode-search-plugin] " +
                      ID +
                      " failed to rebind: " +
                      (defect instanceof Error ? defect.message : String(defect)),
                  )
                }),
              ),
            )
          }).pipe(
            // The credential read can die on its own (a host-side throw
            // before any reload); the subscription survives that too.
            Effect.catchDefect((defect) =>
              Effect.sync(() =>
                console.warn(
                  "[opencode-search-plugin] " +
                    ID +
                    " failed to rebind: " +
                    (defect instanceof Error ? defect.message : String(defect)),
                ),
              ),
            ),
          ),
        ),
        Stream.runDrain,
      ),
    )
  })

export default Plugin.define({ id: "linkup-search", effect })
