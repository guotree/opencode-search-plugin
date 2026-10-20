import { afterEach, describe, expect, it, vi } from "vitest"
import type { Effect, Scope } from "effect"
import type { Plugin } from "@opencode/plugin/effect"
import { jsonResponse, loadPlugin, makeHarness, stubFetch } from "./harness"

/**
 * The cache block is copied byte-for-byte into all nineteen provider files,
 * so it is exercised here through Brave -- the same trick dates.test.ts uses
 * for the shared date parser. Three behaviors are pinned:
 *
 *   1. Eviction is least-recently-used: a query that is actually being
 *      reused survives insertion pressure instead of being dropped for the
 *      crime of arriving first.
 *   2. An empty result set is remembered for a short beat, not the full
 *      TTL: one upstream wobble must not lock retries out for ten minutes.
 *   3. The TTL runs from the fetch, never from a later hit, so a hot entry
 *      can outlive its neighbors but never its own freshness bound.
 *
 * `CACHE_TTL=0` and expiry itself are pinned here too; before this file,
 * none of the three cache branches had a test.
 */

interface ProviderModule {
  default: { id: string }
  effect: (ctx: Plugin.Context) => Effect.Effect<void, never, Scope.Scope>
}

const CREDENTIAL = { type: "key", key: "cache-test-key" } as const

const HIT = { web: { results: [{ title: "T", url: "https://e.com" }] } }
const EMPTY = { web: { results: [] } }

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

async function bind(env: Record<string, string> = {}, body: unknown = HIT) {
  const mod = await loadPlugin<ProviderModule>("../plugins/brave-search", {
    OSP_BRAVE_API_KEY: "",
    ...env,
  })
  const harness = makeHarness({ credentialSequence: [CREDENTIAL] })
  await harness.run(mod.effect(harness.ctx))
  const fetch = stubFetch(() => jsonResponse(body))
  const search = (query: string) => harness.run(harness.providers[0]!.execute({ query }))
  return { search, fetch }
}

describe("cache eviction", () => {
  it("keeps a hot query past the point where insertion order would evict it", async () => {
    // Fill the 200-slot cache exactly, with "hot" as the first entry, then
    // hit "hot" five times and push five new queries in. Under insertion-
    // order eviction "hot" dies on the first push; under least-recently-
    // used it sits at the tail and survives, so the final search is free.
    const { search, fetch } = await bind()

    await search("hot")
    for (let i = 0; i < 199; i++) await search(`filler-${i}`)
    for (let i = 0; i < 5; i++) await search("hot")
    for (let i = 0; i < 5; i++) await search(`newcomer-${i}`)
    await search("hot")

    // hot + 199 fillers + 5 newcomers, all fetched once; the five mid-run
    // hits and the closing search must all be served from the cache.
    expect(fetch.calls).toHaveLength(205)
  })

  it("still evicts the least recently used query once the limit is passed", async () => {
    const { search, fetch } = await bind()

    for (let i = 0; i < 200; i++) await search(`q${i}`)
    await search("q200") // one past the limit: q0 must go
    await search("q0") // back for the evicted one: full price again
    await search("q200") // the newest entry must still be cached

    // 200 fillers + q200 + the q0 refetch; the closing q200 is a hit.
    expect(fetch.calls).toHaveLength(202)
  })
})

describe("cache expiry", () => {
  it("serves a repeat within the TTL and refetches after it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    const { search, fetch } = await bind({ BRAVE_CACHE_TTL: "1000" })
    const t0 = Date.now()

    await search("q")
    vi.setSystemTime(t0 + 900)
    await search("q") // inside the window: a hit
    vi.setSystemTime(t0 + 1100)
    await search("q") // past it: pay again

    expect(fetch.calls).toHaveLength(2)
  })

  it("keeps the TTL anchored to the fetch even when the entry is hit mid-life", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    const { search, fetch } = await bind() // default TTL, 600s
    const t0 = Date.now()

    await search("q")
    vi.setSystemTime(t0 + 500_000)
    await search("q") // hit at 500s
    vi.setSystemTime(t0 + 601_000)
    await search("q") // 601s after the fetch: expired, hit or not

    expect(fetch.calls).toHaveLength(2)
  })

  it("does not cache at all when CACHE_TTL=0", async () => {
    const { search, fetch } = await bind({ BRAVE_CACHE_TTL: "0" })

    await search("q")
    await search("q")
    await search("q")

    expect(fetch.calls).toHaveLength(3)
  })
})

describe("cache of empty results", () => {
  it("remembers an empty result briefly instead of for the whole TTL", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    const { search, fetch } = await bind({}, EMPTY) // default TTL, 600s
    const t0 = Date.now()

    await search("nothing here")
    vi.setSystemTime(t0 + 20_000)
    await search("nothing here") // within the short pin: a hit
    vi.setSystemTime(t0 + 31_000)
    await search("nothing here") // past the pin, well inside the TTL: refetch

    expect(fetch.calls).toHaveLength(2)
  })

  it("never pins an empty result longer than the TTL itself", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    const { search, fetch } = await bind({ BRAVE_CACHE_TTL: "500" }, EMPTY)
    const t0 = Date.now()

    await search("nothing here")
    vi.setSystemTime(t0 + 600)
    await search("nothing here") // the pin is min(TTL, 30s): already gone

    expect(fetch.calls).toHaveLength(2)
  })

  it("still caches a non-empty result for the full TTL", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    const { search, fetch } = await bind({}, HIT) // default TTL, 600s
    const t0 = Date.now()

    await search("q")
    vi.setSystemTime(t0 + 599_000)
    await search("q") // late, but a full-TTL entry

    expect(fetch.calls).toHaveLength(1)
  })
})
