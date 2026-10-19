import { Plugin } from "@opencode/plugin/effect"
import { Effect, Schema, Stream } from "effect"

// Z.ai is Zhipu's international site: a separate account system from
// open.bigmodel.cn (registered here as `osp-zhipu`), with its own keys, its
// own single engine and its own dollar pricing. The two sites are two
// providers rather than one with a site knob because a key issued by one
// cannot authenticate against the other -- each binds on its own credential,
// so neither can be handed the wrong site's key by a config default. The
// response envelope is the cn site's, hit for hit: `id`/`created`/`request_id`
// name the call and ride along unread. A hit carries `media` (site name),
// `icon` and `refer` (the citation index the chat product stamps its answers
// with) next to the four fields mapped below. All four decode as nullable and
// a hit without a URL is dropped, so one malformed row cannot fail the whole
// list.
const ZaiHit = Schema.Struct({
  title: Schema.optional(Schema.NullOr(Schema.String)),
  content: Schema.optional(Schema.NullOr(Schema.String)),
  link: Schema.optional(Schema.NullOr(Schema.String)),
  // "2025-05-23" in the documented examples, or absent when unknown.
  publish_date: Schema.optional(Schema.NullOr(Schema.String)),
})

const ZaiResponse = Schema.Struct({
  // Absent or null when the search found nothing.
  search_result: Schema.optional(Schema.NullOr(Schema.Array(ZaiHit))),
})

// The /connect integration ID, and the websearch provider ID it binds to.
// The `osp-` prefix is this package's namespace: OpenCode's built-ins and a
// vendor plugin's own entry are bare vendor names, so `zai` would collide
// with them, and with the opencode.db row keyed by integration ID.
const ID = "osp-zai"

function envInt(name: string, fallback: number): number {
  const raw = (process.env[name] ?? "").trim()
  if (raw === "") return fallback
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

function envStr(name: string): string {
  return (process.env[name] ?? "").trim()
}

// Z.ai stamps `publish_date` as a bare calendar date ("2025-05-23"), a shape
// the parser below already accepts as-is. The relative-date tables still ship
// byte-identical with the other providers in this package -- the parser comes
// from the same shared block, and `test/structure.test.ts` compares it byte
// for byte.
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

// `publish_date` is the only time field in a hit, and it is a bare calendar
// date in the documented examples -- parsed by the shared block above, and
// left as no `time` at all when absent or unparseable.
function toResult(item: {
  title?: string | null | undefined
  content?: string | null | undefined
  link?: string | null | undefined
  publish_date?: string | null | undefined
}) {
  // A hit without a URL cannot be opened, cited, or read as a source, so it
  // leaves the list instead of reaching the agent as a dead card.
  if (!item.link) return undefined
  const published = parseSearchDate(item.publish_date ?? undefined)
  return {
    url: item.link,
    // The docs always fill `title` in their examples, but `link` is the field
    // the mapping insists on, so it is also the one thing a title can fall
    // back to rather than leave the result untitled.
    title: item.title || item.link,
    // `content` is the excerpt Z.ai derived for the hit. `||`, not `??`: an
    // empty string means there was no excerpt worth reading, and an empty
    // string is not an answer worth handing the agent.
    content: item.content || "",
    time: Number.isFinite(published) ? { published } : {},
  }
}

type SearchResult = NonNullable<ReturnType<typeof toResult>>

// Z.ai bills per search -- $0.01 on Search-Prime, the only engine the intl
// spec enumerates -- with no free tier and no anonymous tier, so a repeat
// query is a dispatch worth skipping. Knobs are read once at load time, so
// restart after changing them.
//
//   ZAI_CACHE_TTL    ms to reuse a response for the same query (0 disables)
//   ZAI_COUNT        results per search, clamped to 1-50 (the API's range)
//   ZAI_RECENCY      oneDay, oneWeek, oneMonth, oneYear, noLimit; unset
//                    omits the parameter, which is the API's noLimit default
//   ZAI_TIMEOUT      ms to wait before failing (0 removes the deadline)
//   OSP_ZAI_API_KEY  required; from https://z.ai/manage-apikey/apikey-list
const CACHE_TTL = envInt("ZAI_CACHE_TTL", 600_000)
// OpenCode's own providers each bounded themselves at 25s, and the host adds
// no deadline of its own around `execute`, so this is the only one that exists.
const SEARCH_TIMEOUT = envInt("ZAI_TIMEOUT", 25_000)
const COUNT = Math.min(Math.max(envInt("ZAI_COUNT", 10), 1), 50)
const RECENCY = envStr("ZAI_RECENCY")

// One endpoint, one account system, one engine. The key comes from
// https://z.ai, and a bigmodel.cn key answers 401 here.
const SEARCH_URL = "https://api.z.ai/api/paas/v4/web_search"

// `search-prime` is the only value the intl spec's `search_engine` enum
// documents (and its documented default), so it is sent explicitly and there
// is no engine knob mirroring cn's four -- the enum has nothing to choose
// between. The parameter description mentioning `search_pro_jina` names a
// value the enum does not contain; the docs themselves flag that text as
// stale, so it is not wired up on the strength of it.
const ENGINE = "search-prime"

// Unlike cn, whose spec caps `search_query` at 70 characters (`maxLength: 70`)
// and cuts to it in `osp-zhipu`, the intl reference publishes no length
// ceiling -- so the query is sent intact rather than cut to a limit this
// endpoint never stated. The cache still keys on the normalized query, as
// everywhere else in this package.

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

// Z.ai does not document this endpoint's refusal body, so the detail is read
// for whichever shape it actually arrives in: the OpenAI-compatible
// `{"error":{"code","message"}}` the platform's chat API answers with, or a
// flat `{"code","message"}` carrying the search-specific codes. A body in any
// other shape stands in as the detail verbatim.
function describeFailure(detail: string): string {
  try {
    const body: unknown = JSON.parse(detail)
    if (typeof body === "object" && body !== null) {
      const record = body as Record<string, unknown>
      const source = (
        typeof record.error === "object" && record.error !== null ? record.error : record
      ) as Record<string, unknown>
      const message =
        typeof source.message === "string" && source.message !== ""
          ? source.message
          : typeof source.msg === "string" && source.msg !== ""
            ? source.msg
            : ""
      if (message !== "") {
        const code = source.code
        const named =
          code === undefined || code === null || code === "" ? "" : ` (code ${String(code)})`
        return message + named
      }
    }
  } catch {
    // Not JSON: the raw body is the only detail there is.
  }
  return detail
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
    // Make "Z.ai Search" show up in /connect with an API-key method.
    yield* ctx.integration.transform((editor) => {
      editor.update(ID, (integration) => {
        integration.name = "Z.ai Search (osp)"
      })
      editor.method.update({
        integrationID: ID,
        method: { type: "key", label: "Z.ai API key" },
      })
      editor.method.update({
        integrationID: ID,
        method: { type: "env", names: ["OSP_ZAI_API_KEY"] },
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
        return credential?.type === "key" ? credential.key : process.env.OSP_ZAI_API_KEY
      })

    // Z.ai has no anonymous tier, so the provider binds only while a key
    // exists. Deleting the key unbinds it, and `random` can never pick a
    // keyless Z.ai. The transform replays on reload and reads `bound` as it
    // stands then.
    let bound = Boolean(yield* resolveKey())

    yield* ctx.websearch.transform((editor) => {
      if (!bound) return
      editor.add({
        id: ID,
        name: "Z.ai Search",
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
                new Error("Connect Z.ai Search in /connect, or set OSP_ZAI_API_KEY"),
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
                    search_query: queryKey,
                    search_engine: ENGINE,
                    count: COUNT,
                    // Omitted rather than sent as "noLimit": the two mean the
                    // same thing, and noLimit is the documented default.
                    ...(RECENCY ? { search_recency_filter: RECENCY } : {}),
                  }),
                  signal: timedSignal(signal, SEARCH_TIMEOUT),
                }),
              // A timeout is its own failure: naming it stops the user hunting
              // for a key problem that was never there.
              catch: (error) =>
                error instanceof Error && error.name === "TimeoutError"
                  ? new Error("Z.ai search timed out after " + SEARCH_TIMEOUT + "ms")
                  : new Error("Z.ai request failed: " + String(error)),
            })

            if (!response.ok) {
              const detail = yield* Effect.tryPromise({
                try: () => response.text(),
                catch: () => new Error("response body unavailable"),
              })
              const described = describeFailure(String(detail))

              // A 401 here is most often a cn key: the two sites are separate
              // account systems, and the fix is a different provider, not a
              // different string in the same box.
              if (response.status === 401) {
                return yield* Effect.fail(
                  new Error(
                    "Z.ai rejected the API key (HTTP 401): " +
                      described +
                      ". Connect Z.ai Search in /connect or set OSP_ZAI_API_KEY to a key from https://z.ai/manage-apikey/apikey-list. A key issued on open.bigmodel.cn belongs to Zhipu Search (osp-zhipu) instead",
                  ),
                )
              }
              if (response.status === 429) {
                const retry = response.headers.get("Retry-After")
                return yield* Effect.fail(
                  new Error(
                    "Z.ai rate limited the request (HTTP 429)" +
                      (retry ? ", retry after " + retry + "s" : "") +
                      ": " +
                      described +
                      ". Concurrent searches are capped per account; retry shortly or run fewer searches at once",
                  ),
                )
              }
              return yield* Effect.fail(
                new Error("Z.ai API error " + response.status + ": " + described),
              )
            }

            const json = yield* Effect.tryPromise({
              try: () => response.json(),
              catch: (error) => new Error("Invalid Z.ai response: " + String(error)),
            })

            const body = yield* Schema.decodeUnknownEffect(ZaiResponse)(json)
            const results = (body.search_result ?? [])
              .map(toResult)
              .filter((result): result is SearchResult => result !== undefined)

            // Z.ai charges per dispatch, so a result that never enters the
            // cache is a query paid for again on every repeat.
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

export default Plugin.define({ id: "zai-search", effect })
