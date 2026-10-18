import { Plugin } from "@opencode/plugin/effect"
import { Effect, Schema } from "effect"

// Keenable answers with a flat object: `results` carries ranked hits, `mode`
// echoes the tier that served the call, and there is no failure envelope --
// refusals arrive as plain HTTP statuses. Every field but the URL is optional,
// and a missing one means "Keenable provided none", not an error.
const KeenableResponse = Schema.Struct({
  query: Schema.optional(Schema.String),
  mode: Schema.optional(Schema.String),
  results: Schema.optional(
    Schema.Array(
      Schema.Struct({
        title: Schema.optional(Schema.String),
        url: Schema.String,
        description: Schema.optional(Schema.String),
        snippet: Schema.optional(Schema.String),
        published_at: Schema.optional(Schema.String),
        acquired_at: Schema.optional(Schema.String),
      }),
    ),
  ),
})

// The /connect integration ID, and the websearch provider ID it binds to.
// The `osp-` prefix is this package's namespace: OpenCode's built-ins and a
// vendor plugin's own entry are bare vendor names, so `keenable` would collide
// with them, and with the opencode.db row keyed by integration ID.
const ID = "osp-keenable"

// Keenable returns ISO 8601 timestamps, which the parser below accepts as-is.
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
  // ISO 8601 with a time component, which Keenable returns on `published_at`.
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
  url: string
  description?: string | undefined
  snippet?: string | undefined
  published_at?: string | undefined
}) {
  const published = parseSearchDate(item.published_at)
  return {
    url: item.url,
    title: item.title || item.url,
    // The snippet is the longer excerpt, so it is the better answer to give an
    // agent; the description is the short summary behind it, and Keenable often
    // returns it empty -- `||`, not `??`, so an empty snippet still falls back.
    content: item.snippet || item.description || "",
    time: Number.isFinite(published) ? { published } : {},
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

// Keenable has two tiers that draw on separate budgets. With a key, a call is
// metered against the free monthly allowance of 100,000 requests per
// organization. Without one, a call goes to the `/public` twin of each endpoint
// and is limited per IP instead -- 1,000 an hour and 10 a second on a pool
// shared with everyone else on the egress address -- and spends no credits.
// A missing key therefore routes elsewhere rather than failing, which is why
// this provider never gates on `bound`. Knobs are read once at load time,
// restart after changing them.
//
//   KEENABLE_CACHE_TTL    ms to reuse a response for the same query (0 disables)
//   KEENABLE_MAX_RESULTS  results per search, clamped to 1-50 (the API's range)
//   KEENABLE_MODE         "pro" for deeper retrieval, "realtime" for speed;
//                         leave unset and the organization's default applies
//   KEENABLE_TITLE        app name sent as X-Keenable-Title, which the keyless
//                         endpoint requires to attribute traffic (max 256 chars)
//   KEENABLE_TIMEOUT      ms to wait before failing (0 removes the deadline)
//   KEENABLE_API_KEY      optional; keyless access works without it
const CACHE_TTL = envInt("KEENABLE_CACHE_TTL", 600_000)
// OpenCode's own providers each bounded themselves at 25s, and the host adds
// no deadline of its own around `execute`, so this is the only one that exists.
const SEARCH_TIMEOUT = envInt("KEENABLE_TIMEOUT", 25_000)
const SEARCH_SIZE = Math.min(Math.max(envInt("KEENABLE_MAX_RESULTS", 10), 1), 50)
const MODE = envStr("KEENABLE_MODE")
const TITLE = (envStr("KEENABLE_TITLE") || "opencode-search-plugin").slice(0, 256)

const SEARCH_URL = "https://api.keenable.ai/v1/search"
const PUBLIC_URL = "https://api.keenable.ai/v1/search/public"

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

// A hung upstream must not hang the agent: the deadline bounds it, and the
// thunk's signal carries host cancellation into the socket. `timeout <= 0`
// removes the deadline but never the cancellation, because
// `AbortSignal.timeout(0)` aborts instantly rather than "never".
function timedSignal(signal: AbortSignal, timeout: number): AbortSignal {
  return timeout > 0 ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : signal
}

// Unlike the key-requiring providers in this repo, Keenable never gates on
// `bound`: keyless access is a first-class mode, so the provider is always in
// the pool. The key is still read per call, which is why no credential-event
// subscription is needed -- a rotated key takes effect on the next search
// without a reload.
export const effect = (ctx: Plugin.Context) =>
  Effect.gen(function* () {
    // Make "Keenable" show up in /connect with an API-key method.
    yield* ctx.integration.transform((editor) => {
      editor.update(ID, (integration) => {
        integration.name = "Keenable (osp)"
      })
      editor.method.update({
        integrationID: ID,
        method: { type: "key", label: "Keenable API key" },
      })
      editor.method.update({
        integrationID: ID,
        method: { type: "env", names: ["KEENABLE_API_KEY"] },
      })
    })

    // The host instantiates this API's failure channel as `unknown`, which would
    // make the whole plugin effect unrunnable. A credential read must never take
    // the plugin down: a failed read degrades to "no stored key", and the
    // environment fallback below applies exactly as it does when the credential
    // simply does not exist.
    const soften = <A>(read: Effect.Effect<A, unknown>): Effect.Effect<A | undefined, never> =>
      read.pipe(Effect.catch(() => Effect.succeed(undefined)))

    yield* ctx.websearch.transform((editor) => {
      editor.add({
        id: ID,
        name: "Keenable",
        execute: ({ query }) =>
          Effect.gen(function* () {
            const queryKey = cacheKey(query)
            const cached = readCache(queryKey)
            if (cached) return cached

            // Keyless access is a first-class mode, so a missing key is not an
            // error: it only moves the request to the `/public` endpoint.
            const connection = yield* soften(ctx.integration.connection.active(ID))
            const credential = connection
              ? yield* soften(ctx.integration.connection.resolve(connection))
              : undefined
            const key =
              credential?.type === "key" ? credential.key : process.env.KEENABLE_API_KEY

            const headers: Record<string, string> = {
              Accept: "application/json",
              "Content-Type": "application/json",
              // Required by the keyless endpoint, where an absent value is a
              // 400. It names the calling application rather than the user, so
              // it rides along with a key too.
              "X-Keenable-Title": TITLE,
            }
            if (key) headers["X-API-Key"] = key

            const response = yield* Effect.tryPromise({
              try: (signal) =>
                fetch(key ? SEARCH_URL : PUBLIC_URL, {
                  method: "POST",
                  headers,
                  body: JSON.stringify({
                    query: queryKey,
                    max_results: SEARCH_SIZE,
                    ...(MODE ? { mode: MODE } : {}),
                  }),
                  signal: timedSignal(signal, SEARCH_TIMEOUT),
                }),
              // A timeout is its own failure: naming it stops the user hunting
              // for a key problem that was never there.
              catch: (error) =>
                error instanceof Error && error.name === "TimeoutError"
                  ? new Error("Keenable search timed out after " + SEARCH_TIMEOUT + "ms")
                  : new Error("Keenable request failed: " + String(error)),
            })

            if (!response.ok) {
              // Only a keyed call is metered, so only a keyed call can exhaust
              // the monthly allowance. The keyless pool is limited by rate, so
              // it answers 429 instead.
              if (response.status === 402 && key) {
                return yield* Effect.fail(
                  new Error(
                    "Keenable credits exhausted (HTTP 402): the free monthly " +
                      "allowance of 100,000 requests is spent. Connect Keenable " +
                      "in /connect or set KEENABLE_API_KEY to buy credits, or " +
                      "wait for the allowance to reset.",
                  ),
                )
              }
              if (response.status === 429) {
                const retry = response.headers.get("Retry-After")
                return yield* Effect.fail(
                  new Error(
                    "Keenable rate limited the request (HTTP 429)" +
                      (retry ? ", retry after " + retry + "s" : "") +
                      (key
                        ? ""
                        : ". The keyless pool allows 1,000 requests an hour and " +
                          "10 a second per IP; set KEENABLE_API_KEY to spend your " +
                          "own 100,000-request monthly allowance instead."),
                  ),
                )
              }
              const detail = yield* Effect.tryPromise({
                try: () => response.text(),
                catch: () => new Error("response body unavailable"),
              })
              return yield* Effect.fail(
                new Error("Keenable API error " + response.status + ": " + detail),
              )
            }

            const json = yield* Effect.tryPromise({
              try: () => response.json(),
              catch: (error) => new Error("Invalid Keenable response: " + String(error)),
            })

            const body = yield* Schema.decodeUnknownEffect(KeenableResponse)(json)
            const results = (body.results ?? []).map(toResult)
            writeCache(queryKey, results)
            return results
          }),
      })
    })
  })

export default Plugin.define({ id: "keenable-search", effect })
