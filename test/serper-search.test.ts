import { afterEach, describe, expect, it, vi } from "vitest"
import { jsonResponse, loadPlugin, makeHarness, stubFetch } from "./harness"

type Serper = typeof import("../plugins/serper-search")

const NO_KEY: Record<string, string> = { OSP_SERPER_API_KEY: "" }

/** Bound with a stored credential, env applied on top of `NO_KEY`. */
async function bind(env: Record<string, string> = {}) {
  const mod = await loadPlugin<Serper>("../plugins/serper-search", { ...NO_KEY, ...env })
  const harness = makeHarness({ credentialSequence: [{ type: "key", key: "serper-key" }] })
  await harness.run(mod.effect(harness.ctx))
  return { mod, harness }
}

interface HitResult {
  url: string
  title: string
  content: string
  time: { published?: number }
}

const EMPTY = { organic: [] }

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe("serper-search", () => {
  it("sends the normalized query with the default num in the POST body", async () => {
    const { harness } = await bind()
    const fetch = stubFetch(() => jsonResponse(EMPTY))

    await harness.run(harness.providers[0]!.execute({ query: "  hello   world  " }))

    const { url, init } = fetch.calls[0]!
    expect(url.host).toBe("google.serper.dev")
    expect(url.pathname).toBe("/search")
    expect(init?.method).toBe("POST")
    expect(init?.headers).toMatchObject({
      "X-API-KEY": "serper-key",
      "Content-Type": "application/json",
    })
    // Unset filters are omitted rather than sent as "".
    expect(fetch.calls[0]!.body).toEqual({ q: "hello world", num: 10 })
  })

  it("carries the gl, hl and tbs in the POST body, never in the URL", async () => {
    // The mirror-image of SerpApi: same three filters, but Serper reads them
    // off the JSON body, so a URL that grows a query string is the bug this
    // test exists to catch.
    const { harness } = await bind({ SERPER_GL: "fr", SERPER_HL: "fr", SERPER_TBS: "qdr:w" })
    const fetch = stubFetch(() => jsonResponse(EMPTY))

    await harness.run(harness.providers[0]!.execute({ query: "q" }))

    expect(fetch.calls[0]!.url.search).toBe("")
    expect(fetch.calls[0]!.body).toEqual({
      q: "q",
      num: 10,
      gl: "fr",
      hl: "fr",
      tbs: "qdr:w",
    })
  })

  it("clamps SERPER_NUM to 1-100 at both ends", async () => {
    // serper.dev documents 100 as its ceiling; Querit is the one provider
    // here that forwards a count raw, so the clamp is what separates them.
    const high = await bind({ SERPER_NUM: "500" })
    const first = stubFetch(() => jsonResponse(EMPTY))
    await high.harness.run(high.harness.providers[0]!.execute({ query: "q" }))
    expect(first.calls[0]!.body).toEqual({ q: "q", num: 100 })

    const low = await bind({ SERPER_NUM: "0" })
    const second = stubFetch(() => jsonResponse(EMPTY))
    await low.harness.run(low.harness.providers[0]!.execute({ query: "q" }))
    expect(second.calls[0]!.body).toEqual({ q: "q", num: 1 })
  })

  it("maps organic only; the rich blocks never reach the agent", async () => {
    // answerBox, knowledgeGraph and peopleAlsoAsk carry no source URL for
    // the agent to open, so only `organic` maps -- the schema ignores the
    // rest on the way in, which this pins from the agent's side.
    const { harness } = await bind()
    stubFetch(() =>
      jsonResponse({
        answerBox: { answer: "42" },
        knowledgeGraph: { title: "A Thing" },
        peopleAlsoAsk: [{ question: "Why?" }],
        searchParameters: { q: "q", num: 10 },
        organic: [
          {
            title: "Dated hit",
            link: "https://example.com/dated",
            snippet: "Dated snippet",
            date: "2026-03-20",
          },
          // Google occasionally omits the title; the link stands in for it.
          { link: "https://example.com/titleless" },
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
      {
        url: "https://example.com/titleless",
        title: "https://example.com/titleless",
        content: "",
        time: {},
      },
    ])
  })

  it("treats a rich-blocks-only response as no results, not a decode failure", async () => {
    const { harness } = await bind()
    stubFetch(() => jsonResponse({ knowledgeGraph: { title: "only rich blocks" } }))

    const results = await harness.run(harness.providers[0]!.execute({ query: "q" }))

    expect(results).toEqual([])
  })
})
