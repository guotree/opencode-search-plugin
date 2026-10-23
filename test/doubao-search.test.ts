import { afterEach, describe, expect, it, vi } from "vitest"
import { jsonResponse, loadPlugin, makeHarness, stubFetch } from "./harness"

type Doubao = typeof import("../plugins/doubao-search")

const NO_KEY: Record<string, string> = { OSP_DOUBAO_API_KEY: "" }

/** Bound with a stored credential, env applied on top of `NO_KEY`. */
async function bind(env: Record<string, string> = {}) {
  const mod = await loadPlugin<Doubao>("../plugins/doubao-search", { ...NO_KEY, ...env })
  const harness = makeHarness({ credentialSequence: [{ type: "key", key: "doubao-key" }] })
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
  vi.restoreAllMocks()
})

describe("doubao-search", () => {
  it("sends the documented body, omitting Filter by default", async () => {
    const { harness } = await bind()
    const fetch = stubFetch(() => jsonResponse({ Result: { WebResults: [] } }))

    await harness.run(harness.providers[0]!.execute({ query: "  hello   world  " }))

    const { url, init } = fetch.calls[0]!
    expect(url.host).toBe("open.feedcoopapi.com")
    expect(url.pathname).toBe("/search_api/web_search")
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer doubao-key",
      "Content-Type": "application/json",
    })
    // PascalCase, and no `Filter` at all: the full page body comes back
    // without asking for it, and a Filter only rides when a knob asks.
    expect(fetch.calls[0]!.body).toEqual({
      Query: "hello world",
      SearchType: "web",
      Count: 10,
    })
  })

  it("clamps DOUBAO_COUNT to the API's documented 1-50", async () => {
    for (const [given, clamped] of [
      ["500", 50],
      ["0", 1],
    ] as const) {
      const { harness } = await bind({ DOUBAO_COUNT: given })
      const fetch = stubFetch(() => jsonResponse({ Result: { WebResults: [] } }))
      await harness.run(harness.providers[0]!.execute({ query: "q" }))
      expect((fetch.calls[0]!.body as { Count: number }).Count).toBe(clamped)
    }
  })

  it("rides AUTH_LEVEL and TIME_RANGE in Filter when the knobs say so", async () => {
    const { harness } = await bind({ DOUBAO_AUTH_LEVEL: "1", DOUBAO_TIME_RANGE: "OneWeek" })
    const fetch = stubFetch(() => jsonResponse({ Result: { WebResults: [] } }))

    await harness.run(harness.providers[0]!.execute({ query: "q" }))

    // AuthInfoLevel as a single integer: upstream rejects an array outright.
    expect(fetch.calls[0]!.body).toEqual({
      Query: "q",
      SearchType: "web",
      Count: 10,
      Filter: { AuthInfoLevel: 1, TimeRange: "OneWeek" },
    })
  })

  it("warns and drops a DOUBAO_TIME_RANGE outside the enum instead of forwarding it", async () => {
    // The range would ride on every request otherwise, and upstream rejects
    // an unknown value instead of ignoring it -- a typo would cost every
    // search rather than only this knob.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const { harness } = await bind({ DOUBAO_TIME_RANGE: "oneWeek" })

    const fetch = stubFetch(() => jsonResponse({ Result: { WebResults: [] } }))
    await harness.run(harness.providers[0]!.execute({ query: "q" }))

    expect("Filter" in (fetch.calls[0]!.body as object)).toBe(false)
    const messages = warn.mock.calls.map((call) => String(call[0]))
    expect(
      messages.some((m) => m.includes("DOUBAO_TIME_RANGE") && m.includes('"oneWeek"')),
    ).toBe(true)
  })

  it("warns and drops a DOUBAO_AUTH_LEVEL outside 1-4", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const { harness } = await bind({ DOUBAO_AUTH_LEVEL: "9" })

    const fetch = stubFetch(() => jsonResponse({ Result: { WebResults: [] } }))
    await harness.run(harness.providers[0]!.execute({ query: "q" }))

    expect("Filter" in (fetch.calls[0]!.body as object)).toBe(false)
    const messages = warn.mock.calls.map((call) => String(call[0]))
    expect(messages.some((m) => m.includes("DOUBAO_AUTH_LEVEL") && m.includes('"9"'))).toBe(true)
  })

  it("maps Content over Summary over Snippet, and the snippet over an empty body", async () => {
    const { harness } = await bind()
    const fetch = stubFetch(() =>
      jsonResponse({
        Result: {
          WebResults: [
            {
              Title: "Full body",
              Url: "https://example.com/full",
              Content: "The full page body",
              Summary: "The summary",
              Snippet: "The snippet",
            },
            {
              Title: "Summary only",
              Url: "https://example.com/summary",
              Content: "",
              Summary: "The summary",
              Snippet: "The snippet",
            },
            {
              Title: "Snippet only",
              Url: "https://example.com/snippet",
              Snippet: "The snippet",
            },
          ],
        },
      }),
    )

    const results = (await harness.run(
      harness.providers[0]!.execute({ query: "q" }),
    )) as HitResult[]

    expect(results[0]!.content).toBe("The full page body")
    // An empty `Content` is Doubao declining to write one, not an answer:
    // the shorter documented forms are what the agent should read instead.
    expect(results[1]!.content).toBe("The summary")
    expect(results[2]!.content).toBe("The snippet")
  })

  it("reads the full page body by default, cut to DOUBAO_CONTENT_CHARS code points", async () => {
    const { harness } = await bind()
    const fetch = stubFetch(() =>
      jsonResponse({
        Result: {
          WebResults: [
            {
              Title: "Long",
              Url: "https://example.com/long",
              Snippet: "The snippet",
              Content: "a".repeat(2500),
            },
          ],
        },
      }),
    )

    const results = (await harness.run(
      harness.providers[0]!.execute({ query: "q" }),
    )) as HitResult[]

    // 2000 is the default budget -- half of a typical Doubao body -- and the
    // ellipsis says the body was clipped rather than that it ended there.
    expect(results[0]!.content).toBe("a".repeat(2000) + "…")
  })

  it("DOUBAO_CONTENT=snippet prefers the excerpt, and the budget binds both branches", async () => {
    const { harness } = await bind({ DOUBAO_CONTENT: "snippet", DOUBAO_CONTENT_CHARS: "10" })
    const fetch = stubFetch(() =>
      jsonResponse({
        Result: {
          WebResults: [
            {
              Title: "Both",
              Url: "https://example.com/both",
              Snippet: "Excerpt",
              Content: "b".repeat(50),
            },
            {
              Title: "No snippet",
              Url: "https://example.com/nosnippet",
              Snippet: "",
              Content: "c".repeat(50),
            },
            {
              Title: "Long snippet",
              Url: "https://example.com/long-snippet",
              Snippet: "d".repeat(50),
              Content: "e".repeat(50),
            },
          ],
        },
      }),
    )

    const results = (await harness.run(
      harness.providers[0]!.execute({ query: "q" }),
    )) as HitResult[]

    // "Excerpt" is inside the 10 code-point budget and stays whole.
    expect(results[0]!.content).toBe("Excerpt")
    // A hit without an excerpt still says something: the trimmed body stands
    // in rather than leaving the agent a bare link.
    expect(results[1]!.content).toBe("c".repeat(10) + "…")
    // The live API cuts its snippets server-side at roughly 600 characters,
    // so the budget has to bind the excerpt branch too -- a cut the mode
    // could slip past would not be a bound at all.
    expect(results[2]!.content).toBe("d".repeat(10) + "…")
  })

  it("keeps the whole body with DOUBAO_CONTENT_CHARS=0", async () => {
    const { harness } = await bind({ DOUBAO_CONTENT_CHARS: "0" })
    const fetch = stubFetch(() =>
      jsonResponse({
        Result: {
          WebResults: [{ Title: "Long", Url: "https://example.com/long", Content: "a".repeat(3000) }],
        },
      }),
    )

    const results = (await harness.run(
      harness.providers[0]!.execute({ query: "q" }),
    )) as HitResult[]

    expect(results[0]!.content).toBe("a".repeat(3000))
  })

  it("cuts on code points, never slicing a surrogate pair", async () => {
    const { harness } = await bind({ DOUBAO_CONTENT_CHARS: "10" })
    const fetch = stubFetch(() =>
      jsonResponse({
        Result: {
          WebResults: [{ Title: "Emoji", Url: "https://example.com/emoji", Content: "😀".repeat(20) }],
        },
      }),
    )

    const results = (await harness.run(
      harness.providers[0]!.execute({ query: "q" }),
    )) as HitResult[]

    // Each emoji is one code point but two UTF-16 units: a UTF-16 cut would
    // leave a lone surrogate, which is not text at all.
    expect(results[0]!.content).toBe("😀".repeat(10) + "…")
  })

  it("warns and drops a DOUBAO_CONTENT outside full/snippet", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const { harness } = await bind({ DOUBAO_CONTENT: "short" })
    const fetch = stubFetch(() =>
      jsonResponse({
        Result: {
          WebResults: [{ Title: "Hit", Url: "https://example.com/hit", Content: "The body" }],
        },
      }),
    )

    const results = (await harness.run(
      harness.providers[0]!.execute({ query: "q" }),
    )) as HitResult[]

    // The typo costs the knob, not the search: full mode applies, and the
    // user hears about it.
    expect(results[0]!.content).toBe("The body")
    const messages = warn.mock.calls.map((call) => String(call[0]))
    expect(messages.some((m) => m.includes("DOUBAO_CONTENT") && m.includes('"short"'))).toBe(true)
  })

  it("reads PublishTime as the ISO string it is, and as the UTC+8 wall clock it means", async () => {
    const { harness } = await bind()
    const fetch = stubFetch(() =>
      jsonResponse({
        Result: {
          WebResults: [
            {
              Title: "ISO",
              Url: "https://example.com/iso",
              Snippet: "s",
              PublishTime: "2026-07-10T20:00:00+08:00",
            },
            {
              Title: "Wall clock",
              Url: "https://example.com/wall",
              Snippet: "s",
              PublishTime: "2026-07-10 20:00:00",
            },
            {
              Title: "Untimed",
              Url: "https://example.com/untimed",
              Snippet: "s",
              PublishTime: "",
            },
          ],
        },
      }),
    )

    const results = (await harness.run(
      harness.providers[0]!.execute({ query: "q" }),
    )) as HitResult[]

    expect(results[0]!.time.published).toBe(Date.parse("2026-07-10T20:00:00+08:00"))
    // The wall clock carries no zone at all: the rewrite to "+08:00" is what
    // puts the epoch right, and reading it as UTC would be eight hours off.
    expect(results[1]!.time.published).toBe(Date.parse("2026-07-10T20:00:00+08:00"))
    expect(results[1]!.time.published).not.toBe(Date.parse("2026-07-10T20:00:00Z"))
    // No date at all keeps no `time`, rather than inventing one.
    expect(results[2]!.time.published).toBeUndefined()
  })

  it("surfaces a business error that rides HTTP 200 with its code and request id", async () => {
    const { harness } = await bind()
    stubFetch(() =>
      jsonResponse({
        ResponseMetadata: {
          RequestId: "20261022120000000ABCDEFGH",
          Error: { Code: "InvalidParameter", Message: "Filter.AuthInfoLevel is invalid" },
        },
      }),
    )

    // Doubao refuses inside HTTP 200; without this the refusal would decode
    // into a silent empty result and the agent would think nothing matched.
    await expect(harness.run(harness.providers[0]!.execute({ query: "q" }))).rejects.toThrow(
      /Doubao search failed: Filter\.AuthInfoLevel is invalid \(code InvalidParameter, request 20261022120000000ABCDEFGH\)/,
    )
  })

  it("reports the 401 key rejection with the console link", async () => {
    const { harness } = await bind()
    stubFetch(() =>
      jsonResponse(
        { ResponseMetadata: { RequestId: "req-401", Error: { Code: "Unauthorized", Message: "API key is invalid" } } },
        401,
      ),
    )

    await expect(harness.run(harness.providers[0]!.execute({ query: "q" }))).rejects.toThrow(
      /Doubao rejected the API key \(HTTP 401\): API key is invalid \(request req-401\)\. Connect Doubao Search in \/connect/,
    )
  })

  it("surfaces the rate limit with its retry hint and the free-quota note", async () => {
    const { harness } = await bind()
    stubFetch(
      () =>
        new Response(
          JSON.stringify({
            ResponseMetadata: { Error: { Code: "Throttling", Message: "Request throttled" } },
          }),
          { status: 429, headers: { "Content-Type": "application/json", "Retry-After": "30" } },
        ),
    )

    await expect(harness.run(harness.providers[0]!.execute({ query: "q" }))).rejects.toThrow(
      /rate limited the request \(HTTP 429\), retry after 30s: Request throttled\. The free quota is 500 searches per month/,
    )
  })

  it("reports a non-JSON error body verbatim", async () => {
    const { harness } = await bind()
    stubFetch(() => new Response("<html>gateway</html>", { status: 502 }))

    await expect(harness.run(harness.providers[0]!.execute({ query: "q" }))).rejects.toThrow(
      /Doubao API error 502: <html>gateway<\/html>/,
    )
  })
})
