# opencode-search-plugin

**English** · [简体中文](README.zh-CN.md)

[![npm version](https://img.shields.io/npm/v/opencode-search-plugin.svg)](https://www.npmjs.com/package/opencode-search-plugin)
[![npm downloads](https://img.shields.io/npm/dm/opencode-search-plugin.svg)](https://www.npmjs.com/package/opencode-search-plugin)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Web search for OpenCode that works out of the box, no API key required.**

AnySearch and Keenable work immediately without any configuration. Other providers activate only when an API key is configured, ensuring you are not billed for unused services.

When OpenCode operates in `random` mode, it automatically fails over to the next available provider if one encounters an HTTP 429 rate limit. Providers without configured keys are excluded from the pool, preventing requests to unconfigured services.

```sh
opencode plugin add opencode-search-plugin
```

After installation, ask OpenCode any question that requires a web search.

## Skip the provider prompt

On your first search, OpenCode prompts you to select a search provider. Set `websearch.provider` in your configuration to bypass this prompt:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "websearch": { "provider": "random" }
}
```

`"random"` uses one provider per session and automatically fails over to another if rate-limited. You can also pin a specific provider using its ID (such as `"osp-brave"`), or disable web search with `false`.

<!-- TODO: replace this comment with a 10-second GIF:
     set websearch.provider -> ask a question -> provider responds with sources -->

## Supported providers

[AnySearch](https://www.anysearch.com/) · [Bocha](https://bocha.ai/) · [Brave Search](https://brave.com/search/api/) · [DeepSeek](https://api-docs.deepseek.com/guides/search/) · [Jina](https://jina.ai/) · [Keenable](https://keenable.ai/) · [Linkup](https://www.linkup.so/) · [Metaso](https://metaso.cn/) · [Moonshot](https://platform.kimi.ai/) · [Moonshot CN](https://platform.kimi.com/) · [Ollama](https://ollama.com/) · [Perplexity](https://www.perplexity.ai/) · [Querit](https://querit.ai/) · [SerpApi](https://serpapi.com/) · [Serper](https://serper.dev/) · [StepFun](https://platform.stepfun.com/) · [You.com](https://you.com/) · [Z.ai](https://z.ai/) · [Zhipu](https://bigmodel.cn/)

## Why this exists

OpenCode v2 ships with several built-in search providers: `exa`, `firecrawl`, `parallel`, `tavily`, and `tinyfish`. In addition, many external search APIs offer free tiers or generous free quotas.

This plugin integrates those providers into OpenCode:

- AnySearch and Keenable work immediately without an API key or account.
- Multiple providers offer free tiers, making it practical to maintain a low-cost backup pool.
- Expands OpenCode's `random` mode pool: when a provider returns an HTTP 429, OpenCode retries with another to prevent search interruptions.

## Install

Choose your preferred installation method. **npm is recommended**: published versions are immutable, so pinning with `@<version>` guarantees a consistent build.

### 1. From npm (recommended)

```sh
# Append @<version> to pin a specific version
opencode plugin add opencode-search-plugin
```

Or declare it in `opencode.json(c)`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-search-plugin"]
}
```

### 2. From GitHub

```sh
# Append #v<version> to pin a specific tag
opencode plugin add github:guotree/opencode-search-plugin
```

Or declare it in `opencode.json(c)`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["github:guotree/opencode-search-plugin"]
}
```

### 3. By copying a file

Each provider plugin is a self-contained `.ts` file with no relative imports and no build step. Place it in one of OpenCode's auto-discovery directories:

```text
~/.config/opencode/plugins/            # global
<project>/.opencode/plugins/           # project-scoped
```

For directories outside the auto-discovery paths, specify the file path explicitly:

```jsonc
{ "plugins": ["./plugins/brave-search.ts"] }
```

> Do not install the package *and* copy individual plugin files. Both register the same provider IDs, which will duplicate entries in the search pool.

### Skip providers you don't use

Installing the package registers all providers, but providers without configured API keys remain inactive (see [Keys](#keys)). To completely exclude or restrict providers, use `disable` or `enable`:

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

- `disable`: Deny-list of provider IDs (from the table below). Because AnySearch and Keenable require no key, `disable` is the only way to remove them from the pool.
- `enable`: Allow-list of provider IDs. Only the listed IDs are registered. For example, `"enable": ["osp-brave", "osp-jina"]` activates only those two.

If both are specified, **`disable` takes precedence on any overlap**:

```jsonc
{
  "options": {
    "enable": ["osp-brave", "osp-jina", "osp-serper"],
    "disable": ["osp-serper", "osp-youcom"]
    // osp-serper is excluded: disable overrides enable.
    // osp-youcom was not in enable, so it is safely ignored.
  }
}
```

The active set is computed as `enable - disable`. Overlapping IDs are dropped, and invalid or unrecognized IDs produce a warning in the logs rather than failing silently.

## Upgrade

```sh
# Installed from npm
opencode plugin update opencode-search-plugin
# Installed from GitHub
opencode plugin update github:guotree/opencode-search-plugin
# Update all outdated plugins
opencode plugin update
```

The update target must match the configured plugin specifier:
- For npm installations, use the package name (`opencode-search-plugin`).
- For GitHub installations, use the full `github:` specifier (using a bare package name will return `Plugin is not configured`).

Run `opencode plugin check` first to inspect available updates. Unpinned installations update to the latest release. Pinned installations (`@<version>` on npm, `#v<version>` on GitHub) remain at their pinned version until you edit the specifier in `opencode.json(c)` or run `plugin add` with a new version. For locally copied files, replace the existing `.ts` file with the newer version.

## Uninstall

```sh
# Installed from npm
opencode plugin remove opencode-search-plugin
# Installed from GitHub
opencode plugin remove github:guotree/opencode-search-plugin
```

Pass the same specifier used during installation. This command updates global configuration. If the plugin was configured as an entry in `opencode.json(c)` or as a local file, remove the configuration entry or delete the copied `.ts` file. Saved `/connect` credentials are preserved and will be recognized upon reinstallation. To deactivate specific providers without removing the entire plugin, use `enable` / `disable` as described above.

## Keys

Every provider except AnySearch and Keenable requires an API key. You can provide credentials in one of two ways:

- **`/connect` in OpenCode**: Stored per provider, rotatable without restarting OpenCode, and unaffected by environment changes.
- **Environment variables**: Read as a fallback for headless, automated, or CI environments.

Environment variables use the `OSP_<PROVIDER>_API_KEY` namespace (e.g., `OSP_BRAVE_API_KEY`) to prevent naming collisions with other tools that export vendor variables. Credentials stored in `/connect` always take precedence over environment variables.

A provider without a configured key remains unbound: it is omitted from the search pool, ensuring `"provider": "random"` never routes queries to a service that would immediately fail.

AnySearch and Keenable are exceptions. Both include an anonymous tier and are registered by default, attaching credentials only when a key is provided. For Keenable, the two tiers use separate quotas: configuring a key provides 100,000 free requests per month, whereas keyless requests route to the `/public` endpoint and are rate-limited to 1,000 requests/hour and 10 requests/second per IP (shared across all users on that egress address). Configuring an API key removes dependence on that shared IP rate limit.

With keys configured, `websearch.provider` controls routing: `"random"` distributes queries across all bound providers (see [Skip the provider prompt](#skip-the-provider-prompt)), a specific ID such as `"osp-brave"` pins that provider, and `false` disables web search entirely.

## Providers

Each provider ID carries an `osp-` prefix to prevent name collisions with OpenCode's built-in providers or official vendor plugins (which use bare names like `exa` or `tavily`). Use the prefixed ID in `websearch.provider` and in `enable` / `disable` options.

In OpenCode's `/connect` settings, each provider is labeled with an `(osp)` suffix (e.g., `DeepSeek (osp)`) to distinguish it from built-in integrations. The search pool itself displays the clean provider name without the suffix.

| Provider | ID | Key (env / `/connect`) | Anonymous | Notes |
| --- | --- | --- | --- | --- |
| AnySearch | `osp-anysearch` | `OSP_ANYSEARCH_API_KEY` | yes | Free tier per IP; intent routing, `cn` / `intl` zones |
| Bocha | `osp-bocha` | `OSP_BOCHA_API_KEY` | no | Bing-compatible results; billed per search, and by token when summaries are requested |
| Brave Search | `osp-brave` | `OSP_BRAVE_API_KEY` | no | Independent index, 20 results max |
| DeepSeek | `osp-deepseek` | `OSP_DEEPSEEK_API_KEY` | no | In-house index; $0.75 per 1,000 successful requests; 5 QPS rate limit |
| Jina | `osp-jina` | `OSP_JINA_API_KEY` | no | Full-page content is opt-in due to token-based billing |
| Keenable | `osp-keenable` | `OSP_KEENABLE_API_KEY` | yes | 100,000 free requests/month with a key; keyless tier is rate-limited per IP |
| Linkup | `osp-linkup` | `OSP_LINKUP_API_KEY` | no | Four reasoning depths: `flash`, `fast`, `standard`, `deep` |
| Metaso | `osp-metaso` | `OSP_METASO_API_KEY` | no | Billed per search, not per result |
| Moonshot | `osp-moonshot` | `OSP_MOONSHOT_API_KEY` | no | Moonshot's international site (api.moonshot.ai); standalone search endpoint, billed per successful search at $0.002 (failed or empty searches are free); separate account system from the cn site |
| Moonshot CN | `osp-moonshot-cn` | `OSP_MOONSHOT_CN_API_KEY` | no | Moonshot's cn site (api.moonshot.cn); standalone search endpoint, billed ¥0.01 per successful search (failed or empty searches are free); separate account system from the international site |
| Ollama | `osp-ollama` | `OSP_OLLAMA_API_KEY` | no | Free personal tier; returns full-page markdown per result (up to 10 results, no publication dates) |
| Perplexity | `osp-perplexity` | `OSP_PERPLEXITY_API_KEY` | no | Search API returns direct search results without generated answers; $5.00 / 1,000 requests ($1.00 with `fast`) |
| Querit | `osp-querit` | `OSP_QUERIT_API_KEY` | no | Falls back to sentence matches when a snippet is missing |
| SerpApi | `osp-serpapi` | `OSP_SERPAPI_API_KEY` | no | Google via SerpApi; includes SerpApi's free 1-hour server-side cache |
| Serper | `osp-serper` | `OSP_SERPER_API_KEY` | no | Google via Serper; billed per query in credits |
| StepFun | `osp-stepfun` | `OSP_STEPFUN_API_KEY` | no | StepFun's cn platform (api.stepfun.com); standalone search endpoint, billed ¥0.04 per search; four scenario biases (`programming`, `research`, `gov`, `business`); no time, domain or paging filters, and every hit carries its full page body |
| You.com | `osp-youcom` | `OSP_YDC_API_KEY` | no | Combined web and news results; multiple extraction modes |
| Z.ai | `osp-zai` | `OSP_ZAI_API_KEY` | no | Zhipu's international site (api.z.ai); standalone search endpoint, billed per search at $0.01 (Search-Prime); separate account system from Zhipu's cn site |
| Zhipu | `osp-zhipu` | `OSP_ZHIPU_API_KEY` | no | Zhipu's cn site (open.bigmodel.cn); standalone search endpoint, no model call; billed per search from ¥0.01 (Search-Std), no free tier; four engines including Sogou and Quark |

## Configuration

Configuration options are loaded as environment variables on startup. If you change a setting, restart OpenCode for it to take effect. Default values align with upstream API documentation recommendations.

### Shared by every provider

| Variable | Default | Description |
| --- | --- | --- |
| `<PROVIDER>_CACHE_TTL` | `600000` | Duration in milliseconds to reuse cached responses for identical normalized queries (`0` disables caching). A hit refreshes the entry's recency so hot queries survive eviction; an empty result set is remembered for at most 30 seconds so a transient upstream wobble does not lock retries out for the full window |
| `<PROVIDER>_TIMEOUT` | `25000` | Timeout in milliseconds before failing a request (`0` removes timeout while preserving cancellation) |

### AnySearch

| Variable | Default | Description |
| --- | --- | --- |
| `ANYSEARCH_MAX_RESULTS` | `10` | Results per search, clamped to 1–10 |
| `ANYSEARCH_TAG` | — | Pins the intent router to a sub-domain, e.g., `code.doc` |
| `ANYSEARCH_ZONE` | — | Geographic zone: `cn` or `intl` |
| `ANYSEARCH_LANGUAGE` | — | Preferred result language, e.g., `zh-CN` |
| `ANYSEARCH_FORMAT` | `markdown` | Content format: `markdown` or `json` |
| `OSP_ANYSEARCH_API_KEY` | — | Optional; anonymous access is used when omitted |

### Bocha

| Variable | Default | Description |
| --- | --- | --- |
| `BOCHA_COUNT` | `10` | Results per search, clamped to 1–50 (Bocha's maximum) |
| `BOCHA_FRESHNESS` | — | Freshness filter: `noLimit`, `oneDay`, `oneWeek`, `oneMonth`, `oneYear`, `YYYY-MM-DD`, or `YYYY-MM-DD..YYYY-MM-DD`. Omitting this parameter is recommended by Bocha, as upstream query rewriting may yield empty results for fixed ranges |
| `BOCHA_SUMMARY` | `off` | `true` replaces snippets with generated summaries (provides more context at higher per-request cost) |

### Brave Search

| Variable | Default | Description |
| --- | --- | --- |
| `BRAVE_NUM` | `8` | Results per search, clamped to 1–20 (Brave's maximum) |
| `BRAVE_COUNTRY` | — | Two-letter country code, or `ALL` |
| `BRAVE_LANG` | — | Result language code, e.g., `en`, `zh-hans`, `pt-br` |
| `BRAVE_FRESHNESS` | — | Time filter: `pd` (24h), `pw` (7d), `pm` (31d), `py` (365d), or `YYYY-MM-DDtoYYYY-MM-DD` |

### DeepSeek

| Variable | Default | Description |
| --- | --- | --- |
| `DEEPSEEK_COUNT` | `10` | Results per search, clamped to 1–50 (DeepSeek's maximum). Billed per request; additional results incur no extra charge |

### Jina

| Variable | Default | Description |
| --- | --- | --- |
| `JINA_NUM` | `0` | Results per search (1–100). `0` omits the parameter, preserving Jina's faster and broader result types |
| `JINA_INCLUDE_CONTENT` | `off` | `true` returns full-page markdown per hit, significantly increasing context and billed tokens |
| `JINA_GL` / `JINA_HL` | — | Country / language code |
| `JINA_LOCATION` | — | Simulated city-level location, e.g., `Berlin` |
| `JINA_TIMEOUT` | `25000` (`60000` with `JINA_INCLUDE_CONTENT`) | Request timeout in milliseconds; full-page fetching uses a higher default timeout |

### Keenable

| Variable | Default | Description |
| --- | --- | --- |
| `KEENABLE_MAX_RESULTS` | `10` | Results per search, clamped to 1–50 |
| `KEENABLE_MODE` | — | Search mode: `pro` (deeper retrieval) or `realtime` (faster); unset uses Keenable's default |
| `KEENABLE_TITLE` | `opencode-search-plugin` | Application identifier sent as `X-Keenable-Title`, required by the keyless endpoint for attribution |
| `OSP_KEENABLE_API_KEY` | — | Optional; keyless access is used when omitted |

### Linkup

| Variable | Default | Description |
| --- | --- | --- |
| `LINKUP_DEPTH` | `fast` | Search depth: `flash`, `fast`, `standard`, or `deep` |
| `LINKUP_MAX_RESULTS` | `10` | Results per search, clamped to 1–100 |

### Metaso

| Variable | Default | Description |
| --- | --- | --- |
| `METASO_SEARCH_SIZE` | `20` | Results per search, clamped to 1–100 |
| `METASO_INCLUDE_RAW_CONTENT` | `off` | `true` returns full source text per hit without extra search cost, but substantially increases context tokens |

### Moonshot

| Variable | Default | Description |
| --- | --- | --- |
| `MOONSHOT_COUNT` | `5` | Results per search, clamped to 1–20 (the API's range and default) |
| `MOONSHOT_INCLUDE_CONTENT` | `off` | `true` sends `include_content` and reads each hit's full-page `text` instead of its snippet; billed the same per search, but substantially increases context tokens |

This is Moonshot's international site ([platform.kimi.ai](https://platform.kimi.ai)), with keys from [platform.kimi.ai](https://platform.kimi.ai/console/api-keys) and the Basic search endpoint at `api.moonshot.ai/v1/tools/search`. Billing is $0.002 per successful search, and only when the response carries at least one result -- failed and empty searches are free, and repeat queries ride the shared cache. There is no anonymous tier, so the provider binds only while a key exists.

The endpoint takes no paging, site, or time filter: `limit`'s 20 is the whole reach of one call, and the `sites` / `time_window` filters belong to the Pro endpoint (50% more, relevance-scored `chunks` instead of snippets), which this provider deliberately does not use. The query is sent intact -- the spec documents no length ceiling and searches it verbatim.

Search QPS is tiered by the account's cumulative recharge (1 QPS at Tier0, rising to 50), counted separately from the chat endpoints' limits; a 429 reports the reset time from `X-RateLimit-Reset`.

The cn site ([platform.kimi.com](https://platform.kimi.com)) is a separate account system with renminbi pricing and registers as its own provider, Moonshot CN (`osp-moonshot-cn`) below.

### Moonshot CN

| Variable | Default | Description |
| --- | --- | --- |
| `MOONSHOT_CN_COUNT` | `5` | Results per search, clamped to 1–20 (the API's range and default) |
| `MOONSHOT_CN_INCLUDE_CONTENT` | `off` | `true` sends `include_content` and reads each hit's full-page `text` instead of its snippet; billed the same per search, but substantially increases context tokens |

This is Moonshot's cn site ([platform.kimi.com](https://platform.kimi.com)), with keys from [platform.kimi.com](https://platform.kimi.com/console/api-keys) and the Basic search endpoint at `api.moonshot.cn/v1/tools/search`. Billing is ¥0.01 per successful search, and only when the response carries at least one result -- failed and empty searches are free, and repeat queries ride the shared cache. The request, mapping, and filter story are identical to the international site above, including the recharge-tiered search QPS (1 at Tier0, rising to 50).

The international site ([platform.kimi.ai](https://platform.kimi.ai)) is a separate account system with dollar pricing and registers as its own provider, Moonshot (`osp-moonshot`) above.

### Ollama

| Variable | Default | Description |
| --- | --- | --- |
| `OLLAMA_MAX_RESULTS` | `5` | Results per search, clamped to 1–10 (API maximum). Because each result includes full-page markdown rather than snippets, the default 5 results provide extensive context |

### Perplexity

| Variable | Default | Description |
| --- | --- | --- |
| `PERPLEXITY_MAX_RESULTS` | `10` | Results per search, clamped to 1–20 (web search supports up to 20; `search_type=people` accepts up to 50) |
| `PERPLEXITY_SEARCH_TYPE` | — | Search type: `web` (API default, $5.00 / 1,000 requests), `fast` ($1.00 / 1,000 requests, lower latency), or `people`; unset omits the parameter |
| `PERPLEXITY_RECENCY` | — | Recency filter: `hour`, `day`, `week`, `month`, or `year` |
| `PERPLEXITY_COUNTRY` | — | Two-letter ISO 3166-1 country code, e.g., `US` |
| `PERPLEXITY_LANGUAGE` | — | Comma-separated ISO 639-1 language codes, e.g., `en,zh` (maximum of 10 codes sent, adhering to the stricter quickstart limit) |

There is intentionally no domain or source filter configuration: the Perplexity API provides no dedicated toggle for news, Reddit, or academic search. Upstream documentation recommends using `search_domain_filter` allowlists per query rather than applying a global configuration.

### Querit

| Variable | Default | Description |
| --- | --- | --- |
| `QUERIT_COUNT` | `8` | Results per search |

### SerpApi

| Variable | Default | Description |
| --- | --- | --- |
| `SERPAPI_GL` / `SERPAPI_HL` | — | Country / language code |
| `SERPAPI_TBS` | — | Advanced search filter, e.g., `qdr:d` (past day), `qdr:y` (past year) |

There is intentionally no result-count configuration: Google deprecated the `num` parameter, so SerpApi no longer supports it.

### Serper

| Variable | Default | Description |
| --- | --- | --- |
| `SERPER_NUM` | `10` | Results per search, clamped to 1–100 |
| `SERPER_GL` / `SERPER_HL` | — | Country / language code |
| `SERPER_TBS` | — | Time filter: `qdr:h`, `qdr:d`, `qdr:w`, `qdr:m`, `qdr:y` |

### StepFun

| Variable | Default | Description |
| --- | --- | --- |
| `STEPFUN_COUNT` | `10` | Results per search, clamped to 1–20 (the API's range and default) |
| `STEPFUN_CATEGORY` | — | Scenario bias: `programming`, `research`, `gov`, or `business`. Unset searches every scenario, which is the API's default; an unknown value is reported and dropped rather than sent to earn a 400 |
| `STEPFUN_INCLUDE_CONTENT` | `off` | `true` returns each hit's full-page `content` instead of its snippet. The body is in every response either way — this only decides whether it is spent on context tokens |
| `STEPFUN_CONTENT_CHARS` | `4000` | Code points kept from `content` when it is read (`0` keeps all of it). Counted in code points, so no emoji is ever cut in half |

StepFun's cn platform ([platform.stepfun.com](https://platform.stepfun.com/interface-key)) serves the only search endpoint: `POST api.stepfun.com/v1/search`, billed ¥0.04 per search. The international host has no equivalent (`api.stepfun.ai/v1/search` answers 404 while its chat endpoint does not), so there is no second provider to bind — unlike Moonshot's two sites.

The endpoint takes three parameters and nothing else: `query`, `n`, and `category`. There is no paging (`n`'s 20 is the whole reach of one call), no time range, no domain filter, and no safe-search switch, so a freshness or site filter has no lever here and is deliberately not exposed. `time` is the page's **index** time — when StepFun's crawler last saw it — not a publish date, and it is reported as `published` because it is the only time field there is.

Every hit carries `content`, the full page body, with no parameter to turn it off. That is why the snippet is the default: the body is paid for on the wire regardless, but it need not be paid for again in context tokens. `STEPFUN_INCLUDE_CONTENT` opts into reading it, and `STEPFUN_CONTENT_CHARS` bounds it. A hit whose snippet is empty still falls back to the truncated body, since an empty string is not an answer worth handing the agent. StepFun publishes no "empty searches are free" rule (unlike Moonshot), so every dispatch is assumed billed and repeat queries ride the shared cache. There is also no search-specific quota in the docs — the account's recharge-tiered concurrency/RPM limits are what apply.

The built-in `web_search` tool in Chat Completions is a different capability — the model decides whether to search, and the results are billed again as prompt tokens — and `step-5-preview` does not support it. This provider calls the standalone endpoint, which works with any model.

### You.com

| Variable | Default | Description |
| --- | --- | --- |
| `YOUCOM_COUNT` | `10` | Results per section (web and news each), clamped to 1–100 |
| `YOUCOM_EXTRACTION` | `highlights` | Extraction mode: `highlights` returns answering passages, `none` returns raw snippets, and `full_page` fetches full pages and bills per fetched page |
| `YOUCOM_LANGUAGE` / `YOUCOM_COUNTRY` | — | Language / country code, e.g., `EN` / `US` |
| `YOUCOM_FRESHNESS` | — | Freshness filter: `day`, `week`, `month`, `year`, or `YYYY-MM-DDtoYYYY-MM-DD` |

### Z.ai

| Variable | Default | Description |
| --- | --- | --- |
| `ZAI_COUNT` | `10` | Results per search, clamped to 1–50 (the API's range) |
| `ZAI_RECENCY` | — | Time filter: `oneDay`, `oneWeek`, `oneMonth`, `oneYear`, or `noLimit`. Omitting it leaves the API's `noLimit` default in place |

Search-Prime ($0.01/search) is the only engine the international site's spec documents, so it is always sent and there is no engine knob. Every dispatch is billed -- there is no free tier -- so repeat queries ride the shared cache. Unlike the cn site, the intl spec publishes no length ceiling on the query, so it is sent intact.

Z.ai is Zhipu's international site with its own account system: keys come from [z.ai](https://z.ai/manage-apikey/apikey-list) and are not interchangeable with the cn site's. A cn key used here answers HTTP 401, which the error message names.

### Zhipu

| Variable | Default | Description |
| --- | --- | --- |
| `ZHIPU_COUNT` | `10` | Results per search, clamped to 1–50 (Zhipu's maximum) |
| `ZHIPU_ENGINE` | `search_std` | Search engine: `search_std` (¥0.01/search), `search_pro` (¥0.03, higher recall), `search_pro_sogou` / `search_pro_quark` (¥0.05 each) |
| `ZHIPU_RECENCY` | — | Time filter: `oneDay`, `oneWeek`, `oneMonth`, `oneYear`, or `noLimit`. Omitting it leaves the API's `noLimit` default in place |
| `ZHIPU_CONTENT_SIZE` | — | Excerpt length: `medium` (the API default) or `high`, which sends fuller excerpts at the same per-search price |

The default `search_std` is the cheapest engine; `search_pro` costs three times as much for higher recall, and the Sogou / Quark engines trade a higher price for their own source pools (Sogou covers the Tencent ecosystem and Zhihu; Quark skews recent). Every dispatch is billed -- there is no free tier -- so repeat queries ride the shared cache. Queries are cut to the API's 70-character `search_query` ceiling before dispatch, `count` is omitted on `search_pro_quark` (whose spec row leaves the field out), and on `search_pro_sogou` it is snapped to the nearest of 10/20/30/40/50.

Zhipu here is the cn site ([open.bigmodel.cn](https://open.bigmodel.cn)), with keys from [bigmodel.cn](https://bigmodel.cn/usercenter/proj-mgmt/apikeys). The international site (api.z.ai) is a separate account system and registers as its own provider, Z.ai (`osp-zai`) above.

## How a query flows

1. OpenCode issues a search request to the active provider.
2. The normalized query (trimmed of leading/trailing whitespace with internal whitespace collapsed) is checked against an in-memory cache. Cache hits return immediately without an external API request.
3. On a cache miss, the API key is freshly resolved so that keys rotated in `/connect` take effect immediately.
4. The request is dispatched with an abort timeout (`<PROVIDER>_TIMEOUT`, default 25s) to prevent unresponsive upstreams from hanging the session.
5. The response is schema-validated, mapped to `{ url, title, content, time }`, and cached for subsequent identical queries.

Publication dates are parsed from relative expressions (`3 hours ago`, `3小时前`), absolute dates (`Sep 30, 2026`, `31 Mar 2026`), and ISO 8601 timestamps. Incomplete date strings that could cause lenient parsers to infer an incorrect year (such as `Nov 1`) are ignored.

## Troubleshooting

```sh
# Check if the plugin is loaded and view its status
opencode plugin list

# List providers currently active in the search pool
# A provider omitted here either lacks an API key or was excluded by enable/disable
# AnySearch and Keenable are always included since neither requires a key
opencode api get "/api/websearch/provider"
```

Common issues to check:

- **Provider is missing from the search pool**: The provider lacks an API key or was excluded by `disable` (or omitted from `enable`). Configure the key in `/connect` or export its environment variable and restart OpenCode (credentials updated in `/connect` rebind immediately without restarting). If a configured provider is missing, check the logs for typos: unrecognized IDs and conflicts between `enable` and `disable` are flagged on startup.
- **Search fails with `Keenable rate limited the request (HTTP 429)`**: The keyless tier is limited to 1,000 requests/hour and 10 requests/second per IP, shared across all users on that egress address. Configure `OSP_KEENABLE_API_KEY` to use your dedicated free monthly quota instead.
- **Search fails with `Ollama API error 401`**: `OSP_OLLAMA_API_KEY` must be an ollama.com account key from [ollama.com/settings/keys](https://ollama.com/settings/keys). If your environment variable holds a bearer token for a local or custom Ollama proxy, configure the API key in `/connect` under **Ollama Search (osp)** instead, which takes precedence over the environment variable.
- **Search fails with `Bocha balance is exhausted (HTTP 403)`**: The account balance is exhausted; recharge at [open.bocha.cn](https://open.bocha.cn). The error message includes Bocha's response message and a `log_id` for contacting support.
- **Search fails with `Bocha rate limited the request (HTTP 429)`**: Bocha's per-account request limit scales with total recharge amount. When returned by Bocha, a `retry after Ns` hint is included in the error message.
- **Search fails with `Zhipu rejected the API key (HTTP 401)`**: The key most likely belongs to Zhipu's other site. The cn site ([open.bigmodel.cn](https://open.bigmodel.cn), provider `osp-zhipu`) and the international site ([api.z.ai](https://api.z.ai), provider `osp-zai`) are separate account systems whose keys are not interchangeable. Use the provider whose site issued the key -- `osp-zhipu` for bigmodel.cn keys, `osp-zai` for z.ai keys -- or get a cn key from [bigmodel.cn](https://bigmodel.cn/usercenter/proj-mgmt/apikeys).
- **Search fails with `Zhipu rate limited the request (HTTP 429)`**: Concurrent searches are capped per account, reported by the API as code 1701. Zhipu attaches a `retry after Ns` hint when it has one; waiting it out or running fewer searches at once clears the refusal.
- **Search fails with `Moonshot rejected the API key (HTTP 401)` (or `Moonshot CN rejected...`)**: The key most likely belongs to Moonshot's other site. The international site ([platform.kimi.ai](https://platform.kimi.ai), provider `osp-moonshot`) and the cn site ([platform.kimi.com](https://platform.kimi.com), provider `osp-moonshot-cn`) issue keys from separate consoles. Use the provider whose site issued the key -- `osp-moonshot` for platform.kimi.ai keys, `osp-moonshot-cn` for platform.kimi.com keys -- or get a key from the console of the site you meant to search.
- **Search fails with `Moonshot rate limited the search (HTTP 429)` (or `Moonshot CN rate limited...`)**: The search QPS cap is tiered by the account's cumulative recharge (1 QPS at Tier0, rising to 50). The error message includes a `retry in Ns` hint when the `X-RateLimit-Reset` header is present; waiting it out or running fewer searches at once clears the refusal.
- **Search fails with `StepFun rejected the API key (HTTP 401)`**: `OSP_STEPFUN_API_KEY` must be a key from [platform.stepfun.com/interface-key](https://platform.stepfun.com/interface-key), and personal accounts must complete real-name verification before they can be billed. StepFun's international site issues no search endpoint, so there is no other site whose key could work here.
- **Search fails with `StepFun balance is insufficient (HTTP 402)`**: The account has run out of credit; top up at [platform.stepfun.com](https://platform.stepfun.com). An organization project key reports the same status with an `insufficient_credit` type.
- **Search fails with `StepFun refused the search on content review (HTTP 451)`**: Either the query or the pages it found tripped moderation. Rephrasing the query is the only lever; it is not a key or quota problem.
- **StepFun results are short or cut off mid-sentence**: The page body is truncated to `STEPFUN_CONTENT_CHARS` (default 4000 code points) and ends with `…` when it was. Raise the limit, or leave `STEPFUN_INCLUDE_CONTENT` off to read the snippet instead.
- **Search fails with `Connect X in /connect, or set OSP_X_API_KEY`**: The credentials were removed or became unavailable between provider registration and search execution. Reconfigure the key in `/connect` or export the environment variable.
- **Search fails with `X search timed out after 25000ms`**: The upstream provider did not respond within the deadline. Retrying often succeeds. If a provider is consistently slow in your network environment, increase its `<PROVIDER>_TIMEOUT`. This deadline prevents a hanging upstream connection from blocking the entire session, as OpenCode does not enforce its own search timeout.
- **Queries are slow or consuming excessive credits**: Keep `*_CACHE_TTL` at its default value. Identical queries within the cache TTL window are served from memory without network calls or credit consumption.
- **Changes to a local plugin file do not take effect**: OpenCode watches plugins and reloads them automatically. If changes are not picked up, run `opencode service restart`.

Logs are located at `~/.local/share/opencode/log/opencode.log`. Filter for `loading plugin` to inspect each resolved plugin and its entry point. Plugin warnings (such as `enable` / `disable` conflicts) are written to this file with an `[opencode-search-plugin]` prefix.

## Development

```sh
npm install
npm run check     # typecheck + tests
```

- `npm run typecheck`: Strict TypeScript checking across all plugins and tests.
- `npm test`: Runs the shared provider contract, individual provider behaviors, date parsing, aggregate registration, and repository structure guards.

`@opencode/plugin` and `effect` are declared as **devDependencies**, not `dependencies`. OpenCode provides both packages at runtime, which allows standalone `.ts` files to run directly from `~/.config/opencode/plugins/` without a local `node_modules` directory. Declaring them as runtime dependencies would cause `opencode plugin add` to download a 127 MB dependency tree (`effect` alone is 47 MB, and `@opencode/plugin` pulls in `@aws-sdk`, `google-auth-library`, and `@opentelemetry`) for 100 KB of plugin source code. Declaring them as devDependencies keeps them available for typechecking and testing while omitting them from consumer installations.

Structure tests enforce that each plugin file remains independently copyable. They will fail if a plugin imports a sibling module, if shared blocks diverge from their canonical byte-for-byte implementation, or if provider IDs become inconsistent. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)

## Friend Links

- [LINUX DO](https://linux.do/) — the new ideal community
