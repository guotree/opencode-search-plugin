import { Plugin } from "@opencode/plugin/effect"
import { Effect, Schema, Stream } from "effect"

// Perplexity's Search API answers with the bare ranked pages an agent reads:
// `results[]` of {title, url, snippet, date, last_updated}, with no generated
// prose to strip. That is what separates it from the vendor's Agent API
// (`/v1/agent`, which answers in prose) and the Sonar API it retired in
// September 2026. Every field is optional -- a missing one means "the source
// provided none", not an error, and a hit without a URL is dropped rather than
// failing the page -- and `snippet` is documented as "" for PDFs and short
// pages, which the mapping below tolerates rather than dropping the row over.
const PerplexityPage = Schema.Struct({
  title: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  snippet: Schema.optional(Schema.String),
  date: Schema.optional(Schema.NullOr(Schema.String)),
  last_updated: Schema.optional(Schema.NullOr(Schema.String)),
})

// The envelope carries a required `id`, a `server_time` the quickstart shows
// as null, and -- in some documented examples only -- a `query_info` object
// absent from the published schema. None of them is read here; the fields
// this provider needs are the ones declared above.
const PerplexityResponse = Schema.Struct({
  results: Schema.optional(Schema.Array(PerplexityPage)),
})

// The /connect integration ID, and the websearch provider ID it binds to.
// The `osp-` prefix is this package's namespace: OpenCode's built-ins and a
// vendor plugin's own entry are bare vendor names, so `perplexity` would
// collide with them, and with the opencode.db row keyed by integration ID.
const ID = "osp-perplexity"

function envInt(name: string, fallback: number): number {
  const raw = (process.env[name] ?? "").trim()
  if (raw === "") return fallback
  const value = Number(raw)
  return Number.isInteger(value) && value >= 0 ? value : fallback
}

function envStr(name: string): string {
  return (process.env[name] ?? "").trim()
}

// Perplexity stamps both of its date fields as `YYYY-MM-DD`, which the parser
// below accepts as-is. The relative-date tables still ship byte-identical with
// the other providers in this package -- the parser comes from the same shared
// block, and `test/structure.test.ts` compares it byte for byte.
// See https://serpapi.com/blog/how-to-parse-dates-from-google-search/
const RELATIVE_MS: Record<string, number> = {
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
  month: 2_592_000_000,
  year: 31_536_000_000,
  分钟: 60_000,
  小时: 3_600_000,
  天: 86_400_000,
  周: 604_800_000,
  个月: 2_592_000_000,
  月: 2_592_000_000,
  年: 31_536_000_000,
}

const RELATIVE_DATE =
  /^(\d+)\s*(minute|hour|day|week|month|year|分钟|小时|天|周|个月|月|年)s?\s*(?:ago|前)$/i

const ABSOLUTE_DATE = [
  /^\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}$/, // "3 Jan 2022", "31 Mar 2026"
  /^[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4}$/, // "Sep 30, 2026", "Jan 27, 2025"
  /^\d{4}-\d{2}-\d{2}$/, // "2026-10-16"
  // ISO 8601 with a time component, which some providers return verbatim.
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/,
]

function parseSearchDate(value: string | undefined): number {
  const text = value?.trim()
  if (!text) return NaN

  const relative = RELATIVE_DATE.exec(text)
  if (relative) {
    const unit = relative[2] !== undefined ? RELATIVE_MS[relative[2].toLowerCase()] : undefined
    const amount = Number(relative[1])
    if (unit === undefined || !Number.isFinite(amount)) return NaN
    return Date.now() - amount * unit
  }

  // Only trust Date.parse on shapes these providers actually emit -- its lenient
  // parser invents a year for strings like "Nov 1", which would date the result
  // to 2001.
  return ABSOLUTE_DATE.some((shape) => shape.test(text)) ? Date.parse(text) : NaN
}

function toResult(item: {
  title?: string | undefined
  url?: string | undefined
  snippet?: string | undefined
  date?: string | null | undefined
  last_updated?: string | null | undefined
}) {
  // A hit without a URL cannot be opened or cited, so it is dropped rather
  // than failing the whole page.
  if (!item.url) return undefined
  // `date` is the publication date and `last_updated` the page's own revision;
  // both answer "when is this from", and OpenCode's result carries a single
  // slot, so the update date stands in when the page declares no publication
  // date. A page that declares neither simply reports no time.
  const published = parseSearchDate(item.date ?? item.last_updated ?? undefined)
  return {
    url: item.url,
    // `url` is the one field the mapping insists on, so it is also the one thing
    // a title can fall back to rather than leave the result untitled.
    title: item.title || item.url,
    // `||`, not `??`: an empty snippet means Perplexity extracted nothing from
    // the page (its own domain-filter example returns "" for every PDF), and an
    // empty string still leaves a result worth reading for its link.
    content: item.snippet || "",
    time: Number.isFinite(published) ? { published } : {},
  }
}

type SearchResult = NonNullable<ReturnType<typeof toResult>>
// An error body is diagnostic, not content: a WAF or CDN interposing an HTML
// page can make it tens of kilobytes, and every byte would land in the tool
// result and the model's context. API refusal bodies are JSON of a few hundred
// characters, so a bound sized above them loses nothing. Counted in code
// points, never UTF-16 units, so no surrogate pair is sliced in half.
const ERROR_DETAIL_CHARS = 300

function boundDetail(detail: string): string {
  if (detail.length <= ERROR_DETAIL_CHARS) return detail
  const points = [...detail]
  if (points.length <= ERROR_DETAIL_CHARS) return detail
  return points.slice(0, ERROR_DETAIL_CHARS).join("") + "… [truncated]"
}


// Perplexity charges per successful request, not per token: $5.00 per 1,000
// requests for `web`, $1.00 for `fast`. A repeat query is a fresh billed
// dispatch, so responses are cached per normalized query. Knobs are read once
// at load time, restart after changing them.
//
//   PERPLEXITY_CACHE_TTL    ms to reuse a response for the same query (0 disables)
//   PERPLEXITY_MAX_RESULTS  results per search, clamped to 1-20
//   PERPLEXITY_SEARCH_TYPE  "web" (the API's default), "fast" (a fifth of the
//                           price, same response shape) or "people"; unset
//                           omits the field and lets the API default apply
//   PERPLEXITY_RECENCY      "hour", "day", "week", "month" or "year"
//   PERPLEXITY_COUNTRY      ISO 3166-1 alpha-2 code, e.g. "US"
//   PERPLEXITY_LANGUAGE     ISO 639-1 codes, comma-separated; at most 10 are
//                           sent, the stricter of the two limits the docs state
//   PERPLEXITY_TIMEOUT      ms to wait before failing (0 removes the deadline)
//   OSP_PERPLEXITY_API_KEY     required; from https://console.perplexity.ai/project/keys
const CACHE_TTL = envInt("PERPLEXITY_CACHE_TTL", 600_000)
// OpenCode's own providers each bounded themselves at 25s, and the host adds
// no deadline of its own around `execute`, so this is the only one that exists.
const SEARCH_TIMEOUT = envInt("PERPLEXITY_TIMEOUT", 25_000)
// Web search takes at most 20 (`max_results` above 20 requires `search_type=
// people`), so the clamp stays inside what the default search type accepts.
const SEARCH_SIZE = Math.min(Math.max(envInt("PERPLEXITY_MAX_RESULTS", 10), 1), 20)
const SEARCH_TYPE = ["web", "fast", "people"].includes(envStr("PERPLEXITY_SEARCH_TYPE"))
  ? envStr("PERPLEXITY_SEARCH_TYPE")
  : ""
const RECENCY = ["hour", "day", "week", "month", "year"].includes(
  envStr("PERPLEXITY_RECENCY"),
)
  ? envStr("PERPLEXITY_RECENCY")
  : ""
const COUNTRY = envStr("PERPLEXITY_COUNTRY")
// The spec allows 20 codes where the quickstart warns of 10; the stricter of
// the two documented limits is the one enforced here, so a request built from
// this knob cannot be the one that trips validation.
const LANGUAGE = envStr("PERPLEXITY_LANGUAGE")
  .split(",")
  .map((code) => code.trim())
  .filter(Boolean)
  .slice(0, 10)

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
    // Make "Perplexity" show up in /connect with an API-key method.
    yield* ctx.integration.transform((editor) => {
      editor.update(ID, (integration) => {
        integration.name = "Perplexity (osp)"
      })
      editor.method.update({
        integrationID: ID,
        method: { type: "key", label: "Perplexity API key" },
      })
      editor.method.update({
        integrationID: ID,
        method: { type: "env", names: ["OSP_PERPLEXITY_API_KEY"] },
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
        return credential?.type === "key" ? credential.key : process.env.OSP_PERPLEXITY_API_KEY
      })

    // Perplexity has no anonymous tier -- `POST /search` answers 401 without a
    // key -- so it is bound to websearch only while a key exists. Deleting the
    // key unbinds the provider, so `random` can never pick a keyless Perplexity.
    // The transform replays on reload and reads `bound` as it stands then.
    let bound = Boolean(yield* resolveKey())

    yield* ctx.websearch.transform((editor) => {
      if (!bound) return
      editor.add({
        id: ID,
        name: "Perplexity",
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
                new Error("Connect Perplexity in /connect, or set OSP_PERPLEXITY_API_KEY"),
              )
            }

            const response = yield* Effect.tryPromise({
              try: (signal) =>
                fetch("https://api.perplexity.ai/search", {
                  method: "POST",
                  headers: {
                    Accept: "application/json",
                    "Content-Type": "application/json",
                    Authorization: "Bearer " + key,
                  },
                  body: JSON.stringify({
                    query: queryKey,
                    max_results: SEARCH_SIZE,
                    ...(SEARCH_TYPE ? { search_type: SEARCH_TYPE } : {}),
                    ...(RECENCY ? { search_recency_filter: RECENCY } : {}),
                    ...(COUNTRY ? { country: COUNTRY } : {}),
                    ...(LANGUAGE.length > 0 ? { search_language_filter: LANGUAGE } : {}),
                  }),
                  signal: timedSignal(signal, SEARCH_TIMEOUT),
                }),
              // A timeout is its own failure: naming it stops the user hunting
              // for a key problem that was never there.
              catch: (error) =>
                error instanceof Error && error.name === "TimeoutError"
                  ? new Error("Perplexity search timed out after " + SEARCH_TIMEOUT + "ms")
                  : new Error("Perplexity request failed: " + String(error)),
            })

            if (!response.ok) {
              const detail = yield* Effect.tryPromise({
                try: () => response.text(),
                catch: () => new Error("response body unavailable"),
              })
              return yield* Effect.fail(
                new Error("Perplexity API error " + response.status + ": " + boundDetail(detail)),
              )
            }

            const json = yield* Effect.tryPromise({
              try: () => response.json(),
              catch: (error) => new Error("Invalid Perplexity response: " + String(error)),
            })

            const body = yield* Schema.decodeUnknownEffect(PerplexityResponse)(json)
            const results = (body.results ?? [])
              .map(toResult)
              .filter((result): result is SearchResult => result !== undefined)

            // Perplexity charges per dispatch, so a response that never enters
            // the cache is a query paid for again on every repeat.
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

export default Plugin.define({ id: "perplexity-search", effect })
