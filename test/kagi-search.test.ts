import { afterEach, describe, expect, it, vi } from "vitest"
import { jsonResponse, loadPlugin, makeHarness, stubFetch } from "./harness"

type Kagi = typeof import("../plugins/kagi-search")

const NO_KEY: Record<string, string> = { OSP_KAGI_API_KEY: "" }

/** Bound with a stored credential, env applied on top of `NO_KEY`. */
async function bind(env: Record<string, string> = {}, events?: ReadonlyArray<{ type: string }>) {
  const mod = await loadPlugin<Kagi>("../plugins/kagi-search", { ...NO_KEY, ...env })
  const harness = makeHarness({
    credentialSequence: [{ type: "key", key: "kagi-key" }],
    events,
  })
  await harness.run(mod.effect(harness.ctx))
  return { mod, harness }
}

interface HitResult {
  url: string
  title: string
  content: string
  time: { published?: number }
}

const EMPTY = { meta: { trace: "t", node: "n", ms: 1 }, data: { search: [] } }

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("kagi-search", () => {
  it("does not bind a provider without a key", async () => {
    const mod = await loadPlugin<Kagi>("../plugins/kagi-search", NO_KEY)
    const harness = makeHarness()
    await harness.run(mod.effect(harness.ctx))
    expect(harness.providers).toHaveLength(0)
  })

  it("binds the provider and wires /connect when a key is stored", async () => {
    const { mod, harness } = await bind()
    expect(harness.providers.map((p) => p.id)).toEqual(["osp-kagi"])
    expect(harness.integrationNames.get("osp-kagi")).toBe("Kagi (osp)")
    expect(harness.envMethods).toEqual([{ integrationID: "osp-kagi", names: ["OSP_KAGI_API_KEY"] }])
    expect(mod.default.id).toBe("kagi-search")
  })

  it("sends the documented body, omitting lens, recency and region by default", async () => {
    const { harness } = await bind()
    const fetch = stubFetch(() => jsonResponse(EMPTY))

    await harness.run(harness.providers[0]!.execute({ query: "  hello   world  " }))

    const { url, init } = fetch.calls[0]!
    expect(url.host).toBe("kagi.com")
    expect(url.pathname).toBe("/api/v1/search")
    expect(init?.method).toBe("POST")
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer kagi-key",
      "Content-Type": "application/json",
      Accept: "application/json",
    })
    // `limit` is always sent (naming it keeps the knob honest); the three
    // filters are omitted rather than sent as "".
    expect(fetch.calls[0]!.body).toEqual({
      query: "hello world",
      workflow: "search",
      limit: 8,
    })
  })

  it("sends the lens, recency and region the knobs ask for, and clamps KAGI_NUM to 1-1024", async () => {
    const { harness } = await bind({
      KAGI_NUM: "9999",
      KAGI_RECENT: "week",
      KAGI_REGION: "cn",
    })
    const fetch = stubFetch(() => jsonResponse(EMPTY))

    await harness.run(harness.providers[0]!.execute({ query: "q" }))

    // No KAGI_LENS is set, so recency rides along as an inline lens.
    expect(fetch.calls[0]!.body).toEqual({
      query: "q",
      workflow: "search",
      limit: 1024,
      lens: { time_relative: "week" },
      filters: { region: "cn" },
    })
  })

  it("prefers the named lens over the recency filter", async () => {
    const { harness } = await bind({ KAGI_LENS: "programming", KAGI_RECENT: "day" })
    const fetch = stubFetch(() => jsonResponse(EMPTY))

    await harness.run(harness.providers[0]!.execute({ query: "q" }))

    // lens_id and an inline lens would be two lenses at once, which the spec
    // does not define -- the named lens wins and the inline one is dropped.
    expect(fetch.calls[0]!.body).toEqual({
      query: "q",
      workflow: "search",
      limit: 8,
      lens_id: "programming",
    })
  })

  it("warns about an unknown recency value and omits the filter", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const { harness } = await bind({ KAGI_RECENT: "hour" })
    const fetch = stubFetch(() => jsonResponse(EMPTY))

    await harness.run(harness.providers[0]!.execute({ query: "q" }))

    // An out-of-enum lens.time_relative is a 400, so the typo is dropped
    // here rather than paid for on every search.
    expect(fetch.calls[0]!.body).toEqual({ query: "q", workflow: "search", limit: 8 })
    expect(warn.mock.calls.some((call) => String(call[0]).includes("KAGI_RECENT"))).toBe(true)
  })

  it("maps data.search only, reading `time` as published and falling back to an empty snippet", async () => {
    const { harness } = await bind()
    const published = "2026-11-29T03:54:26Z"
    stubFetch(() =>
      jsonResponse({
        meta: { trace: "9f7c", node: "kagi-07", ms: 142 },
        data: {
          search: [
            { url: "https://example.com/one", title: "First", snippet: "Body one", time: published },
            { url: "https://example.com/two", title: "Second" },
          ],
          news: [{ url: "https://example.com/news", title: "A news result" }],
        },
      }),
    )

    const results = (await harness.run(
      harness.providers[0]!.execute({ query: "q" }),
    )) as HitResult[]

    // The news collection and the debugging `meta` ride along unread: only
    // data.search maps to the agent.
    expect(results).toEqual([
      {
        url: "https://example.com/one",
        title: "First",
        content: "Body one",
        time: { published: Date.parse(published) },
      },
      { url: "https://example.com/two", title: "Second", content: "", time: {} },
    ])
  })

  it("caches a repeated query instead of paying for it twice", async () => {
    const { harness } = await bind()
    const fetch = stubFetch(() =>
      jsonResponse({
        data: { search: [{ url: "https://e.com", title: "T", snippet: "S" }] },
      }),
    )

    const provider = harness.providers[0]!
    await harness.run(provider.execute({ query: "same query" }))
    await harness.run(provider.execute({ query: "  same   query " }))
    expect(fetch.calls).toHaveLength(1)
  })

  it("names the timeout when Kagi never answers", async () => {
    const { harness } = await bind({ KAGI_TIMEOUT: "250" })
    // Accepts the request, then goes silent -- a stalled upstream. The real
    // fetch would never return, so the deadline is the only thing that ends it.
    stubFetch(
      (call) =>
        new Promise<Response>((_resolve, reject) => {
          call.init?.signal?.addEventListener("abort", () => reject(call.init?.signal?.reason))
        }) as unknown as Response,
    )

    const started = Date.now()
    await expect(harness.run(harness.providers[0]!.execute({ query: "q" }))).rejects.toThrow(
      /Kagi search timed out after 250ms/,
    )
    expect(Date.now() - started).toBeLessThan(3_000)
  })

  it("reports the HTTP status when Kagi refuses the request", async () => {
    const { harness } = await bind()
    stubFetch(() => new Response("invalid api key", { status: 401 }))

    await expect(harness.run(harness.providers[0]!.execute({ query: "q" }))).rejects.toThrow(
      /Kagi API error 401/,
    )
  })

  it("reports a decode failure rather than returning malformed results", async () => {
    const { harness } = await bind()
    stubFetch(() => jsonResponse({ data: { search: [{ url: 42, title: "bad" }] } }))

    await expect(harness.run(harness.providers[0]!.execute({ query: "q" }))).rejects.toThrow()
  })

  it("rebinds when a credential appears after startup", async () => {
    const mod = await loadPlugin<Kagi>("../plugins/kagi-search", NO_KEY)
    const harness = makeHarness({
      credentialSequence: [undefined, { type: "key", key: "later" }],
      events: [{ type: "credential.updated" }],
    })
    await harness.run(mod.effect(harness.ctx))

    // Startup saw no credential, so nothing bound. The event-driven rebind
    // noticed the key and replayed the transform, which is what makes the
    // provider join the pool without a restart.
    expect(harness.reloads).toBe(1)
    expect(harness.providers.map((p) => p.id)).toEqual(["osp-kagi"])
  })

  it("does not reload when the credential state is unchanged", async () => {
    const { harness } = await bind(NO_KEY, [{ type: "credential.updated" }])
    expect(harness.providers).toHaveLength(1)
    expect(harness.reloads).toBe(0)
  })
})
