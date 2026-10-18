import { afterEach, describe, expect, it, vi } from "vitest"
import { jsonResponse, loadPlugin, makeHarness, stubFetch } from "./harness"

type Keenable = typeof import("../plugins/keenable-search")

const NO_KEY: Record<string, string> = { KEENABLE_API_KEY: "" }

async function bind(env: Record<string, string> = NO_KEY, storedKey?: string) {
  const mod = await loadPlugin<Keenable>("../plugins/keenable-search", env)
  const harness = makeHarness(
    storedKey ? { credentialSequence: [{ type: "key", key: storedKey }] } : {},
  )
  await harness.run(mod.effect(harness.ctx))
  return { mod, harness }
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe("keenable-search", () => {
  it("binds without a credential and calls the keyless endpoint", async () => {
    const { mod, harness } = await bind()
    expect(harness.providers.map((p) => p.id)).toEqual(["osp-keenable"])
    expect(harness.integrationNames.get("osp-keenable")).toBe("Keenable (osp)")
    expect(harness.envMethods).toEqual([
      { integrationID: "osp-keenable", names: ["KEENABLE_API_KEY"] },
    ])
    expect(mod.default.id).toBe("keenable-search")

    const fetch = stubFetch(() => jsonResponse({ results: [] }))
    await harness.run(harness.providers[0]!.execute({ query: "q" }))

    const { url, init } = fetch.calls[0]!
    expect(url.href).toBe("https://api.keenable.ai/v1/search/public")
    expect(init?.headers).toMatchObject({
      "X-Keenable-Title": "opencode-search-plugin",
      Accept: "application/json",
    })
    // The header that identifies a key must stay off the anonymous request.
    expect(init?.headers).not.toHaveProperty("X-API-Key")
  })

  it("moves to the keyed endpoint once a key is stored", async () => {
    const { harness } = await bind(NO_KEY, "keen_stored")

    const fetch = stubFetch(() => jsonResponse({ results: [] }))
    await harness.run(harness.providers[0]!.execute({ query: "q" }))

    const { url, init } = fetch.calls[0]!
    expect(url.href).toBe("https://api.keenable.ai/v1/search")
    expect(init?.headers).toMatchObject({ "X-API-Key": "keen_stored" })
  })

  it("normalizes the query, sends the knobs, and maps results", async () => {
    const { harness } = await bind({
      KEENABLE_API_KEY: "",
      KEENABLE_MAX_RESULTS: "500",
      KEENABLE_MODE: "realtime",
      KEENABLE_TITLE: "my-agent",
    })

    const published = "2026-10-01T08:30:00.000Z"
    const fetch = stubFetch(() =>
      jsonResponse({
        query: "hello world",
        mode: "realtime",
        results: [
          {
            title: "First",
            url: "https://example.com/one",
            description: "Summary one",
            snippet: "Longer excerpt one",
            published_at: published,
          },
          { title: "Second", url: "https://example.com/two", description: "Summary two" },
        ],
      }),
    )

    const results = (await harness.run(
      harness.providers[0]!.execute({ query: "  hello   world  " }),
    )) as Array<{ url: string; title: string; content: string; time: Record<string, number> }>

    const { url, init, body } = fetch.calls[0]!
    expect(url.searchParams.toString()).toBe("")
    expect(init?.headers).toMatchObject({ "X-Keenable-Title": "my-agent" })
    expect(body).toEqual({
      query: "hello world",
      max_results: 50,
      mode: "realtime",
    })

    expect(results).toHaveLength(2)
    expect(results[0]).toEqual({
      url: "https://example.com/one",
      title: "First",
      // The snippet is the longer excerpt, so it outranks the description.
      content: "Longer excerpt one",
      time: { published: Date.parse(published) },
    })
    expect(results[1]).toEqual({
      url: "https://example.com/two",
      title: "Second",
      content: "Summary two",
      time: {},
    })
  })

  it("explains the keyless pool when the request is rate limited", async () => {
    const { harness } = await bind()
    stubFetch(() => new Response("slow down", { status: 429 }))

    await expect(harness.run(harness.providers[0]!.execute({ query: "q" }))).rejects.toThrow(
      /1,000 requests an hour/,
    )
  })

  it("names the monthly allowance when a keyed call runs out of credits", async () => {
    const { harness } = await bind(NO_KEY, "keen_stored")
    stubFetch(() => new Response("no credits", { status: 402 }))

    await expect(harness.run(harness.providers[0]!.execute({ query: "q" }))).rejects.toThrow(
      /100,000 requests/,
    )
  })

  it("reports the HTTP status when Keenable refuses the request", async () => {
    const { harness } = await bind()
    stubFetch(() => new Response("nope", { status: 500 }))

    await expect(harness.run(harness.providers[0]!.execute({ query: "q" }))).rejects.toThrow(
      /Keenable API error 500/,
    )
  })

  it("reports a decode failure rather than returning malformed results", async () => {
    const { harness } = await bind()
    stubFetch(() => jsonResponse({ results: [{ url: 42 }] }))

    await expect(harness.run(harness.providers[0]!.execute({ query: "q" }))).rejects.toThrow()
  })
})
