import { afterEach, describe, expect, it, vi } from "vitest"
import { jsonResponse, loadPlugin, makeHarness, stubFetch } from "./harness"

type Perplexity = typeof import("../plugins/perplexity-search")

const NO_KEY: Record<string, string> = { OSP_PERPLEXITY_API_KEY: "" }

interface HitResult {
  url: string
  title: string
  content: string
  time: Record<string, number>
}

/** Bound with a stored credential, env applied on top of `NO_KEY`. */
async function bind(env: Record<string, string> = {}) {
  const mod = await loadPlugin<Perplexity>("../plugins/perplexity-search", { ...NO_KEY, ...env })
  const harness = makeHarness({ credentialSequence: [{ type: "key", key: "pplx-key" }] })
  await harness.run(mod.effect(harness.ctx))
  return { mod, harness }
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe("perplexity-search", () => {
  it("sends the query and the API's own defaults to POST /search", async () => {
    const { harness } = await bind()
    const fetch = stubFetch(() => jsonResponse({ results: [] }))

    await harness.run(harness.providers[0]!.execute({ query: "  hello   world  " }))

    const { url, init } = fetch.calls[0]!
    expect(url.host).toBe("api.perplexity.ai")
    expect(url.pathname).toBe("/search")
    expect(init?.method).toBe("POST")
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer pplx-key",
      "Content-Type": "application/json",
    })
    // `max_results` is sent explicitly so the shape is assertable; every other
    // knob stays out of the body, which leaves the API's own defaults in place.
    expect(fetch.calls[0]!.body).toEqual({ query: "hello world", max_results: 10 })
  })

  it("clamps PERPLEXITY_MAX_RESULTS to web search's 1-20", async () => {
    for (const [given, clamped] of [
      ["500", 20],
      ["0", 1],
    ] as const) {
      const { harness } = await bind({ PERPLEXITY_MAX_RESULTS: given })
      const fetch = stubFetch(() => jsonResponse({ results: [] }))
      await harness.run(harness.providers[0]!.execute({ query: "q" }))
      expect((fetch.calls[0]!.body as { max_results: number }).max_results).toBe(clamped)
    }
  })

  it("sends the filters when set and omits them when not", async () => {
    const { harness } = await bind({
      PERPLEXITY_SEARCH_TYPE: "fast",
      PERPLEXITY_RECENCY: "week",
      PERPLEXITY_COUNTRY: "US",
      PERPLEXITY_LANGUAGE: " en , zh ",
    })
    const fetch = stubFetch(() => jsonResponse({ results: [] }))
    await harness.run(harness.providers[0]!.execute({ query: "q" }))

    expect(fetch.calls[0]!.body).toEqual({
      query: "q",
      max_results: 10,
      search_type: "fast",
      search_recency_filter: "week",
      country: "US",
      search_language_filter: ["en", "zh"],
    })
  })

  it("drops a filter value the API does not document", async () => {
    const { harness } = await bind({
      PERPLEXITY_SEARCH_TYPE: "academic",
      PERPLEXITY_RECENCY: "decade",
    })
    const fetch = stubFetch(() => jsonResponse({ results: [] }))
    await harness.run(harness.providers[0]!.execute({ query: "q" }))

    // Undocumented values are refused rather than passed upstream to fail as a
    // 422: the body keeps exactly what the API documents, so the search runs.
    expect(fetch.calls[0]!.body).toEqual({ query: "q", max_results: 10 })
  })

  it("maps the pages, their dates, and the fields a page leaves out", async () => {
    const { harness } = await bind()
    const fetch = stubFetch(() =>
      jsonResponse({
        results: [
          {
            title: "Dated",
            url: "https://example.com/dated",
            snippet: "Dated snippet",
            date: "2026-10-01",
            last_updated: "2026-10-15",
          },
          // No publication date, but a revision: both are the page's own "when
          // is this from", and the result carries a single slot for it.
          {
            title: "Updated only",
            url: "https://example.com/updated",
            snippet: "Updated snippet",
            date: null,
            last_updated: "2026-09-20",
          },
          // A PDF, from Perplexity's own examples: no date at all, an empty
          // snippet, and no title. The row still ships -- for its link.
          { title: "", url: "https://example.com/bare", snippet: "", date: null },
        ],
        id: "e38104d5-6bd7-4d82-bc4e-0a21179d1f77",
        server_time: null,
      }),
    )

    const results = (await harness.run(
      harness.providers[0]!.execute({ query: "q" }),
    )) as HitResult[]

    expect(fetch.calls).toHaveLength(1)
    expect(results).toEqual([
      {
        url: "https://example.com/dated",
        title: "Dated",
        content: "Dated snippet",
        time: { published: Date.parse("2026-10-01") },
      },
      {
        url: "https://example.com/updated",
        title: "Updated only",
        content: "Updated snippet",
        time: { published: Date.parse("2026-09-20") },
      },
      {
        url: "https://example.com/bare",
        title: "https://example.com/bare",
        content: "",
        time: {},
      },
    ])
  })

  it("treats an empty result list as no hits, not a failure", async () => {
    const { harness } = await bind()
    stubFetch(() => jsonResponse({ results: [], id: "e38104d5" }))

    const results = await harness.run(harness.providers[0]!.execute({ query: "q" }))
    expect(results).toEqual([])
  })

  it("reports the HTTP status and the API's own error envelope", async () => {
    const { harness } = await bind()
    stubFetch(() =>
      jsonResponse(
        {
          error: {
            message: "Invalid API key provided.",
            type: "invalid_api_key",
            code: 401,
          },
        },
        401,
      ),
    )

    await expect(harness.run(harness.providers[0]!.execute({ query: "q" }))).rejects.toThrow(
      /Perplexity API error 401: .*invalid_api_key/,
    )
  })
})
