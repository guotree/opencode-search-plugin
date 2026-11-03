import { once } from "node:events"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Deferred, Effect } from "effect"
import { HttpClientError } from "effect/http"
import { loadPlugin, makeHarness, stubFetch } from "./harness"
import { PROVIDER_CASES } from "./cases"
import type * as BraveProvider from "../plugins/brave-search"

type ProviderModule = typeof BraveProvider
const CREDENTIAL = { type: "key" as const, key: "lifecycle-secret-key" }

// A zero-size queue starts pulling only when the response body is consumed.
function stalledBody(signal: AbortSignal, onRead: () => void) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      signal.addEventListener("abort", () => controller.error(signal.reason), { once: true })
    },
    pull() {
      onRead()
    },
  }, { highWaterMark: 0 })
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe.each(PROVIDER_CASES)("$providerID request lifecycle", (spec) => {
  const timeoutKnob = spec.file.replace(/-search$/, "").replace(/-/g, "_").toUpperCase() + "_TIMEOUT"

  async function bind(timeout: number) {
    const plugin = await loadPlugin<ProviderModule>(`../plugins/${spec.file}`, {
      [spec.envKey]: "",
      [timeoutKnob]: String(timeout),
    })
    const harness = makeHarness({ credentialSequence: [CREDENTIAL] })
    await harness.run(plugin.effect(harness.ctx))
    return harness.providers[0]!
  }

  it("bounds a request that never returns headers", async () => {
    const provider = await bind(100)
    const fetch = stubFetch((call) => once(call.init!.signal!, "abort").then(() => {
      throw call.init!.signal!.reason
    }))
    const error = await Effect.runPromise(provider.execute({ query: "header deadline" }).pipe(Effect.flip))

    expect(String(error)).toContain("timed out after 100ms")
    expect(fetch.calls[0]!.init!.signal!.aborted).toBe(true)
  })

  it("cancels the request while waiting for headers with no deadline", async () => {
    const provider = await bind(0)
    const arrived = await Effect.runPromise(Deferred.make<void>())
    const fetch = stubFetch((call) => {
      Effect.runSync(Deferred.succeed(arrived, undefined))
      return once(call.init!.signal!, "abort").then(() => { throw call.init!.signal!.reason })
    })
    const controller = new AbortController()
    const running = Effect.runPromiseExit(provider.execute({ query: "cancel headers" }), { signal: controller.signal })
    await Effect.runPromise(Deferred.await(arrived))
    controller.abort()
    const exit = await running

    expect(exit._tag).toBe("Failure")
    expect(fetch.calls[0]!.init!.signal!.aborted).toBe(true)
  })

  it("cancels the underlying request after headers, while reading the body", async () => {
    const provider = await bind(0)
    const reading = await Effect.runPromise(Deferred.make<void>())
    const fetch = stubFetch((call) => new Response(stalledBody(call.init!.signal!, () => {
      Effect.runSync(Deferred.succeed(reading, undefined))
    })))
    const controller = new AbortController()
    const running = Effect.runPromiseExit(provider.execute({ query: "cancel body" }), { signal: controller.signal })
    await Effect.runPromise(Deferred.await(reading))
    controller.abort()
    const exit = await running

    expect(exit._tag).toBe("Failure")
    expect(fetch.calls[0]!.init!.signal!.aborted).toBe(true)
  })

  it.each([200, 503])("bounds stalled HTTP %i bodies with the request deadline", async (status) => {
    const provider = await bind(100)
    const fetch = stubFetch((call) => new Response(stalledBody(call.init!.signal!, () => {}), { status }))
    const error = await Effect.runPromise(provider.execute({ query: "body deadline" }).pipe(Effect.flip))

    expect(String(error)).toContain("timed out after 100ms")
    expect(HttpClientError.isHttpClientError(error)).toBe(false)
    expect(fetch.calls[0]!.init!.signal!.aborted).toBe(true)
  })

  it.each(["12", "Wed, 21 Oct 2026 07:28:00 GMT"])("preserves typed 429 and Retry-After %s without request secrets", async (retry) => {
    const provider = await bind(0)
    const fetch = stubFetch(() => new Response("rate limited", {
      status: 429,
      headers: { "Retry-After": retry, "X-Private-Header": "private-value" },
    }))
    const execute = () => Effect.runPromise(provider.execute({ query: "private-query-marker" }).pipe(Effect.flip))
    const error = await execute()
    await execute()

    expect(HttpClientError.isHttpClientError(error)).toBe(true)
    if (!HttpClientError.isHttpClientError(error)) throw new Error("Expected typed throttle")
    expect(error.response?.status).toBe(429)
    expect(error.response?.headers["retry-after"]).toBe(retry)
    expect(error.response?.headers).not.toHaveProperty("x-private-header")
    expect(error.request.url).not.toContain("?")
    const serialized = JSON.stringify(error)
    expect(serialized).not.toContain(CREDENTIAL.key)
    expect(serialized).not.toContain("private-query-marker")
    expect(fetch.calls).toHaveLength(2)
  })

  it.each(["failed", "stalled"])("keeps known HTTP 429 typed when its body is %s", async (mode) => {
    const provider = await bind(100)
    stubFetch((call) => new Response(mode === "stalled"
      ? stalledBody(call.init!.signal!, () => {})
      : new ReadableStream({ start(controller) { controller.error(new Error("body disconnected")) } }), {
      status: 429,
      headers: { "Retry-After": "7" },
    }))
    const error = await Effect.runPromise(provider.execute({ query: "broken throttle body" }).pipe(Effect.flip))

    expect(HttpClientError.isHttpClientError(error)).toBe(true)
    if (!HttpClientError.isHttpClientError(error)) throw new Error("Expected typed throttle")
    expect(error.response?.status).toBe(429)
    expect(error.response?.headers["retry-after"]).toBe("7")
  })

  it.each([401, 402, 403, 451, 500])("does not reclassify HTTP %i as a throttle or cache it", async (status) => {
    const provider = await bind(0)
    const fetch = stubFetch(() => new Response("refused", { status }))
    for (let i = 0; i < 2; i++) {
      const error = await Effect.runPromise(provider.execute({ query: "non-throttle refusal" }).pipe(Effect.flip))
      expect(HttpClientError.isHttpClientError(error)).toBe(false)
      expect(String(error)).toContain(String(status))
    }
    expect(fetch.calls).toHaveLength(2)
  })
})
