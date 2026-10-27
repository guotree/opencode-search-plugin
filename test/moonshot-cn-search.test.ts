import { afterEach, describe, expect, it, vi } from "vitest"
import { jsonResponse, loadPlugin, makeHarness, stubFetch } from "./harness"

type MoonshotCn = typeof import("../plugins/moonshot-cn-search")

const NO_KEY: Record<string, string> = { OSP_MOONSHOT_CN_API_KEY: "" }

/** Bound with a stored credential, env applied on top of `NO_KEY`. */
async function bind(env: Record<string, string> = {}) {
  const mod = await loadPlugin<MoonshotCn>("../plugins/moonshot-cn-search", {
    ...NO_KEY,
    ...env,
  })
  const harness = makeHarness({ credentialSequence: [{ type: "key", key: "moonshot-cn-key" }] })
  await harness.run(mod.effect(harness.ctx))
  return { mod, harness }
}

interface HitResult {
  url: string
  title: string
  content: string
  time: { published?: number }
}

const EMPTY = { search_results: [] }

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe("moonshot-cn-search", () => {
  it("sends the documented Basic body to the cn host", async () => {
    const { harness } = await bind()
    const fetch = stubFetch(() => jsonResponse(EMPTY))

    await harness.run(harness.providers[0]!.execute({ query: "  你好   世界  " }))

    const { url, init } = fetch.calls[0]!
    expect(url.host).toBe("api.moonshot.cn")
    expect(url.pathname).toBe("/v1/tools/search")
    expect(init?.headers).toMatchObject({ Authorization: "Bearer moonshot-cn-key" })
    expect(fetch.calls[0]!.body).toEqual({ text_query: "你好 世界", limit: 5 })
  })

  it("sends a long query intact: the spec documents no length ceiling", async () => {
    const { harness } = await bind()
    const fetch = stubFetch(() => jsonResponse(EMPTY))

    const query = "搜".repeat(100)
    await harness.run(harness.providers[0]!.execute({ query }))
    expect((fetch.calls[0]!.body as { text_query: string }).text_query).toBe(query)
  })

  it("maps a hit, reading text over snippet and date as the bare date it is", async () => {
    const { harness } = await bind()
    stubFetch(() =>
      jsonResponse({
        search_results: [
          {
            authority: "S",
            date: "2026-06-01",
            icon: "https://example.com/favicon.ico",
            mime: "text/html",
            site_name: "示例网站",
            snippet: "Moonshot CN snippet",
            text: "",
            title: "Moonshot CN hit",
            url: "https://example.com/moonshot-cn",
          },
        ],
      }),
    )

    const results = (await harness.run(
      harness.providers[0]!.execute({ query: "q" }),
    )) as HitResult[]

    expect(results[0]).toEqual({
      url: "https://example.com/moonshot-cn",
      title: "Moonshot CN hit",
      content: "Moonshot CN snippet",
      time: { published: Date.parse("2026-06-01") },
    })
  })

  it("cuts the full page body to MOONSHOT_CN_CONTENT_CHARS code points, defaulting to 4000", async () => {
    const { harness } = await bind({ MOONSHOT_CN_INCLUDE_CONTENT: "true" })
    stubFetch(() =>
      jsonResponse({
        search_results: [
          { title: "Long", url: "https://example.com/long", text: "a".repeat(5000) },
        ],
      }),
    )

    const results = (await harness.run(
      harness.providers[0]!.execute({ query: "q" }),
    )) as HitResult[]

    // 4000 matches the international site's default, and the ellipsis says
    // the body was clipped rather than that it ended there.
    expect(results[0]!.content).toBe("a".repeat(4000) + "…")
  })

  it("keeps the whole body with MOONSHOT_CN_CONTENT_CHARS=0", async () => {
    const { harness } = await bind({
      MOONSHOT_CN_INCLUDE_CONTENT: "true",
      MOONSHOT_CN_CONTENT_CHARS: "0",
    })
    stubFetch(() =>
      jsonResponse({
        search_results: [
          { title: "Long", url: "https://example.com/long", text: "a".repeat(5000) },
        ],
      }),
    )

    const results = (await harness.run(
      harness.providers[0]!.execute({ query: "q" }),
    )) as HitResult[]

    expect(results[0]!.content).toBe("a".repeat(5000))
  })

  it("cuts on code points, never slicing a surrogate pair", async () => {
    const { harness } = await bind({
      MOONSHOT_CN_INCLUDE_CONTENT: "true",
      MOONSHOT_CN_CONTENT_CHARS: "10",
    })
    stubFetch(() =>
      jsonResponse({
        search_results: [
          { title: "Emoji", url: "https://example.com/emoji", text: "😀".repeat(20) },
        ],
      }),
    )

    const results = (await harness.run(
      harness.providers[0]!.execute({ query: "q" }),
    )) as HitResult[]

    expect(results[0]!.content).toBe("😀".repeat(10) + "…")
  })

  it("caches the truncated body, so a repeat query cannot repay the context", async () => {
    const { harness } = await bind({ MOONSHOT_CN_INCLUDE_CONTENT: "true" })
    const fetch = stubFetch(() =>
      jsonResponse({
        search_results: [
          { title: "Long", url: "https://example.com/long", text: "a".repeat(5000) },
        ],
      }),
    )

    const provider = harness.providers[0]!
    const first = (await harness.run(provider.execute({ query: "q" }))) as HitResult[]
    const second = (await harness.run(provider.execute({ query: "q" }))) as HitResult[]

    expect(fetch.calls).toHaveLength(1)
    expect(first[0]!.content).toBe("a".repeat(4000) + "…")
    expect(second[0]!.content).toBe(first[0]!.content)
  })

  it("names a key refusal with the documented no-body 401 and points the intl site at its provider", async () => {
    const { harness } = await bind()
    // The reference documents 401 as arriving with no error body at all.
    stubFetch(() => new Response(null, { status: 401 }))

    await expect(harness.run(harness.providers[0]!.execute({ query: "q" }))).rejects.toThrow(
      /Moonshot CN rejected the API key \(HTTP 401\)\. .*OSP_MOONSHOT_CN_API_KEY.*osp-moonshot\)/,
    )
  })
})
