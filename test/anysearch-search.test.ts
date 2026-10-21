import { afterEach, describe, expect, it, vi } from "vitest"
import { jsonResponse, loadPlugin, makeHarness, stubFetch } from "./harness"

type AnySearch = typeof import("../plugins/anysearch-search")

const NO_KEY: Record<string, string> = { OSP_ANYSEARCH_API_KEY: "" }

/** Anonymous bind: no stored credential, no env key -- AnySearch's first-class mode. */
async function bindAnon(env: Record<string, string> = {}) {
  const mod = await loadPlugin<AnySearch>("../plugins/anysearch-search", { ...NO_KEY, ...env })
  const harness = makeHarness()
  await harness.run(mod.effect(harness.ctx))
  return { harness }
}

/** Bound with a stored credential, which the request must authenticate with. */
async function bindKeyed(env: Record<string, string> = {}) {
  const mod = await loadPlugin<AnySearch>("../plugins/anysearch-search", { ...NO_KEY, ...env })
  const harness = makeHarness({ credentialSequence: [{ type: "key", key: "anysearch-stored" }] })
  await harness.run(mod.effect(harness.ctx))
  return { harness }
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe("anysearch-search", () => {
  it("binds without a key and keeps the Authorization header off the anonymous request", async () => {
    const { harness } = await bindAnon()
    expect(harness.providers.map((p) => p.id)).toEqual(["osp-anysearch"])

    const fetch = stubFetch(() => jsonResponse({ code: 0 }))
    await harness.run(harness.providers[0]!.execute({ query: "  hello   world  " }))

    const { url, init, body } = fetch.calls[0]!
    expect(url.href).toBe("https://api.anysearch.com/v1/search")
    // The header that carries the key must stay off an anonymous request.
    expect(init?.headers).not.toHaveProperty("Authorization")
    // toEqual is exact: with no routing knobs set, tag/zone/language are
    // omitted rather than sent as "", and format defaults to markdown.
    expect(body).toEqual({ query: "hello world", max_results: 10, format: "markdown" })
  })

  it("authenticates with the stored key and forwards the routing knobs", async () => {
    const { harness } = await bindKeyed({
      ANYSEARCH_TAG: "code.doc",
      ANYSEARCH_ZONE: "intl",
      ANYSEARCH_LANGUAGE: "zh-CN",
      ANYSEARCH_FORMAT: "json",
    })

    const fetch = stubFetch(() => jsonResponse({ code: 0 }))
    await harness.run(harness.providers[0]!.execute({ query: "q" }))

    const { init, body } = fetch.calls[0]!
    expect(init?.headers).toMatchObject({ Authorization: "Bearer anysearch-stored" })
    expect(body).toEqual({
      query: "q",
      max_results: 10,
      tag: "code.doc",
      zone: "intl",
      language: "zh-CN",
      format: "json",
    })
  })

  it("sends markdown unless ANYSEARCH_FORMAT is exactly json", async () => {
    const { harness } = await bindAnon({ ANYSEARCH_FORMAT: "yaml" })

    const fetch = stubFetch(() => jsonResponse({ code: 0 }))
    await harness.run(harness.providers[0]!.execute({ query: "q" }))

    // The knob only recognises "json"; anything else is the default content
    // format rather than a value forwarded to an API that would reject it.
    expect((fetch.calls[0]!.body as { format: string }).format).toBe("markdown")
  })

  it("clamps ANYSEARCH_MAX_RESULTS to the API's 1-10 range", async () => {
    const low = await bindAnon({ ANYSEARCH_MAX_RESULTS: "0" })
    const lowFetch = stubFetch(() => jsonResponse({ code: 0 }))
    await low.harness.run(low.harness.providers[0]!.execute({ query: "q" }))
    expect((lowFetch.calls[0]!.body as { max_results: number }).max_results).toBe(1)

    const high = await bindAnon({ ANYSEARCH_MAX_RESULTS: "999" })
    const highFetch = stubFetch(() => jsonResponse({ code: 0 }))
    await high.harness.run(high.harness.providers[0]!.execute({ query: "q" }))
    expect((highFetch.calls[0]!.body as { max_results: number }).max_results).toBe(10)
  })

  it("names the quota wall on 402 and withholds the response body", async () => {
    const { harness } = await bindAnon()
    // A 402 body can hand back freshly generated credentials, so it must
    // never be echoed into the conversation.
    stubFetch(() => new Response("fresh credentials inside", { status: 402 }))

    const failure = await harness
      .run(harness.providers[0]!.execute({ query: "q" }))
      .then(
        () => "resolved",
        (error: unknown) => error,
      )

    expect(String(failure)).toMatch(/AnySearch quota exhausted \(HTTP 402\)/)
    expect(String(failure)).toMatch(/OSP_ANYSEARCH_API_KEY/)
    expect(String(failure)).not.toContain("fresh credentials inside")
  })

  it("reports the HTTP status and body on any other failure", async () => {
    const { harness } = await bindAnon()
    stubFetch(() => new Response("upstream exploded", { status: 500 }))

    await expect(harness.run(harness.providers[0]!.execute({ query: "q" }))).rejects.toThrow(
      /AnySearch API error 500: upstream exploded/,
    )
  })

  it("surfaces an envelope failure with its code, message and request_id", async () => {
    const { harness } = await bindAnon()
    // AnySearch reports failures in the envelope even on HTTP 200, and
    // request_id is the only handle support has on the request.
    stubFetch(() => jsonResponse({ code: -1, message: "no such intent", request_id: "req_7f3" }))

    await expect(harness.run(harness.providers[0]!.execute({ query: "q" }))).rejects.toThrow(
      /AnySearch API error -1: no such intent \(request_id req_7f3\)/,
    )
  })
})
