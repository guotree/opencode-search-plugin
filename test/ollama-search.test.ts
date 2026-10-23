import { afterEach, describe, expect, it, vi } from "vitest"
import { jsonResponse, loadPlugin, makeHarness, stubFetch } from "./harness"

type Ollama = typeof import("../plugins/ollama-search")

const NO_KEY: Record<string, string> = { OSP_OLLAMA_API_KEY: "" }

interface HitResult {
  url: string
  title: string
  content: string
  time: Record<string, never>
}

/** Bound with a stored credential, env applied on top of `NO_KEY`. */
async function bind(env: Record<string, string> = {}) {
  const mod = await loadPlugin<Ollama>("../plugins/ollama-search", { ...NO_KEY, ...env })
  const harness = makeHarness({ credentialSequence: [{ type: "key", key: "ollama-key" }] })
  await harness.run(mod.effect(harness.ctx))
  return { mod, harness }
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe("ollama-search", () => {
  it("sends the query and the default max_results to the hosted endpoint", async () => {
    const { harness } = await bind()
    const fetch = stubFetch(() => jsonResponse({ results: [] }))

    await harness.run(harness.providers[0]!.execute({ query: "  hello   world  " }))

    const { url, init } = fetch.calls[0]!
    expect(url.host).toBe("ollama.com")
    expect(url.pathname).toBe("/api/web_search")
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer ollama-key",
      "Content-Type": "application/json",
    })
    // The API's own default of 5, sent explicitly so the shape is assertable.
    expect(fetch.calls[0]!.body).toEqual({ query: "hello world", max_results: 5 })
  })

  it("clamps OLLAMA_MAX_RESULTS to the API's 1-10", async () => {
    for (const [given, clamped] of [
      ["500", 10],
      ["0", 1],
    ] as const) {
      const { harness } = await bind({ OLLAMA_MAX_RESULTS: given })
      const fetch = stubFetch(() => jsonResponse({ results: [] }))
      await harness.run(harness.providers[0]!.execute({ query: "q" }))
      expect((fetch.calls[0]!.body as { max_results: number }).max_results).toBe(clamped)
    }
  })

  it("maps the flat results, falling back to the URL and to an empty body", async () => {
    const { harness } = await bind()
    const fetch = stubFetch(() =>
      jsonResponse({
        results: [
          {
            title: "Ollama hit",
            url: "https://example.com/ollama",
            content: "Ollama content",
          },
          // A hit Ollama returned without the optional fields: the URL is the
          // one thing the schema insists on, so it is also the fallback title,
          // and a missing content is an empty string rather than a failure.
          { url: "https://example.com/bare" },
        ],
      }),
    )

    const results = (await harness.run(
      harness.providers[0]!.execute({ query: "q" }),
    )) as HitResult[]

    expect(fetch.calls).toHaveLength(1)
    expect(results).toEqual([
      {
        url: "https://example.com/ollama",
        title: "Ollama hit",
        content: "Ollama content",
        time: {},
      },
      { url: "https://example.com/bare", title: "https://example.com/bare", content: "", time: {} },
    ])
  })

  it("cuts each body to OLLAMA_CONTENT_CHARS code points, defaulting to 2000", async () => {
    const { harness } = await bind()
    const fetch = stubFetch(() =>
      jsonResponse({
        results: [{ title: "Long", url: "https://example.com/long", content: "a".repeat(2500) }],
      }),
    )

    const results = (await harness.run(
      harness.providers[0]!.execute({ query: "q" }),
    )) as HitResult[]

    // 2000 matches Doubao's default, and the ellipsis says the body was
    // clipped rather than that it ended there.
    expect(results[0]!.content).toBe("a".repeat(2000) + "…")
  })

  it("keeps the whole body with OLLAMA_CONTENT_CHARS=0", async () => {
    const { harness } = await bind({ OLLAMA_CONTENT_CHARS: "0" })
    const fetch = stubFetch(() =>
      jsonResponse({
        results: [{ title: "Long", url: "https://example.com/long", content: "a".repeat(3000) }],
      }),
    )

    const results = (await harness.run(
      harness.providers[0]!.execute({ query: "q" }),
    )) as HitResult[]

    expect(results[0]!.content).toBe("a".repeat(3000))
  })

  it("cuts on code points, never slicing a surrogate pair", async () => {
    const { harness } = await bind({ OLLAMA_CONTENT_CHARS: "10" })
    const fetch = stubFetch(() =>
      jsonResponse({
        results: [{ title: "Emoji", url: "https://example.com/emoji", content: "😀".repeat(20) }],
      }),
    )

    const results = (await harness.run(
      harness.providers[0]!.execute({ query: "q" }),
    )) as HitResult[]

    // Each emoji is one code point but two UTF-16 units: a UTF-16 cut would
    // leave a lone surrogate, which is not text at all.
    expect(results[0]!.content).toBe("😀".repeat(10) + "…")
  })

  it("treats an empty result list as no hits, not a failure", async () => {
    const { harness } = await bind()
    stubFetch(() => jsonResponse({ results: [] }))

    const results = await harness.run(harness.providers[0]!.execute({ query: "q" }))
    expect(results).toEqual([])
  })

  it("reports the HTTP status when Ollama refuses the request", async () => {
    const { harness } = await bind()
    stubFetch(() => new Response("Unauthorized", { status: 401 }))

    await expect(harness.run(harness.providers[0]!.execute({ query: "q" }))).rejects.toThrow(
      /Ollama API error 401: Unauthorized/,
    )
  })
})
