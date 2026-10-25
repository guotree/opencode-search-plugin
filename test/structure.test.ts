import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { PROVIDER_CASES } from "./cases"

const root = fileURLToPath(new URL("..", import.meta.url))

const read = (file: string) => readFileSync(join(root, file), "utf8")

/** A provider's source, which always lives under `plugins/`. */
const providerSource = (file: string) => read(`plugins/${file}.ts`)

/**
 * The shared blocks below are copied verbatim into every file that needs them,
 * because each file must stay runnable when copied out of this repository on
 * its own. They are asserted byte-for-byte so a fix lands in all copies at once
 * instead of drifting between them.
 *
 * If one of these assertions fails, the change belongs in every listed file.
 * See CONTRIBUTING.md.
 */
const ENV_INT = `function envInt(name: string, fallback: number): number {
  const raw = (process.env[name] ?? "").trim()
  if (raw === "") return fallback
  const value = Number(raw)
  return Number.isInteger(value) && value >= 0 ? value : fallback
}`

const ERROR_DETAIL_BLOCK = `const ERROR_DETAIL_CHARS = 300

function boundDetail(detail: string): string {
  if (detail.length <= ERROR_DETAIL_CHARS) return detail
  const points = [...detail]
  if (points.length <= ERROR_DETAIL_CHARS) return detail
  return points.slice(0, ERROR_DETAIL_CHARS).join("") + "… [truncated]"
}`

const RETRY_HINT_BLOCK = `function retryHint(retry: string | null): string {
  const value = retry?.trim()
  if (!value) return ""
  return ", retry after " + value + (/^\\d+$/.test(value) ? "s" : "")
}`

const WITH_RETRY_HINT = [
  "bocha-search", "doubao-search", "keenable-search",
  "stepfun-search", "zai-search", "zhipu-search",
]

const CACHE_BLOCK = `const EMPTY_RESULT_TTL = 30_000
const cache = new Map<string, { at: number; ttl: number; results: SearchResult[] }>()

function cacheKey(query: string): string {
  return query.trim().replace(/\\s+/g, " ")
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
}`

const DATE_BLOCK = `function parseSearchDate(value: string | undefined): number {
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
}`

const SOFTEN_BLOCK = `const soften = <A>(read: Effect.Effect<A, unknown>): Effect.Effect<A | undefined, never> =>
      read.pipe(Effect.catch(() => Effect.succeed(undefined)))`

const TIMED_SIGNAL_BLOCK = `// A hung upstream must not hang the agent: the deadline bounds it, and the
// thunk's signal carries host cancellation into the socket. \`timeout <= 0\`
// removes the deadline but never the cancellation, because
// \`AbortSignal.timeout(0)\` aborts instantly rather than "never".
function timedSignal(signal: AbortSignal, timeout: number): AbortSignal {
  return timeout > 0 ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : signal
}`

/**
 * The credential-rebind subscription. Nineteen files carry it; the two
 * keyless providers (anysearch, keenable) bind at startup and have no
 * credential to rebind, so they must not subscribe at all.
 */
const EVENT_BLOCK = `    yield* Effect.forkScoped(
      ctx.event.subscribe().pipe(
        Stream.filter(
          (event) =>
            event.type === "credential.updated" ||
            event.type === "credential.switched" ||
            event.type === "integration.updated",
        ),
        Stream.mapEffect(() =>
          // One failed rebind must not kill the subscription: the next
          // credential event still has to reach the reload. \`bound\` moves
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
    )`

/** Files that carry a date field and must therefore share the date parser. */
/** Files that carry a date field and must therefore share the date parser. */
const WITH_DATES = [
  "bocha-search",
  "brave-search",
  "deepseek-search",
  "doubao-search",
  "kagi-search",
  "keenable-search",
  "metaso-search",
  "moonshot-cn-search",
  "moonshot-search",
  "perplexity-search",
  "querit-search",
  "serpapi-search",
  "serper-search",
  "stepfun-search",
  "youcom-search",
  "zai-search",
  "zhipu-search",
]

/**
 * Files that bound their own HTTP request. The host applies no deadline around
 * a provider's `execute`, so a provider that omits this can hang the agent for
 * as long as the upstream stays silent.
 *
 * Every file that fetches belongs here. Each reads the budget from its own
 * `*_TIMEOUT` variable and falls back to 25s, matching the built-in providers.
 * `jina-search` is the exception: its default depends on `JINA_INCLUDE_CONTENT`,
 * because whole-page fetches legitimately take far longer than a snippet search.
 */
const WITH_TIMEOUT = [
  "anysearch-search",
  "bocha-search",
  "brave-search",
  "deepseek-search",
  "doubao-search",
  "jina-search",
  "kagi-search",
  "keenable-search",
  "linkup-search",
  "metaso-search",
  "moonshot-cn-search",
  "moonshot-search",
  "ollama-search",
  "perplexity-search",
  "querit-search",
  "serpapi-search",
  "serper-search",
  "stepfun-search",
  "youcom-search",
  "zai-search",
  "zhipu-search",
]

/**
 * Providers with an anonymous tier, which bind at startup and never rebind:
 * there is no credential to change, so these files carry no event
 * subscription. Mirrors `KEYLESS` in providers.test.ts.
 */
const KEYLESS = ["anysearch-search", "keenable-search"]

describe("repository structure", () => {
  it("exposes every provider as a standalone file with no cross-file imports", () => {
    for (const { file } of PROVIDER_CASES) {
      const source = providerSource(file)
      expect(source, `${file} must not import a sibling module`).not.toMatch(
        /from\s+["']\.\.?\//,
      )
      expect(source, `${file} must not require a build step`).not.toMatch(
        /require\s*\(\s*["']\.\.?\//,
      )
    }
  })

  it("names each plugin after its file", () => {
    for (const { file, pluginID } of PROVIDER_CASES) {
      const source = providerSource(file)
      expect(source, `${file} default export`).toContain(
        `export default Plugin.define({ id: "${pluginID}", effect })`,
      )
      expect(pluginID).toBe(file)
    }
  })

  it("keeps plugin, provider and integration IDs from drifting apart", () => {
    const ids = PROVIDER_CASES.map(({ providerID, pluginID }) => pluginID)
    expect(new Set(ids).size).toBe(PROVIDER_CASES.length)

    for (const { file, providerID } of PROVIDER_CASES) {
      const source = providerSource(file)
      // The provider ID appears as `editor.add({ id: "..." })` and as the
      // integration ID; both must agree or `/connect` credentials would be
      // stored against an ID the websearch pool never reads.
      expect(source, `${file} provider id`).toContain(`const ID = "${providerID}"`)
      expect(source).toContain(`editor.add({\n        id: ID,`)
    }
  })

  it("copies the shared blocks into every file that needs them", () => {
    for (const { file } of PROVIDER_CASES) {
      const source = providerSource(file)
      expect(source, `${file} envInt`).toContain(ENV_INT)
      expect(source, `${file} error detail bound`).toContain(ERROR_DETAIL_BLOCK)
      expect(source, `${file} cache`).toContain(CACHE_BLOCK)
      expect(source, `${file} credential read`).toContain(SOFTEN_BLOCK)
      expect(source, `${file} must export a composable effect`).toContain(
        "export const effect = (ctx: Plugin.Context) =>",
      )
    }

    for (const { file } of PROVIDER_CASES) {
      const source = providerSource(file)
      if (WITH_RETRY_HINT.includes(file)) {
        expect(source, `${file} retry hint`).toContain(RETRY_HINT_BLOCK)
        expect(source, `${file} applies retry hint`).toContain("retryHint(retry) +")
      } else {
        expect(source, `${file} has no Retry-After hint`).not.toContain("function retryHint(")
      }
    }

    for (const file of WITH_DATES) {
      const source = providerSource(file)
      expect(source, `${file} date parser`).toContain(DATE_BLOCK)
    }

    for (const file of WITH_TIMEOUT) {
      const source = providerSource(file)
      expect(source, `${file} request deadline`).toContain(TIMED_SIGNAL_BLOCK)
      // The deadline must actually be applied, not merely defined.
      expect(source, `${file} applies the deadline`).toContain("signal: timedSignal(signal, ")
      expect(source, `${file} names its timeout`).toContain('_TIMEOUT", ')
    }

    // The rebind subscription binds every credentialed provider: the two
    // keyless files have no credential, so they carry no subscription and
    // the other nineteen must carry this exact block.
    for (const { file } of PROVIDER_CASES) {
      const source = providerSource(file)
      if (KEYLESS.includes(file)) {
        expect(source, `${file} is keyless and must not subscribe`).not.toContain(
          "Effect.forkScoped",
        )
      } else {
        expect(source, `${file} event subscription`).toContain(EVENT_BLOCK)
      }
    }

    // Files without a date field must not carry a parser they never call.
    for (const { file } of PROVIDER_CASES.filter((c) => !WITH_DATES.includes(c.file))) {
      expect(providerSource(file), `${file} has no date field`).not.toContain("parseSearchDate")
    }
  })

  it("wires every provider into the aggregate entrypoint", () => {
    const index = read("index.ts")
    for (const { file, providerID } of PROVIDER_CASES) {
      expect(index, `index.ts must import ${file}`).toContain(
        `import { effect as ${safeName(file)} } from "./plugins/${file}"`,
      )
      expect(index, `index.ts must register ${providerID}`).toContain(
        `["${providerID}", ${safeName(file)}]`,
      )
    }
  })

  it("uses unique provider IDs", () => {
    const ids = PROVIDER_CASES.map((c) => c.providerID)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

/** `anysearch-search` -> `anysearch`, `moonshot-cn-search` -> `moonshotcn`. */
function safeName(file: string): string {
  return file.replace(/-search$/, "").replace(/-/g, "")
}
