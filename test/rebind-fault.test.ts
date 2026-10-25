import { describe, expect, it, vi } from "vitest"
import { Effect } from "effect"
import { makeHarness, loadPlugin } from "./harness"

/**
 * The rebind subscription's fault tolerance. A host-side defect while handling
 * one credential event (here: `websearch.reload()` throwing mid-rebind) must
 * not take the subscription down, and the binding it failed to apply must be
 * retried by the next event rather than treated as done. Pinned after a review
 * found the bare `Stream.runDrain` died silently on the first defect,
 * permanently disabling rebind until a process restart.
 */

const KEY = { type: "key" as const, key: "k1" }
const KEY2 = { type: "key" as const, key: "k2" }
const CRED_EVENT = { type: "credential.updated" }

type Brave = typeof import("../plugins/brave-search")

describe("rebind subscription fault tolerance", () => {
  it.each(["synchronous throw", "undefined defect"])(
    "rolls back and retries after a %s",
    async (mode) => {
      const plugin = await loadPlugin<Brave>("../plugins/brave-search")
      const harness = makeHarness({
        credentialSequence: [undefined, KEY, KEY],
        events: [CRED_EVENT, CRED_EVENT],
      })
      const reload = vi.spyOn(harness.ctx.websearch, "reload")
      reload.mockImplementationOnce(() => {
        if (mode === "synchronous throw") throw new Error("reload factory fault")
        return Effect.die(undefined)
      })
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

      await harness.run(plugin.effect(harness.ctx))

      expect(reload).toHaveBeenCalledTimes(2)
      expect(harness.reloads).toBe(1)
      expect(harness.providers).toHaveLength(1)
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        "[opencode-search-plugin] osp-brave failed to rebind: " +
          (mode === "synchronous throw" ? "reload factory fault" : "undefined"),
      )
    },
  )

  it("propagates a reload interruption without a warning or processing later events", async () => {
    const plugin = await loadPlugin<Brave>("../plugins/brave-search")
    const harness = makeHarness({
      credentialSequence: [undefined, KEY, KEY],
      events: [CRED_EVENT, CRED_EVENT],
    })
    const reload = vi.spyOn(harness.ctx.websearch, "reload")
      .mockImplementationOnce(() => Effect.interrupt)
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

    await harness.run(plugin.effect(harness.ctx))

    expect(reload).toHaveBeenCalledTimes(1)
    expect(harness.reloads).toBe(0)
    expect(harness.providers).toHaveLength(0)
    expect(warn).not.toHaveBeenCalled()
  })

  it("retries a reload the fault killed, on the next event with the same credential", async () => {
    const plugin = await loadPlugin<Brave>("../plugins/brave-search")
    const harness = makeHarness({
      // Startup unbound; event 1 sees the key appear but the reload dies.
      // `bound` must still be false, so event 2 -- same key -- retries the
      // reload instead of treating the binding as done.
      credentialSequence: [undefined, KEY, KEY],
      events: [CRED_EVENT, CRED_EVENT],
      reloadFailures: 1,
    })
    await harness.run(plugin.effect(harness.ctx))

    expect(harness.reloads).toBe(1)
    expect(harness.providers).toHaveLength(1)
  })

  it("completes the full cycle when the fault hits the bind side: retry, then unbind", async () => {
    const plugin = await loadPlugin<Brave>("../plugins/brave-search")
    const harness = makeHarness({
      // Startup unbound; bind (dies), bind retried (runs), unbind (runs).
      credentialSequence: [undefined, KEY, KEY, undefined],
      events: [CRED_EVENT, CRED_EVENT, CRED_EVENT],
      reloadFailures: 1,
    })
    await harness.run(plugin.effect(harness.ctx))

    expect(harness.reloads).toBe(2)
    expect(harness.providers).toHaveLength(0)
  })

  it("unbinds on a later event when the fault hits the unbind side", async () => {
    const plugin = await loadPlugin<Brave>("../plugins/brave-search")
    const harness = makeHarness({
      // Startup bound; event 1 deletes the key but the reload dies, so
      // `bound` stays true. Event 2 rotates the key (still bound, nothing to
      // do), event 3 deletes it again and the unbind runs.
      credentialSequence: [KEY, undefined, KEY2, undefined],
      events: [CRED_EVENT, CRED_EVENT, CRED_EVENT],
      reloadFailures: 1,
    })
    await harness.run(plugin.effect(harness.ctx))

    expect(harness.reloads).toBe(1)
    expect(harness.providers).toHaveLength(0)
  })
})
