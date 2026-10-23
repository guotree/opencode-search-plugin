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
  vi.restoreAllMocks()
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
      options: { disable: ["osp-serper", "osp-brave"] },
    })
    await harness.run(mod.default.effect(harness.ctx))

    const registered = harness.providers.map((p) => p.id).sort()
    expect(registered).toEqual(ALL_IDS.filter((id) => id !== "osp-brave" && id !== "osp-serper"))
    expect(harness.integrationNames.has("osp-serper")).toBe(false)
  })

  it("honours the enable option as an allow-list", async () => {
    const mod = await loadPlugin<AggregateModule>("../index")
    const harness = makeHarness({
      credentialSequence: [CREDENTIAL],
      options: { enable: ["osp-brave", "osp-serper"] },
    })
    await harness.run(mod.default.effect(harness.ctx))

    expect(harness.providers.map((p) => p.id).sort()).toEqual(["osp-brave", "osp-serper"])
    expect(harness.integrationNames.has("osp-jina")).toBe(false)
    expect(harness.envMethods.map((m) => m.integrationID).sort()).toEqual(["osp-brave", "osp-serper"])
  })

  it("lets disable win over enable on the overlap", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const mod = await loadPlugin<AggregateModule>("../index")
    const harness = makeHarness({
      credentialSequence: [CREDENTIAL],
      options: { enable: ["osp-brave", "osp-serper"], disable: ["osp-serper"] },
    })
    await harness.run(mod.default.effect(harness.ctx))

    expect(harness.providers.map((p) => p.id)).toEqual(["osp-brave"])
    expect(harness.integrationNames.has("osp-serper")).toBe(false)
    expect(
      warn.mock.calls.some((call) => String(call[0]).includes("osp-serper")),
    ).toBe(true)
  })

  it("registers enable minus disable: overlapped IDs drop out, disable entries outside the allow-list are inert", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const mod = await loadPlugin<AggregateModule>("../index")
    const harness = makeHarness({
      credentialSequence: [CREDENTIAL],
      options: {
        // A five-ID allow-list; the deny-list removes two of them and names
        // one ID the allow-list never contained.
        enable: ["osp-anysearch", "osp-brave", "osp-jina", "osp-keenable", "osp-linkup"],
        disable: ["osp-keenable", "osp-linkup", "osp-youcom"],
      },
    })
    await harness.run(mod.default.effect(harness.ctx))

    expect(harness.providers.map((p) => p.id).sort()).toEqual([
      "osp-anysearch",
      "osp-brave",
      "osp-jina",
    ])
    const messages = warn.mock.calls.map((call) => String(call[0]))
    // The overlap is reported by name...
    expect(messages.some((m) => m.includes("osp-keenable") && m.includes("osp-linkup"))).toBe(
      true,
    )
    // ...but a disable entry outside the allow-list is redundant, not a problem.
    expect(messages.some((m) => m.includes("osp-youcom"))).toBe(false)
  })

  it("warns about an ID neither option recognises", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const mod = await loadPlugin<AggregateModule>("../index")
    const harness = makeHarness({
      credentialSequence: [CREDENTIAL],
      options: { enable: ["osp-brave", "osp-serperr"], disable: ["osp-nope"] },
    })
    await harness.run(mod.default.effect(harness.ctx))

    const messages = warn.mock.calls.map((call) => String(call[0]))
    expect(messages.some((m) => m.includes("osp-serperr"))).toBe(true)
    expect(messages.some((m) => m.includes("osp-nope"))).toBe(true)
    // The unknown enable entry is dropped; the known one still binds.
    expect(harness.providers.map((p) => p.id)).toEqual(["osp-brave"])
  })

  it("warns and ignores an enable option that is not an array", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const mod = await loadPlugin<AggregateModule>("../index")
    const harness = makeHarness({
      credentialSequence: [CREDENTIAL],
      options: { enable: "osp-brave" },
    })
    await harness.run(mod.default.effect(harness.ctx))

    expect(harness.providers.map((p) => p.id).sort()).toEqual(ALL_IDS)
    expect(warn.mock.calls.some((call) => String(call[0]).includes("enable"))).toBe(true)
  })

  it("warns when enable leaves the pool empty", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const mod = await loadPlugin<AggregateModule>("../index")
    const harness = makeHarness({
      credentialSequence: [CREDENTIAL],
      options: { enable: [] },
    })
    await harness.run(mod.default.effect(harness.ctx))

    expect(harness.providers).toHaveLength(0)
    expect(
      warn.mock.calls.some((call) => String(call[0]).includes("search pool will be empty")),
    ).toBe(true)
  })

  it("ignores a malformed disable option rather than dropping providers", async () => {
    const mod = await loadPlugin<AggregateModule>("../index")
    const harness = makeHarness({
      credentialSequence: [CREDENTIAL],
      options: { disable: ["osp-serper", 42, null] },
    })
    await harness.run(mod.default.effect(harness.ctx))

    const registered = harness.providers.map((p) => p.id).sort()
    expect(registered).toEqual(ALL_IDS.filter((id) => id !== "osp-serper"))
  })

  it("keeps the anonymous providers available even with no credential", async () => {
    const mod = await loadPlugin<AggregateModule>(
      "../index",
      Object.fromEntries(PROVIDER_CASES.map(({ envKey }) => [envKey, ""])),
    )
    const harness = makeHarness()
    await harness.run(mod.default.effect(harness.ctx))
    expect(harness.providers.map((p) => p.id)).toEqual(["osp-anysearch", "osp-keenable"])
  })
})
