import { afterEach, describe, expect, it, vi } from "vitest"
import { jsonResponse, loadPlugin, makeHarness, stubFetch, type Harness } from "./harness"

/**
 * The malformed-hit policy: a single result missing its URL (or title, where
 * the schema required one) is dropped, and the rest of the page survives.
 * These providers decoded with required per-item fields until this suite was
 * added -- one half-formed row failed the entire search.
 */

const KEY = { type: "key" as const, key: "test-key" }

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

/** Loads one provider module and runs its effect against a bound harness. */
async function bind(file: string): Promise<Harness> {
  const mod = (await loadPlugin<{ effect: (ctx: never) => never }>(
    `../plugins/${file}`,
  )) as unknown as { effect: (ctx: unknown) => { [k: string]: unknown } }
  const harness = makeHarness({ credentialSequence: [KEY] })
  const run = harness.run as unknown as (self: unknown) => Promise<unknown>
  await run(mod.effect(harness.ctx))
  return harness
}

describe("a malformed hit is dropped, not the page", () => {
  it("brave: a hit without a url or title leaves the healthy rows", async () => {
    const harness = await bind("brave-search")
    stubFetch(() =>
      jsonResponse({
        web: {
          results: [
            { title: "no url", description: "half-formed" },
            { url: "https://example.com/a", title: "t", description: "d" },
            { url: "https://example.com/b" }, // no title: falls back to the URL
          ],
        },
      }),
    )
    const results = (await harness.run(
      harness.providers[0]!.execute({ query: "q" }),
    )) as unknown as Array<{ url: string; title: string }>

    expect(results).toHaveLength(2)
    expect(results[0]).toMatchObject({ url: "https://example.com/a", title: "t" })
    expect(results[1]).toMatchObject({ url: "https://example.com/b", title: "https://example.com/b" })
  })

  it("bocha: a null-url hit is dropped and the rest survive", async () => {
    const harness = await bind("bocha-search")
    stubFetch(() =>
      jsonResponse({
        data: {
          webPages: {
            value: [
              { name: "null url", url: null, snippet: "half-formed" },
              { url: "https://example.com/a", snippet: "s" },
            ],
          },
        },
      }),
    )
    const results = (await harness.run(
      harness.providers[0]!.execute({ query: "q" }),
    )) as unknown as Array<{ url: string }>

    expect(results).toHaveLength(1)
    expect(results[0]!.url).toBe("https://example.com/a")
  })

  it("doubao: a hit without Url is dropped and the rest survive", async () => {
    const harness = await bind("doubao-search")
    stubFetch(() =>
      jsonResponse({
        Result: {
          WebResults: [
            { Title: "no url", Snippet: "half-formed" },
            { Url: "https://example.com/a", Title: "t", Snippet: "s" },
          ],
        },
      }),
    )
    const results = (await harness.run(
      harness.providers[0]!.execute({ query: "q" }),
    )) as unknown as Array<{ url: string }>

    expect(results).toHaveLength(1)
    expect(results[0]!.url).toBe("https://example.com/a")
  })

  it("metaso: a hit without link is dropped and the rest survive", async () => {
    const harness = await bind("metaso-search")
    stubFetch(() =>
      jsonResponse({
        webpages: [
          { title: "no link", snippet: "half-formed" },
          { link: "https://example.com/a", snippet: "s" },
        ],
      }),
    )
    const results = (await harness.run(
      harness.providers[0]!.execute({ query: "q" }),
    )) as unknown as Array<{ url: string }>

    expect(results).toHaveLength(1)
    expect(results[0]!.url).toBe("https://example.com/a")
  })

  it("kagi: a hit without url or title leaves the healthy rows", async () => {
    const harness = await bind("kagi-search")
    stubFetch(() =>
      jsonResponse({
        data: {
          search: [
            { title: "no url" },
            { url: "https://example.com/a", title: "t", snippet: "s" },
            { url: "https://example.com/b", snippet: "s" },
          ],
        },
      }),
    )
    const results = (await harness.run(
      harness.providers[0]!.execute({ query: "q" }),
    )) as unknown as Array<{ url: string; title: string }>

    expect(results).toHaveLength(2)
    expect(results[1]!.title).toBe("https://example.com/b")
  })
})
