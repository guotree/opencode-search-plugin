import { afterEach, describe, expect, it, vi } from "vitest"
import type { Plugin } from "@opencode/plugin/effect"
import type { Effect, Scope } from "effect"
import { loadPlugin, makeHarness, stubFetch, stubMcpFetch } from "./harness"
import type { Harness, RecordedCall } from "./harness"

interface ProviderModule {
  default: { id: string }
  effect: (ctx: Plugin.Context) => Effect.Effect<void, never, Scope.Scope>
}

const ENV_KEY = "OSP_ZAI_CODING_API_KEY"
const ENDPOINT = "https://api.z.ai/api/mcp/web_search_prime/mcp"
const KEY = "zai-coding-plan-key"
const ROW = {
  title: "Z.ai Coding hit",
  link: "https://example.com/zai-coding",
  content: "Z.ai Coding snippet",
}

function textResult(value: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(value) }] }
}

function methodOf(call: RecordedCall): string {
  if (call.init?.method === "DELETE") return "DELETE"
  return (call.body as { method?: string } | undefined)?.method ?? ""
}

async function bind(env: Record<string, string> = {}): Promise<{
  harness: Harness
  provider: Harness["providers"][number]
  mod: ProviderModule
}> {
  const mod = await loadPlugin<ProviderModule>("../plugins/zai-coding-search", {
    [ENV_KEY]: KEY,
    ...env,
  })
  const harness = makeHarness()
  await harness.run(mod.effect(harness.ctx))
  return { harness, provider: harness.providers[0]!, mod }
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe("Z.ai Coding Plan MCP", () => {
  it("binds the international Coding Plan endpoint and key", async () => {
    const { harness, provider, mod } = await bind()
    expect(mod.default.id).toBe("zai-coding-search")
    expect(harness.providers.map((entry) => entry.id)).toEqual(["osp-zai-coding"])
    expect(harness.providers.map((entry) => entry.name)).toEqual(["Z.ai Coding Plan"])
    expect(harness.integrationNames.get("osp-zai-coding")).toBe("Z.ai Coding Plan (osp)")
    expect(harness.envMethods).toEqual([
      { integrationID: "osp-zai-coding", names: [ENV_KEY] },
    ])

    const fake = stubMcpFetch({ callResult: textResult({ search_result: [ROW] }) })
    const results = (await harness.run(provider.execute({ query: "international" }))) as unknown[]
    expect(results).toHaveLength(1)
    expect(fake.calls.every((call) => call.url.href === ENDPOINT)).toBe(true)
    expect(fake.calls.some((call) => call.url.href.includes("/paas/v4/web_search"))).toBe(false)
  })

  it("sends international knobs and the schema-advertised count", async () => {
    const { harness, provider } = await bind({
      ZAI_CODING_COUNT: "3",
      ZAI_CODING_RECENCY: "oneMonth",
      ZAI_CODING_CONTENT_SIZE: "medium",
    })
    const fake = stubMcpFetch({
      inputSchema: {
        type: "object",
        properties: {
          search_query: { type: "string" },
          count: { type: "integer" },
          search_recency_filter: { type: "string" },
          content_size: { type: "string" },
        },
      },
      callResult: textResult({ search_result: [ROW] }),
    }, (call) => {
      expect((call.body as { params: { arguments: unknown } }).params.arguments).toEqual({
        search_query: "knobs",
        count: 3,
        search_recency_filter: "oneMonth",
        content_size: "medium",
      })
    })

    await harness.run(provider.execute({ query: "knobs" }))
    expect(fake.calls.filter((call) => methodOf(call) === "tools/call")).toHaveLength(1)
  })

  it("accepts the server's camelCase tool and SSE replies", async () => {
    const { harness, provider } = await bind()
    stubMcpFetch({
      toolName: "webSearchPrime",
      transport: "sse",
      callResult: textResult({ results: [ROW] }),
    })
    const results = (await harness.run(provider.execute({ query: "sse" }))) as unknown[]
    expect(results).toHaveLength(1)
  })

  it("names the cn key on 401 and does not echo the refusal body", async () => {
    const { harness, provider } = await bind()
    stubFetch(() => new Response("secret " + KEY + " session-secret", { status: 401 }))
    const error = await harness.run(provider.execute({ query: "unauthorized" })).catch(
      (value: unknown) => value,
    )
    expect(String(error)).toContain(ENV_KEY)
    expect(String(error)).toContain("osp-zhipu-coding")
    expect(String(error)).not.toContain(KEY)
    expect(String(error)).not.toContain("session-secret")
  })

  it("preserves typed 429 and Retry-After", async () => {
    const { harness, provider } = await bind()
    stubFetch(() => new Response("private", {
      status: 429,
      headers: { "Retry-After": "12" },
    }))
    const error = await harness.run(provider.execute({ query: "throttle" })).catch(
      (value: unknown) => value,
    )
    expect((error as { response?: { status?: number } }).response?.status).toBe(429)
    expect((error as { response?: { headers?: Record<string, string> } }).response?.headers?.[
      "retry-after"
    ]).toBe("12")
    expect(String(error)).not.toContain("private")
  })
})
