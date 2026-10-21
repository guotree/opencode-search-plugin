import { afterEach, describe, expect, it, vi } from "vitest"
import { jsonResponse, loadPlugin, makeHarness, stubFetch } from "./harness"

type SerpApi = typeof import("../plugins/serpapi-search")

const NO_KEY: Record<string, string> = { OSP_SERPAPI_API_KEY: "" }

/** Bound with a stored credential, env applied on top of `NO_KEY`. */
async function bind(env: Record<string, string> = {}) {
  const mod = await loadPlugin<SerpApi>("../plugins/serpapi-search", { ...NO_KEY, ...env })
  const harness = makeHarness({ credentialSequence: [{ type: "key", key: "serpapi-key" }] })
  await harness.run(mod.effect(harness.ctx))
  return { mod, harness }
}

interface HitResult {
  url: string
  title: string
  content: string
  time: { published?: number }
}

const EMPTY = { organic_results: [] }

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe("serpapi-search", () => {
  it("sends a GET with engine, q and api_key in the URL, omitting the unset filters", async () => {
    const { harness } = await bind()
    const fetch = stubFetch(() => jsonResponse(EMPTY))

    await harness.run(harness.providers[0]!.execute({ query: "  hello   world  " }))

    const { url, init } = fetch.calls[0]!
    expect(url.host).toBe("serpapi.com")
    expect(url.pathname).toBe("/search.json")
    // No method means GET: unlike its POST siblings, SerpApi pays per query
    // string, and the key rides there too rather than in a header.
    expect(init?.method).toBeUndefined()
    expect(init?.headers).toEqual({ Accept: "application/json" })
    expect(url.searchParams.get("engine")).toBe("google")
    expect(url.searchParams.get("q")).toBe("hello world")
    expect(url.searchParams.get("api_key")).toBe("serpapi-key")
    // Unset knobs are omitted, not sent as "".
    expect(url.searchParams.has("gl")).toBe(false)
    expect(url.searchParams.has("hl")).toBe(false)
    expect(url.searchParams.has("tbs")).toBe(false)
    // There is deliberately no count knob: Google withdrew the `num`
    // parameter, so a count would be a lie.
    expect(url.searchParams.has("num")).toBe(false)
  })

  it("puts the gl, hl and tbs the knobs ask for into the URL query", async () => {
    const { harness } = await bind({ SERPAPI_GL: "cn", SERPAPI_HL: "zh-cn", SERPAPI_TBS: "qdr:d" })
    const fetch = stubFetch(() => jsonResponse(EMPTY))

    await harness.run(harness.providers[0]!.execute({ query: "q" }))

    const { url } = fetch.calls[0]!
    expect(url.searchParams.get("gl")).toBe("cn")
    expect(url.searchParams.get("hl")).toBe("zh-cn")
    expect(url.searchParams.get("tbs")).toBe("qdr:d")
  })

  it("maps organic_results only; the rich result blocks stay out", async () => {
    // Answer boxes and knowledge graphs carry no source URL for the agent to
    // open, so only the organic list maps -- the schema ignores the rest on
    // the way in, which this pins from the agent's side.
    const { harness } = await bind()
    stubFetch(() =>
      jsonResponse({
        answer_box: { answer: "42", title: "The Answer" },
        knowledge_graph: { title: "A Thing" },
        related_searches: [{ query: "another query" }],
        organic_results: [
          {
            title: "Dated hit",
            link: "https://example.com/dated",
            snippet: "Dated snippet",
            date: "2026-03-20",
          },
          { title: "Bare hit", link: "https://example.com/bare" },
        ],
      }),
    )

    const results = (await harness.run(
      harness.providers[0]!.execute({ query: "q" }),
    )) as HitResult[]

    expect(results).toEqual([
      {
        url: "https://example.com/dated",
        title: "Dated hit",
        content: "Dated snippet",
        time: { published: Date.parse("2026-03-20") },
      },
      { url: "https://example.com/bare", title: "Bare hit", content: "", time: {} },
    ])
  })

  it("treats a rich-blocks-only response as no results, not a decode failure", async () => {
    // A query whose answer lives entirely in an answer box returns an empty
    // list; failing here would turn a usable (if empty) answer into an error.
    const { harness } = await bind()
    stubFetch(() => jsonResponse({ answer_box: { answer: "only rich blocks" } }))

    const results = await harness.run(harness.providers[0]!.execute({ query: "q" }))

    expect(results).toEqual([])
  })
})
