import { Effect, Stream } from "effect"
import type { Scope } from "effect"
import type { Plugin } from "@opencode/plugin/effect"
import { vi } from "vitest"

/** A websearch provider as captured from `editor.add`. */
export interface CapturedProvider {
  id: string
  name: string
  execute: (input: { query: string }) => Effect.Effect<readonly unknown[], unknown>
}

export type Credential = { type: "key"; key: string }

export interface HarnessOptions {
  /**
   * Credentials observed by successive `resolveKey()` calls. The last entry
   * repeats once the sequence is exhausted.
   *
   * A plugin calls `resolveKey()` once at startup to decide whether it binds,
   * once per search, and once per credential event. One entry therefore models
   * a stable credential; `[undefined, cred]` models a key that appears after
   * startup, which is what the event-driven rebind path reacts to.
   */
  credentialSequence?: ReadonlyArray<Credential | undefined>
  /** Events replayed to the plugin's subscription before the stream ends. */
  events?: ReadonlyArray<{ readonly type: string }>
  /** Passed through as `ctx.options`, which `index.ts` reads for `disable`. */
  options?: Readonly<Record<string, unknown>>
}

export interface Harness {
  /** The plugin context handed to `effect(ctx)`. */
  ctx: Plugin.Context
  /** Providers captured from `ctx.websearch.transform`. */
  providers: CapturedProvider[]
  /** Display names captured from `ctx.integration.transform`. */
  integrationNames: Map<string, string>
  /** Environment-variable methods captured from the integration editor. */
  envMethods: Array<{ integrationID: string; names: readonly string[] }>
  /** How many times `ctx.websearch.reload()` was called. */
  reloads: number
  /**
   * Run an effect inside a fresh scope, as OpenCode does.
   *
   * Two casts are deliberate. `Effect.scoped` discharges the `Scope` a plugin's
   * effect carries, so the runner has nothing left to provide. Before that
   * scope closes, the run waits for the event stream to drain: closing a scope
   * interrupts its `forkScoped` fibers, so without this wait the subscription
   * fiber would be cut off before it ever saw an event.
   */
  run<A, E, R>(self: Effect.Effect<A, E, R>): Promise<A>
}

function makeWebsearchEditor(harness: Harness) {
  return {
    add: (provider: CapturedProvider) => {
      harness.providers.push(provider)
    },
    default: {
      get: () => undefined,
      set: () => {},
    },
  }
}

function makeIntegrationEditor(harness: Harness) {
  return {
    update: (id: string, update: (integration: { name: string }) => void) => {
      const draft = { name: harness.integrationNames.get(id) ?? id }
      update(draft)
      harness.integrationNames.set(id, draft.name)
    },
    remove: () => {},
    method: {
      list: () => [],
      update: (input: {
        integrationID: string
        method: { type: string; names?: readonly string[]; label?: string }
      }) => {
        if (input.method.type === "env") {
          harness.envMethods.push({
            integrationID: input.integrationID,
            names: input.method.names ?? [],
          })
        }
      },
      remove: () => {},
    },
  }
}

export function makeHarness(options: HarnessOptions = {}): Harness {
  const sequence = options.credentialSequence ? [...options.credentialSequence] : undefined

  // One step per `resolveKey()`: `active()` decides whether a stored credential
  // exists, `resolve()` returns the one that step selected. Without a sequence
  // there is no stored credential at all, so only the environment can supply a
  // key.
  let step = 0
  let current: Credential | undefined = undefined
  const advance = (): Credential | undefined => {
    if (!sequence) return undefined
    const index = Math.min(step, sequence.length - 1)
    step += 1
    current = sequence[index]
    return current
  }

  let resolveDrained!: () => void
  const drained = new Promise<void>((resolve) => {
    resolveDrained = resolve
  })
  let subscribed = false

  const events = options.events ?? []
  const websearchTransforms: Array<(editor: unknown) => void> = []
  const integrationTransforms: Array<(editor: unknown) => void> = []

  const harness: Harness = {
    ctx: undefined as unknown as Plugin.Context,
    providers: [],
    integrationNames: new Map(),
    envMethods: [],
    reloads: 0,
    run: <A, E, R>(self: Effect.Effect<A, E, R>): Promise<A> =>
      Effect.runPromise(
        Effect.scoped(
          Effect.flatMap(self as Effect.Effect<A, E, Scope.Scope>, (value) =>
            Effect.promise(async () => {
              if (subscribed) await drained
              return value
            }),
          ) as Effect.Effect<A, E, Scope.Scope>,
        ) as Effect.Effect<A, E, never>,
      ) as Promise<A>,
  }

  harness.ctx = {
    options: options.options ?? {},
    integration: {
      transform: (callback: (editor: unknown) => void) =>
        Effect.sync(() => {
          integrationTransforms.push(callback)
          callback(makeIntegrationEditor(harness))
          return { dispose: Effect.void }
        }),
      connection: {
        active: () => Effect.succeed(advance() ? { id: "connection" } : undefined),
        resolve: () => Effect.succeed(current),
      },
    },
    websearch: {
      transform: (callback: (editor: unknown) => void) =>
        Effect.sync(() => {
          websearchTransforms.push(callback)
          callback(makeWebsearchEditor(harness))
          return { dispose: Effect.void }
        }),
      // Mirrors the real registry: a reload discards the built value and
      // replays every active transform onto a fresh one.
      reload: () =>
        Effect.sync(() => {
          harness.reloads += 1
          harness.providers.length = 0
          for (const callback of websearchTransforms) {
            callback(makeWebsearchEditor(harness))
          }
        }),
      providers: () => Effect.succeed([]),
      query: () => Effect.succeed([]),
    },
    event: {
      subscribe: () => {
        subscribed = true
        return Stream.fromIterable(events).pipe(
          Stream.ensuring(Effect.sync(() => resolveDrained())),
        )
      },
    },
  } as unknown as Plugin.Context

  return harness
}

/**
 * Import a plugin module fresh, with `env` applied first. Plugin knobs are read
 * once at module load time, so a test that changes one must re-import rather
 * than mutate `process.env` against an already-evaluated module. Pass `""` to
 * model an unset variable.
 */
export async function loadPlugin<T = Record<string, unknown>>(
  specifier: string,
  env: Record<string, string | undefined> = {},
): Promise<T> {
  vi.resetModules()
  vi.unstubAllEnvs()
  for (const [key, value] of Object.entries(env)) {
    vi.stubEnv(key, value ?? "")
  }
  return (await import(/* @vite-ignore */ specifier)) as T
}

export interface RecordedCall {
  url: URL
  init: RequestInit | undefined
  body: unknown
}

/**
 * Replace `fetch` with a typed recorder. Providers pass either a `URL` or a
 * string, so `String` recovers the href; POST bodies are parsed when they are
 * JSON so a test can assert on what was actually sent.
 */
export function stubFetch(
  handler: (call: RecordedCall) => Response | Promise<Response>,
): { calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const mock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const raw = init?.body
    let body: unknown
    if (typeof raw === "string") {
      try {
        body = JSON.parse(raw)
      } catch {
        body = raw
      }
    }
    const call: RecordedCall = { url: new URL(String(input)), init, body }
    calls.push(call)
    return handler(call)
  })
  vi.stubGlobal("fetch", mock)
  return { calls }
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

/** A provider's fixture hit, already shaped for the `{url,title,content}` contract. */
export interface ExpectedResult {
  url: string
  title: string
  content: string
}

export interface ProviderCase {
  /** Module filename without extension, e.g. `brave-search`. */
  file: string
  /** ID on the plugin's default export, and its `/connect` integration ID. */
  pluginID: string
  /** ID passed to `editor.add`, i.e. the websearch provider ID. */
  providerID: string
  /** Display name registered for both the provider and the integration. */
  displayName: string
  /** Environment variable registered as the integration's key method. */
  envKey: string
  /** A response body that decodes to `expected`. */
  response: unknown
  /** The results `execute` must produce for that response. */
  expected: ExpectedResult[]
}

