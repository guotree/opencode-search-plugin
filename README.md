# opencode-search-plugin

**English** · [简体中文](README.zh-CN.md)

Ten self-contained [OpenCode](https://opencode.ai) v2 plugins that register web search providers. Each file stands on its own: copy one into your plugins directory, or install the package to get all ten.

[AnySearch](https://www.anysearch.com/) · [Brave Search](https://brave.com/search/api/) · [Jina](https://jina.ai/) · [Keenable](https://keenable.ai/) · [Linkup](https://www.linkup.so/) · [Metaso](https://metaso.cn/) · [Querit](https://querit.ai/) · [SerpApi](https://serpapi.com/) · [Serper](https://serper.dev/) · [You.com](https://you.com/)

## Why this exists

OpenCode v2 ships with five web search providers built in: `exa`, `firecrawl`, `parallel`, `tavily` and `tinyfish`. Outside that set, a much wider field of search APIs offers free quotas or free tiers — enough to run an agent's searches without paying for the privilege.

This repository adds plugins for ten more of them, taking the pool from five providers to fifteen. AnySearch and Keenable run without a key at all; the other eight bind only when you supply one, so installing this package never routes a query to a provider that would immediately fail. Which of them are worth your time depends on the free tier each one currently offers, so check a provider's pricing before you rely on it.

## Install

Three equivalent ways to install; pick one. **npm is recommended**: a version published to the registry is immutable, so a pinned `@2.0.0` always installs the same bytes, whereas a GitHub tag can in principle be moved by a maintainer to point at a different commit. The first two install the same complete package (all ten); use the third for one or two files only.

### 1. From npm (recommended)

```sh
# add @2.0.0 to pin
opencode plugin add opencode-search-plugin
```

or declare it in `opencode.json(c)`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-search-plugin"]
}
```

### 2. From GitHub

```sh
# add #v2.0.0 to pin
opencode plugin add github:guotree/opencode-search-plugin
```

or declare it in `opencode.json(c)`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["github:guotree/opencode-search-plugin"]
}
```

### 3. By copying a file

Every plugin is a single `.ts` file with no relative imports and no build step. Drop it where OpenCode auto-discovers plugins:

```text
~/.config/opencode/plugins/            # global
<project>/.opencode/plugins/           # one project
```

For a location that is not auto-discovered, list it explicitly:

```jsonc
{ "plugins": ["./plugins/brave-search.ts"] }
```

> Do not install the package *and* copy its files. Both register the same websearch provider IDs, so the pool would contain each service twice.

### Skip the services you have no key for

Loading the package registers all ten, but a provider without a key never joins the search pool — see [Keys](#keys). To keep them out of the registry entirely:

```jsonc
{
  "plugins": [
    {
      "package": "opencode-search-plugin",
      "options": { "disable": ["osp-serper", "osp-serpapi", "osp-youcom"] }
    }
  ]
}
```

`disable` takes the provider IDs listed in the table below. AnySearch and Keenable need no key, so `disable` is the only way to keep those two out of the pool.

## Upgrade

```sh
# installed from npm
opencode plugin update opencode-search-plugin
# installed from GitHub
opencode plugin update github:guotree/opencode-search-plugin
# everything outdated
opencode plugin update
```

The target is the specifier that was configured: an npm install is named by its package name, a GitHub install answers only to its `github:` form — naming it by its bare package name fails with `Plugin is not configured`. Run `opencode plugin check` first to see what is outdated. An install without a pinned version follows new releases; a pinned one — `@2.0.0` on npm, `#v2.0.0` on GitHub — stays on its pin until you re-run `plugin add` with a newer pin or edit the specifier in `opencode.json(c)`. A locally copied file is upgraded by copying the new version over the old one.

## Uninstall

```sh
# installed from npm
opencode plugin remove opencode-search-plugin
# installed from GitHub
opencode plugin remove github:guotree/opencode-search-plugin
```

The same rule: pass the specifier you installed with. The command edits the global configuration; if the plugin is instead a `plugins` entry in `opencode.json(c)` or a locally copied file, delete the entry or the copied `.ts` file. Saved `/connect` credentials are untouched — a reinstall finds them again — and to turn off a few providers instead of the whole plugin, use `disable` above.

## Keys

Every provider except AnySearch and Keenable needs an API key. Give it one of two ways:

- **`/connect`** inside OpenCode — stored per provider, rotated without a restart, and survives environment changes.
- **Environment variable** — read as a fallback, so it works in headless and CI contexts.

A provider with no key stays unbound: it is absent from the websearch pool, so `"provider": "random"` can never route a query to a service that would immediately fail.

AnySearch and Keenable are the exceptions. Both have an anonymous tier, so they are always registered and only attach their credential header when a key exists. For Keenable the two tiers draw on separate budgets: a key spends the free allowance of 100,000 requests a month, while a keyless call goes to the `/public` endpoint instead and is metered by rate — 1,000 requests an hour and 10 a second per IP, on a pool shared with everyone else on your egress address. A key is what makes that shared headroom irrelevant.

Once keys are in place, pick how OpenCode chooses among them:

```jsonc
{ "websearch": { "provider": "random" } }
```

`random` spreads queries across every bound provider. Set it to a specific ID such as `"osp-brave"` to pin one, or `false` to turn web search off.

## Providers

Every ID below carries an `osp-` prefix — this package's namespace. OpenCode's own providers register bare vendor names (`exa`, `tavily`), and a vendor's official plugin would do the same, so the prefix is what keeps those entries from colliding with ours — both in the websearch pool and in the `/connect` table, where credentials are keyed by integration ID. Use the prefixed form verbatim in `websearch.provider` and in `disable`.

| Provider | ID | Key (env / `/connect`) | Anonymous | Notes |
| --- | --- | --- | --- | --- |
| AnySearch | `osp-anysearch` | `ANYSEARCH_API_KEY` | yes | Free tier per IP; intent router, `cn`/`intl` zones |
| Brave Search | `osp-brave` | `BRAVE_SEARCH_API_KEY` | no | Independent index, 20 results max |
| Jina | `osp-jina` | `JINA_API_KEY` | no | Page content is opt-in because it is token-billed |
| Keenable | `osp-keenable` | `KEENABLE_API_KEY` | yes | 100,000 requests a month with a key; keyless tier is per IP |
| Linkup | `osp-linkup` | `LINKUP_API_KEY` | no | `flash`/`fast`/`standard`/`deep` reasoning depth |
| Metaso | `osp-metaso` | `METASO_API_KEY` | no | Billed per search, not per result |
| Querit | `osp-querit` | `QUERIT_API_KEY` | no | Falls back to sentence matches when a snippet is missing |
| SerpApi | `osp-serpapi` | `SERPAPI_API_KEY` | no | Google via SerpApi; also has its own free 1-hour server cache |
| Serper | `osp-serper` | `SERPER_API_KEY` | no | Google via Serper; billed per query in credits |
| You.com | `osp-youcom` | `YDC_API_KEY` | no | Web and news merged; extraction modes |

## Configuration

Knobs are environment variables, read once when OpenCode starts — change one and restart. Defaults match what each API documents, so leaving them unset is the right starting point.

### Shared by all ten

| Variable | Default | Meaning |
| --- | --- | --- |
| `<PROVIDER>_CACHE_TTL` | `600000` | Milliseconds to reuse a response for the same normalized query. `0` disables caching. |

### AnySearch

| Variable | Default | Meaning |
| --- | --- | --- |
| `ANYSEARCH_MAX_RESULTS` | `10` | Results per search, clamped to the API's 1–10 |
| `ANYSEARCH_TAG` | — | Pin the intent router to a sub-domain, e.g. `code.doc` |
| `ANYSEARCH_ZONE` | — | `cn` or `intl` |
| `ANYSEARCH_LANGUAGE` | — | Preferred result language, e.g. `zh-CN` |
| `ANYSEARCH_FORMAT` | `markdown` | `markdown` or `json` for the content field |
| `ANYSEARCH_API_KEY` | — | Optional; anonymous access works without it |

### Brave Search

| Variable | Default | Meaning |
| --- | --- | --- |
| `BRAVE_NUM` | `8` | Results per search, clamped to 1–20 (Brave's maximum) |
| `BRAVE_COUNTRY` | — | Two-letter country code, or `ALL` |
| `BRAVE_LANG` | — | Result language, e.g. `en`, `zh-hans`, `pt-br` |
| `BRAVE_FRESHNESS` | — | `pd` (24h), `pw` (7d), `pm` (31d), `py` (365d), or `YYYY-MM-DDtoYYYY-MM-DD` |

### Jina

| Variable | Default | Meaning |
| --- | --- | --- |
| `JINA_NUM` | `0` | Results per search, 1–100. `0` omits the parameter, which keeps Jina's faster and wider result types |
| `JINA_INCLUDE_CONTENT` | off | `true` returns each hit's full page markdown — far more context and billed tokens |
| `JINA_GL` / `JINA_HL` | — | Country / language code |
| `JINA_LOCATION` | — | City-level origin to simulate, e.g. `Berlin` |

### Keenable

| Variable | Default | Meaning |
| --- | --- | --- |
| `KEENABLE_MAX_RESULTS` | `10` | Results per search, clamped to 1–50 |
| `KEENABLE_MODE` | — | `pro` (deeper retrieval) or `realtime` (fastest); unset leaves Keenable's own default |
| `KEENABLE_TITLE` | `opencode-search-plugin` | App name sent as `X-Keenable-Title`, which the keyless endpoint requires to attribute the call |
| `KEENABLE_API_KEY` | — | Optional; keyless access works without it |

### Linkup

| Variable | Default | Meaning |
| --- | --- | --- |
| `LINKUP_DEPTH` | `fast` | `flash`, `fast`, `standard`, or `deep` |
| `LINKUP_MAX_RESULTS` | `10` | Results per search, clamped to 1–100 |

### Metaso

| Variable | Default | Meaning |
| --- | --- | --- |
| `METASO_SEARCH_SIZE` | `20` | Results per search, clamped to 1–100 |
| `METASO_INCLUDE_RAW_CONTENT` | off | `true` returns every hit's full source text at the same search cost, but far more context tokens |

### Querit

| Variable | Default | Meaning |
| --- | --- | --- |
| `QUERIT_COUNT` | `8` | Results per search |

### SerpApi

| Variable | Default | Meaning |
| --- | --- | --- |
| `SERPAPI_GL` / `SERPAPI_HL` | — | Country / language code |
| `SERPAPI_TBS` | — | Advanced filter, e.g. `qdr:d` (past day), `qdr:y` (past year) |

There is deliberately no result-count knob: Google withdrew the `num` parameter, so SerpApi cannot honour one.

### Serper

| Variable | Default | Meaning |
| --- | --- | --- |
| `SERPER_NUM` | `10` | Results per search, clamped to 1–100 |
| `SERPER_GL` / `SERPER_HL` | — | Country / language code |
| `SERPER_TBS` | — | Time filter: `qdr:h`, `qdr:d`, `qdr:w`, `qdr:m`, `qdr:y` |

### You.com

| Variable | Default | Meaning |
| --- | --- | --- |
| `YOUCOM_COUNT` | `10` | Results per section (web and news each), clamped to 1–100 |
| `YOUCOM_EXTRACTION` | `highlights` | `highlights` returns answering passages, `none` returns bare snippets, `full_page` crawls every hit and bills per live-fetched page |
| `YOUCOM_LANGUAGE` / `YOUCOM_COUNTRY` | — | e.g. `EN` / `US` |
| `YOUCOM_FRESHNESS` | — | `day`, `week`, `month`, `year`, or `YYYY-MM-DDtoYYYY-MM-DD` |

## How a query flows

1. OpenCode asks the selected provider for the query.
2. The normalized query (trimmed, whitespace collapsed) is checked against an in-memory cache. A hit returns immediately — repeat queries are free and instant.
3. On a miss the key is resolved again, so a key rotated in `/connect` applies to the very next search.
4. The request goes out; failures surface the HTTP status and response body so you can see what the provider actually said.
5. The response is schema-decoded, mapped to `{ url, title, content, time }`, and cached.

Dates are parsed from relative phrases (`3 hours ago`, `3小时前`), absolute formats (`Sep 30, 2026`, `31 Mar 2026`), and ISO 8601. Strings whose lenient parsing would invent a wrong year — `Nov 1`, which `Date.parse` reads as 2001 — are dropped rather than reported as a bogus timestamp.

## Troubleshooting

```sh
# Is the plugin loaded, and did it fail?
opencode plugin list

# Which providers are actually in the pool?
# A provider missing here has no key, or is listed in `disable`.
# AnySearch and Keenable are always present, since neither needs one.
opencode api get "/api/websearch/provider"
```

Also worth checking:

- **A provider is missing from the pool** — it has no key. Run `/connect` or export its variable, then restart; credential changes made in `/connect` rebind without one.
- **A search fails with `Keenable rate limited the request (HTTP 429)`** — the keyless pool is capped at 1,000 requests an hour and 10 a second per IP, shared with the rest of your egress address. Set `KEENABLE_API_KEY` to draw on your own allowance instead.
- **A search fails with `Connect X in /connect, or set X_API_KEY`** — the key disappeared between binding and searching. Reconnect or re-export.
- **Everything is slow or burning credits** — leave `*_CACHE_TTL` at its default. Repeated queries within the window are served from memory.
- **Nothing happens after editing a plugin file** — OpenCode watches plugins and reloads them; if it does not, `opencode service restart`.

Logs live at `~/.local/share/opencode/log/opencode.log`; filter for `loading plugin` to see every plugin OpenCode resolved, with its entrypoint.

## Development

```sh
npm install
npm run check     # typecheck + tests
```

- `npm run typecheck` — strict TypeScript across every plugin and test.
- `npm test` — the shared provider contract, per-provider behaviour, date parsing, aggregate registration, and repository-structure guards.

`@opencode/plugin` and `effect` are declared as **devDependencies**, not `dependencies`. OpenCode provides both to plugins at runtime — the same mechanism that lets a single `.ts` file run from `~/.config/opencode/plugins/` with no `node_modules` at all. Declaring them as runtime dependencies would make `opencode plugin add` install a 127 MB tree (`effect` alone is 47 MB, and `@opencode/plugin` pulls in `@aws-sdk`, `google-auth-library` and `@opentelemetry`) to reach 100 KB of plugin source; as devDependencies they are present for typechecking and tests, and absent from a consumer's install.

The structure tests exist because each file must remain independently copyable: they fail if a plugin starts importing a sibling module, if the shared blocks stop being byte-identical copies, or if a provider's IDs drift apart. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
