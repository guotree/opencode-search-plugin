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
  return Number.isFinite(value) && value >= 0 ? value : fallback
}`

const CACHE_BLOCK = `function cacheKey(query: string): string {
  return query.trim().replace(/\\s+/g, " ")
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

/** Files that carry a date field and must therefore share the date parser. */
const WITH_DATES = [
  "brave-search",
  "deepseek-search",
  "keenable-search",
  "metaso-search",
  "querit-search",
  "serpapi-search",
  "serper-search",
  "youcom-search",
]

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
      expect(source, `${file} cache`).toContain(CACHE_BLOCK)
      expect(source, `${file} credential read`).toContain(SOFTEN_BLOCK)
      expect(source, `${file} must export a composable effect`).toContain(
        "export const effect = (ctx: Plugin.Context) =>",
      )
    }

    for (const file of WITH_DATES) {
      const source = providerSource(file)
      expect(source, `${file} date parser`).toContain(DATE_BLOCK)
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

/** `anysearch-search` -> `anysearch`, so the import binding reads as a name. */
function safeName(file: string): string {
  return file.replace(/-search$/, "")
}
