import { Plugin } from "@opencode/plugin/effect"
import { Effect } from "effect"
import type { Scope } from "effect"

import { effect as anysearch } from "./plugins/anysearch-search"
import { effect as brave } from "./plugins/brave-search"
import { effect as jina } from "./plugins/jina-search"
import { effect as keenable } from "./plugins/keenable-search"
import { effect as linkup } from "./plugins/linkup-search"
import { effect as metaso } from "./plugins/metaso-search"
import { effect as querit } from "./plugins/querit-search"
import { effect as serpapi } from "./plugins/serpapi-search"
import { effect as serper } from "./plugins/serper-search"
import { effect as youcom } from "./plugins/youcom-search"

type ProviderEffect = (ctx: Plugin.Context) => Effect.Effect<void, never, Scope.Scope>

/**
 * The ten providers this package registers, in alphabetical order. Each entry
 * is the same effect its standalone file uses as a default export, so a file
 * copied out of this repository behaves exactly as it does here.
 *
 * The key of each entry is the websearch provider ID -- the one that appears in
 * `/api/websearch/provider`, in `websearch.provider`, and in the `enable` and
 * `disable` options below. Renaming one would strand existing configuration.
 * Each is prefixed `osp-` to namespace it to this package; see CONTRIBUTING.md.
 */
const PROVIDERS: ReadonlyArray<readonly [id: string, run: ProviderEffect]> = [
  ["osp-anysearch", anysearch],
  ["osp-brave", brave],
  ["osp-jina", jina],
  ["osp-keenable", keenable],
  ["osp-linkup", linkup],
  ["osp-metaso", metaso],
  ["osp-querit", querit],
  ["osp-serpapi", serpapi],
  ["osp-serper", serper],
  ["osp-youcom", youcom],
]

/** Every ID this package registers, so a typo in an option can be named. */
const KNOWN_IDS: ReadonlySet<string> = new Set(PROVIDERS.map(([id]) => id))

const WARNING = "[opencode-search-plugin]"

/**
 * Reads the `enable` or `disable` plugin option: an array of provider IDs.
 * Anything that cannot take effect is reported on stderr rather than acted on
 * -- a wrong shape is ignored outright, and an ID naming no provider here is
 * dropped. A typo in a knob must not cost the user every provider, but it must
 * not vanish silently either: `disable` shrinks the pool by one entry when an
 * ID misses, while `enable` can shrink it to nothing.
 */
function readOption(
  ctx: Plugin.Context,
  option: "enable" | "disable",
): ReadonlySet<string> | undefined {
  const requested: unknown = ctx.options[option]
  if (requested === undefined) return undefined
  if (!Array.isArray(requested)) {
    console.warn(`${WARNING} ${option} must be an array of provider IDs; ignoring it`)
    return undefined
  }
  const ids = new Set(requested.filter((entry): entry is string => typeof entry === "string"))
  const unknown = [...ids].filter((id) => !KNOWN_IDS.has(id))
  if (unknown.length > 0) {
    console.warn(
      `${WARNING} ${option} names no provider this package registers: ${unknown.join(", ")}`,
    )
  }
  return ids
}

/**
 * Resolves both options into the sets the registration loop reads. `undefined`
 * from `readOption` means "no opinion": without `enable` every provider is a
 * candidate, and without `disable` nothing is vetoed, so each option on its
 * own behaves exactly as it did before the other existed.
 */
function registrationOptions(ctx: Plugin.Context): {
  readonly allowed: ReadonlySet<string> | undefined
  readonly disabled: ReadonlySet<string>
} {
  const allowed = readOption(ctx, "enable")
  const disabled = readOption(ctx, "disable") ?? new Set<string>()

  // Deny wins on the overlap: a provider `disable` names stays out even when
  // `enable` lists it, so a per-provider exclusion is never overridden by a
  // bulk allow-list. The overlap is named because the config is redundant,
  // not fatal -- loading continues under the deny.
  const overlap = allowed ? [...allowed].filter((id) => disabled.has(id)) : []
  if (overlap.length > 0) {
    console.warn(
      `${WARNING} disable overrides enable for: ${overlap.join(", ")} -- those providers stay out`,
    )
  }

  // An allow-list that reaches no known provider registers nothing at all. The
  // registration loop stays faithful to that, but the reason belongs in the
  // log: an empty search pool is otherwise indistinguishable from a loaded
  // plugin that silently did nothing.
  if (allowed !== undefined && ![...allowed].some((id) => KNOWN_IDS.has(id))) {
    console.warn(`${WARNING} enable lists no known provider; the search pool will be empty`)
  }

  return { allowed, disabled }
}

export default Plugin.define({
  id: "opencode-search-plugin",
  effect: (ctx) =>
    Effect.gen(function* () {
      const { allowed, disabled } = registrationOptions(ctx)
      for (const [id, run] of PROVIDERS) {
        if (disabled.has(id)) continue
        if (allowed !== undefined && !allowed.has(id)) continue
        yield* run(ctx)
      }
    }),
})
