import { afterEach, describe, expect, it, vi } from "vitest"
import { jsonResponse, loadPlugin, makeHarness, stubFetch } from "./harness"

type Zai = typeof import("../plugins/zai-search")

const NO_KEY: Record<string, string> = { OSP_ZAI_API_KEY: "" }

/** Bound with a stored credential, env applied on top of `NO_KEY`. */
async function bind(env: Record<string, string> = {}) {
  const mod = await loadPlugin<Zai>("../plugins/zai-search", { ...NO_KEY, ...env })
  const harness = makeHarness({ credentialSequence: [{ type: "key", key: "zai-key" }] })
  await harness.run(mod.effect(harness.ctx))
  return { mod, harness }
}

interface HitResult {
  url: string
  title: string
  content: string
  time: { published?: number }
}

const EMPTY = { search_result: [] }

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe("zai-search", () => {
  it("sends the documented intl body: search-prime, no search_intent, no content_size", async () => {
    const { harness } = await bind()
    const fetch = stubFetch(() => jsonResponse(EMPTY))

    await harness.run(harness.providers[0]!.execute({ query: "  hello   world  " }))

    const { url, init } = fetch.calls[0]!
    expect(url.host).toBe("api.z.ai")
    expect(url.pathname).toBe("/api/paas/v4/web_search")
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer zai-key",
      "Content-Type": "application/json",
    })
    // `search-prime` is the intl spec's only engine and is always sent; the
    // optional filters are absent rather than sent as their default values.
    expect(fetch.calls[0]!.body).toEqual({
      search_query: "hello world",
      search_engine: "search-prime",
      count: 10,
    })
  })

  it("sends the recency and count the knobs ask for", async () => {
    const { harness } = await bind({ ZAI_RECENCY: "oneWeek", ZAI_COUNT: "20" })
    const fetch = stubFetch(() => jsonResponse(EMPTY))

    await harness.run(harness.providers[0]!.execute({ query: "q" }))

    expect(fetch.calls[0]!.body).toEqual({
      search_query: "q",
      search_engine: "search-prime",
      count: 20,
      search_recency_filter: "oneWeek",
    })
  })

  it("clamps count to the API's 1-50 range", async () => {
    const { harness } = await bind({ ZAI_COUNT: "500" })
    const fetch = stubFetch(() => jsonResponse(EMPTY))

    await harness.run(harness.providers[0]!.execute({ query: "q" }))

    expect((fetch.calls[0]!.body as { count: number }).count).toBe(50)
  })

  it("sends a long query intact: the intl spec documents no length ceiling", async () => {
    const { harness } = await bind()
    const fetch = stubFetch(() => jsonResponse(EMPTY))

    // cn cuts this to 70 characters; the intl reference publishes no
    // maxLength, so nothing is cut.
    const query = "搜".repeat(100)
    await harness.run(harness.providers[0]!.execute({ query }))
    expect((fetch.calls[0]!.body as { search_query: string }).search_query).toBe(query)
  })

  it("maps a hit, and reads publish_date as the bare date it is", async () => {
    const { harness } = await bind()
    stubFetch(() =>
      jsonResponse({
        search_result: [
          {
            title: "Z.ai hit",
            content: "Z.ai snippet",
            link: "https://example.com/zai",
            publish_date: "2025-05-23",
          },
        ],
      }),
    )

    const results = (await harness.run(
      harness.providers[0]!.execute({ query: "q" }),
    )) as HitResult[]

    expect(results[0]).toEqual({
      url: "https://example.com/zai",
      title: "Z.ai hit",
      content: "Z.ai snippet",
      time: { published: Date.parse("2025-05-23") },
    })
  })

  it("drops a hit without a link instead of failing the whole list", async () => {
    const { harness } = await bind()
    stubFetch(() =>
      jsonResponse({
        search_result: [
          { title: "No link", content: "unusable" },
          { title: "Kept", content: "usable", link: "https://example.com/kept" },
          { title: "Null link", content: "unusable", link: null },
        ],
      }),
    )

    const results = (await harness.run(
      harness.providers[0]!.execute({ query: "q" }),
    )) as HitResult[]

    expect(results.map((r) => r.url)).toEqual(["https://example.com/kept"])
  })

  it("names a key refusal with Z.ai's message and points cn keys at osp-zhipu", async () => {
    const { harness } = await bind()
    stubFetch(() =>
      jsonResponse({ error: { code: "1001", message: "invalid api key" } }, 401),
    )

    await expect(harness.run(harness.providers[0]!.execute({ query: "q" }))).rejects.toThrow(
      /Z\.ai rejected the API key \(HTTP 401\): invalid api key \(code 1001\). .*OSP_ZAI_API_KEY.*osp-zhipu/,
    )
  })

  it("surfaces the rate limit with its retry hint", async () => {
    const { harness } = await bind()
    stubFetch(
      () =>
        new Response(
          JSON.stringify({ code: 1701, message: "concurrent searches exceeded" }),
          { status: 429, headers: { "Content-Type": "application/json", "Retry-After": "30" } },
        ),
    )

    await expect(harness.run(harness.providers[0]!.execute({ query: "q" }))).rejects.toThrow(
      /rate limited the request \(HTTP 429\), retry after 30s: concurrent searches exceeded \(code 1701\)/,
    )
  })

  it("reports a non-JSON error body verbatim", async () => {
    const { harness } = await bind()
    stubFetch(() => new Response("<html>gateway</html>", { status: 502 }))

    await expect(harness.run(harness.providers[0]!.execute({ query: "q" }))).rejects.toThrow(
      /Z\.ai API error 502: <html>gateway<\/html>/,
    )
  })
})
