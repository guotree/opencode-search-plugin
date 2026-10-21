import { afterEach, describe, expect, it, vi } from "vitest"
import { jsonResponse, loadPlugin, makeHarness, stubFetch } from "./harness"

type Linkup = typeof import("../plugins/linkup-search")

const NO_KEY: Record<string, string> = { OSP_LINKUP_API_KEY: "" }

/** Bound with a stored credential, env applied on top of `NO_KEY`. */
async function bind(env: Record<string, string> = {}) {
  const mod = await loadPlugin<Linkup>("../plugins/linkup-search", { ...NO_KEY, ...env })
  const harness = makeHarness({ credentialSequence: [{ type: "key", key: "linkup-key" }] })
  await harness.run(mod.effect(harness.ctx))
  return { harness }
}

interface HitResult {
  url: string
  title: string
  content: string
  time: Record<string, never>
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe("linkup-search", () => {
  it("sends the documented body with the vendor's recommended depth and default size", async () => {
    const { harness } = await bind()
    const fetch = stubFetch(() => jsonResponse({ results: [] }))

    await harness.run(harness.providers[0]!.execute({ query: "  hello   world  " }))

    const { url, init, body } = fetch.calls[0]!
    expect(url.href).toBe("https://api.linkup.so/v1/search")
    expect(init?.method).toBe("POST")
    expect(init?.headers).toMatchObject({ Authorization: "Bearer linkup-key" })
    expect(body).toEqual({
      q: "hello world",
      depth: "fast",
      outputType: "searchResults",
      maxResults: 10,
    })
  })

  it("clamps LINKUP_MAX_RESULTS to the API's 1-100 range", async () => {
    const low = await bind({ LINKUP_MAX_RESULTS: "0" })
    const lowFetch = stubFetch(() => jsonResponse({ results: [] }))
    await low.harness.run(low.harness.providers[0]!.execute({ query: "q" }))
    expect((lowFetch.calls[0]!.body as { maxResults: number }).maxResults).toBe(1)

    const high = await bind({ LINKUP_MAX_RESULTS: "999" })
    const highFetch = stubFetch(() => jsonResponse({ results: [] }))
    await high.harness.run(high.harness.providers[0]!.execute({ query: "q" }))
    expect((highFetch.calls[0]!.body as { maxResults: number }).maxResults).toBe(100)
  })

  it("sends a LINKUP_DEPTH from the set the API defines", async () => {
    const { harness } = await bind({ LINKUP_DEPTH: "deep" })
    const fetch = stubFetch(() => jsonResponse({ results: [] }))

    await harness.run(harness.providers[0]!.execute({ query: "q" }))

    expect((fetch.calls[0]!.body as { depth: string }).depth).toBe("deep")
  })

  it("falls back to fast when LINKUP_DEPTH is not a depth the API defines", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const { harness } = await bind({ LINKUP_DEPTH: "turbo" })
    const fetch = stubFetch(() => jsonResponse({ results: [] }))

    await harness.run(harness.providers[0]!.execute({ query: "q" }))

    // An out-of-enum depth would be rejected upstream on every search, so
    // the typo is replaced with the vendor's recommended default -- and
    // reported, so the user hears that the knob did not take.
    expect((fetch.calls[0]!.body as { depth: string }).depth).toBe("fast")
    const messages = warn.mock.calls.map((call) => String(call[0]))
    expect(
      messages.some((m) => m.includes("LINKUP_DEPTH") && m.includes('"turbo"')),
    ).toBe(true)
  })

  it("drops image results and any hit without a url on the way out", async () => {
    const { harness } = await bind()
    stubFetch(() =>
      jsonResponse({
        results: [
          { name: "Text hit", url: "https://example.com/one", content: "Body" },
          { name: "An image", url: "https://example.com/pic.png", type: "image" },
          { name: "No url", url: "", type: "webpage" },
          { name: "Another text hit", url: "https://example.com/two" },
        ],
      }),
    )

    const results = (await harness.run(
      harness.providers[0]!.execute({ query: "q" }),
    )) as HitResult[]

    // Text and image entries share one list; image ones carry no content, so
    // they are filtered rather than handed to the agent as empty hits.
    expect(results).toEqual([
      { url: "https://example.com/one", title: "Text hit", content: "Body", time: {} },
      { url: "https://example.com/two", title: "Another text hit", content: "", time: {} },
    ])
  })
})
