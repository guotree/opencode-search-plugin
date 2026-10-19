import { afterEach, describe, expect, it, vi } from "vitest"
import { jsonResponse, loadPlugin, makeHarness, stubFetch } from "./harness"

type StepFun = typeof import("../plugins/stepfun-search")

const NO_KEY: Record<string, string> = { OSP_STEPFUN_API_KEY: "" }

/** Bound with a stored credential, env applied on top of `NO_KEY`. */
async function bind(env: Record<string, string> = {}) {
  const mod = await loadPlugin<StepFun>("../plugins/stepfun-search", { ...NO_KEY, ...env })
  const harness = makeHarness({ credentialSequence: [{ type: "key", key: "stepfun-key" }] })
  await harness.run(mod.effect(harness.ctx))
  return { mod, harness }
}

interface HitResult {
  url: string
  title: string
  content: string
  time: { published?: number }
}

const EMPTY = { query: "q", category: "", results: [] }

/** One hit with a body far longer than the default cut. */
function longHit(body: string) {
  return {
    query: "q",
    category: "",
    results: [
      {
        url: "https://example.com/long",
        position: 1,
        title: "Long",
        snippet: "Long snippet",
        content: body,
      },
    ],
  }
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("stepfun-search", () => {
  it("sends the documented body, omitting category by default", async () => {
    const { harness } = await bind()
    const fetch = stubFetch(() => jsonResponse(EMPTY))

    await harness.run(harness.providers[0]!.execute({ query: "  hello   world  " }))

    const { url, init } = fetch.calls[0]!
    expect(url.host).toBe("api.stepfun.com")
    expect(url.pathname).toBe("/v1/search")
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer stepfun-key",
      "Content-Type": "application/json",
    })
    // `n` is always sent (10 is the API default, and naming it keeps the knob
    // honest); `category` is omitted rather than sent as "".
    expect(fetch.calls[0]!.body).toEqual({ query: "hello world", n: 10 })
  })

  it("sends the category the knob asks for and clamps n to 1-20", async () => {
    const { harness } = await bind({ STEPFUN_CATEGORY: "research", STEPFUN_COUNT: "99" })
    const fetch = stubFetch(() => jsonResponse(EMPTY))

    await harness.run(harness.providers[0]!.execute({ query: "q" }))

    expect(fetch.calls[0]!.body).toEqual({ query: "q", n: 20, category: "research" })
  })

  it("warns about an unknown category and searches every scenario instead", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const { harness } = await bind({ STEPFUN_CATEGORY: "news" })
    const fetch = stubFetch(() => jsonResponse(EMPTY))

    await harness.run(harness.providers[0]!.execute({ query: "q" }))

    // The endpoint answers 400 for an unknown category, so the typo is dropped
    // here rather than paid for on every search.
    expect(fetch.calls[0]!.body).toEqual({ query: "q", n: 10 })
    expect(warn.mock.calls.some((call) => String(call[0]).includes("STEPFUN_CATEGORY"))).toBe(true)
  })

  it("maps the snippet by default, even though content is always returned", async () => {
    const { harness } = await bind()
    stubFetch(() =>
      jsonResponse({
        query: "q",
        category: "",
        results: [
          {
            url: "https://example.com/stepfun",
            position: 1,
            title: "StepFun hit",
            snippet: "StepFun snippet",
            content: "StepFun full page body",
          },
        ],
      }),
    )

    const results = (await harness.run(
      harness.providers[0]!.execute({ query: "q" }),
    )) as HitResult[]

    expect(results).toEqual([
      {
        url: "https://example.com/stepfun",
        title: "StepFun hit",
        content: "StepFun snippet",
        time: {},
      },
    ])
  })

  it("reads the full page body when STEPFUN_INCLUDE_CONTENT is on", async () => {
    const { harness } = await bind({ STEPFUN_INCLUDE_CONTENT: "true" })
    stubFetch(() => jsonResponse(longHit("Full body")))

    const results = (await harness.run(
      harness.providers[0]!.execute({ query: "q" }),
    )) as HitResult[]

    expect(results[0]!.content).toBe("Full body")
  })

  it("cuts a long body to the default 4000 code points and marks the cut", async () => {
    const { harness } = await bind({ STEPFUN_INCLUDE_CONTENT: "true" })
    stubFetch(() => jsonResponse(longHit("搜".repeat(5_000))))

    const results = (await harness.run(
      harness.providers[0]!.execute({ query: "q" }),
    )) as HitResult[]

    const content = results[0]!.content
    expect(content.endsWith("…")).toBe(true)
    expect([...content]).toHaveLength(4_001)
  })

  it("cuts by code point, never slicing a surrogate pair", async () => {
    const { harness } = await bind({ STEPFUN_INCLUDE_CONTENT: "true", STEPFUN_CONTENT_CHARS: "3" })
    stubFetch(() => jsonResponse(longHit("🙂".repeat(10))))

    const results = (await harness.run(
      harness.providers[0]!.execute({ query: "q" }),
    )) as HitResult[]

    const content = results[0]!.content
    expect([...content]).toHaveLength(4)
    // Three emoji at two UTF-16 units each, plus the ellipsis: no pair halved.
    expect(content).toBe("🙂🙂🙂…")
  })

  it("keeps the whole body when STEPFUN_CONTENT_CHARS is 0", async () => {
    const { harness } = await bind({ STEPFUN_INCLUDE_CONTENT: "true", STEPFUN_CONTENT_CHARS: "0" })
    const body = "x".repeat(9_000)
    stubFetch(() => jsonResponse(longHit(body)))

    const results = (await harness.run(
      harness.providers[0]!.execute({ query: "q" }),
    )) as HitResult[]

    expect(results[0]!.content).toBe(body)
  })

  it("falls back to the body when the snippet is empty", async () => {
    const { harness } = await bind()
    stubFetch(() =>
      jsonResponse({
        query: "q",
        category: "",
        results: [
          {
            url: "https://example.com/no-snippet",
            position: 1,
            title: "No snippet",
            snippet: "",
            content: "Body only",
          },
        ],
      }),
    )

    const results = (await harness.run(
      harness.providers[0]!.execute({ query: "q" }),
    )) as HitResult[]

    expect(results[0]!.content).toBe("Body only")
  })

  it("cuts the body on the snippet-less fallback too, not just under the knob", async () => {
    // The body is in every response, so the fallback path is the one that
    // reaches the agent whenever the crawler wrote no snippet -- it must be
    // bounded there as well.
    const { harness } = await bind()
    stubFetch(() =>
      jsonResponse({
        query: "q",
        category: "",
        results: [
          {
            url: "https://example.com/fallback",
            position: 1,
            title: "Fallback",
            snippet: "",
            content: "x".repeat(9_000),
          },
        ],
      }),
    )

    const results = (await harness.run(
      harness.providers[0]!.execute({ query: "q" }),
    )) as HitResult[]

    expect([...results[0]!.content]).toHaveLength(4_001)
  })

  it("never leaks the body when the snippet is present", async () => {
    const { harness } = await bind()
    stubFetch(() => jsonResponse(longHit("SECRET-BODY")))

    const results = (await harness.run(
      harness.providers[0]!.execute({ query: "q" }),
    )) as HitResult[]

    expect(results[0]!.content).toBe("Long snippet")
    expect(results[0]!.content).not.toContain("SECRET-BODY")
  })

  it("reads time as the index time it is", async () => {
    const { harness } = await bind()
    stubFetch(() =>
      jsonResponse({
        query: "q",
        category: "",
        results: [
          {
            url: "https://example.com/dated",
            position: 1,
            title: "Dated",
            time: "2026-03-20T00:00:00",
            snippet: "Dated snippet",
            content: "Dated body",
          },
        ],
      }),
    )

    const results = (await harness.run(
      harness.providers[0]!.execute({ query: "q" }),
    )) as HitResult[]

    expect(results[0]!.time).toEqual({ published: Date.parse("2026-03-20T00:00:00") })
  })

  it("drops a hit without a url instead of failing the whole list", async () => {
    const { harness } = await bind()
    stubFetch(() =>
      jsonResponse({
        query: "q",
        category: "",
        results: [
          { title: "No url", snippet: "unusable" },
          { url: null, title: "Null url", snippet: "unusable" },
          { url: "https://example.com/kept", title: "Kept", snippet: "usable" },
        ],
      }),
    )

    const results = (await harness.run(
      harness.providers[0]!.execute({ query: "q" }),
    )) as HitResult[]

    expect(results.map((r) => r.url)).toEqual(["https://example.com/kept"])
  })

  it("names a key refusal with StepFun's message and where to get a key", async () => {
    const { harness } = await bind()
    stubFetch(() =>
      jsonResponse(
        { error: { message: "Incorrect API key provided", type: "invalid_api_key" } },
        401,
      ),
    )

    await expect(harness.run(harness.providers[0]!.execute({ query: "q" }))).rejects.toThrow(
      /StepFun rejected the API key \(HTTP 401\): Incorrect API key provided \(invalid_api_key\)\. .*OSP_STEPFUN_API_KEY/,
    )
  })

  it("reports an exhausted balance as a 402", async () => {
    const { harness } = await bind()
    stubFetch(() =>
      jsonResponse({ error: { message: "Insufficient balance", type: "insufficient_credit" } }, 402),
    )

    await expect(harness.run(harness.providers[0]!.execute({ query: "q" }))).rejects.toThrow(
      /StepFun balance is insufficient \(HTTP 402\).*platform\.stepfun\.com/,
    )
  })

  it("reports a moderation refusal as a 451 that rephrasing clears", async () => {
    const { harness } = await bind()
    stubFetch(() => new Response("", { status: 451 }))

    await expect(harness.run(harness.providers[0]!.execute({ query: "q" }))).rejects.toThrow(
      /refused the search on content review \(HTTP 451\).*Rephrase/,
    )
  })

  it("surfaces the rate limit with its retry hint", async () => {
    const { harness } = await bind()
    stubFetch(
      () =>
        new Response(JSON.stringify({ error: { message: "Too many requests" } }), {
          status: 429,
          headers: { "Content-Type": "application/json", "Retry-After": "30" },
        }),
    )

    await expect(harness.run(harness.providers[0]!.execute({ query: "q" }))).rejects.toThrow(
      /rate limited the search \(HTTP 429\), retry after 30s: Too many requests/,
    )
  })

  it("reports a non-JSON error body verbatim", async () => {
    const { harness } = await bind()
    stubFetch(() => new Response("<html>gateway</html>", { status: 502 }))

    await expect(harness.run(harness.providers[0]!.execute({ query: "q" }))).rejects.toThrow(
      /StepFun API error 502: <html>gateway<\/html>/,
    )
  })
})
