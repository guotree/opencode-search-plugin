import { describe, expect, it } from "vitest"
import { jsonResponse, loadPlugin, makeHarness, stubFetch } from "./harness"
import type { Harness } from "./harness"

type ProviderModule = typeof import("../plugins/brave-search")

const KEY = { type: "key" as const, key: "test-key" }

async function bind(file: string) {
  const plugin = await loadPlugin<ProviderModule>(`../plugins/${file}-search`)
  const harness = makeHarness({ credentialSequence: [KEY] })
  await harness.run(plugin.effect(harness.ctx))
  return harness
}

async function errorMessage(harness: Harness): Promise<string> {
  try {
    await harness.run(harness.providers[0]!.execute({ query: "error detail regression" }))
  } catch (error) {
    return String(error)
  }
  throw new Error("Expected the search to fail")
}

describe("Retry-After hints", () => {
  it.each(["bocha", "doubao", "keenable", "stepfun", "zai", "zhipu"])(
    "%s handles seconds, dates, and absent or empty headers",
    async (file) => {
      const harness = await bind(file)
      const date = "Wed, 21 Oct 2026 07:28:00 GMT"
      for (const retry of [null, "", "   ", "3", date]) {
        stubFetch(() => new Response("limit", {
          status: 429,
          headers: retry === null ? {} : { "Retry-After": retry },
        }))
        const message = await errorMessage(harness)
        expect(message).toContain("HTTP 429")
        if (retry === "3") {
          expect(message).toContain("retry after 3s")
        } else if (retry === date) {
          expect(message).toContain("retry after " + date)
          expect(message).not.toContain("GMTs")
        } else {
          expect(message).not.toContain("retry after")
        }
      }
    },
  )
})

describe("error detail bound", () => {
  it("keeps a short JSON refusal body verbatim", async () => {
    const harness = await bind("brave")
    stubFetch(() => jsonResponse({ message: "unauthorized" }, 401))
    const message = await errorMessage(harness)
    expect(message).toContain("Brave API error 401")
    expect(message).toContain('{"message":"unauthorized"}')
    expect(message).not.toContain("truncated")
  })

  const refusalBranches = [
    ["bocha", 401], ["bocha", 403], ["bocha", 429], ["bocha", 500],
    ["doubao", 401], ["doubao", 429], ["doubao", 500],
    ["zai", 401], ["zai", 429], ["zai", 500],
    ["zhipu", 401], ["zhipu", 429], ["zhipu", 500],
  ] as const

  it.each(refusalBranches)("%s bounds HTML errors on HTTP %i", async (file, status) => {
    const harness = await bind(file)
    const page = "<html>" + "x".repeat(50_000) + "</html>"
    stubFetch(() => new Response(page, { status }))
    const message = await errorMessage(harness)
    expect(message).toContain(String(status))
    expect(message).toContain(page.slice(0, 300) + "… [truncated]")
    expect(message).not.toContain(page)
    // Includes the provider's status-specific diagnosis and remediation text.
    expect(message.length).toBeLessThan(1_000)
  })

  it("extracts a business error before truncating the detail", async () => {
    const harness = await bind("bocha")
    stubFetch(() => jsonResponse({
      ignored: "x".repeat(1_000),
      message: "invalid key",
      log_id: "trace-id",
    }, 401))
    const message = await errorMessage(harness)
    expect(message).toContain("invalid key (log_id trace-id)")
    expect(message).toContain("Connect Bocha")
    expect(message).not.toContain("truncated")
  })

  it("bounds long business messages in the status-specific branches", async () => {
    const harness = await bind("bocha")
    stubFetch(() => jsonResponse({ message: "x".repeat(5_000) }, 401))
    const message = await errorMessage(harness)
    expect(message).toContain("x".repeat(300) + "… [truncated]")
    expect(message).toContain("Connect Bocha")
    expect(message.length).toBeLessThan(1_000)
  })

  it("keeps the complete emoji at the 300th code point and removes the tail", async () => {
    const harness = await bind("brave")
    const prefix = "<html>" + "x".repeat(293) // 299 code points
    const page = prefix + "🎉" + "y".repeat(50_000) + "</html>"
    const { calls } = stubFetch(() => new Response(page, { status: 503 }))
    const message = await errorMessage(harness)
    expect(calls).toHaveLength(1)
    expect(message).toBe(String(new Error("Brave API error 503: " + prefix + "🎉… [truncated]")))
  })

  it.each([200, 300])("does not mark %i emoji as truncated", async (count) => {
    const harness = await bind("brave")
    const detail = "🎉".repeat(count)
    stubFetch(() => new Response(detail, { status: 503 }))
    expect(await errorMessage(harness)).toBe(String(new Error("Brave API error 503: " + detail)))
  })
})
