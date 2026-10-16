import { afterEach, describe, expect, it, vi } from "vitest"
import type { Plugin } from "@opencode/plugin/effect"
import type { Effect, Scope } from "effect"
import { jsonResponse, loadPlugin, makeHarness, stubFetch } from "./harness"

interface BraveModule {
  default: { id: string }
  effect: (ctx: Plugin.Context) => Effect.Effect<void, never, Scope.Scope>
}

/**
 * Date parsing is shared byte-for-byte by every provider that emits a date
 * field (structure.test.ts enforces the copy), so exercising it through one
 * provider covers them all.
 *
 * The cases below are the ones that distinguish a careful parser from a bare
 * `Date.parse`: relative phrases in both languages, the shapes Google actually
 * emits, and the strings whose lenient parsing invents a wrong year.
 */
async function timeFor(pageAge: string | undefined): Promise<{ published?: number }> {
  const mod = await loadPlugin<BraveModule>("../brave-search", { BRAVE_SEARCH_API_KEY: "" })
  const harness = makeHarness({ credentialSequence: [{ type: "key", key: "k" }] })
  await harness.run(mod.effect(harness.ctx))

  stubFetch(() =>
    jsonResponse({
      web: {
        results: [
          {
            title: "Hit",
            url: "https://example.com/hit",
            ...(pageAge === undefined ? {} : { page_age: pageAge }),
          },
        ],
      },
    }),
  )

  const results = (await harness.run(harness.providers[0]!.execute({ query: "q" }))) as Array<{
    time: { published?: number }
  }>
  return results[0]!.time
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe("parseSearchDate", () => {
  it("accepts an ISO 8601 timestamp", async () => {
    const iso = "2026-10-01T08:30:00.000Z"
    expect(await timeFor(iso)).toEqual({ published: Date.parse(iso) })
  })

  it("accepts a date-only ISO day", async () => {
    const day = "2026-10-01"
    expect(await timeFor(day)).toEqual({ published: Date.parse(day) })
  })

  it.each([
    ["Sep 30, 2026"],
    ["31 Mar 2026"],
    ["3 Jan 2022"],
  ])("accepts the absolute date shape %s", async (value) => {
    expect(await timeFor(value)).toEqual({ published: Date.parse(value) })
  })

  it("resolves an English relative phrase against now", async () => {
    const before = Date.now()
    const { published } = await timeFor("3 hours ago")
    const after = Date.now()

    expect(published).toBeGreaterThanOrEqual(before - 3 * 3_600_000 - 1_000)
    expect(published).toBeLessThanOrEqual(after - 3 * 3_600_000 + 1_000)
  })

  it("resolves a Chinese relative phrase against now", async () => {
    const before = Date.now()
    const { published } = await timeFor("3小时前")
    const after = Date.now()

    expect(published).toBeGreaterThanOrEqual(before - 3 * 3_600_000 - 1_000)
    expect(published).toBeLessThanOrEqual(after - 3 * 3_600_000 + 1_000)
  })

  it("drops a date instead of trusting Date.parse on an incomplete shape", async () => {
    // `Date.parse("Nov 1")` invents the year 2001, which would silently date a
    // result to a quarter century ago. An unrecognised shape is no date.
    expect(await timeFor("Nov 1")).toEqual({})
    expect(await timeFor("yesterday-ish")).toEqual({})
    expect(await timeFor("")).toEqual({})
    expect(await timeFor(undefined)).toEqual({})
  })

  it("keeps the month/year rounding the relative phrase implies", async () => {
    const before = Date.now()
    const { published } = await timeFor("2 weeks ago")
    const after = Date.now()
    const twoWeeks = 14 * 86_400_000

    expect(published).toBeGreaterThanOrEqual(before - twoWeeks - 1_000)
    expect(published).toBeLessThanOrEqual(after - twoWeeks + 1_000)
  })
})
