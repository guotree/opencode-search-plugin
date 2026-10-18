import { readFileSync } from "node:fs"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Plugin } from "@opencode/plugin/effect"
import type { Effect, Scope } from "effect"
import { jsonResponse, loadPlugin, makeHarness, stubFetch } from "./harness"
import { PROVIDER_CASES } from "./cases"

/**
 * Every module in this repository has the same shape: a default export naming
 * the plugin, and a named `effect` so `index.ts` can compose it. Typing that
 * shape once keeps these tests free of casts.
 */
interface ProviderModule {
  default: { id: string }
  effect: (ctx: Plugin.Context) => Effect.Effect<void, never, Scope.Scope>
}

const CREDENTIAL = { type: "key", key: "stored-key" } as const

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

/**
 * The contract every provider in this repository must satisfy. Anything a
 * provider does beyond this is asserted in its own test file.
 */
/** Providers with an anonymous tier, which never gate on a key. */
const KEYLESS = new Set(["osp-anysearch", "osp-keenable"])

describe.each(PROVIDER_CASES)("$providerID ($file)", (spec) => {
  const modulePath = `../plugins/${spec.file}`
  const noKeyEnv = { [spec.envKey]: "" }
  const requiresKey = !KEYLESS.has(spec.providerID)

  async function load(env: Record<string, string> = noKeyEnv) {
    return loadPlugin<ProviderModule>(modulePath, env)
  }

  it("is always available when anonymous access exists, otherwise key-gated", async () => {
    const mod = await load()
    const harness = makeHarness()
    await harness.run(mod.effect(harness.ctx))

    if (requiresKey) {
      expect(harness.providers).toHaveLength(0)
    } else {
      expect(harness.providers.map((p) => p.id)).toEqual([spec.providerID])
    }
  })

  it("binds the provider, the integration, and the env method together", async () => {
    const mod = await load()
    const harness = makeHarness({ credentialSequence: [CREDENTIAL] })
    await harness.run(mod.effect(harness.ctx))

    expect(harness.providers.map((p) => p.id)).toEqual([spec.providerID])
    expect(harness.providers.map((p) => p.name)).toEqual([spec.displayName])
    // The integration ID must equal the websearch provider ID, or credentials
    // saved in /connect would be stored against an ID the pool never reads.
    // The /connect display name carries the ` (osp)` package marker, so an
    // entry cannot be confused with a built-in integration of the same brand.
    expect(harness.integrationNames.get(spec.providerID)).toBe(`${spec.displayName} (osp)`)
    expect(harness.envMethods).toEqual([
      { integrationID: spec.providerID, names: [spec.envKey] },
    ])
    expect(mod.default.id).toBe(spec.pluginID)
  })

  it("maps a response to url, title and content", async () => {
    const mod = await load()
    const harness = makeHarness({ credentialSequence: [CREDENTIAL] })
    await harness.run(mod.effect(harness.ctx))

    const fetch = stubFetch(() => jsonResponse(spec.response))
    const results = (await harness.run(
      harness.providers[0]!.execute({ query: "a query" }),
    )) as Array<{ url: string; title: string; content: string; time: unknown }>

    expect(results).toEqual(spec.expected.map((r) => ({ ...r, time: {} })))
    expect(fetch.calls).toHaveLength(1)
  })

  it("serves a repeated query from the cache", async () => {
    const mod = await load()
    const harness = makeHarness({ credentialSequence: [CREDENTIAL] })
    await harness.run(mod.effect(harness.ctx))

    const fetch = stubFetch(() => jsonResponse(spec.response))
    const provider = harness.providers[0]!
    await harness.run(provider.execute({ query: "same query" }))
    await harness.run(provider.execute({ query: "  same   query " }))
    expect(fetch.calls).toHaveLength(1)
  })

  it("reports the HTTP status when the API refuses the request", async () => {
    const mod = await load()
    const harness = makeHarness({ credentialSequence: [CREDENTIAL] })
    await harness.run(mod.effect(harness.ctx))

    stubFetch(() => new Response("nope", { status: 500 }))
    await expect(harness.run(harness.providers[0]!.execute({ query: "q" }))).rejects.toThrow(
      /API error 500/,
    )
  })

  it("bounds a hung upstream and names the timeout in the failure", async () => {
    // OpenCode applies no deadline around `execute`, so without one a stalled
    // upstream hangs the agent indefinitely. Providers that have landed the
    // shared `timedSignal` block are covered here; the rest start failing this
    // assertion as soon as they adopt it.
    const source = readFileSync(new URL(`../plugins/${spec.file}.ts`, import.meta.url), "utf8")
    if (!source.includes("timedSignal")) return

    // Read the deadline's own variable name out of the plugin, rather than
    // deriving it: Brave is `BRAVE_TIMEOUT`, not `BRAVE_SEARCH_TIMEOUT`.
    const knob = /envInt\("([A-Z_]+_TIMEOUT)"/.exec(source)?.[1]
    if (!knob) throw new Error(`${spec.file} reads no *_TIMEOUT variable`)

    // The deadline is read once at load time, so the budget has to be set
    // there. 250ms keeps the suite fast and still proves the bound fires.
    const mod = await loadPlugin<ProviderModule>(modulePath, { ...noKeyEnv, [knob]: "250" })
    const harness = makeHarness({ credentialSequence: [CREDENTIAL] })
    await harness.run(mod.effect(harness.ctx))

    // Accepts the request and never answers, which is what a stalled upstream
    // looks like. A real AbortSignal is handed over so the deadline can fire.
    stubFetch(
      (call) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = call.init?.signal
          if (signal) signal.addEventListener("abort", () => reject(signal.reason))
        }) as unknown as Response,
    )

    await expect(harness.run(harness.providers[0]!.execute({ query: "q" }))).rejects.toThrow(
      /timed out after \d+ms/,
    )
  })

  it("rebinds when a credential appears after startup", async () => {
    const mod = await load()
    const harness = makeHarness({
      credentialSequence: [undefined, { type: "key", key: "later" }],
      events: [{ type: "credential.updated" }],
    })
    await harness.run(mod.effect(harness.ctx))

    if (!requiresKey) {
      // Anonymous by design: always bound, so there is nothing to reload.
      expect(harness.reloads).toBe(0)
      expect(harness.providers.map((p) => p.id)).toEqual([spec.providerID])
      return
    }

    expect(harness.reloads).toBe(1)
    expect(harness.providers.map((p) => p.id)).toEqual([spec.providerID])
  })

  it.runIf(requiresKey)(
    "fails with a message naming the env var once the key is gone",
    async () => {
      const mod = await load()
      // Bound at startup, credential gone by search time.
      const harness = makeHarness({ credentialSequence: [CREDENTIAL, undefined] })
      await harness.run(mod.effect(harness.ctx))
      expect(harness.providers).toHaveLength(1)

      stubFetch(() => jsonResponse(spec.response))
      await expect(harness.run(harness.providers[0]!.execute({ query: "q" }))).rejects.toThrow(
        spec.envKey,
      )
    },
  )
})
