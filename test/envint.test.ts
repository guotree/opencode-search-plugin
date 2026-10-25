import { afterEach, describe, expect, it, vi } from "vitest"
import { jsonResponse, loadPlugin, makeHarness, stubFetch } from "./harness"

/**
 * `envInt` is the shared knob parser. A fractional value falls back to the
 * default instead of reaching the wire: `BRAVE_NUM=8.5` used to dispatch
 * `count=8.5` because only finiteness was checked, never integrity. The
 * exponent and hexadecimal forms stay accepted -- `Number` parses them and
 * they are whole numbers.
 */

type Brave = typeof import("../plugins/brave-search")

const KEY = { type: "key" as const, key: "brave-key" }

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

/** Binds Brave with `num` as BRAVE_NUM and returns the dispatched count. */
async function dispatchedCount(num: string): Promise<string> {
  const plugin = await loadPlugin<Brave>("../plugins/brave-search", { BRAVE_NUM: num })
  const harness = makeHarness({ credentialSequence: [KEY] })
  await harness.run(plugin.effect(harness.ctx))
  const fetch = stubFetch(() => jsonResponse({ web: { results: [] } }))
  await harness.run(harness.providers[0]!.execute({ query: "q" }))
  return fetch.calls[0]!.url.searchParams.get("count") ?? ""
}

describe("envInt integer validation", () => {
  it("falls back to the default for a fractional value", async () => {
    expect(await dispatchedCount("8.5")).toBe("8")
  })

  it("falls back to the default for a negative number", async () => {
    expect(await dispatchedCount("-3")).toBe("8")
  })

  it("keeps whole-number forms that Number() accepts: decimal, exponent, hex", async () => {
    expect(await dispatchedCount("12")).toBe("12")
    expect(await dispatchedCount("1e1")).toBe("10")
    expect(await dispatchedCount("0x10")).toBe("16")
  })
})
