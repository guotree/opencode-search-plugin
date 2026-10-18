# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Bocha** (`plugins/bocha-search.ts`), the twelfth provider, on the
  Bing-compatible Web Search API at `api.bocha.cn` (`osp-bocha`,
  `OSP_BOCHA_API_KEY`). The snippet is the default content and `summary` is left
  off, which matches the API's own default: a generated summary costs more
  per call than the search that produced it, and `BOCHA_SUMMARY=true` is the
  switch for when the extra context earns that. `BOCHA_FRESHNESS` is omitted
  unless set, because the docs recommend `noLimit` -- the search rewrites
  time ranges itself, and a pinned range often finds nothing within it.
  Bocha's example response omits `datePublished`, but the live API carries
  both date fields on every hit: `datePublished` with its true UTC+8 offset,
  and the misnamed `dateLastCrawled` holding the same wall clock stamped
  with a "Z" that lies. The parser prefers the honest field and keeps the
  documented "Z" -> "+08:00" rewrite as its fallback, pinned by comment to
  the API's promised v2 fix. The envelope, the `summary` switch, `freshness`
  and the 401 refusal body were all checked against the live API.
- **Ollama** (`plugins/ollama-search.ts`), the thirteenth provider, on the
  hosted Web Search API at `ollama.com/api/web_search` (`osp-ollama`,
  `OSP_OLLAMA_API_KEY`). The account key comes from ollama.com/settings/keys,
  and the namespaced variable keeps it clear of the vendor-canonical
  `OLLAMA_API_KEY`, which other tools -- and OpenCode's own config examples --
  also read, sometimes as a bearer token for an Ollama-compatible proxy
  rather than an account key. The response is the
  flattest in this package -- `results` of `{title, url, content}`, no
  wrapper and no dates -- so the file carries no date parser at all, and
  `content` turns out to be the whole page as markdown rather than a
  snippet, which is what makes `OLLAMA_MAX_RESULTS` (the API's own default
  of 5, clamped to its 1-10) the knob that matters for context. Envelope,
  `max_results` and the 401 body (`{"error":"Unauthorized"}`) were checked
  against the live API.

### Changed

- **Breaking: every provider key variable is namespaced.**
  `<PROVIDER>_API_KEY` became `OSP_<PROVIDER>_API_KEY`, so a key this plugin
  reads can no longer collide with the same vendor name exported for another
  tool. The variables no longer read are `ANYSEARCH_API_KEY`, `BOCHA_API_KEY`,
  `BRAVE_SEARCH_API_KEY`, `DEEPSEEK_API_KEY`, `JINA_API_KEY`,
  `KEENABLE_API_KEY`, `LINKUP_API_KEY`, `METASO_API_KEY`, `OLLAMA_API_KEY`,
  `QUERIT_API_KEY`, `SERPAPI_API_KEY`, `SERPER_API_KEY` and `YDC_API_KEY`;
  each now carries the `OSP_` prefix. Credentials stored in `/connect` are
  unaffected and still outrank the environment. The tuning knobs
  (`<PROVIDER>_CACHE_TTL`, `<PROVIDER>_TIMEOUT` and friends) keep their
  names -- no other tool reads those.

### Fixed

- `package.json` exported every provider file as a subpath except
  `./deepseek-search`, so the deep link for that one provider resolved to
  nothing.

## [2.2.0] - 2026-10-18

### Added

- **A request deadline on every provider**, as `<PROVIDER>_TIMEOUT` (default
  `25000`, matching OpenCode's own providers, each of which bounds itself at
  `Duration.seconds(25)`). `0` removes the deadline but keeps cancellation.
  Jina is the one exception: its default is `60000` when
  `JINA_INCLUDE_CONTENT` is on, because fetching whole pages is legitimately
  slower than a snippet search and a shared budget would either cut that off
  or be padded high enough that a genuine hang takes a minute to surface.
- The request now also observes the signal `Effect.tryPromise` hands its
  thunk, so cancelling the turn stops the fetch instead of leaving it running
  in the background. For a metered provider that is a billed dispatch the user
  would otherwise pay for after walking away.

### Fixed

- **A stalled upstream hung the turn indefinitely.** Every provider called
  `fetch` with no `AbortSignal` and no deadline, and OpenCode applies neither
  around `WebSearch.query`'s `provider.execute` — the only timeout in that
  tool wraps the provider-selection form, and the search itself runs outside
  it. A provider that accepted a connection and then went silent kept the
  search waiting forever, indistinguishable from a slow but healthy one. The
  timeout is reported by name (`X search timed out after 25000ms`) so it is
  not mistaken for an authentication problem.
- `timedSignal` joins the shared blocks in `CONTRIBUTING.md`, and
  `test/structure.test.ts` asserts both that it is present and that its signal
  actually reaches `fetch` — a file that defines the helper without applying
  it fails too.

## [2.1.1] - 2026-10-18

### Changed

- **`(osp)` marker on every `/connect` entry.** Each integration this package
  registers now carries the namespace on its display name — `DeepSeek (osp)`
  beside OpenCode's built-in `DeepSeek`, `Serper (osp)` and likewise for the
  rest — so a key saved through `/connect` cannot be mistaken for a built-in
  provider's. The websearch pool keeps the plain provider name: the pool holds
  only search providers, where the collision does not exist. Credentials are
  keyed by integration ID and are unaffected.
- The pinned version named throughout both READMEs is now `@2.1.1`.

## [2.1.0] - 2026-10-18

### Added

- **DeepSeek** (`plugins/deepseek-search.ts`), the eleventh provider, on the
  Search API DeepSeek opened on 2026-10-17 (`POST /v1/tools/search`, the
  in-house engine behind its own app). It authenticates with the same
  `DEEPSEEK_API_KEY` as chat and has no anonymous tier, so it binds exactly
  like the other key-requiring providers. Billing is per successful request —
  $0.75 (¥5) per 1,000, with failures and empty results unbilled — under an
  account-wide 5 QPS cap, which makes the shared response cache the difference
  between paying for repeat queries and not. `content` maps `summary`, the
  field the API documents as "intended to be read by a model", rather than
  `need_content` page text, which would bloat the agent's context; `date`
  arrives as RFC 3339 and joins the shared date parser. Knob:
  `DEEPSEEK_COUNT` (1–50, default 10 — price does not scale with results).
  Query operators (`site:`, `lang:`, `after:`/`before:`) pass through
  untouched.

- **`enable` plugin option**, an allow-list shaped like `disable`: only the IDs
  it names are registered. Both options are optional, either can be used alone,
  and both may be set at once — when they are, **deny wins**: an ID named by
  `disable` stays out even when `enable` lists it, so a per-provider exclusion
  is never overridden by a bulk allow-list. The registered set is therefore
  `enable − disable`: the overlap drops out, and a `disable` ID the allow-list
  never contained is inert — redundant but harmless, and not reported. The failure
  direction is the safe one: wrongly excluding a provider costs a search source,
  while wrongly including one routes queries to a service meant to be off.
  Configuration that cannot take effect is now reported in the log rather than
  acted on silently — an ID no provider in this package registers, an option
  that is not an array, an `enable`/`disable` overlap, and an `enable` list
  that matches no known provider (which leaves the pool empty, and now says so).
  `disable`-only configuration behaves exactly as before.

### Changed

- The pinned version named throughout both READMEs is now `@2.1.0`.

## [2.0.0] - 2026-10-17

### Changed

- **Breaking: every provider ID now carries an `osp-` prefix** (`brave` becomes
  `osp-brave`, and likewise for the other nine). The prefix is this package's
  namespace: OpenCode's built-ins register bare vendor names (`exa`, `tavily`),
  and a vendor's official plugin does the same — Keenable already ships one —
  so a bare name could collide with a provider OpenCode adds later, or with a
  vendor plugin installed alongside this one. The collision would land twice:
  in the websearch pool, and in the `opencode.db` row that keys credentials by
  integration ID, where our `editor.update` would edit someone else's entry.
  Only `const ID` changed. Plugin file IDs, npm export paths, display names,
  and environment variables are untouched, and there is deliberately no
  compatibility shim for the old IDs. `websearch.provider` and `disable` must
  use the prefixed form.
- The pinned version named throughout both READMEs is now `@2.0.0`.

## [1.1.0] - 2026-10-17

### Added

- **Keenable** (`plugins/keenable-search.ts`), the second provider that runs
  without a key. It mirrors AnySearch's shape: always registered, the key read
  per call, and `/connect` still available for one. With a key the request goes
  to `POST /v1/search` and is metered against the free monthly allowance of
  100,000 requests; without one it falls back to `POST /v1/search/public` with
  the required `X-Keenable-Title` header, which is limited per IP instead (1,000
  an hour, 10 a second) and spends no credits. Results carry `published_at`, so
  Keenable shares the date parser, and a `402` on a keyed call names the
  exhausted allowance while a `429` explains the keyless pool's caps.
  Knobs: `KEENABLE_MAX_RESULTS` (1–50), `KEENABLE_MODE`, `KEENABLE_TITLE`.
- Upgrade and uninstall instructions in both READMEs, one command per
  install form. The target of `opencode plugin update` and
  `opencode plugin remove` is the specifier that was configured — a
  GitHub install rejects its bare package name with `Plugin is not
  configured` — alongside the manual equivalents for a `plugins` entry
  and a copied file, and a note that `/connect` credentials survive a
  reinstall.

### Changed

- Both READMEs now present install, upgrade, and uninstall in the order
  npm, GitHub, local copy, as three parallel options, with npm
  recommended: a published npm version is immutable, so a pinned install
  always yields the same bytes, whereas a GitHub tag can be moved by a
  maintainer. The `disable` example uses the npm specifier accordingly.
- The pinned version named throughout both READMEs is now `@1.1.0`, so the
  recommended pin includes Keenable.

## [1.0.1] - 2026-10-16

Releases are now automated: every `v*` tag publishes to npm through
GitHub Actions.

### Added

- npm as an install source in both READMEs: `opencode plugin add
  opencode-search-plugin` next to the GitHub form, with each form's
  pinning syntax noted in its own comment.
- Release workflow (`.github/workflows/release.yml`) publishing to npm on
  every `v*` tag through npm trusted publishing (OIDC). No npm token is
  stored in repository secrets and provenance attestations are generated
  automatically. A gate rejects a tag whose version does not match
  `package.json`, and `npm run check` runs before the publish step —
  `ci.yml` watches branches and pull requests only, so a tag push would
  otherwise reach the registry untested.

## [1.0.0] - 2026-10-16

First public release. The nine providers were previously maintained as loose
files in a personal `~/.config/opencode/plugins/` directory; they are now a
tested, documented repository installable as a package.

### Added

- Package entrypoint (`index.ts`) registering all nine providers under one
  plugin ID, so `opencode plugin add github:guotree/opencode-search-plugin`
  installs everything at once.
- `disable` plugin option to leave named providers out of the registry.
- Named `effect` export on every provider file, letting the entrypoint compose
  them while each file keeps its standalone default export.
- Caching for **Brave**, **Querit**, and **SerpApi**, which previously paid for
  every repeat query. Default TTL matches the other providers (600s, `0`
  disables).
- Environment knobs for **Brave** (`BRAVE_NUM`, `BRAVE_COUNTRY`, `BRAVE_LANG`,
  `BRAVE_FRESHNESS`), **Querit** (`QUERIT_COUNT`), and **SerpApi**
  (`SERPAPI_GL`, `SERPAPI_HL`, `SERPAPI_TBS`).
- Shared date parsing for **Brave**, **Metaso**, **Querit**, **SerpApi**, and
  **You.com**, which previously passed provider dates straight to `Date.parse`
  and so dropped every relative phrase (`3 hours ago`).
- Strict TypeScript checking and a test suite covering the provider contract,
  date parsing, aggregate registration, and repository structure.

### Fixed

- **Serper's cache was never written.** `writeCache` was defined but never
  called, so the cache was read, always missed, and every repeat query was
  billed again while `SERPER_CACHE_TTL` did nothing.
- **SerpApi sent a `num` parameter Google no longer honours.** Google withdrew
  `num`, so the value was ignored by upstream. The parameter and a
  result-count knob built on it were removed rather than documented as working.
- **ISO 8601 timestamps with a time component were rejected.** The date parser
  accepted date-only `YYYY-MM-DD` but not `2026-10-01T08:30:00Z`, which is the
  shape Brave returns on `page_age`.
- An empty environment variable was read as `0` rather than as unset, so
  `BRAVE_NUM=` collapsed to one result instead of falling back to the default.

### Changed

- Providers without a key behave as before: they stay out of the websearch
  pool so `websearch.provider: "random"` cannot route to them.
- A failed credential read now degrades to the environment fallback instead of
  making the plugin effect unrunnable. The host types that failure channel as
  `unknown`, which previously could not satisfy the plugin API's `never`.
- Plugin, provider, and integration IDs are unchanged, so existing
  `websearch.provider` configuration and `/connect` credentials keep working.

[Unreleased]: https://github.com/guotree/opencode-search-plugin/compare/v2.2.0...HEAD
[2.2.0]: https://github.com/guotree/opencode-search-plugin/releases/tag/v2.2.0
[2.1.1]: https://github.com/guotree/opencode-search-plugin/releases/tag/v2.1.1
[2.1.0]: https://github.com/guotree/opencode-search-plugin/releases/tag/v2.1.0
[2.0.0]: https://github.com/guotree/opencode-search-plugin/releases/tag/v2.0.0
[1.1.0]: https://github.com/guotree/opencode-search-plugin/releases/tag/v1.1.0
[1.0.1]: https://github.com/guotree/opencode-search-plugin/releases/tag/v1.0.1
[1.0.0]: https://github.com/guotree/opencode-search-plugin/releases/tag/v1.0.0
