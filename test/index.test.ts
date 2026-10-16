import { afterEach, describe, expect, it, vi } from "vitest"
import type { Plugin } from "@opencode/plugin/effect"
import type { Effect, Scope } from "effect"
import { loadPlugin, makeHarness } from "./harness"
import { PROVIDER_CASES } from "./cases"

interface AggregateModule {
  default: {
    id: string
    effect: (ctx: Plugin.Context) => Effect.Effect<void, never, Scope.Scope>
  }
}

const ALL_IDS = PROVIDER_CASES.map((c) => c.providerID).sort()
const CREDENTIAL = { type: "key", key: "stored-key" } as const

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("index", () => {
  it("registers every provider under one plugin ID", async () => {
    const mod = await loadPlugin<AggregateModule>("../index")
    const harness = makeHarness({ credentialSequence: [CREDENTIAL] })
    await harness.run(mod.default.effect(harness.ctx))

    expect(mod.default.id).toBe("opencode-search-plugin")
    expect(harness.providers.map((p) => p.id).sort()).toEqual(ALL_IDS)

    // Every provider gets its own /connect entry and env method, keyed by the
    // same ID it registers in the websearch pool.
    expect([...harness.integrationNames.keys()].sort()).toEqual(ALL_IDS)
    expect(harness.envMethods.map((m) => m.integrationID).sort()).toEqual(ALL_IDS)
  })

  it("honours the disable option", async () => {
    const mod = await loadPlugin<AggregateModule>("../index")
    const harness = makeHarness({
      credentialSequence: [CREDENTIAL],
      options: { disable: ["serper", "brave"] },
    })
    await harness.run(mod.default.effect(harness.ctx))

    const registered = harness.providers.map((p) => p.id).sort()
    expect(registered).toEqual(ALL_IDS.filter((id) => id !== "brave" && id !== "serper"))
    expect(harness.integrationNames.has("serper")).toBe(false)
  })

  it("ignores a malformed disable option rather than dropping providers", async () => {
    const mod = await loadPlugin<AggregateModule>("../index")
    const harness = makeHarness({
      credentialSequence: [CREDENTIAL],
      options: { disable: ["serper", 42, null] },
    })
    await harness.run(mod.default.effect(harness.ctx))

    const registered = harness.providers.map((p) => p.id).sort()
    expect(registered).toEqual(ALL_IDS.filter((id) => id !== "serper"))
  })

  it("keeps anonymous AnySearch available even with no credential", async () => {
    const mod = await loadPlugin<AggregateModule>("../index")
    const harness = makeHarness()
    await harness.run(mod.default.effect(harness.ctx))
    expect(harness.providers.map((p) => p.id)).toEqual(["anysearch"])
  })
})
