import { afterEach, describe, expect, it, vi } from "vitest"
import { loadPlugin, makeHarness } from "./harness"

type Brave = typeof import("../plugins/brave-search")

const NO_KEY: Record<string, string> = { BRAVE_SEARCH_API_KEY: "" }

interface RecordedCall {
  url: URL
  init: RequestInit | undefined
}

/**
 * Replace `fetch` with a typed recorder. Brave passes a `URL`, so `String`
 * recovers the href without pretending the argument is a string.
 */
function stubFetch(
  handler: (call: RecordedCall) => Response | Promise<Response> = () =>
    new Response("{}", { status: 200 }),
): { calls: RecordedCall[]; invocations: () => number } {
  const calls: RecordedCall[] = []
  const mock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const call: RecordedCall = { url: new URL(String(input)), init }
    calls.push(call)
    return handler(call)
  })
  vi.stubGlobal("fetch", mock)
  return { calls, invocations: () => calls.length }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

async function bind(env: Record<string, string> = NO_KEY, events?: ReadonlyArray<{ type: string }>) {
  const mod = await loadPlugin<Brave>("../plugins/brave-search", env)
  const harness = makeHarness({
    credentialSequence: [{ type: "key", key: "brave-key" }],
    events,
  })
  await harness.run(mod.effect(harness.ctx))
  return { mod, harness }
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe("brave-search", () => {
  it("does not bind a provider without a key", async () => {
    const mod = await loadPlugin<Brave>("../plugins/brave-search", NO_KEY)
    const harness = makeHarness()
    await harness.run(mod.effect(harness.ctx))
    expect(harness.providers).toHaveLength(0)
  })

  it("binds the provider and wires /connect when a key is stored", async () => {
    const { mod, harness } = await bind()
    expect(harness.providers.map((p) => p.id)).toEqual(["osp-brave"])
    expect(harness.integrationNames.get("osp-brave")).toBe("Brave Search")
    expect(harness.envMethods).toEqual([
      { integrationID: "osp-brave", names: ["BRAVE_SEARCH_API_KEY"] },
    ])
    expect(mod.default.id).toBe("brave-search")
  })

  it("takes the key from the environment when no credential is stored", async () => {
    const mod = await loadPlugin<Brave>("../plugins/brave-search", {
      BRAVE_SEARCH_API_KEY: "env-key",
    })
    const harness = makeHarness()
    await harness.run(mod.effect(harness.ctx))
    expect(harness.providers.map((p) => p.id)).toEqual(["osp-brave"])

    const fetch = stubFetch(() => jsonResponse({ web: { results: [] } }))
    await harness.run(harness.providers[0]!.execute({ query: "q" }))
    expect(fetch.calls[0]!.init?.headers).toMatchObject({
      "X-Subscription-Token": "env-key",
    })
  })

  it("normalizes the query, sends the knobs, and maps results", async () => {
    const { harness } = await bind({
      BRAVE_SEARCH_API_KEY: "",
      BRAVE_NUM: "12",
      BRAVE_COUNTRY: "cn",
      BRAVE_LANG: "zh-hans",
      BRAVE_FRESHNESS: "pw",
    })

    const published = "2026-10-01T08:30:00.000Z"
    const fetch = stubFetch(() =>
      jsonResponse({
        web: {
          results: [
            {
              title: "First",
              url: "https://example.com/one",
              description: "Body one",
              page_age: published,
            },
            { title: "Second", url: "https://example.com/two" },
          ],
        },
      }),
    )

    const results = (await harness.run(
      harness.providers[0]!.execute({ query: "  hello   world  " }),
    )) as Array<{ url: string; title: string; content: string; time: Record<string, number> }>

    const { url, init } = fetch.calls[0]!
    expect(url.searchParams.get("q")).toBe("hello world")
    expect(url.searchParams.get("count")).toBe("12")
    expect(url.searchParams.get("country")).toBe("cn")
    expect(url.searchParams.get("search_lang")).toBe("zh-hans")
    expect(url.searchParams.get("freshness")).toBe("pw")
    expect(init?.headers).toMatchObject({
      "X-Subscription-Token": "brave-key",
      Accept: "application/json",
    })

    expect(results).toHaveLength(2)
    expect(results[0]).toEqual({
      url: "https://example.com/one",
      title: "First",
      content: "Body one",
      time: { published: Date.parse(published) },
    })
    expect(results[1]!.time).toEqual({})
  })

  it("clamps BRAVE_NUM to Brave's documented maximum of 20", async () => {
    const { harness } = await bind({ BRAVE_SEARCH_API_KEY: "", BRAVE_NUM: "500" })
    const fetch = stubFetch(() => jsonResponse({ web: { results: [] } }))
    await harness.run(harness.providers[0]!.execute({ query: "q" }))
    expect(fetch.calls[0]!.url.searchParams.get("count")).toBe("20")
  })

  it("caches a repeated query instead of paying for it twice", async () => {
    const { harness } = await bind()
    const fetch = stubFetch(() =>
      jsonResponse({ web: { results: [{ title: "T", url: "https://e.com" }] } }),
    )

    const provider = harness.providers[0]!
    await harness.run(provider.execute({ query: "same query" }))
    await harness.run(provider.execute({ query: "  same   query " }))
    expect(fetch.calls).toHaveLength(1)
  })

  it("reports the HTTP status when Brave refuses the request", async () => {
    const { harness } = await bind()
    stubFetch(() => new Response("quota exceeded", { status: 429 }))

    await expect(harness.run(harness.providers[0]!.execute({ query: "q" }))).rejects.toThrow(
      /Brave API error 429/,
    )
  })

  it("reports a decode failure rather than returning malformed results", async () => {
    const { harness } = await bind()
    stubFetch(() => jsonResponse({ web: { results: [{ url: 42 }] } }))

    await expect(harness.run(harness.providers[0]!.execute({ query: "q" }))).rejects.toThrow()
  })

  it("rebinds when a credential appears after startup", async () => {
    const mod = await loadPlugin<Brave>("../plugins/brave-search", NO_KEY)
    const harness = makeHarness({
      credentialSequence: [undefined, { type: "key", key: "later" }],
      events: [{ type: "credential.updated" }],
    })
    await harness.run(mod.effect(harness.ctx))

    // Startup saw no credential, so nothing bound. The event-driven rebind
    // noticed the key and replayed the transform, which is what makes the
    // provider join the pool without a restart.
    expect(harness.reloads).toBe(1)
    expect(harness.providers.map((p) => p.id)).toEqual(["osp-brave"])
  })

  it("does not reload when the credential state is unchanged", async () => {
    const { harness } = await bind(NO_KEY, [{ type: "credential.updated" }])
    expect(harness.providers).toHaveLength(1)
    expect(harness.reloads).toBe(0)
  })
})
