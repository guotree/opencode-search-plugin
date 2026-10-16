import { Plugin } from "@opencode/plugin/effect"
import { Effect } from "effect"
import type { Scope } from "effect"

import { effect as anysearch } from "./anysearch-search"
import { effect as brave } from "./brave-search"
import { effect as jina } from "./jina-search"
import { effect as linkup } from "./linkup-search"
import { effect as metaso } from "./metaso-search"
import { effect as querit } from "./querit-search"
import { effect as serpapi } from "./serpapi-search"
import { effect as serper } from "./serper-search"
import { effect as youcom } from "./youcom-search"

type ProviderEffect = (ctx: Plugin.Context) => Effect.Effect<void, never, Scope.Scope>

/**
 * The nine providers this package registers, in alphabetical order. Each entry
 * is the same effect its standalone file uses as a default export, so a file
 * copied out of this repository behaves exactly as it does here.
 *
 * The key of each entry is the websearch provider ID -- the one that appears in
 * `/api/websearch/provider`, in `websearch.provider`, and in the `disable`
 * option below. Renaming one would strand existing configuration.
 */
const PROVIDERS: ReadonlyArray<readonly [id: string, run: ProviderEffect]> = [
  ["anysearch", anysearch],
  ["brave", brave],
  ["jina", jina],
  ["linkup", linkup],
  ["metaso", metaso],
  ["querit", querit],
  ["serpapi", serpapi],
  ["serper", serper],
  ["youcom", youcom],
]

/**
 * Reads the `disable` plugin option. A key-requiring provider that is disabled
 * here is never registered, which is how a user trims the pool down to the
 * services they actually hold keys for.
 */
function disabledProviders(ctx: Plugin.Context): ReadonlySet<string> {
  const requested: unknown = ctx.options["disable"]
  if (!Array.isArray(requested)) return new Set()
  return new Set(requested.filter((entry): entry is string => typeof entry === "string"))
}

export default Plugin.define({
  id: "opencode-search-plugin",
  effect: (ctx) =>
    Effect.gen(function* () {
      const disabled = disabledProviders(ctx)
      for (const [id, run] of PROVIDERS) {
        if (disabled.has(id)) continue
        yield* run(ctx)
      }
    }),
})
