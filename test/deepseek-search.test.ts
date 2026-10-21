import { afterEach, describe, expect, it, vi } from "vitest"
import { jsonResponse, loadPlugin, makeHarness, stubFetch } from "./harness"

type DeepSeek = typeof import("../plugins/deepseek-search")

const NO_KEY: Record<string, string> = { OSP_DEEPSEEK_API_KEY: "" }

/** Bound with a stored credential, env applied on top of `NO_KEY`. */
async function bind(env: Record<string, string> = {}) {
  const mod = await loadPlugin<DeepSeek>("../plugins/deepseek-search", { ...NO_KEY, ...env })
  const harness = makeHarness({ credentialSequence: [{ type: "key", key: "deepseek-key" }] })
  await harness.run(mod.effect(harness.ctx))
  return { harness }
}

interface HitResult {
  url: string
  title: string
  content: string
  time: { published?: number }
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe("deepseek-search", () => {
  it("sends the documented body to the tools endpoint with the default count", async () => {
    const { harness } = await bind()
    const fetch = stubFetch(() => jsonResponse({ results: [] }))

    await harness.run(harness.providers[0]!.execute({ query: "  hello   world  " }))

    const { url, init, body } = fetch.calls[0]!
    expect(url.href).toBe("https://api.deepseek.com/v1/tools/search")
    expect(init?.method).toBe("POST")
    expect(body).toEqual({ query: "hello world", count: 10 })
  })

  it("clamps DEEPSEEK_COUNT to the API's 1-50 range", async () => {
    const low = await bind({ DEEPSEEK_COUNT: "0" })
    const lowFetch = stubFetch(() => jsonResponse({ results: [] }))
    await low.harness.run(low.harness.providers[0]!.execute({ query: "q" }))
    expect((lowFetch.calls[0]!.body as { count: number }).count).toBe(1)

    const high = await bind({ DEEPSEEK_COUNT: "999" })
    const highFetch = stubFetch(() => jsonResponse({ results: [] }))
    await high.harness.run(high.harness.providers[0]!.execute({ query: "q" }))
    expect((highFetch.calls[0]!.body as { count: number }).count).toBe(50)
  })

  it("maps content from summary, as an empty string when the hit carries none", async () => {
    const { harness } = await bind()
    stubFetch(() =>
      jsonResponse({
        results: [
          { title: "With summary", url: "https://example.com/one", summary: "The summary" },
          { url: "https://example.com/two" },
        ],
      }),
    )

    const results = (await harness.run(
      harness.providers[0]!.execute({ query: "q" }),
    )) as HitResult[]

    // A missing summary means "the source provided none": the agent sees an
    // empty content string, never an absent field.
    expect(results).toEqual([
      { url: "https://example.com/one", title: "With summary", content: "The summary", time: {} },
      { url: "https://example.com/two", title: "https://example.com/two", content: "", time: {} },
    ])
  })

  it("decodes a body with no results key as an empty page", async () => {
    const { harness } = await bind()
    stubFetch(() => jsonResponse({}))

    const results = await harness.run(harness.providers[0]!.execute({ query: "q" }))
    expect(results).toEqual([])
  })

  it("accepts the documented null date as unknown instead of failing the decode", async () => {
    const { harness } = await bind()
    // DeepSeek emits RFC 3339 dates, with null when the publication time is
    // unknown -- the null must decode, it must not take the whole page down.
    stubFetch(() =>
      jsonResponse({ results: [{ url: "https://example.com/x", summary: "s", date: null }] }),
    )

    const results = (await harness.run(
      harness.providers[0]!.execute({ query: "q" }),
    )) as HitResult[]

    expect(results[0]!.time).toEqual({})
  })
})
