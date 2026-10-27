import { afterEach, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import type { Plugin } from "@opencode/plugin/effect"
import type { Effect, Scope } from "effect"
import { loadPlugin, makeHarness, jsonResponse, stubFetch } from "./harness"

interface Module {
  default: { id: string }
  effect: (ctx: Plugin.Context) => Effect.Effect<void, never, Scope.Scope>
}

const NO_KEY: Record<string, string> = { OSP_JINA_API_KEY: "" }
const CREDENTIAL = { type: "key", key: "k" } as const

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

async function bind(env: Record<string, string> = NO_KEY) {
  const mod = await loadPlugin<Module>("../plugins/jina-search", { ...NO_KEY, ...env })
  const harness = makeHarness({ credentialSequence: [CREDENTIAL] })
  await harness.run(mod.effect(harness.ctx))
  return harness
}

/** Accepts the request and never answers, handing over a real signal. */
function hangForever(): void {
  vi.stubGlobal(
    "fetch",
    (_i: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason))
      }) as never,
  )
}

describe("jina-search deadline", () => {
  it("wires JINA_TIMEOUT into the request and names it on failure", async () => {
    const harness = await bind({ JINA_TIMEOUT: "250" })
    hangForever()

    await expect(harness.run(harness.providers[0]!.execute({ query: "q" }))).rejects.toThrow(
      "Jina search timed out after 250ms",
    )
  })

  it("removes the deadline at 0 but still passes the cancellation signal", async () => {
    const harness = await bind({ JINA_TIMEOUT: "0" })
    let init: RequestInit | undefined
    vi.stubGlobal("fetch", (_i: unknown, init2?: RequestInit) => {
      init = init2
      return Promise.resolve(
        new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ) as never
    })

    await harness.run(harness.providers[0]!.execute({ query: "q" }))
    expect(init?.signal).toBeDefined()
    expect((init?.signal as AbortSignal).aborted).toBe(false)
  })

  it("defaults to a longer budget when INCLUDE_CONTENT is on", () => {
    // The two defaults are 25s and 60s -- far past what a test can wait out, so
    // this asserts the rule at the source level, the way structure.test.ts does.
    const src = readFileSync(new URL("../plugins/jina-search.ts", import.meta.url), "utf8")
    expect(src).toContain("const DEFAULT_TIMEOUT = INCLUDE_CONTENT ? 60_000 : 25_000")
    expect(src).toContain('const SEARCH_TIMEOUT = envInt("JINA_TIMEOUT", DEFAULT_TIMEOUT)')
  })

  it("leaves the deadline out of the page-content request path only via the knob", async () => {
    // INCLUDE_CONTENT changes the request shape, not the deadline: a crawl must
    // be bounded too, or it is the worst case for hanging the agent.
    const harness = await bind({ JINA_INCLUDE_CONTENT: "true", JINA_TIMEOUT: "250" })
    hangForever()

    await expect(harness.run(harness.providers[0]!.execute({ query: "q" }))).rejects.toThrow(
      /timed out after 250ms/,
    )
  })
})

describe("jina-search content bound", () => {
  const page = (content: string) =>
    jsonResponse({
      data: [{ title: "Long", url: "https://example.com/long", content }],
    })

  it("cuts each page to JINA_CONTENT_CHARS code points, defaulting to 4000", async () => {
    const harness = await bind({ JINA_INCLUDE_CONTENT: "true" })
    stubFetch(() => page("a".repeat(5000)))

    const results = (await harness.run(
      harness.providers[0]!.execute({ query: "q" }),
    )) as Array<{ content: string }>

    // 4000 is roughly a long article's opening, and the ellipsis says the
    // page was clipped rather than that it ended there.
    expect(results[0]!.content).toBe("a".repeat(4000) + "…")
  })

  it("keeps the whole page with JINA_CONTENT_CHARS=0", async () => {
    const harness = await bind({ JINA_INCLUDE_CONTENT: "true", JINA_CONTENT_CHARS: "0" })
    stubFetch(() => page("a".repeat(5000)))

    const results = (await harness.run(
      harness.providers[0]!.execute({ query: "q" }),
    )) as Array<{ content: string }>

    expect(results[0]!.content).toBe("a".repeat(5000))
  })

  it("cuts on code points, never slicing a surrogate pair", async () => {
    const harness = await bind({ JINA_INCLUDE_CONTENT: "true", JINA_CONTENT_CHARS: "10" })
    stubFetch(() => page("😀".repeat(20)))

    const results = (await harness.run(
      harness.providers[0]!.execute({ query: "q" }),
    )) as Array<{ content: string }>

    expect(results[0]!.content).toBe("😀".repeat(10) + "…")
  })

  it("caches the truncated page, so a repeat query cannot repay the context", async () => {
    const harness = await bind({ JINA_INCLUDE_CONTENT: "true" })
    const fetch = stubFetch(() => page("a".repeat(5000)))

    const provider = harness.providers[0]!
    const first = (await harness.run(provider.execute({ query: "q" }))) as Array<{
      content: string
    }>
    const second = (await harness.run(provider.execute({ query: "q" }))) as Array<{
      content: string
    }>

    expect(fetch.calls).toHaveLength(1)
    expect(first[0]!.content).toBe("a".repeat(4000) + "…")
    expect(second[0]!.content).toBe(first[0]!.content)
  })
})
