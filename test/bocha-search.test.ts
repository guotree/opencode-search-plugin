import { afterEach, describe, expect, it, vi } from "vitest"
import { jsonResponse, loadPlugin, makeHarness, stubFetch } from "./harness"

type Bocha = typeof import("../plugins/bocha-search")

const NO_KEY: Record<string, string> = { BOCHA_API_KEY: "" }

/** Bound with a stored credential, env applied on top of `NO_KEY`. */
async function bind(env: Record<string, string> = {}) {
  const mod = await loadPlugin<Bocha>("../plugins/bocha-search", { ...NO_KEY, ...env })
  const harness = makeHarness({ credentialSequence: [{ type: "key", key: "bocha-key" }] })
  await harness.run(mod.effect(harness.ctx))
  return { mod, harness }
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

describe("bocha-search", () => {
  it("sends the documented body, omitting freshness by default", async () => {
    const { harness } = await bind()
    const fetch = stubFetch(() => jsonResponse({ data: { webPages: { value: [] } } }))

    await harness.run(harness.providers[0]!.execute({ query: "  hello   world  " }))

    const { url, init } = fetch.calls[0]!
    expect(url.host).toBe("api.bocha.cn")
    expect(url.pathname).toBe("/v1/web-search")
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer bocha-key",
      "Content-Type": "application/json",
    })
    // No `freshness` key at all: omitting it is what the docs recommend, since
    // the search rewrites time ranges itself under the noLimit default.
    expect(fetch.calls[0]!.body).toEqual({
      query: "hello world",
      count: 10,
      summary: false,
    })
  })

  it("sends freshness and asks for summaries when the knobs say so", async () => {
    const { harness } = await bind({ BOCHA_FRESHNESS: "oneWeek", BOCHA_SUMMARY: "true" })
    const fetch = stubFetch(() => jsonResponse({ data: { webPages: { value: [] } } }))

    await harness.run(harness.providers[0]!.execute({ query: "q" }))

    expect(fetch.calls[0]!.body).toEqual({
      query: "q",
      count: 10,
      summary: true,
      freshness: "oneWeek",
    })
  })

  it("clamps BOCHA_COUNT to the API's documented 1-50", async () => {
    for (const [given, clamped] of [
      ["500", 50],
      ["0", 1],
    ] as const) {
      const { harness } = await bind({ BOCHA_COUNT: given })
      const fetch = stubFetch(() => jsonResponse({ data: { webPages: { value: [] } } }))
      await harness.run(harness.providers[0]!.execute({ query: "q" }))
      expect((fetch.calls[0]!.body as { count: number }).count).toBe(clamped)
    }
  })

  it("maps a summary over the snippet, and the snippet over an empty summary", async () => {
    const { harness } = await bind()
    const fetch = stubFetch(() =>
      jsonResponse({
        data: {
          webPages: {
            value: [
              {
                name: "Summarized",
                url: "https://example.com/summarized",
                snippet: "The snippet",
                summary: "The generated summary",
              },
              {
                name: "Declined",
                url: "https://example.com/declined",
                snippet: "The snippet",
                summary: "",
              },
            ],
          },
        },
      }),
    )

    const results = (await harness.run(
      harness.providers[0]!.execute({ query: "q" }),
    )) as HitResult[]

    expect(results[0]!.content).toBe("The generated summary")
    // An empty `summary` is Bocha declining to write one, not an answer: the
    // snippet is what the agent should read instead.
    expect(results[1]!.content).toBe("The snippet")
  })

  it("prefers datePublished, and reads dateLastCrawled as the UTC+8 it is", async () => {
    const { harness } = await bind()
    const fetch = stubFetch(() =>
      jsonResponse({
        data: {
          webPages: {
            value: [
              {
                name: "Published",
                url: "https://example.com/published",
                snippet: "s",
                datePublished: "2025-02-23T08:18:30+08:00",
                // A different, wrong date: `datePublished` must win over it.
                dateLastCrawled: "2020-01-01T00:00:00Z",
              },
              {
                name: "Crawled only",
                url: "https://example.com/crawled",
                snippet: "s",
                dateLastCrawled: "2024-07-22T00:00:00Z",
              },
            ],
          },
        },
      }),
    )

    const results = (await harness.run(
      harness.providers[0]!.execute({ query: "q" }),
    )) as HitResult[]

    expect(results[0]!.time.published).toBe(Date.parse("2025-02-23T08:18:30+08:00"))
    // The documented workaround: `dateLastCrawled` stamps a UTC+8 wall clock
    // with a "Z", so the rewrite to "+08:00" is what puts the epoch right.
    expect(results[1]!.time.published).toBe(Date.parse("2024-07-22T00:00:00+08:00"))
    expect(results[1]!.time.published).not.toBe(Date.parse("2024-07-22T00:00:00Z"))
  })

  it("names a balance refusal with the message and log_id Bocha sent", async () => {
    const { harness } = await bind()
    stubFetch(() =>
      jsonResponse(
        { code: "403", message: "You do not have enough money", log_id: "c66aac17eab1bb7e" },
        403,
      ),
    )

    await expect(harness.run(harness.providers[0]!.execute({ query: "q" }))).rejects.toThrow(
      /Bocha balance is exhausted \(HTTP 403\): You do not have enough money \(log_id c66aac17eab1bb7e\)/,
    )
  })

  it("surfaces the rate limit with its retry hint", async () => {
    const { harness } = await bind()
    stubFetch(
      () =>
        new Response(
          JSON.stringify({
            code: "429",
            message: "You have reached the request limit",
            log_id: "abc123",
          }),
          { status: 429, headers: { "Content-Type": "application/json", "Retry-After": "30" } },
        ),
    )

    await expect(harness.run(harness.providers[0]!.execute({ query: "q" }))).rejects.toThrow(
      /rate limited the request \(HTTP 429\), retry after 30s: You have reached the request limit \(log_id abc123\)/,
    )
  })

  it("reports a non-JSON error body verbatim", async () => {
    const { harness } = await bind()
    stubFetch(() => new Response("<html>gateway</html>", { status: 502 }))

    await expect(harness.run(harness.providers[0]!.execute({ query: "q" }))).rejects.toThrow(
      /Bocha API error 502: <html>gateway<\/html>/,
    )
  })
})
