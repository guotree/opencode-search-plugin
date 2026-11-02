import { afterEach, describe, expect, it, vi } from "vitest"
import { Effect } from "effect"
import { HttpClientError } from "effect/http"
import { jsonResponse, loadPlugin, makeHarness, stubFetch } from "./harness"

type Yuanbao = typeof import("../plugins/yuanbao-search")
const KEY = { type: "key" as const, key: "yuanbao-key" }
const ENV = {
  OSP_YUANBAO_API_KEY: "", YUANBAO_COUNT: "", YUANBAO_SITE: "",
  YUANBAO_FRESHNESS: "", YUANBAO_INDUSTRY: "",
}
const page = (fields: Record<string, unknown> = {}) => JSON.stringify({
  url: "https://example.com/a", title: "Title", passage: "Standard excerpt", ...fields,
})
const envelope = (Pages: unknown[] = [page()], extra: Record<string, unknown> = {}) => ({
  Response: { Pages, RequestId: "req-yuanbao", ...extra },
})

async function bind(env: Record<string, string> = {}) {
  const mod = await loadPlugin<Yuanbao>("../plugins/yuanbao-search", { ...ENV, ...env })
  const harness = makeHarness({ credentialSequence: [KEY] })
  await harness.run(mod.effect(harness.ctx))
  const search = (query = "q") => harness.run(harness.providers[0]!.execute({ query }))
  const failure = (query = "q") => harness.run(harness.providers[0]!.execute({ query }).pipe(Effect.flip))
  return { harness, search, failure }
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe("yuanbao-search", () => {
  it("uses the Bearer service endpoint and sends only Query by default for all account tiers", async () => {
    const { search } = await bind()
    const fetch = stubFetch(() => jsonResponse(envelope()))
    await search("  hello   world  ")
    expect(fetch.calls).toHaveLength(1)
    expect(fetch.calls[0]!.url.href).toBe("https://api.wsa.cloud.tencent.com/SearchPro")
    expect(fetch.calls[0]!.init).toMatchObject({
      method: "POST",
      headers: { Authorization: "Bearer yuanbao-key", "Content-Type": "application/json; charset=utf-8" },
    })
    expect(fetch.calls[0]!.body).toEqual({ Query: "hello world" })
  })

  it("sends documented optional filters and an integer Cnt", async () => {
    const { search } = await bind({
      YUANBAO_COUNT: "20", YUANBAO_SITE: "exclude:qq.com|sohu.com",
      YUANBAO_FRESHNESS: "d7", YUANBAO_INDUSTRY: "acad",
    })
    const fetch = stubFetch(() => jsonResponse(envelope()))
    await search()
    expect(fetch.calls[0]!.body).toEqual({
      Query: "q", Cnt: 20, Site: "exclude:qq.com|sohu.com", Freshness: "d7", Industry: "acad",
    })
  })

  it("uses the environment key when no saved credential exists", async () => {
    const mod = await loadPlugin<Yuanbao>("../plugins/yuanbao-search", { ...ENV, OSP_YUANBAO_API_KEY: "env-key" })
    const harness = makeHarness()
    await harness.run(mod.effect(harness.ctx))
    const fetch = stubFetch(() => jsonResponse(envelope()))
    await harness.run(harness.providers[0]!.execute({ query: "env" }))
    expect(fetch.calls[0]!.init?.headers).toMatchObject({ Authorization: "Bearer env-key" })
  })

  it("prefers saved credentials and reads a rotated key on the next cache miss", async () => {
    const mod = await loadPlugin<Yuanbao>("../plugins/yuanbao-search", { ...ENV, OSP_YUANBAO_API_KEY: "env-key" })
    const harness = makeHarness({ credentialSequence: [KEY, KEY, { type: "key", key: "rotated-key" }] })
    await harness.run(mod.effect(harness.ctx))
    const fetch = stubFetch(() => jsonResponse(envelope()))
    await harness.run(harness.providers[0]!.execute({ query: "first" }))
    await harness.run(harness.providers[0]!.execute({ query: "second" }))
    expect(fetch.calls.map((c) => c.init?.headers)).toEqual([
      expect.objectContaining({ Authorization: "Bearer yuanbao-key" }),
      expect.objectContaining({ Authorization: "Bearer rotated-key" }),
    ])
  })

  it("keeps host cancellation active with YUANBAO_TIMEOUT=0", async () => {
    const { harness } = await bind({ YUANBAO_TIMEOUT: "0" })
    const controller = new AbortController()
    let arrived!: () => void
    const started = new Promise<void>((resolve) => { arrived = resolve })
    const fetch = stubFetch((call) => new Promise<Response>((_resolve, reject) => {
      const signal = call.init!.signal!
      signal.addEventListener("abort", () => reject(signal.reason))
      arrived()
    }))
    const running = Effect.runPromise(harness.providers[0]!.execute({ query: "cancel" }), { signal: controller.signal })
    const rejected = expect(running).rejects.toBeDefined()
    await started
    expect(fetch.calls[0]!.init?.signal?.aborted).toBe(false)
    controller.abort()
    await rejected
    expect(fetch.calls[0]!.init?.signal?.aborted).toBe(true)
  })

  it("bounds a response body that stalls after headers arrived", async () => {
    const { search } = await bind({ YUANBAO_TIMEOUT: "50" })
    stubFetch((call) => {
      const signal = call.init!.signal!
      return new Response(new ReadableStream({
        start(controller) {
          signal.addEventListener("abort", () => controller.error(signal.reason))
        },
      }))
    })
    await expect(search()).rejects.toThrow("Yuanbao search timed out after 50ms")
  })

  it.each(["10", "20", "30", "40", "50"])("accepts count %s", async (count) => {
    const { search } = await bind({ YUANBAO_COUNT: count })
    const fetch = stubFetch(() => jsonResponse(envelope()))
    await search()
    expect(fetch.calls[0]!.body).toEqual({ Query: "q", Cnt: Number(count) })
  })

  it.each([
    ["YUANBAO_COUNT", "11"], ["YUANBAO_COUNT", "10.5"], ["YUANBAO_COUNT", "0"],
    ["YUANBAO_COUNT", "-10"], ["YUANBAO_COUNT", "500"], ["YUANBAO_INDUSTRY", "medical"],
    ["YUANBAO_FRESHNESS", "d0"], ["YUANBAO_FRESHNESS", "d31"], ["YUANBAO_FRESHNESS", "m13"],
    ["YUANBAO_FRESHNESS", "y6"], ["YUANBAO_FRESHNESS", "2026-08-20,2026-08-30"],
    ["YUANBAO_SITE", "https://qq.com/path"], ["YUANBAO_SITE", "qq.com|sohu.com"],
    ["YUANBAO_SITE", "exclude:a.cn|b.cn|c.cn|d.cn|e.cn|f.cn"],
  ])("warns and omits invalid %s=%s", async (name, value) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const { search } = await bind({ [name]: value })
    const fetch = stubFetch(() => jsonResponse(envelope()))
    await search()
    expect(fetch.calls[0]!.body).toEqual({ Query: "q" })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(name))
  })

  it.each(["d1", "d30", "m1", "m12", "y1", "y5"])("accepts freshness %s", async (freshness) => {
    const { search } = await bind({ YUANBAO_FRESHNESS: freshness })
    const fetch = stubFetch(() => jsonResponse(envelope()))
    await search()
    expect(fetch.calls[0]!.body).toEqual({ Query: "q", Freshness: freshness })
  })

  it("accepts a single-domain filter", async () => {
    const { search } = await bind({ YUANBAO_SITE: "docs.example.com" })
    const fetch = stubFetch(() => jsonResponse(envelope()))
    await search()
    expect(fetch.calls[0]!.body).toEqual({ Query: "q", Site: "docs.example.com" })
  })

  it("maps lite and richer excerpts, removes known highlights, and falls back from blank content", async () => {
    const { search } = await bind()
    stubFetch(() => jsonResponse(envelope([
      page(), page({ url: "https://example.com/b", title: "<strong>Dynamic</strong>", content: "A <strong>match</strong>" }),
      page({ url: "https://example.com/c", title: " ", content: " <strong></strong> " }),
      page({ url: "https://example.com/d", content: null, passage: null }),
    ])))
    expect(await search()).toEqual([
      { url: "https://example.com/a", title: "Title", content: "Standard excerpt", time: {} },
      { url: "https://example.com/b", title: "Dynamic", content: "A match", time: {} },
      { url: "https://example.com/c", title: "https://example.com/c", content: "Standard excerpt", time: {} },
      { url: "https://example.com/d", title: "Title", content: "", time: {} },
    ])
  })

  it("keeps valid pages in upstream order despite malformed rows and unused metadata", async () => {
    const { search } = await bind()
    stubFetch(() => jsonResponse(envelope([
      "{broken", null, {}, "null", "[]", page({ url: null }), page({ title: 123 }),
      page({ url: "https://example.com/b", score: null, pics: "unknown", authority_level: 5 }),
      page({ title: null }),
    ], { Version: "flagship" })))
    expect(await search()).toEqual([
      { url: "https://example.com/b", title: "Title", content: "Standard excerpt", time: {} },
      { url: "https://example.com/a", title: "https://example.com/a", content: "Standard excerpt", time: {} },
    ])
  })

  it("only timestamps dates with an explicit zone", async () => {
    const { search } = await bind()
    const dates = ["2026-10-01T10:00:00+08:00", "2026-10-01T02:00:00Z", "2026/10/01 10:00:00", "2026-10-01 10:00:00", "2026-10-01T10:00:00", "", "Nov 1"]
    stubFetch(() => jsonResponse(envelope(dates.map((date) => page({ date })))))
    const result = await search() as Array<{ time: { published?: number } }>
    expect(result.map((r) => r.time)).toEqual([
      { published: Date.parse("2026-10-01T02:00:00Z") },
      { published: Date.parse("2026-10-01T02:00:00Z") }, {}, {}, {}, {}, {},
    ])
  })

  it.each([null, {}, { Response: null }, { Response: {} }, { Response: { Pages: {} } }, envelope(["{bad"])])(
    "fails malformed envelopes or entirely unusable pages without caching them: %j", async (body) => {
      const { search } = await bind()
      const fetch = stubFetch(() => jsonResponse(body))
      await expect(search()).rejects.toThrow(/Invalid Yuanbao response/)
      await expect(search()).rejects.toThrow(/Invalid Yuanbao response/)
      expect(fetch.calls).toHaveLength(2)
    },
  )

  it.each([
    ["UnauthorizedOperation", /\/connect.*OSP_YUANBAO_API_KEY/],
    ["ResourceNotFound", /Enable Yuanbao Search/],
    ["ResourceUnavailable", /service availability and account status/],
    ["InvalidParameter", /account tier/],
    ["InternalError", /InternalError/],
  ])("surfaces HTTP 200 business error %s with request id and no cached empty result", async (Code, hint) => {
    const { search } = await bind()
    const fetch = stubFetch(() => jsonResponse(envelope([], { Error: { Code, Message: "Refused" } })))
    await expect(search()).rejects.toThrow(hint)
    await expect(search()).rejects.toThrow(/HTTP 200.*req-yuanbao.*Refused/)
    expect(fetch.calls).toHaveLength(2)
  })

  it.each([200, 429])("emits the host's typed throttle contract for HTTP %i", async (status) => {
    const { failure } = await bind()
    stubFetch(() => new Response(JSON.stringify(envelope([], {
      Error: { Code: "RequestLimitExceeded", Message: "Too many requests" },
    })), { status, headers: { "Retry-After": "12" } }))
    const error = await failure()
    expect(HttpClientError.isHttpClientError(error)).toBe(true)
    if (!HttpClientError.isHttpClientError(error)) throw new Error("Expected HttpClientError")
    expect(error.response?.status).toBe(429)
    expect(error.response?.headers["retry-after"]).toBe("12")
    expect(error.message).toContain("HTTP " + status)
    expect(error.message).toContain("RequestLimitExceeded")
    expect(error.message).toContain("req-yuanbao")
    expect(error.request.headers).not.toHaveProperty("authorization")
    expect(JSON.stringify(error)).not.toContain(KEY.key)
  })

  it("bounds HTTP 200 business errors without losing their code or request id", async () => {
    const { search } = await bind()
    stubFetch(() => jsonResponse(envelope([], { Error: { Code: "InternalError", Message: "😀".repeat(5000) } })))
    await expect(search()).rejects.toThrow("😀".repeat(300) + "… [truncated]")
    await expect(search()).rejects.toThrow(/InternalError.*req-yuanbao/)
  })

  it("reports policy refusals and never caches them", async () => {
    const { search } = await bind()
    const fetch = stubFetch(() => jsonResponse(envelope([], { Msg: "hit black query" })))
    await expect(search()).rejects.toThrow(/refused the query.*req-yuanbao/)
    await expect(search()).rejects.toThrow(/refused the query/)
    expect(fetch.calls).toHaveLength(2)
  })

  it("does not misclassify or cache an empty result with an unknown informational message", async () => {
    const { search } = await bind()
    const fetch = stubFetch(() => jsonResponse(envelope([], { Msg: "new upstream notice" })))
    expect(await search()).toEqual([])
    expect(await search()).toEqual([])
    expect(fetch.calls).toHaveLength(2)
  })

  it("caches actual empty results for only 30 seconds", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    const { search } = await bind()
    const fetch = stubFetch(() => jsonResponse(envelope([])))
    await search()
    await search()
    expect(fetch.calls).toHaveLength(1)
    vi.setSystemTime(Date.now() + 31_000)
    await search()
    expect(fetch.calls).toHaveLength(2)
  })
})
