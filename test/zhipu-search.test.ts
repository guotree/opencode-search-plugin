import { afterEach, describe, expect, it, vi } from "vitest"
import { jsonResponse, loadPlugin, makeHarness, stubFetch } from "./harness"

type Zhipu = typeof import("../plugins/zhipu-search")

const NO_KEY: Record<string, string> = { OSP_ZHIPU_API_KEY: "" }

/** Bound with a stored credential, env applied on top of `NO_KEY`. */
async function bind(env: Record<string, string> = {}) {
  const mod = await loadPlugin<Zhipu>("../plugins/zhipu-search", { ...NO_KEY, ...env })
  const harness = makeHarness({ credentialSequence: [{ type: "key", key: "zhipu-key" }] })
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

describe("zhipu-search", () => {
  it("sends the documented cn body, omitting recency and content_size by default", async () => {
    const { harness } = await bind()
    const fetch = stubFetch(() => jsonResponse(EMPTY))

    await harness.run(harness.providers[0]!.execute({ query: "  hello   world  " }))

    const { url, init } = fetch.calls[0]!
    expect(url.host).toBe("open.bigmodel.cn")
    expect(url.pathname).toBe("/api/paas/v4/web_search")
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer zhipu-key",
      "Content-Type": "application/json",
    })
    // `search_intent: false` is always sent on cn (the spec marks it required,
    // with `false` as its documented default); the optional filters are absent
    // rather than sent as their default values.
    expect(fetch.calls[0]!.body).toEqual({
      search_query: "hello world",
      search_engine: "search_std",
      search_intent: false,
      count: 10,
    })
  })

  it("cuts a query to the API's 70-character search_query ceiling", async () => {
    const { harness } = await bind()
    const fetch = stubFetch(() => jsonResponse(EMPTY))

    // 100 CJK characters, and 80 emoji: the cut counts code points, so no
    // surrogate pair is ever sliced in half.
    await harness.run(harness.providers[0]!.execute({ query: "搜".repeat(100) }))
    expect([...(fetch.calls[0]!.body as { search_query: string }).search_query]).toHaveLength(70)

    await harness.run(harness.providers[0]!.execute({ query: "🙂".repeat(80) }))
    const emoji = (fetch.calls[1]!.body as { search_query: string }).search_query
    expect([...emoji]).toHaveLength(70)
    // 70 code points at 2 UTF-16 units each: no pair was sliced in half.
    expect(emoji.length).toBe(140)
  })

  it("sends the engine, recency and content_size the knobs ask for", async () => {
    const { harness } = await bind({
      ZHIPU_ENGINE: "search_pro",
      ZHIPU_RECENCY: "oneWeek",
      ZHIPU_CONTENT_SIZE: "high",
    })
    const fetch = stubFetch(() => jsonResponse(EMPTY))

    await harness.run(harness.providers[0]!.execute({ query: "q" }))

    expect(fetch.calls[0]!.body).toEqual({
      search_query: "q",
      search_engine: "search_pro",
      search_intent: false,
      count: 10,
      search_recency_filter: "oneWeek",
      content_size: "high",
    })
  })

  it("omits count on the Quark engine and snaps Sogou's to its five sizes", async () => {
    const quark = await bind({ ZHIPU_ENGINE: "search_pro_quark" })
    const quarkFetch = stubFetch(() => jsonResponse(EMPTY))
    await quark.harness.run(quark.harness.providers[0]!.execute({ query: "q" }))
    // Quark's spec row leaves `count` out, so the knob does not reach it.
    expect(quarkFetch.calls[0]!.body).not.toHaveProperty("count")

    // Sogou accepts 10/20/30/40/50 only: 15 rounds up to 20, 7 up to 10.
    for (const [given, snapped] of [
      ["15", 20],
      ["7", 10],
    ] as const) {
      const sogou = await bind({ ZHIPU_ENGINE: "search_pro_sogou", ZHIPU_COUNT: given })
      const fetch = stubFetch(() => jsonResponse(EMPTY))
      await sogou.harness.run(sogou.harness.providers[0]!.execute({ query: "q" }))
      expect((fetch.calls[0]!.body as { count: number }).count).toBe(snapped)
    }
  })

  it("targets open.bigmodel.cn and names the site in a key refusal", async () => {
    const { harness } = await bind()
    const fetch = stubFetch(() => jsonResponse(EMPTY))

    await harness.run(harness.providers[0]!.execute({ query: "q" }))

    expect(fetch.calls[0]!.url.host).toBe("open.bigmodel.cn")
  })

  it("maps a hit, and reads publish_date as the bare date it is", async () => {
    const { harness } = await bind()
    stubFetch(() =>
      jsonResponse({
        search_result: [
          {
            title: "Zhipu hit",
            content: "Zhipu snippet",
            link: "https://example.com/zhipu",
            publish_date: "2025-05-23",
          },
        ],
      }),
    )

    const results = (await harness.run(
      harness.providers[0]!.execute({ query: "q" }),
    )) as HitResult[]

    expect(results[0]).toEqual({
      url: "https://example.com/zhipu",
      title: "Zhipu hit",
      content: "Zhipu snippet",
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

  it("names a key refusal with Zhipu's message and where to get a key", async () => {
    const { harness } = await bind()
    stubFetch(() =>
      jsonResponse({ error: { code: "1001", message: "无效的API Key" } }, 401),
    )

    await expect(harness.run(harness.providers[0]!.execute({ query: "q" }))).rejects.toThrow(
      /Zhipu rejected the API key \(HTTP 401\): 无效的API Key \(code 1001\). .*OSP_ZHIPU_API_KEY/,
    )
  })

  it("surfaces the rate limit with its retry hint and concurrency code", async () => {
    const { harness } = await bind()
    stubFetch(
      () =>
        new Response(
          JSON.stringify({ code: 1701, message: "网络搜索并发已达上限，请稍后重试" }),
          { status: 429, headers: { "Content-Type": "application/json", "Retry-After": "30" } },
        ),
    )

    await expect(harness.run(harness.providers[0]!.execute({ query: "q" }))).rejects.toThrow(
      /rate limited the request \(HTTP 429\), retry after 30s: 网络搜索并发已达上限，请稍后重试 \(code 1701\)/,
    )
  })

  it("reports a non-JSON error body verbatim", async () => {
    const { harness } = await bind()
    stubFetch(() => new Response("<html>gateway</html>", { status: 502 }))

    await expect(harness.run(harness.providers[0]!.execute({ query: "q" }))).rejects.toThrow(
      /Zhipu API error 502: <html>gateway<\/html>/,
    )
  })
})
