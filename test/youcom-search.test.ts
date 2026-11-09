import { HttpClientError } from "effect/http"
import { afterEach, describe, expect, it, vi } from "vitest"
import { jsonResponse, loadPlugin, makeHarness, stubFetch } from "./harness"

type YouCom = typeof import("../plugins/youcom-search")

// You.com's key is its SDK-canonical variable, not a YOUCOM_-prefixed one.
const NO_KEY: Record<string, string> = { OSP_YDC_API_KEY: "" }

/** Bound with a stored credential, env applied on top of `NO_KEY`. */
async function bind(env: Record<string, string> = {}) {
  const mod = await loadPlugin<YouCom>("../plugins/youcom-search", { ...NO_KEY, ...env })
  const harness = makeHarness({ credentialSequence: [{ type: "key", key: "youcom-key" }] })
  await harness.run(mod.effect(harness.ctx))
  return { mod, harness }
}

/** Bound without any credentials (keyless free tier). */
async function bindKeyless(env: Record<string, string> = {}) {
  const mod = await loadPlugin<YouCom>("../plugins/youcom-search", { ...NO_KEY, ...env })
  const harness = makeHarness()
  await harness.run(mod.effect(harness.ctx))
  return { mod, harness }
}

interface HitResult {
  url: string
  title: string
  content: string
  time: { published?: number }
}

const EMPTY = { results: { web: [], news: [] } }

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe("youcom-search", () => {
  it("sends the normalized query with the default count and highlights extraction", async () => {
    const { harness } = await bind()
    const fetch = stubFetch(() => jsonResponse(EMPTY))

    await harness.run(harness.providers[0]!.execute({ query: "  hello   world  " }))

    const { url, init } = fetch.calls[0]!
    expect(url.host).toBe("ydc-index.io")
    expect(url.pathname).toBe("/v1/search")
    expect(init?.method).toBe("POST")
    expect(init?.headers).toMatchObject({
      "X-API-Key": "youcom-key",
      "Content-Type": "application/json",
    })
    // Highlights is the documented default: the passages that answer the
    // query, without the per-page live-fetch billing of full_page.
    expect(fetch.calls[0]!.body).toEqual({
      query: "hello world",
      count: 10,
      extraction: { extraction_mode: "highlights" },
    })
  })

  it("clamps YOUCOM_COUNT to 1-100 at both ends", async () => {
    // The documented ceiling is 100 results per section; the clamp keeps a
    // typo from turning into a 400 on every search.
    const high = await bind({ YOUCOM_COUNT: "500" })
    const first = stubFetch(() => jsonResponse(EMPTY))
    await high.harness.run(high.harness.providers[0]!.execute({ query: "q" }))
    expect(first.calls[0]!.body).toMatchObject({ count: 100 })

    const low = await bind({ YOUCOM_COUNT: "0" })
    const second = stubFetch(() => jsonResponse(EMPTY))
    await low.harness.run(low.harness.providers[0]!.execute({ query: "q" }))
    expect(second.calls[0]!.body).toMatchObject({ count: 1 })
  })

  it("omits the extraction block entirely for YOUCOM_EXTRACTION=none", async () => {
    const { harness } = await bind({ YOUCOM_EXTRACTION: "none" })
    const fetch = stubFetch(() => jsonResponse(EMPTY))

    await harness.run(harness.providers[0]!.execute({ query: "q" }))

    // "none" is bare snippets, which needs no extraction block at all --
    // sending an empty one would be a shape the API does not define.
    expect(fetch.calls[0]!.body).toEqual({ query: "q", count: 10 })
  })

  it("asks for the billed full page when YOUCOM_EXTRACTION=full_page", async () => {
    // full_page crawls every hit and is billed per live-fetched page on top
    // of the search, so the exact request shape is worth pinning.
    const { harness } = await bind({ YOUCOM_EXTRACTION: "full_page" })
    const fetch = stubFetch(() => jsonResponse(EMPTY))

    await harness.run(harness.providers[0]!.execute({ query: "q" }))

    expect(fetch.calls[0]!.body).toEqual({
      query: "q",
      count: 10,
      extraction: { extraction_mode: "full_page", full_page: { extraction_formats: ["markdown"] } },
    })
  })

  it("falls back to highlights when YOUCOM_EXTRACTION is not a known mode", async () => {
    // An out-of-enum mode is a rejected dispatch on every search, so the typo
    // degrades to the default -- and says so, the way Kagi's warned filters do.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const { harness } = await bind({ YOUCOM_EXTRACTION: "highlight" })
    const fetch = stubFetch(() => jsonResponse(EMPTY))

    await harness.run(harness.providers[0]!.execute({ query: "q" }))

    expect(fetch.calls[0]!.body).toEqual({
      query: "q",
      count: 10,
      extraction: { extraction_mode: "highlights" },
    })
    const messages = warn.mock.calls.map((call) => String(call[0]))
    expect(
      messages.some((m) => m.includes("YOUCOM_EXTRACTION") && m.includes("highlight")),
    ).toBe(true)
  })

  it("merges web before news into one list, dropping url-less hits", async () => {
    // An agent asking "what's new" reads both sections as one list, web
    // first; metadata rides along unread.
    const { harness } = await bind()
    stubFetch(() =>
      jsonResponse({
        results: {
          web: [
            { url: "https://example.com/w1", title: "Web one", description: "d1" },
            { url: "https://example.com/w2", title: "Web two", description: "d2" },
          ],
          news: [
            { url: "https://example.com/n1", title: "News one", description: "dn" },
            { title: "No url at all" },
          ],
        },
        metadata: { search_uuid: "uuid-123", query: "q", latency: 0.4 },
      }),
    )

    const results = (await harness.run(
      harness.providers[0]!.execute({ query: "q" }),
    )) as HitResult[]

    expect(results).toEqual([
      { url: "https://example.com/w1", title: "Web one", content: "d1", time: {} },
      { url: "https://example.com/w2", title: "Web two", content: "d2", time: {} },
      { url: "https://example.com/n1", title: "News one", content: "dn", time: {} },
    ])
  })

  it("reads content down the extraction chain: highlights, markdown, snippets, description", async () => {
    // The knob decides what the service returns, but this chain decides what
    // the agent actually reads when a hit carries several text sources.
    const { harness } = await bind()
    stubFetch(() =>
      jsonResponse({
        results: {
          web: [
            {
              url: "https://example.com/all",
              title: "All sources",
              contents: { highlights: ["h1", "h2"], markdown: "# md" },
              snippets: ["s"],
              description: "d",
            },
            {
              url: "https://example.com/md",
              title: "Markdown only",
              contents: { markdown: "# markdown body" },
              snippets: ["s"],
              description: "d",
            },
            {
              url: "https://example.com/snips",
              title: "Snippets only",
              snippets: ["one", "two"],
              description: "d",
            },
            { url: "https://example.com/desc", title: "Description only", description: "d" },
          ],
        },
      }),
    )

    const results = (await harness.run(
      harness.providers[0]!.execute({ query: "q" }),
    )) as HitResult[]

    expect(results.map((r) => r.content)).toEqual([
      "h1\nh2",
      "# markdown body",
      "one two",
      "d",
    ])
  })

  it.each([
    [{ contents: { highlights: [], markdown: "# body" } }, "# body"],
    [{ contents: { highlights: ["", " "], markdown: "# body" } }, "# body"],
    [{ contents: { markdown: " \n " }, snippets: ["snippet"] }, "snippet"],
    [{ snippets: [], description: "description" }, "description"],
    [{ contents: { markdown: "  code\n\n" }, description: "fallback" }, "  code\n\n"],
    [{ contents: { highlights: [" "], markdown: " " }, snippets: ["", ""], description: " " }, ""],
  ])("selects usable text without changing its formatting: %j", async (fields, expected) => {
    const { harness } = await bind()
    stubFetch(() => jsonResponse({
      results: { web: [{ url: "https://example.com/content", ...fields }] },
    }))

    const results = (await harness.run(
      harness.providers[0]!.execute({ query: "content fallback" }),
    )) as HitResult[]

    expect(results[0]!.content).toBe(expected)
  })

  it("binds without a credential and calls the hosted MCP free endpoint", async () => {
    const { mod, harness } = await bindKeyless()
    expect(harness.providers.map((p) => p.id)).toEqual(["osp-youcom"])
    expect(harness.integrationNames.get("osp-youcom")).toBe("You.com (osp)")
    expect(harness.envMethods).toEqual([
      { integrationID: "osp-youcom", names: ["OSP_YDC_API_KEY"] },
    ])
    expect(mod.default.id).toBe("youcom-search")

    const fetch = stubFetch(() => jsonResponse(EMPTY))
    await harness.run(harness.providers[0]!.execute({ query: "  hello   world  " }))

    const { url, init } = fetch.calls[0]!
    expect(url.href).toBe("https://api.you.com/mcp?profile=free")
    expect(init?.method).toBe("POST")
    expect(init?.headers).toMatchObject({
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    })
    expect(init?.headers).not.toHaveProperty("X-API-Key")
    expect(fetch.calls[0]!.body).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "you-search",
        arguments: {
          query: "hello world",
          count: 10,
          extraction: "highlights",
        },
      },
    })
  })

  it("parses SSE event-stream payload from the hosted MCP free endpoint", async () => {
    const { harness } = await bindKeyless()
    const ssePayload = [
      "event: message",
      'data: {"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info","data":"Search successful"}}',
      "",
      "event: message",
      'data: {"result":{"content":[{"type":"text","text":"{\\"results\\":{\\"web\\":[{\\"url\\":\\"https://example.com/free\\",\\"title\\":\\"Free hit\\",\\"description\\":\\"Free snippet\\"}]}}"}]}}',
      "",
    ].join("\n")

    stubFetch(() => new Response(ssePayload, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }))

    const results = (await harness.run(
      harness.providers[0]!.execute({ query: "q" }),
    )) as HitResult[]

    expect(results).toEqual([
      {
        url: "https://example.com/free",
        title: "Free hit",
        content: "Free snippet",
        time: {},
      },
    ])
  })

  it("passes language and country to _meta overrides in keyless mode", async () => {
    const { harness } = await bindKeyless({
      YOUCOM_LANGUAGE: "ZH-HANS",
      YOUCOM_COUNTRY: "CN",
    })
    const fetch = stubFetch(() => jsonResponse(EMPTY))

    await harness.run(harness.providers[0]!.execute({ query: "q" }))

    expect(fetch.calls[0]!.body).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "you-search",
        arguments: {
          query: "q",
          count: 10,
          extraction: "highlights",
        },
        _meta: {
          "com.you.com/search": {
            language: "ZH-HANS",
            country: "CN",
          },
        },
      },
    })
  })

  it("parses multi-line SSE event data chunks", async () => {
    const { harness } = await bindKeyless()
    const ssePayload = [
      "event: message",
      "data: {",
      'data:   "result": {',
      'data:     "content": [{"type": "text", "text": "{\\"results\\":{\\"web\\":[{\\"url\\":\\"https://example.com/multi\\",\\"title\\":\\"Multi line\\",\\"description\\":\\"Parsed\\"}]}}"}]',
      "data:   }",
      "data: }",
      "",
    ].join("\n")

    stubFetch(() => new Response(ssePayload, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }))

    const results = (await harness.run(
      harness.providers[0]!.execute({ query: "q" }),
    )) as HitResult[]

    expect(results).toEqual([
      {
        url: "https://example.com/multi",
        title: "Multi line",
        content: "Parsed",
        time: {},
      },
    ])
  })

  it("handles upstream JSON-RPC errors from MCP", async () => {
    const { harness } = await bindKeyless()
    const ssePayload = [
      "event: message",
      'data: {"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"Method not found"}}',
      "",
    ].join("\n")

    stubFetch(() => new Response(ssePayload, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }))

    await expect(harness.run(harness.providers[0]!.execute({ query: "q" }))).rejects.toThrow(
      "You.com MCP error: Method not found",
    )
  })

  it("handles upstream tool errors with isError: true", async () => {
    const { harness } = await bindKeyless()
    const ssePayload = [
      "event: message",
      'data: {"result":{"content":[{"type":"text","text":"Rate limit exceeded for free profile"}],"isError":true}}',
      "",
    ].join("\n")

    stubFetch(() => new Response(ssePayload, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }))

    await expect(harness.run(harness.providers[0]!.execute({ query: "q" }))).rejects.toThrow(
      /You\.com MCP error: Rate limit exceeded.*The keyless free tier is rate limited/,
    )
  })

  it("surfaces upstream error notification when no result is returned", async () => {
    const { harness } = await bindKeyless()
    const ssePayload = [
      "event: message",
      'data: {"jsonrpc":"2.0","method":"notifications/message","params":{"level":"error","data":"Search failed upstream"}}',
      "",
    ].join("\n")

    stubFetch(() => new Response(ssePayload, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }))

    await expect(harness.run(harness.providers[0]!.execute({ query: "q" }))).rejects.toThrow(
      "You.com MCP error: Search failed upstream",
    )
  })

  it("explains the keyless free tier when the request is rate limited", async () => {
    const { harness } = await bindKeyless()
    stubFetch(() => new Response("slow down", { status: 429, headers: { "Retry-After": "10" } }))

    let caught: unknown
    try {
      await harness.run(harness.providers[0]!.execute({ query: "q" }))
    } catch (e) {
      caught = e
    }

    expect(caught).toBeInstanceOf(HttpClientError.HttpClientError)
    const err = caught as HttpClientError.HttpClientError
    expect(HttpClientError.isHttpClientError(err)).toBe(true)
    expect(err.message).toContain("The keyless free tier is rate limited")
    expect(err.message).toContain("connect You.com in /connect or set OSP_YDC_API_KEY")
  })
})
