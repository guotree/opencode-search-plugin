import { afterEach, describe, expect, it, vi } from "vitest"
import { jsonResponse, loadPlugin, makeHarness, stubFetch } from "./harness"

type Metaso = typeof import("../plugins/metaso-search")

const NO_KEY: Record<string, string> = { OSP_METASO_API_KEY: "" }

/** Bound with a stored credential, env applied on top of `NO_KEY`. */
async function bind(env: Record<string, string> = {}) {
  const mod = await loadPlugin<Metaso>("../plugins/metaso-search", { ...NO_KEY, ...env })
  const harness = makeHarness({ credentialSequence: [{ type: "key", key: "metaso-key" }] })
  await harness.run(mod.effect(harness.ctx))
  return { harness }
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

describe("metaso-search", () => {
  it("sends the documented body, telling the API explicitly that no raw content is wanted", async () => {
    const { harness } = await bind()
    const fetch = stubFetch(() => jsonResponse({ webpages: [] }))

    await harness.run(harness.providers[0]!.execute({ query: "  hello   metaso  " }))

    const { url, init, body } = fetch.calls[0]!
    expect(url.href).toBe("https://metaso.cn/api/v1/search")
    expect(init?.method).toBe("POST")
    expect(init?.headers).toMatchObject({ Authorization: "Bearer metaso-key" })
    // includeRawContent is a constant field, not an opt-in key: every request
    // states its choice, false by default, instead of omitting the field.
    expect(body).toEqual({
      q: "hello metaso",
      scope: "webpage",
      size: 20,
      includeSummary: false,
      includeRawContent: false,
      conciseSnippet: true,
    })
  })

  it("flips includeRawContent only for the exact literal true", async () => {
    const on = await bind({ METASO_INCLUDE_RAW_CONTENT: "true" })
    const onFetch = stubFetch(() => jsonResponse({ webpages: [] }))
    await on.harness.run(on.harness.providers[0]!.execute({ query: "q" }))
    expect((onFetch.calls[0]!.body as { includeRawContent: boolean }).includeRawContent).toBe(true)

    // The knob compares against "true" exactly -- a differently-cased or
    // numeric truthy-looking value stays off, matching the rest of the
    // package's string knobs.
    const off = await bind({ METASO_INCLUDE_RAW_CONTENT: "TRUE" })
    const offFetch = stubFetch(() => jsonResponse({ webpages: [] }))
    await off.harness.run(off.harness.providers[0]!.execute({ query: "q" }))
    expect((offFetch.calls[0]!.body as { includeRawContent: boolean }).includeRawContent).toBe(
      false,
    )
  })

  it("clamps METASO_SEARCH_SIZE to the API's 1-100 range", async () => {
    const low = await bind({ METASO_SEARCH_SIZE: "0" })
    const lowFetch = stubFetch(() => jsonResponse({ webpages: [] }))
    await low.harness.run(low.harness.providers[0]!.execute({ query: "q" }))
    expect((lowFetch.calls[0]!.body as { size: number }).size).toBe(1)

    const high = await bind({ METASO_SEARCH_SIZE: "999" })
    const highFetch = stubFetch(() => jsonResponse({ webpages: [] }))
    await high.harness.run(high.harness.providers[0]!.execute({ query: "q" }))
    expect((highFetch.calls[0]!.body as { size: number }).size).toBe(100)
  })

  it("maps body.webpages only, letting sibling collections ride along unread", async () => {
    const { harness } = await bind()
    stubFetch(() =>
      jsonResponse({
        webpages: [
          {
            title: "Metaso hit",
            link: "https://example.com/metaso",
            snippet: "Metaso snippet",
            date: "2026-10-16",
          },
        ],
        images: [{ url: "https://example.com/pic.png", title: "An image" }],
      }),
    )

    const results = (await harness.run(
      harness.providers[0]!.execute({ query: "q" }),
    )) as HitResult[]

    expect(results).toEqual([
      {
        url: "https://example.com/metaso",
        title: "Metaso hit",
        content: "Metaso snippet",
        time: { published: Date.parse("2026-10-16") },
      },
    ])
  })

  it("prefers rawContent over snippet for the content field", async () => {
    const { harness } = await bind({ METASO_INCLUDE_RAW_CONTENT: "true" })
    stubFetch(() =>
      jsonResponse({
        webpages: [
          {
            title: "Full",
            link: "https://example.com/full",
            snippet: "Short snippet",
            rawContent: "The whole page",
          },
          { title: "Thin", link: "https://example.com/thin", snippet: "Short snippet" },
        ],
      }),
    )

    const results = (await harness.run(
      harness.providers[0]!.execute({ query: "q" }),
    )) as HitResult[]

    expect(results).toEqual([
      {
        url: "https://example.com/full",
        title: "Full",
        content: "The whole page",
        time: {},
      },
      {
        url: "https://example.com/thin",
        title: "Thin",
        content: "Short snippet",
        time: {},
      },
    ])
  })

  it("decodes a body with no webpages key as an empty page", async () => {
    const { harness } = await bind()
    stubFetch(() => jsonResponse({}))

    const results = await harness.run(harness.providers[0]!.execute({ query: "q" }))
    expect(results).toEqual([])
  })
})
