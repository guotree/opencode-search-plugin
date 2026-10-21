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

/**
 * How the mocked `jina-search` module behaves when `index.ts` registers it.
 *
 * The mock lives in this file and nowhere else: `vi.mock` applies to every
 * import in the file that declares it, so putting it in `index.test.ts` would
 * hand all eleven of that file's cases a jina that never works.
 *
 * Three modes, one per case below:
 *
 * - `die` -- a provider whose registration effect fails as a defect, the shape
 *   a bug inside `Effect.gen` takes.
 * - `throw` -- the provider factory throws before it ever returns an Effect,
 *   which only reaches the registration loop if the call itself is suspended.
 * - `interrupt` -- the provider suspends itself outright, modelling teardown.
 */
const injected = vi.hoisted(() => ({ mode: "die" as "die" | "throw" | "interrupt" }))

vi.mock("../plugins/jina-search", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/jina-search")>()
  const { Effect } = await import("effect")
  return {
    ...actual,
    effect: () => {
      if (injected.mode === "throw") throw new Error("jina exploded")
      if (injected.mode === "interrupt") return Effect.interrupt
      return Effect.die(new Error("jina exploded"))
    },
  }
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  injected.mode = "die"
})

/** Loads the aggregate plugin with a spy on stderr, and starts it without awaiting. */
async function start() {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  const mod = await loadPlugin<AggregateModule>("../index")
  const harness = makeHarness({ credentialSequence: [CREDENTIAL] })
  return { warn, harness, running: harness.run(mod.default.effect(harness.ctx)) }
}

describe("index registration fault isolation", () => {
  it("registers every other provider when one dies mid-loop, and names it on stderr", async () => {
    injected.mode = "die"
    const { warn, harness, running } = await start()

    await expect(running).resolves.toBeUndefined()
    // The pool is complete except for the provider that failed -- both the
    // ones queued before it and the ones queued after it survived.
    expect(harness.providers.map((p) => p.id).sort()).toEqual(
      ALL_IDS.filter((id) => id !== "osp-jina"),
    )
    const messages = warn.mock.calls.map((call) => String(call[0]))
    expect(messages.some((m) => m.includes("osp-jina") && m.includes("jina exploded"))).toBe(true)
  })

  it("isolates a provider factory that throws before returning an effect", async () => {
    injected.mode = "throw"
    const { warn, harness, running } = await start()

    await expect(running).resolves.toBeUndefined()
    expect(harness.providers.map((p) => p.id).sort()).toEqual(
      ALL_IDS.filter((id) => id !== "osp-jina"),
    )
    const messages = warn.mock.calls.map((call) => String(call[0]))
    expect(messages.some((m) => m.includes("osp-jina") && m.includes("jina exploded"))).toBe(true)
  })

  it("lets an interruption propagate instead of reporting it as a failure", async () => {
    // Teardown must not be mistaken for a broken provider: scope close
    // interrupts the loop, and swallowing that would keep registering
    // providers while the host shuts down. This one passes before and after
    // the isolation lands -- it pins the boundary the isolation must not cross.
    injected.mode = "interrupt"
    const { warn, running } = await start()

    await expect(running).rejects.toBeDefined()
    expect(warn).not.toHaveBeenCalled()
  })
})
