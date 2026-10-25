# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **One failed rebind no longer kills the rebind subscription** (the nineteen
  credentialed providers). The credential-event handler ran bare inside
  `Stream.runDrain`: a single host-side defect -- a throw while reading the
  credential, or a `websearch.reload()` that died mid-replay -- terminated the
  forked fiber silently, and that provider permanently stopped reacting to
  credential changes until a process restart. The handler now recovers from
  defects with a one-line stderr warning naming the provider, and `bound`
  rolls back when the reload dies so the next credential event retries the
  binding instead of treating it as done. The reload call is suspended so
  synchronous throws share the same recovery path; even an `undefined`
  defect rolls back and is reported. An interruption still propagates, so
  teardown is never mistaken for a failed rebind. Covered by
  `test/rebind-fault.test.ts`, whose harness `reloadFailures` option makes the
  first N reloads die on cue.

- **A malformed hit no longer fails the whole page** (eleven providers).
  AnySearch, Bocha, Brave, DeepSeek, Doubao, Kagi, Keenable, Linkup, Metaso,
  Ollama and Perplexity decoded each result with a required `url` (Brave,
  Kagi and Metaso also a required `title`), so one half-formed row failed the
  entire response through `Schema.decodeUnknownEffect`. All per-item fields
  are now optional: a hit without a URL is dropped -- it cannot be opened,
  cited, or read as a source -- and a missing title falls back to the URL the
  way the ten providers that already tolerated this do. Linkup's mapping had
  always filtered URL-less hits behind a guard its own schema made
  unreachable; the schema now matches the comment that always claimed every
  field was optional. Covered by `test/malformed-hit.test.ts` and a
  Linkup-specific case.

- **An error body is cut at 300 code points before it reaches the tool
  result** (all twenty-one providers). A WAF or CDN interposing an HTML page
  on a 4xx/5xx used to land whole in the `Error` message -- tens of
  kilobytes of markup in the agent's context. Structured refusal messages are
  extracted before the bound is applied, including the 401/403/429 branches.
  The cut counts code points so no surrogate pair is sliced in half, and
  marks only text that was actually truncated. Covered by
  `test/error-detail.test.ts`; structure guards keep the helper identical
  across all twenty-one files.

### Changed

- `Retry-After` is reported as seconds only when it is delay-seconds (bocha,
  doubao, keenable, stepfun, zai, zhipu). RFC 9110 also allows an HTTP-date,
  which the old unconditional `+"s"` rendered as "...GMTs"; a date-form value
  is now quoted verbatim. Missing or blank headers produce no retry hint;
  structure guards keep the helper identical across the six files.
- `envInt`-read knobs take whole numbers only (all twenty-one). `BRAVE_NUM=8.5`
  used to dispatch `count=8.5` because only finiteness was checked; a
  fractional or negative value now falls back to the default. `1e1` and
  `0x10` stay accepted -- `Number` whole-numbers them. Covered by
  `test/envint.test.ts`.

## [4.4.0] - 2026-10-23

### Changed

- Ollama Search bounds what each hit's `content` spends on context:
  `OLLAMA_CONTENT_CHARS` (default 2000 code points, `0` keeps all of it) cuts
  the body on code points and marks the cut with an ellipsis -- the shape
  `DOUBAO_CONTENT_CHARS` and `STEPFUN_CONTENT_CHARS` already use. The API
  offers no length knob of its own (`web_search` takes only `query` and
  `max_results`, and unknown parameters are accepted and ignored), and
  Ollama's own agent example cuts its search output to 8k characters before
  the model reads it. Measured against the live API, `content` is the whole
  page -- byte-identical to what `web_fetch` returns for the same URL -- not
  the "relevant content snippet" the docs describe: 20 hits across four
  queries ran 348 to 208,805 characters, median near 10,000, and 17 of them
  passed the 2,000 default. The cut is recoverable, since the same text is
  what `web_fetch` returns for that URL.

- Linkup Search bounds each hit's `content` with `LINKUP_CONTENT_CHARS`
  (default 4000 code points, `0` keeps all of it), the code-point cut the other
  bounded providers use. Measured against the live API, Linkup's `content` is a
  query-relevant excerpt rather than a page -- 375 to 4,395 characters across
  85 hits, median near 2,000 -- so the default sits at the top of that range
  and trims the tail: cutting an excerpt costs answer text, not a footer. Two
  more measurements shape the docs around it. `maxResults` is answered with at
  most 20 whatever is asked for (50 and 200 both return 20), so the 1-100
  clamp only guards a typo; and `depth` buys recall and latency rather than
  text, with flash, fast and deep returning the same excerpt lengths.
  `outputType` stays `searchResults`: `sourcedAnswer` would add an AI answer to
  source snippets that are the same text `results[].content` already holds,
  and WebSearch.Result has no field for an answer to live in.

### Fixed

- The README pointed `ANYSEARCH_TAG` at `code.doc`, a sub-domain whose
  required `library` parameter this provider cannot send, so the example
  could only ever fail with a 400. It now points at `code.snippet`, which
  needs no parameters, and names the limitation. `ANYSEARCH_FORMAT` also
  claimed to pick the serialization of the content field; it actually picks
  its extraction (`markdown` is the fuller body with heading structure,
  `json` is a plain-text description where `content` degrades to the
  snippet), which is now spelled out in both languages.

## [4.3.0] - 2026-10-23

### Added

- Doubao Search (`osp-doubao`, `plugins/doubao-search.ts`), speaking the
  Custom version of Volcengine's Doubao Search -- the search API ByteDance
  built for AI agents. Custom is the version wired up here because it
  returns the full page body per hit (thousands of characters), honors
  `Count` server-side up to 50, and can restrict results to authoritative
  sources (`DOUBAO_AUTH_LEVEL`) and a time range (`DOUBAO_TIME_RANGE`);
  the sibling Global version shares the same API key and free quota but
  speaks a different snake_case protocol. 500 free searches per month per
  Volcengine account, then per-search billing. Reads `PublishTime` in both
  of its shapes -- ISO with an explicit offset, and a bare UTC+8 wall clock
  -- and surfaces Doubao's business errors, which ride HTTP 200 inside
  `ResponseMetadata.Error`, instead of letting them decode into a silent
  empty result. Because OpenCode never truncates a tool result, the
  provider bounds what the API's page bodies spend on context itself:
  `DOUBAO_CONTENT` picks the body or the query-relevant excerpt, and
  `DOUBAO_CONTENT_CHARS` cuts whichever wins on code points (default 2000,
  roughly half a typical Doubao body; `0` keeps all of it).

## [4.2.1] - 2026-10-21

### Added

- `scripts/audit-readme.mjs` cross-checks both READMEs against the code:
  config-table variables against each plugin's `envInt` / `envStr` knobs,
  stated numeric defaults against the plugin's `envInt` fallback, the
  provider table's ID / key / anonymous columns against `test/cases.ts`
  and `KEYLESS`, the supported-providers link line, and EN/zh-CN section
  and default-cell parity -- exiting non-zero on any mismatch. It was
  written after a manual README-vs-reality audit of the Kagi provider
  turned up three prose claims the upstream docs did not support, and is
  wired into the "Adding a provider" checklist in `CONTRIBUTING.md`.
- Provider-specific tests for the eight providers that until now rode
  only the shared contract -- AnySearch, DeepSeek, Linkup, Metaso,
  Querit, SerpApi, Serper and You.com -- pinning each request body, its
  knobs and clamps, its mapping quirks (Serper's body-borne filters
  against SerpApi's URL-borne ones, You.com's web+news merge, Metaso's
  always-present `includeRawContent`) and its error branches in
  `test/<provider>-search.test.ts`.

### Changed

- Closed-set env knobs now report an unknown value instead of dropping
  it silently, matching the warn-and-drop Kagi and StepFun already
  document in both READMEs: `YOUCOM_EXTRACTION`, `LINKUP_DEPTH`,
  `ANYSEARCH_FORMAT` and `ANYSEARCH_ZONE` -- the last of which
  previously forwarded whatever it was given to the API, so a typo
  failed every search instead of costing one knob. Both READMEs' config
  rows name the behaviour.

### Fixed

- SerpApi and Serper no longer let one malformed organic hit fail the
  whole search. Both schemas now keep every result field optional as
  their header comments always claimed, drop items without a link the
  way querit and linkup already do, and a schema-level decode failure
  carries the same `Invalid ... response` prefix as a JSON-parse
  failure instead of surfacing as a raw decode dump.
- A provider that fails while registering no longer takes the other
  nineteen down with it. The aggregate loop in `index.ts` suspends each
  registration call and recovers from defects with a one-line stderr
  warning naming the provider, so a bug in one plugin file costs the
  user one provider instead of the whole package. An interruption still
  propagates, so teardown is never mistaken for a registration failure.
  Covered by `test/index-fault.test.ts`.

## [4.2.0] - 2026-10-20

### Added

- **Kagi** (`plugins/kagi-search.ts`), the twentieth provider, on Kagi's v1
  Search API at `POST kagi.com/api/v1/search` (`osp-kagi`,
  `OSP_KAGI_API_KEY`). Kagi is an ad-free, subscription-funded search engine
  whose API is billed pay-as-you-go at $12 per 1,000 requests, with no free
  credit and no anonymous tier -- so every dispatch is assumed billed and
  repeat queries ride the shared cache. The request sends `query`,
  `workflow: "search"` and `limit` (`KAGI_NUM`, clamped to the API's
  1-1024 range), and layers three documented filters on top: `lens_id`
  (`KAGI_LENS` -- the identifier of a built-in lens, or a shareable lens
  ID: the ID portion of its URL or the full URL), an inline
  `lens: { time_relative }` (`KAGI_RECENT`,
  `day`/`week`/`month`; an unknown value is warned about and dropped rather
  than sent to earn a 400, and it is skipped entirely when `KAGI_LENS` is
  set, because two lenses at once is undefined by the spec), and
  `filters.region` (`KAGI_REGION`). Only `data.search` maps to the agent:
  the news, image, and other collections, plus the debugging `meta`, ride
  along unread. `snippet` becomes `content` and `time` (ISO 8601) is
  reported as `published`, so Kagi joins the date-carrying files that share
  `parseSearchDate`. The endpoint can inline Extract-API page fetches in
  the same request at per-page cost, so this provider never asks for them --
  snippets are mapped instead. Account settings (block/promote rules,
  snippet length) apply only when the key opts in via the API portal's
  `Inherit account settings in API requests` option, and `workflow` stays
  `search` because the images, videos and news workflows return other
  result collections rather than html pages. Knobs: `KAGI_CACHE_TTL`,
  `KAGI_NUM`, `KAGI_LENS`, `KAGI_RECENT`, `KAGI_REGION`, `KAGI_TIMEOUT`.
- `test/kagi-search.test.ts` covers the request body, the three filter
  knobs and the lens/recency precedence rule, the recency warning path, the
  `data.search`-only mapping with `time` read as `published`, caching, the
  timeout naming, and the 401 report. The contract cases,
  structure guards (date parser, deadline, rebind subscription), README
  tables in both languages, and `CONTRIBUTING.md`'s shared-block lists
  count the new file alongside the other nineteen.

## [4.1.1] - 2026-10-20

### Fixed

- **The shared cache is now least-recently-used** (all nineteen providers).
  Previously a cache hit returned early without touching the entry's
  position, and a rewrite kept its old slot, so eviction always spent the
  oldest-inserted query regardless of how often it was reused; any working
  set larger than the 200-entry limit lost its hot queries. A hit now
  moves the entry to the tail and a rewrite re-inserts at the tail, while
  the expiry timestamp stays anchored to the fetch so a hot entry can
  never outlive its own freshness bound.
- **An empty result set is remembered for at most 30 seconds** instead of
  the full `<PROVIDER>_CACHE_TTL` (all nineteen providers). An HTTP 200
  with zero results is truthy and was cached like any other answer, so a
  single transient upstream wobble locked retries out for ten minutes; the
  pin is now `min(CACHE_TTL, EMPTY_RESULT_TTL)`.

### Added

- `test/cache.test.ts` covers the three cache branches that previously had
  no tests at all: eviction (both that a hot query survives and that the
  least recently used one is still spent), expiry (including
  `CACHE_TTL=0`), and the empty-result pin.
- `test/structure.test.ts` now asserts the `Effect.forkScoped` rebind
  subscription byte-for-byte in the seventeen files that carry it, and
  asserts the two keyless files (anysearch, keenable) carry no
  subscription. This was the sixth shared block and the only one without
  an assertion; `CONTRIBUTING.md`'s block table now lists it.

## [4.1.0] - 2026-10-19

### Added

- **StepFun** (`plugins/stepfun-search.ts`), the nineteenth provider, on
  StepFun's (阶跃星辰) standalone web search API at
  `POST api.stepfun.com/v1/search` (`osp-stepfun`, `OSP_STEPFUN_API_KEY`).
  A bare retrieval endpoint -- `query`, `n`, and an optional `category`
  in, `results[]` of `{url, position, title, time, snippet, content}` out --
  with no model call in the loop, billed ¥0.04 per search. The endpoint has
  no paging (`n` caps at 20), no time range, no domain filter and no
  safe-search switch, so none of those is exposed; the four documented
  scenario values (`programming`, `research`, `gov`, `business`) are the only
  lever, and an unrecognised `STEPFUN_CATEGORY` is warned about and dropped
  rather than sent to earn a 400. Every hit carries `content` -- the full
  page body -- with no parameter to turn it off, so the snippet is read by
  default and `STEPFUN_INCLUDE_CONTENT` opts into the body, cut to
  `STEPFUN_CONTENT_CHARS` (4000) code points so no emoji is ever sliced in
  half. `time` is the page's index time and is reported as `published`, the
  only time field there is. The cn platform serves the only search endpoint
  (`api.stepfun.ai/v1/search` answers 404 while its chat endpoint does not),
  so there is no international twin to bind as a second provider. StepFun
  publishes no "empty searches are free" rule, so every dispatch is assumed
  billed and repeat queries ride the shared cache. Knobs: `STEPFUN_COUNT`
  (1-20, default 10), `STEPFUN_CATEGORY`, `STEPFUN_INCLUDE_CONTENT`,
  `STEPFUN_CONTENT_CHARS`. The 401/402/451/429 messages each carry the fix
  they can act on (key console, top-up, rephrasing, waiting out the shared
  rate-limit tier). Endpoint, schema and pricing read from the published
  docs on 2026-10-19 (see `docs/research/stepfun-web-search.md`).

## [4.0.0] - 2026-10-19

### Added

- **Z.ai** (`plugins/zai-search.ts`), the sixteenth provider, on Zhipu
  international site's standalone Web Search API at
  `POST api.z.ai/api/paas/v4/web_search` (`osp-zai`, `OSP_ZAI_API_KEY`).
  Same request and hit shape as the cn site, minus the two fields the intl
  spec does not define (`search_intent`, `content_size`), and with
  `search-prime` as the only engine -- the intl enum documents that one
  value, so it is sent explicitly and there is no engine knob mirroring cn's
  four. Billing is $0.01 per successful search with no free tier, so it
  binds only while a key exists and the shared cache keeps repeat queries
  from being paid for twice. The intl spec publishes no `search_query`
  length ceiling (cn caps at 70 with `maxLength`), so the query is sent
  intact. Knobs: `ZAI_COUNT` (1–50), `ZAI_RECENCY`.
- **Moonshot** (`plugins/moonshot-search.ts`), the seventeenth provider, on
  Moonshot AI's (Kimi) international-site Basic search API at
  `POST api.moonshot.ai/v1/tools/search` (`osp-moonshot`,
  `OSP_MOONSHOT_API_KEY`). A bare search endpoint -- `text_query` plus
  `limit` in, `search_results[]` of `{title, url, snippet, date, text,
  authority, icon, mime, site_name}` out -- with no model call in the loop.
  Billing is $0.002 per search and only when the response carries at least
  one result (failed and empty searches are free), with no anonymous tier,
  so it binds only while a key exists and the shared cache keeps repeat
  queries from being dispatched twice. The Basic endpoint takes no paging,
  site or time filter (`limit` caps at 20; those belong to the Pro endpoint,
  which bills 50% more and returns relevance-scored `chunks`), so there is
  deliberately no engine or filter knob. Knobs: `MOONSHOT_COUNT` (1–20,
  default 5), `MOONSHOT_INCLUDE_CONTENT` (opt-in full-page `text` per hit).
  The 401 and 403 messages carry the console fix and name the other site's
  provider; the 429 turns `X-RateLimit-Reset` into a `retry in Ns` hint
  alongside the recharge-tiered QPS note (1 QPS at Tier0, rising to 50).
- **Moonshot CN** (`plugins/moonshot-cn-search.ts`), the eighteenth
  provider, the China-site twin at `POST api.moonshot.cn/v1/tools/search`
  (`osp-moonshot-cn`, `OSP_MOONSHOT_CN_API_KEY`). Same request, mapping and
  filter story as the international site, in renminbi (¥0.01 per successful
  search). The two are separate account systems issuing keys from separate
  consoles -- platform.kimi.ai and platform.kimi.com -- so each site is its
  own provider rather than one provider with a site knob that could aim a
  key at the wrong host, mirroring the Zhipu cn/intl split. Knobs:
  `MOONSHOT_CN_COUNT`, `MOONSHOT_CN_INCLUDE_CONTENT`. Endpoint, schema and
  pricing read from the published docs on 2026-10-19 (see
  `docs/research/kimi-web-search.md`); the provider name follows the
  models.dev / Mastra / OpenClaw convention of the bare name for the
  international site and a `-cn` suffix for the China one.

### Changed

- **Breaking: the cn and intl sites of Zhipu's Web Search API are now two
  providers.** `osp-zhipu` is the cn site only (`open.bigmodel.cn`, keys from
  bigmodel.cn); the intl site (`api.z.ai`, keys from z.ai) is the new
  `osp-zai` above. The two are separate account systems -- a key from one
  answers HTTP 401 against the other, and the engines and prices differ --
  so each now binds on its own credential instead of a `ZHIPU_SITE` knob
  aiming one provider's key at either host. `ZHIPU_SITE` is no longer read.
  Users who set `ZHIPU_SITE=intl` must move to `osp-zai` with `OSP_ZAI_API_KEY`
  and the `ZAI_*` knobs; `osp-zhipu` credentials in `/connect` are
  unaffected and keep working. Both 401 messages now name the other site's
  provider, so a key on the wrong endpoint points at its fix. The cn-only
  knobs (`ZHIPU_ENGINE`, `ZHIPU_CONTENT_SIZE`) are unchanged on `osp-zhipu`
  and deliberately absent on `osp-zai`.

## [3.3.0] - 2026-10-19

### Added

- **Zhipu** (`plugins/zhipu-search.ts`), the fifteenth provider, on Zhipu's
  standalone Web Search API at `POST open.bigmodel.cn/api/paas/v4/web_search`
  (`osp-zhipu`, `OSP_ZHIPU_API_KEY`). This is a bare search endpoint -- the
  request is `search_query` plus an engine, and the response is `search_result[]`
  of `{title, content, link, media, icon, refer, publish_date}` -- so nothing
  has to be untangled from a generated answer the way a chat-shaped API would
  require. Billing is per search with no free tier (¥0.01 Search-Std, ¥0.03
  Search-Pro, ¥0.05 Sogou/Quark, $0.01 on the international endpoint) and no
  anonymous tier, so it binds only while a key exists and the shared cache is
  what keeps repeat queries from being paid for twice. Two endpoints, two
  account systems: `ZHIPU_SITE` picks `cn` (open.bigmodel.cn, default) or
  `intl` (api.z.ai), which changes the default engine to `search-prime` and
  drops the two request fields the intl spec does not document
  (`search_intent`, `content_size`). `search_query` is cut to its 70-character
  `maxLength` before dispatch, `count` is omitted on the Quark engine (whose
  row leaves it out) and snapped to 10/20/30/40/50 on Sogou. Knobs:
  `ZHIPU_COUNT`, `ZHIPU_ENGINE`, `ZHIPU_RECENCY`, `ZHIPU_CONTENT_SIZE`,
  `ZHIPU_SITE`. The endpoint, request schema, response envelope and pricing
  were read from the published OpenAPI specs and the docs' own examples on
  2026-10-19 (see `docs/research/zhipu-search-api.md`); the refusal body for
  this endpoint is undocumented, so errors are read for whichever of the
  platform's shapes -- `{"error":{"code","message"}}` or a flat
  `{"code","message"}` -- they actually arrive in.

## [3.2.0] - 2026-10-19

### Added

- **Perplexity** (`plugins/perplexity-search.ts`), the fourteenth provider, on
  the Search API at `POST api.perplexity.ai/search` (`osp-perplexity`,
  `OSP_PERPLEXITY_API_KEY`). This is the vendor's bare search endpoint --
  `results[]` of `{title, url, snippet, date, last_updated}` and nothing else --
  which is what makes it usable here at all: the Agent API (`/v1/agent`) answers
  in prose and the Sonar chat-completions API it retired in September 2026
  answered in prose plus citations, both of which would have to be stripped back
  into links before an agent could read them. Billing is per successful request
  ($5.00 per 1,000, $1.00 with `search_type: "fast"`), never per token, and
  there is no anonymous tier -- an unauthenticated call answers `401
  invalid_api_key` -- so it binds only while a key exists and the shared cache
  is what keeps repeat queries from being paid for twice. `time.published` reads
  `date`, falling back to `last_updated`: OpenCode's result carries one slot and
  both are the page's own answer to "when is this from". Knobs:
  `PERPLEXITY_MAX_RESULTS` (1–20, the web search ceiling -- above 20 the API
  demands `search_type=people`), `PERPLEXITY_SEARCH_TYPE`, `PERPLEXITY_RECENCY`,
  `PERPLEXITY_COUNTRY` and `PERPLEXITY_LANGUAGE`. Three of those are omitted
  unless set, which is how this package honours an API default: `search_type`
  stays unset so the documented `web` applies, and a documented-only value is
  dropped rather than sent to fail as a `422`. `PERPLEXITY_LANGUAGE` sends at
  most 10 codes because the spec allows 20 where the quickstart warns of 10.
  The endpoint, the request schema, the response envelope and the 401 refusal
  body were all read from the published OpenAPI spec and the docs' own examples
  on 2026-10-19, because no key was available for a billed search: only the
  unauthenticated refusal was exercised live.

### Changed

- **Both READMEs stopped naming a pinned version and a provider count.** Each
  release had to bump the pin in the install examples and each new provider had
  to bump every "thirteen providers" phrasing, so the cost of landing a change
  landed on the change itself -- and a missed edit left the docs asserting a
  number that was no longer true. The install examples now show `@<version>` /
  `#v<version>` placeholders, and the counts read as "every provider" and "the
  others". The provider table and the per-provider configuration tables are
  untouched: those are the content the README exists to carry, and a new
  provider still belongs in them.
- **Both READMEs lead with the `random` pool.** The single-sentence tagline
  became three bullets -- no key needed, safe to sit in OpenCode's `random`
  pool, one command -- and the `websearch.provider` block moved out of Keys up
  to a "Skip the provider prompt" section beside the install command, because
  the first search otherwise prompts for a provider and that is the first thing
  a new install hits. "Why another pack, when OpenCode already searches the
  web?" answers the objection the old opening left unaddressed, and the claim
  each bullet makes is the one this repository can actually back: a provider
  registers only while it holds a credential, so `random` cannot be handed a
  member that is guaranteed to fail.

## [3.1.0] - 2026-10-19

### Fixed

- Brave now reads its key from `OSP_BRAVE_API_KEY`, not
  `OSP_BRAVE_SEARCH_API_KEY` -- the only one of the thirteen that broke the
  `OSP_<PROVIDER>_API_KEY` shape. 3.0.0 shipped the longer name earlier the
  same day, before it had any users to strand.

## [3.0.0] - 2026-10-19

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

[Unreleased]: https://github.com/guotree/opencode-search-plugin/compare/v4.4.0...HEAD
[4.4.0]: https://github.com/guotree/opencode-search-plugin/releases/tag/v4.4.0
[4.3.0]: https://github.com/guotree/opencode-search-plugin/releases/tag/v4.3.0
[4.2.1]: https://github.com/guotree/opencode-search-plugin/releases/tag/v4.2.1
[4.2.0]: https://github.com/guotree/opencode-search-plugin/releases/tag/v4.2.0
[4.1.1]: https://github.com/guotree/opencode-search-plugin/releases/tag/v4.1.1
[4.1.0]: https://github.com/guotree/opencode-search-plugin/releases/tag/v4.1.0
[4.0.0]: https://github.com/guotree/opencode-search-plugin/releases/tag/v4.0.0
[3.3.0]: https://github.com/guotree/opencode-search-plugin/releases/tag/v3.3.0
[3.2.0]: https://github.com/guotree/opencode-search-plugin/releases/tag/v3.2.0
[3.1.0]: https://github.com/guotree/opencode-search-plugin/releases/tag/v3.1.0
[3.0.0]: https://github.com/guotree/opencode-search-plugin/releases/tag/v3.0.0
[2.2.0]: https://github.com/guotree/opencode-search-plugin/releases/tag/v2.2.0
[2.1.1]: https://github.com/guotree/opencode-search-plugin/releases/tag/v2.1.1
[2.1.0]: https://github.com/guotree/opencode-search-plugin/releases/tag/v2.1.0
[2.0.0]: https://github.com/guotree/opencode-search-plugin/releases/tag/v2.0.0
[1.1.0]: https://github.com/guotree/opencode-search-plugin/releases/tag/v1.1.0
[1.0.1]: https://github.com/guotree/opencode-search-plugin/releases/tag/v1.0.1
[1.0.0]: https://github.com/guotree/opencode-search-plugin/releases/tag/v1.0.0
