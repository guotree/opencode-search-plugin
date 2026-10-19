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

  it("names a key refusal with the documented no-body 401 and points the intl site at its provider", async () => {
    const { harness } = await bind()
    // The reference documents 401 as arriving with no error body at all.
    stubFetch(() => new Response(null, { status: 401 }))

    await expect(harness.run(harness.providers[0]!.execute({ query: "q" }))).rejects.toThrow(
      /Moonshot CN rejected the API key \(HTTP 401\)\. .*OSP_MOONSHOT_CN_API_KEY.*osp-moonshot\)/,
    )
  })
})
