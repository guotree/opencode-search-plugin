import { afterEach, describe, expect, it, vi } from "vitest"
import type { Plugin } from "@opencode/plugin/effect"
import type { Effect, Scope } from "effect"
import { HttpClientError } from "effect/http"
import { loadPlugin, makeHarness, stubFetch, stubMcpFetch } from "./harness"
import type { Harness, RecordedCall } from "./harness"

interface ProviderModule {
  default: { id: string }
  effect: (ctx: Plugin.Context) => Effect.Effect<void, never, Scope.Scope>
}

const ENV_KEY = "OSP_ZHIPU_CODING_API_KEY"
const ENDPOINT = "https://open.bigmodel.cn/api/mcp/web_search_prime/mcp"
const KEY = "coding-plan-key"
const CREDENTIAL = { type: "key" as const, key: KEY }

const schema = {
  type: "object",
  properties: {
    search_query: { type: "string" },
    count: { type: "integer" },
    search_recency_filter: { type: "string" },
    search_domain_filter: { type: "string" },
    content_size: { type: "string" },
  },
}

const rows = [
  { title: "First", link: "https://example.com/1", content: "中文🐟abcdef", publish_date: "2026-11-06" },
  { title: "", url: "https://example.com/2", snippet: "second" },
  { title: "No URL", content: "drop" },
]

function textResult(value: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(value) }] }
}

function methodOf(call: RecordedCall): string {
  if (call.init?.method === "DELETE") return "DELETE"
  return (call.body as { method?: string } | undefined)?.method ?? ""
}

function headersOf(call: RecordedCall): Record<string, string> {
  return (call.init?.headers ?? {}) as Record<string, string>
}

async function bind(
  env: Record<string, string> = {},
  options: { credentialSequence?: Array<{ type: "key"; key: string } | undefined> } = {},
): Promise<{ harness: Harness; provider: Harness["providers"][number]; mod: ProviderModule }> {
  const mod = await loadPlugin<ProviderModule>("../plugins/zhipu-coding-search", {
    [ENV_KEY]: KEY,
    ...env,
  })
  const harness = makeHarness({ credentialSequence: options.credentialSequence ?? undefined })
  await harness.run(mod.effect(harness.ctx))
  return { harness, provider: harness.providers[0]!, mod }
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe("Zhipu Coding Plan MCP", () => {
  it("binds through /connect and uses the Coding Plan endpoint, not the metered REST API", async () => {
    const { harness, provider, mod } = await bind()
    expect(mod.default.id).toBe("zhipu-coding-search")
    expect(harness.providers.map((entry) => entry.id)).toEqual(["osp-zhipu-coding"])
    expect(harness.providers.map((entry) => entry.name)).toEqual(["Zhipu Coding Plan"])
    expect(harness.integrationNames.get("osp-zhipu-coding")).toBe("Zhipu Coding Plan (osp)")
    expect(harness.envMethods).toEqual([
      { integrationID: "osp-zhipu-coding", names: [ENV_KEY] },
    ])

    const fake = stubMcpFetch({
      callResult: textResult({ search_result: rows }),
    })
    await harness.run(provider.execute({ query: "hello" }))
    expect(fake.calls.every((call) => call.url.href === ENDPOINT)).toBe(true)
    expect(fake.calls.some((call) => call.url.href.includes("/paas/v4/web_search"))).toBe(false)
  })

  it("runs initialize, initialized, tools/list, tools/call and DELETE with session headers", async () => {
    const { harness, provider } = await bind()
    const fake = stubMcpFetch({
      callResult: textResult({ search_result: rows }),
    })

    const results = (await harness.run(provider.execute({ query: "  hello   world " }))) as Array<{
      url: string
      title: string
      content: string
      time: { published?: number }
    }>

    expect(results).toEqual([
      {
        url: "https://example.com/1",
        title: "First",
        content: "中文🐟abcdef",
        time: { published: Date.parse("2026-11-06") },
      },
      {
        url: "https://example.com/2",
        title: "https://example.com/2",
        content: "second",
        time: {},
      },
    ])
    expect(fake.calls.map(methodOf)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
      "tools/call",
      "DELETE",
    ])

    const initialize = fake.calls[0]!
    expect(headersOf(initialize).Authorization).toBe("Bearer " + KEY)
    expect(headersOf(initialize).Accept).toContain("text/event-stream")
    expect(headersOf(initialize)).not.toHaveProperty("Mcp-Session-Id")

    const notification = fake.calls[1]!
    expect(headersOf(notification)["Mcp-Session-Id"]).toBe("mcp-session")
    expect(headersOf(notification)["MCP-Protocol-Version"]).toBe("2024-11-05")
    expect(notification.body).toEqual({ jsonrpc: "2.0", method: "notifications/initialized" })

    const list = fake.calls[2]!
    expect((list.body as { id: number }).id).toBe(2)
    const call = fake.calls[3]!
    expect((call.body as { id: number }).id).toBe(3)
    expect((call.body as { params: { arguments: unknown } }).params.arguments).toEqual({
      search_query: "hello world",
      count: 10,
    })
    expect(headersOf(fake.calls[4]!)["Mcp-Session-Id"]).toBe("mcp-session")
  })

  it("sends schema-advertised filters and caps the returned rows locally", async () => {
    const { harness, provider } = await bind({
      ZHIPU_CODING_COUNT: "2",
      ZHIPU_CODING_RECENCY: "oneWeek",
      ZHIPU_CODING_DOMAIN_FILTER: "example.com",
      ZHIPU_CODING_CONTENT_SIZE: "high",
    })
    const fake = stubMcpFetch({
      inputSchema: schema,
      callResult: textResult({ search_result: rows }),
    }, (call) => {
      expect((call.body as { params: { arguments: unknown } }).params.arguments).toEqual({
        search_query: "filters",
        count: 2,
        search_recency_filter: "oneWeek",
        search_domain_filter: "example.com",
        content_size: "high",
      })
    })

    const results = (await harness.run(provider.execute({ query: "filters" }))) as unknown[]
    expect(results).toHaveLength(2)
  })

  it("omits count when the schema does not advertise it and still caps locally", async () => {
    const { harness, provider } = await bind({ ZHIPU_CODING_COUNT: "1" })
    const fake = stubMcpFetch({
      inputSchema: { type: "object", properties: { search_query: { type: "string" } } },
      callResult: textResult({ search_result: rows }),
    }, (call) => {
      expect((call.body as { params: { arguments: unknown } }).params.arguments).toEqual({
        search_query: "local cap",
      })
    })

    const results = (await harness.run(provider.execute({ query: "local cap" }))) as unknown[]
    expect(results).toHaveLength(1)
  })

  it("omits noLimit recency and fails before tools/call when a configured filter is unsupported", async () => {
    const noLimit = await bind({ ZHIPU_CODING_RECENCY: "noLimit" })
    let fake = stubMcpFetch({ callResult: textResult({ search_result: rows }) })
    await noLimit.harness.run(noLimit.provider.execute({ query: "no limit" }))
    expect(
      (fake.calls.find((call) => methodOf(call) === "tools/call")!.body as {
        params: { arguments: unknown }
      }).params.arguments,
    ).toEqual({ search_query: "no limit", count: 10 })

    const unsupported = await bind({ ZHIPU_CODING_DOMAIN_FILTER: "example.com" })
    fake = stubMcpFetch({
      inputSchema: { type: "object", properties: { search_query: { type: "string" } } },
      callResult: textResult({ search_result: rows }),
    })
    await expect(
      unsupported.harness.run(unsupported.provider.execute({ query: "unsupported" })),
    ).rejects.toThrow(/DOMAIN_FILTER.*does not advertise search_domain_filter/)
    expect(fake.calls.some((call) => methodOf(call) === "tools/call")).toBe(false)
  })

  it("accepts the documented camelCase tool and both JSON and SSE framing", async () => {
    for (const transport of ["json", "sse"] as const) {
      const { harness, provider } = await bind()
      const fake = stubMcpFetch({
        toolName: "webSearchPrime",
        transport,
        callResult: textResult({ search_result: rows }),
      })
      const results = (await harness.run(provider.execute({ query: transport }))) as unknown[]
      expect(results).toHaveLength(2)
      expect(
        (fake.calls.find((call) => methodOf(call) === "tools/call")!.body as {
          params: { name: string }
        }).params.name,
      ).toBe("webSearchPrime")
    }
  })

  it("decodes structuredContent and up to three JSON text layers", async () => {
    for (const result of [
      { structuredContent: { search_result: rows } },
      { content: [{ type: "text", text: JSON.stringify(JSON.stringify({ results: rows })) }] },
      {
        content: [{
          type: "text",
          text: JSON.stringify(JSON.stringify(JSON.stringify({ search_result: rows }))),
        }],
      },
    ]) {
      const { harness, provider } = await bind({ ZHIPU_CODING_CACHE_TTL: "0" })
      stubMcpFetch({ callResult: result })
      const results = (await harness.run(provider.execute({ query: JSON.stringify(result) }))) as unknown[]
      expect(results).toHaveLength(2)
    }
  })

  it("caches empty results briefly, but never caches malformed or wholly unusable payloads", async () => {
    const empty = await bind()
    let fake = stubMcpFetch({ callResult: textResult({ search_result: [] }) })
    await empty.harness.run(empty.provider.execute({ query: "empty" }))
    await empty.harness.run(empty.provider.execute({ query: "empty" }))
    expect(fake.calls.filter((call) => methodOf(call) === "tools/call")).toHaveLength(1)

    const malformed = await bind()
    fake = stubMcpFetch({ callResult: { content: [{ type: "text", text: "not-json" }] } })
    for (let index = 0; index < 2; index += 1) {
      await expect(
        malformed.harness.run(malformed.provider.execute({ query: "bad" })),
      ).rejects.toThrow(/expected results array/)
    }
    expect(fake.calls.filter((call) => methodOf(call) === "tools/call")).toHaveLength(2)

    const unusable = await bind()
    fake = stubMcpFetch({
      callResult: textResult({ search_result: [{ title: "missing URL" }] }),
    })
    await expect(
      unusable.harness.run(unusable.provider.execute({ query: "unusable" })),
    ).rejects.toThrow(/no usable search results/)
  })

  it("cuts content by code point and normalizes a repeated query into one cache entry", async () => {
    const { harness, provider } = await bind({ ZHIPU_CODING_CONTENT_CHARS: "4" })
    const fake = stubMcpFetch({ callResult: textResult({ search_result: rows }) })
    const first = (await harness.run(
      provider.execute({ query: "  repeat   query " }),
    )) as Array<{ content: string }>
    expect(first[0]!.content).toBe("中文🐟a…")
    const second = (await harness.run(provider.execute({ query: "repeat query" }))) as unknown[]
    expect(second).toEqual(first)
    expect(fake.calls.filter((call) => methodOf(call) === "tools/call")).toHaveLength(1)
  })

  it("isolates the result cache by key", async () => {
    const { harness, provider } = await bind(
      { [ENV_KEY]: "" },
      {
        credentialSequence: [
          CREDENTIAL,
          CREDENTIAL,
          { type: "key", key: "second-key" },
        ],
      },
    )
    const fake = stubMcpFetch({ callResult: textResult({ search_result: rows }) })
    await harness.run(provider.execute({ query: "rotating key" }))
    await harness.run(provider.execute({ query: "rotating key" }))
    expect(fake.calls.filter((call) => methodOf(call) === "tools/call")).toHaveLength(2)
  })

  it("preserves typed 429 diagnostics without reading a damaged body, and explains a 401", async () => {
    const { harness, provider } = await bind()

    stubFetch(() => new Response("private refusal", {
      status: 429,
      headers: { "Retry-After": "7" },
    }))
    const throttled = await harness.run(provider.execute({ query: "throttle" })).catch(
      (error: unknown) => error,
    )
    expect(HttpClientError.isHttpClientError(throttled)).toBe(true)
    if (!HttpClientError.isHttpClientError(throttled)) throw new Error("Expected typed throttle")
    expect(throttled.response?.status).toBe(429)
    expect(throttled.response?.headers["retry-after"]).toBe("7")
    expect(JSON.stringify(throttled)).not.toContain("private refusal")
    expect(JSON.stringify(throttled)).not.toContain(KEY)
  })

  it("names the env key and the other site on 401, without echoing the body", async () => {
    const { harness, provider } = await bind()
    stubFetch(() => new Response("secret " + KEY + " session-secret", { status: 401 }))
    const error = await harness.run(provider.execute({ query: "unauthorized" })).catch(
      (value: unknown) => value,
    )
    expect(String(error)).toContain(ENV_KEY)
    expect(String(error)).toContain("osp-zai-coding")
    expect(String(error)).not.toContain(KEY)
    expect(String(error)).not.toContain("session-secret")
  })

  it("cleans up a live session after a tool refusal but not after a failed initialize", async () => {
    const { harness, provider } = await bind()
    const fake = stubMcpFetch()
    const original = globalThis.fetch
    let toolCall = false
    globalThis.fetch = async (input, init) => {
      const body = JSON.parse(String(init?.body ?? "null")) as { method?: string } | null
      if (body?.method === "tools/call") {
        toolCall = true
        return new Response("refused", { status: 500 })
      }
      return original(input, init)
    }
    try {
      await expect(harness.run(provider.execute({ query: "call refusal" }))).rejects.toThrow(
        /API error 500/,
      )
      expect(toolCall).toBe(true)
      expect(fake.calls.some((call) => call.init?.method === "DELETE")).toBe(true)
    } finally {
      globalThis.fetch = original
    }
  })

  it("redacts the key and session id from a JSON-RPC error", async () => {
    const { harness, provider } = await bind()
    stubFetch((call) => {
      if (call.init?.method === "DELETE") return new Response(null, { status: 204 })
      const body = call.body as { id?: number; method?: string }
      if (body.method === "initialize") {
        return new Response(JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: { protocolVersion: "2024-11-05" },
        }), {
          headers: {
            "Content-Type": "application/json",
            "Mcp-Session-Id": "session-secret",
          },
        })
      }
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 })
      if (body.method === "tools/list") {
        return new Response(JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: { tools: [{ name: "web_search_prime", inputSchema: schema }] },
        }), { headers: { "Content-Type": "application/json" } })
      }
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        error: { code: -32000, message: "bad " + KEY + " and session-secret" },
      }), { headers: { "Content-Type": "application/json" } })
    })

    const error = await harness.run(provider.execute({ query: "rpc error" })).catch(
      (value: unknown) => value,
    )
    expect(String(error)).toContain("[redacted]")
    expect(String(error)).not.toContain(KEY)
    expect(String(error)).not.toContain("session-secret")
  })

  it("does not open a session when initialize is refused", async () => {
    const { harness, provider } = await bind()
    const fake = stubFetch(() => new Response("refused", { status: 500 }))
    await expect(harness.run(provider.execute({ query: "init refusal" }))).rejects.toThrow(
      /API error 500/,
    )
    expect(fake.calls.some((call) => call.init?.method === "DELETE")).toBe(false)
  })

  it("rejects a blank query before dispatch and does not bind a whitespace key", async () => {
    const { harness, provider } = await bind()
    const fake = stubFetch(() => {
      throw new Error("must not fetch")
    })
    await expect(harness.run(provider.execute({ query: "   " }))).rejects.toThrow(
      /query must not be empty/,
    )
    expect(fake.calls).toHaveLength(0)

    const blank = await loadPlugin<ProviderModule>("../plugins/zhipu-coding-search", {
      [ENV_KEY]: "   ",
    })
    const blankHarness = makeHarness()
    await blankHarness.run(blank.effect(blankHarness.ctx))
    expect(blankHarness.providers).toHaveLength(0)
  })

  it("does not dispatch tools/call when the server publishes no supported search tool", async () => {
    const { harness, provider } = await bind()
    const fake = stubMcpFetch({ toolName: "webReader" })
    await expect(harness.run(provider.execute({ query: "unsupported tool" }))).rejects.toThrow(
      /did not publish a supported Web Search tool/,
    )
    expect(fake.calls.some((call) => methodOf(call) === "tools/call")).toBe(false)
  })
})
