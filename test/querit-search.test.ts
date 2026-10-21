import { afterEach, describe, expect, it, vi } from "vitest"
import { jsonResponse, loadPlugin, makeHarness, stubFetch } from "./harness"

type Querit = typeof import("../plugins/querit-search")

const NO_KEY: Record<string, string> = { OSP_QUERIT_API_KEY: "" }

/** Bound with a stored credential, env applied on top of `NO_KEY`. */
async function bind(env: Record<string, string> = {}) {
  const mod = await loadPlugin<Querit>("../plugins/querit-search", { ...NO_KEY, ...env })
  const harness = makeHarness({ credentialSequence: [{ type: "key", key: "querit-key" }] })
  await harness.run(mod.effect(harness.ctx))
  return { mod, harness }
}

interface HitResult {
  url: string
  title: string
  content: string
  time: { published?: number }
}

const EMPTY = { results: { result: [] } }

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe("querit-search", () => {
  it("sends the documented body with the query normalized and count 8 by default", async () => {
    const { harness } = await bind()
    const fetch = stubFetch(() => jsonResponse(EMPTY))

    await harness.run(harness.providers[0]!.execute({ query: "  hello   world  " }))

    const { url, init } = fetch.calls[0]!
    expect(url.host).toBe("api.querit.ai")
    expect(url.pathname).toBe("/v1/search")
    expect(init?.method).toBe("POST")
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer querit-key",
      "Content-Type": "application/json",
    })
    expect(fetch.calls[0]!.body).toEqual({ query: "hello world", count: 8 })
  })

  it("passes QUERIT_COUNT through unclamped -- the only provider that does", async () => {
    // Every other provider here clamps its count knob to a documented range
    // (Serper and You.com to 1-100); Querit forwards whatever finite,
    // non-negative number it reads and lets the service's own limit apply.
    // A value far past any sibling's ceiling must reach the wire unchanged.
    const { harness } = await bind({ QUERIT_COUNT: "5000" })
    const fetch = stubFetch(() => jsonResponse(EMPTY))

    await harness.run(harness.providers[0]!.execute({ query: "q" }))

    expect(fetch.calls[0]!.body).toEqual({ query: "q", count: 5000 })
  })

  it("falls back to the default count when QUERIT_COUNT is negative or not a number", async () => {
    // envInt only accepts finite values >= 0, so a sign typo or a stray
    // word degrades to the default rather than reaching the API.
    const negative = await bind({ QUERIT_COUNT: "-5" })
    const first = stubFetch(() => jsonResponse(EMPTY))
    await negative.harness.run(negative.harness.providers[0]!.execute({ query: "q" }))
    expect(first.calls[0]!.body).toEqual({ query: "q", count: 8 })

    const garbage = await bind({ QUERIT_COUNT: "many" })
    const second = stubFetch(() => jsonResponse(EMPTY))
    await garbage.harness.run(garbage.harness.providers[0]!.execute({ query: "q" }))
    expect(second.calls[0]!.body).toEqual({ query: "q", count: 8 })
  })

  it("prefers the snippet for content, falling back to the joined sentence matches", async () => {
    // Querit can return sentence-level matches instead of a snippet; the
    // fallback is the only body text the agent gets on such hits.
    const { harness } = await bind()
    stubFetch(() =>
      jsonResponse({
        // error_code 200 is the success code riding along on the envelope,
        // not an error to surface.
        error_code: 200,
        results: {
          result: [
            {
              url: "https://example.com/snippet-wins",
              title: "Snippet wins",
              snippet: "The snippet",
              sentence: ["a match"],
            },
            {
              url: "https://example.com/sentences",
              title: "Sentences only",
              sentence: ["first match", "second match"],
            },
            { url: "https://example.com/bare", title: "Bare" },
          ],
        },
      }),
    )

    const results = (await harness.run(
      harness.providers[0]!.execute({ query: "q" }),
    )) as HitResult[]

    expect(results.map((r) => r.content)).toEqual([
      "The snippet",
      "first match second match",
      "",
    ])
  })

  it("drops a hit without a url instead of failing the whole list", async () => {
    const { harness } = await bind()
    stubFetch(() =>
      jsonResponse({
        results: {
          result: [
            { title: "No url", snippet: "unusable" },
            { url: "https://example.com/kept", title: "Kept", snippet: "usable" },
          ],
        },
      }),
    )

    const results = (await harness.run(
      harness.providers[0]!.execute({ query: "q" }),
    )) as HitResult[]

    expect(results.map((r) => r.url)).toEqual(["https://example.com/kept"])
  })

  it("reports a body-level error on HTTP 200 with its search_id, a branch the HTTP check never sees", async () => {
    // Querit reports failures in the response body even when the request
    // "succeeded"; search_id is what support needs to trace it, and it is
    // documented as both a string and an integer, so read it loosely.
    const numbered = await bind()
    stubFetch(() =>
      jsonResponse({
        error_code: 400,
        error_msg: "quota exceeded",
        search_id: 98765,
        results: { result: [] },
      }),
    )
    await expect(
      numbered.harness.run(numbered.harness.providers[0]!.execute({ query: "q" })),
    ).rejects.toThrow(/Querit API error 400: quota exceeded \(search_id 98765\)/)

    // The string form must survive into the message as-is, and a missing
    // error_msg degrades to a named placeholder rather than "undefined".
    const strung = await bind()
    stubFetch(() => jsonResponse({ error_code: 500, search_id: "abc-123" }))
    await expect(
      strung.harness.run(strung.harness.providers[0]!.execute({ query: "q" })),
    ).rejects.toThrow(/Querit API error 500: unknown error \(search_id abc-123\)/)
  })

  it("reports the HTTP status with the body text, the branch the envelope error never touches", async () => {
    // A non-2xx fails before the envelope is even parsed, so the message
    // carries the raw response text instead of error_msg/search_id.
    const { harness } = await bind()
    stubFetch(() => new Response("invalid api key", { status: 401 }))

    await expect(harness.run(harness.providers[0]!.execute({ query: "q" }))).rejects.toThrow(
      /Querit API error 401: invalid api key/,
    )
  })
})
