# Contributing

## The rule that shapes everything else

Each provider is **one self-contained `.ts` file**, living in `plugins/`:

```text
index.ts          package entrypoint; composes the sixteen providers
plugins/          the providers, each one independently copyable
test/             contract tests, harness, and structure guards
scripts/          manual sync into a local OpenCode config
```

It must run when copied on its own into `~/.config/opencode/plugins/` or `<project>/.opencode/plugins/`, with no build step and no sibling imports.

That is why this repository has no `src/core/` shared library. A shared module would make the source cleaner and the files unusable on their own, so the shared logic is instead **copied verbatim** into every file that needs it.

`test/structure.test.ts` enforces this. It fails when:

- a plugin file imports a sibling module;
- a shared block stops being byte-identical across the files that carry it;
- a plugin's IDs drift apart;
- a provider is missing from `index.ts`.

So a fix to shared logic lands in **every** file at once. If one of those assertions fails, the change belongs in all of them — not just the file you were editing.

## The shared blocks

These are copied verbatim. Edit them in every file that carries them, then update the matching constant in `test/structure.test.ts`.

| Block | Carried by | Why it is duplicated |
| --- | --- | --- |
| `envInt` / `envStr` | all sixteen | Environment knobs read once at load time |
| `cacheKey` / `readCache` / `writeCache` | all sixteen | Repeat queries are billed dispatches |
| `timedSignal` | all sixteen | The host applies no deadline around `execute` |
| `parseSearchDate` and its tables | bocha, brave, deepseek, keenable, metaso, perplexity, querit, serpapi, serper, youcom, zai, zhipu | Relative and absolute date shapes, plus the `Date.parse` trap |
| `soften` | all sixteen | The host types the credential API's failure channel as `unknown` |

Files with no date field (anysearch, jina, linkup, ollama) must not carry `parseSearchDate`. The structure test asserts that too.

`timedSignal` is not optional: OpenCode's own providers each bound themselves at 25s (`Effect.timeoutOrElse({ duration: Duration.seconds(25) })`), and `WebSearch.query` calls `provider.execute` with no deadline of its own. A provider that omits this can hang the agent for as long as the upstream stays silent. `test/structure.test.ts` asserts the block is present **and applied** — a file that defines `timedSignal` without passing its signal to `fetch` fails too.

## Identifiers are public API

Three IDs appear on every plugin, and renaming any of them breaks users:

| ID | Set in | Used by |
| --- | --- | --- |
| `<file>` e.g. `brave-search` | `Plugin.define({ id })` | `plugins` entries and `-` disable control |
| `const ID` e.g. `osp-brave` | `editor.add({ id })` and `editor.update(ID)` | `websearch.provider`, the `enable`/`disable` options, `/api/websearch/provider` |
| `const ID` | `editor.method.update({ integrationID })` | Credentials saved in `/connect` |

The plugin ID equals the filename; the provider ID equals the integration ID. Both are asserted in `test/structure.test.ts`, because a credential saved against one ID is invisible to code reading the other.

The provider ID is the one that can collide with somebody else's, so it carries this package's `osp-` prefix: OpenCode's built-ins are bare vendor names (`exa`, `tavily`), and a vendor's own plugin registers one too — Keenable already ships one. A new provider takes `const ID = "osp-<vendor>"`. The plugin file ID stays unprefixed, because the plugins list already namespaces it by package.

## Adding a provider

1. Copy the closest existing file to `plugins/<name>-search.ts` and change `ID` (to `osp-<vendor>`), the schema, the endpoint, and the mapping.
2. Keep the shared blocks byte-identical — copy them from an existing file rather than retyping.
3. Export both `effect` (so `index.ts` can compose it) and `default Plugin.define({ id: "<name>-search", effect })`.
4. Add an entry to `PROVIDER_CASES` in `test/cases.ts` with a response body and the results it must map to.
5. Add the import and the `["<name>", <name>]` tuple to `index.ts`.
6. Add a row to the provider table and the configuration tables in `README.md`.
7. `npm run check`.

Before inventing a query parameter, check the provider's own documentation. Two of these plugins shipped knobs that the upstream API silently ignores; `plugins/serpapi-search.ts` documents one such removal in a comment.

## Tests

| File | Covers |
| --- | --- |
| `test/providers.test.ts` | The contract every provider must satisfy: binding, `/connect` wiring, mapping, caching, error status, request deadline, rebind |
| `test/bocha-search.test.ts` | Bocha's request body and knobs, the `dateLastCrawled` UTC+8 rewrite, and the 401/403/429 reports |
| `test/brave-search.test.ts` | Brave-specific request construction and env knobs |
| `test/jina-search.test.ts` | The one provider whose deadline default varies by mode |
| `test/keenable-search.test.ts` | Keyless routing between the public and keyed endpoints, and the 402/429 reports |
| `test/ollama-search.test.ts` | Ollama's request body, the 1–10 clamp, and the flat-result mapping |
| `test/perplexity-search.test.ts` | Perplexity's request body, the documented-only filters, date fallback from `last_updated`, and the 401 envelope |
| `test/zai-search.test.ts` | Z.ai's request body, the fixed `search-prime` engine, hit filtering, and the 401/429 reports |
| `test/zhipu-search.test.ts` | Zhipu's request body per engine, the 70-character query cut, hit filtering, and the 401/429 reports |
| `test/dates.test.ts` | The shared date parser, exercised through Brave |
| `test/index.test.ts` | Aggregate registration and the `enable`/`disable` options |
| `test/structure.test.ts` | The self-containment and shared-copy guards |
| `test/harness.ts` | The fake plugin context, credential sequences, fetch recorder |

`test/harness.ts` models two things worth understanding:

- **Credential sequences** — a plugin reads the credential once at startup, once per search, and once per credential event. `[cred]` is a stable key; `[undefined, cred]` is a key that appears later, which is what drives the rebind path.
- **Scope and the event stream** — `Effect.scoped` interrupts `forkScoped` fibers when it closes, so `harness.run` waits for the subscription to drain before closing. Without that, rebind tests would race.

## Behaviour changes

Open an issue before changing what a provider sends or how it maps a response. Caching, env knobs, and result counts are easy to adjust and easy to regress quietly; tests should move in the same commit.
