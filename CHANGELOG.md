# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[1.0.1]: https://github.com/guotree/opencode-search-plugin/releases/tag/v1.0.1
[1.0.0]: https://github.com/guotree/opencode-search-plugin/releases/tag/v1.0.0
