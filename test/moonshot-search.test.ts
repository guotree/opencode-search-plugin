import { afterEach, describe, expect, it, vi } from "vitest"
import { jsonResponse, loadPlugin, makeHarness, stubFetch } from "./harness"

type Moonshot = typeof import("../plugins/moonshot-search")

const NO_KEY: Record<string, string> = { OSP_MOONSHOT_API_KEY: "" }

/** Bound with a stored credential, env applied on top of `NO_KEY`. */
async function bind(env: Record<string, string> = {}) {
  const mod = await loadPlugin<Moonshot>("../plugins/moonshot-search", { ...NO_KEY, ...env })
  const harness = makeHarness({ credentialSequence: [{ type: "key", key: "moonshot-key" }] })
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

describe("moonshot-search", () => {
  it("sends the documented Basic body: text_query, the default limit, no content", async () => {
    const { harness } = await bind()
    const fetch = stubFetch(() => jsonResponse(EMPTY))

    await harness.run(harness.providers[0]!.execute({ query: "  hello   world  " }))

    const { url, init } = fetch.calls[0]!
    expect(url.host).toBe("api.moonshot.ai")
    expect(url.pathname).toBe("/v1/tools/search")
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer moonshot-key",
      "Content-Type": "application/json",
    })
    // 5 is the API's own default limit; `include_content` is absent rather
    // than sent as its default `false`.
    expect(fetch.calls[0]!.body).toEqual({
      text_query: "hello world",
      limit: 5,
    })
  })

  it("sends include_content only when the knob asks", async () => {
    const off = await bind()
    const offFetch = stubFetch(() => jsonResponse(EMPTY))
    await off.harness.run(off.harness.providers[0]!.execute({ query: "q" }))
    expect(offFetch.calls[0]!.body).toEqual({ text_query: "q", limit: 5 })

    vi.unstubAllGlobals()
    const on = await bind({ MOONSHOT_INCLUDE_CONTENT: "true" })
    const onFetch = stubFetch(() => jsonResponse(EMPTY))
    await on.harness.run(on.harness.providers[0]!.execute({ query: "q" }))
    expect(onFetch.calls[0]!.body).toEqual({ text_query: "q", limit: 5, include_content: true })
  })

  it("prefers the full page body over the snippet when include_content was sent", async () => {
    const { harness } = await bind({ MOONSHOT_INCLUDE_CONTENT: "true" })
    stubFetch(() =>
      jsonResponse({
        search_results: [
          {
            title: "Full page",
            url: "https://example.com/full",
            snippet: "the snippet",
            text: "# the full body",
          },
          {
            // A page whose crawl found no body falls back to the snippet
            // rather than reaching the agent with nothing to read.
            title: "Snippet only",
            url: "https://example.com/snippet",
            snippet: "just this",
            text: "",
          },
        ],
      }),
    )

    const results = (await harness.run(
      harness.providers[0]!.execute({ query: "q" }),
    )) as HitResult[]

    expect(results.map((r) => r.content)).toEqual(["# the full body", "just this"])
  })

  it("cuts the full page body to MOONSHOT_CONTENT_CHARS code points, defaulting to 4000", async () => {
    const { harness } = await bind({ MOONSHOT_INCLUDE_CONTENT: "true" })
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

    // 4000 matches Jina's and StepFun's default, and the ellipsis says the
    // body was clipped rather than that it ended there.
    expect(results[0]!.content).toBe("a".repeat(4000) + "…")
  })

  it("keeps the whole body with MOONSHOT_CONTENT_CHARS=0", async () => {
    const { harness } = await bind({
      MOONSHOT_INCLUDE_CONTENT: "true",
      MOONSHOT_CONTENT_CHARS: "0",
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
      MOONSHOT_INCLUDE_CONTENT: "true",
      MOONSHOT_CONTENT_CHARS: "10",
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
    const { harness } = await bind({ MOONSHOT_INCLUDE_CONTENT: "true" })
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
            site_name: "Example",
            snippet: "Moonshot snippet",
            text: "",
            title: "Moonshot hit",
            url: "https://example.com/moonshot",
          },
        ],
      }),
    )

    const results = (await harness.run(
      harness.providers[0]!.execute({ query: "q" }),
    )) as HitResult[]

    expect(results[0]).toEqual({
      url: "https://example.com/moonshot",
      title: "Moonshot hit",
      content: "Moonshot snippet",
      time: { published: Date.parse("2026-06-01") },
    })
  })

  it("clamps limit to the API's 1-20 range", async () => {
    const { harness } = await bind({ MOONSHOT_COUNT: "500" })
    const fetch = stubFetch(() => jsonResponse(EMPTY))

    await harness.run(harness.providers[0]!.execute({ query: "q" }))

    expect((fetch.calls[0]!.body as { limit: number }).limit).toBe(20)
  })

  it("drops a hit without a URL instead of failing the whole list", async () => {
    const { harness } = await bind()
    stubFetch(() =>
      jsonResponse({
        search_results: [
          { title: "No URL", snippet: "unusable" },
          { title: "Kept", snippet: "usable", url: "https://example.com/kept" },
          { title: "Null URL", snippet: "unusable", url: null },
        ],
      }),
    )

    const results = (await harness.run(
      harness.providers[0]!.execute({ query: "q" }),
    )) as HitResult[]

    expect(results.map((r) => r.url)).toEqual(["https://example.com/kept"])
  })

  it("names a key refusal with the documented no-body 401 and points the other site at its provider", async () => {
    const { harness } = await bind()
    // The reference documents 401 as arriving with no error body at all.
    stubFetch(() => new Response(null, { status: 401 }))

    await expect(harness.run(harness.providers[0]!.execute({ query: "q" }))).rejects.toThrow(
      /Moonshot rejected the API key \(HTTP 401\)\. .*OSP_MOONSHOT_API_KEY.*osp-moonshot-cn/,
    )
  })

  it("surfaces the 403 account refusal", async () => {
    const { harness } = await bind()
    stubFetch(() => new Response(null, { status: 403 }))

    await expect(harness.run(harness.providers[0]!.execute({ query: "q" }))).rejects.toThrow(
      /reports the account as not activated or disabled \(HTTP 403\)/,
    )
  })

  it("surfaces the rate limit with the reset header as a retry hint", async () => {
    const { harness } = await bind()
    const reset = Math.floor(Date.now() / 1000) + 30
    stubFetch(
      () =>
        new Response(JSON.stringify({ error: { message: "project qps limit exceeded" } }), {
          status: 429,
          headers: { "Content-Type": "application/json", "X-RateLimit-Reset": String(reset) },
        }),
    )

    await expect(harness.run(harness.providers[0]!.execute({ query: "q" }))).rejects.toThrow(
      /rate limited the search \(HTTP 429\), retry in \d+s: project qps limit exceeded/,
    )
  })

  it("reports a non-JSON error body verbatim", async () => {
    const { harness } = await bind()
    stubFetch(() => new Response("<html>gateway</html>", { status: 502 }))

    await expect(harness.run(harness.providers[0]!.execute({ query: "q" }))).rejects.toThrow(
      /Moonshot API error 502: <html>gateway<\/html>/,
    )
  })
})
