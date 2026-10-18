[English](README.md) · **简体中文**

# opencode-search-plugin

[![npm version](https://img.shields.io/npm/v/opencode-search-plugin.svg)](https://www.npmjs.com/package/opencode-search-plugin)
[![npm downloads](https://img.shields.io/npm/dm/opencode-search-plugin.svg)](https://www.npmjs.com/package/opencode-search-plugin)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**不用 API key，装上就能搜。**

一条命令，给 OpenCode v2 加上十三个搜索 provider，搜索池从五家扩到十八家。AnySearch 和 Keenable 不用 key 直接能用；其余十一家等你配好 key 才会启用。

```sh
opencode plugin add opencode-search-plugin
```

装完就能问 OpenCode 需要联网的问题。

<!-- TODO: 录一段 10 秒 GIF 后替换本注释：
     提问 → websearch 工具触发 → 结果返回 -->

十三个 provider 装一次全有，想用哪家用哪家：

[AnySearch](https://www.anysearch.com/) · [Bocha](https://bocha.ai/) · [Brave Search](https://brave.com/search/api/) · [DeepSeek](https://api-docs.deepseek.com/guides/search/) · [Jina](https://jina.ai/) · [Keenable](https://keenable.ai/) · [Linkup](https://www.linkup.so/) · [Metaso](https://metaso.cn/) · [Ollama](https://ollama.com/) · [Querit](https://querit.ai/) · [SerpApi](https://serpapi.com/) · [Serper](https://serper.dev/) · [You.com](https://you.com/)

## 为什么做这个插件

OpenCode v2 内置了五个网页搜索 provider：`exa`、`firecrawl`、`parallel`、`tavily`、`tinyfish`。在这个范围之外，还有大量搜索 API 提供免费额度或免费层级，足以支撑 agent 的日常检索而不必为此付费。

本仓库为其中十三家补上了插件，把可用池从五个 provider 扩到十八个。AnySearch 和 Keenable 无需任何 key 即可使用；其余十一家只在你提供 key 之后才会绑定，因此装上这个包也不会把查询路由到一个注定失败的服务上。至于哪几家值得用，取决于它们各自当前的免费额度，长期依赖某家之前建议先确认它的定价。

## 安装

三种方式等价，任选其一。**推荐 npm**：已发布到 registry 的版本不可变，固定 `@3.0.0` 后每次安装都拿到同一份字节；GitHub 的 tag 在理论上可以被维护者移动、指向别的 commit。前两种装的是同一个完整包（十三个全有），只想用一两个就用第三种。

### 1. 从 npm 安装（推荐）

```sh
# 追加 @3.0.0 可固定到该版本
opencode plugin add opencode-search-plugin
```

或者写进 `opencode.json(c)`：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-search-plugin"]
}
```

### 2. 从 GitHub 安装

```sh
# 追加 #v3.0.0 可固定到该 tag
opencode plugin add github:guotree/opencode-search-plugin
```

或者写进 `opencode.json(c)`：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["github:guotree/opencode-search-plugin"]
}
```

### 3. 本地复制文件

每个插件都是单个 `.ts` 文件，没有相对导入，也没有构建步骤。放进 OpenCode 会自动发现插件的位置即可：

```text
~/.config/opencode/plugins/            # 全局
<project>/.opencode/plugins/           # 单个项目
```

如果位置不在自动发现范围内，就显式列出：

```jsonc
{ "plugins": ["./plugins/brave-search.ts"] }
```

> **不要既装包、又复制它的文件。** 两者注册的是同一批 websearch provider ID，搜索池里每家服务会出现两次。

### 跳过你没有 key 的服务

装包会注册全部十三家，但没有 key 的 provider 永远不会进入搜索池（见下文[密钥](#密钥)）。想让它们连注册表都不出现，可以单独或同时使用下面两个可选选项：

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

- `disable` 是黑名单：它列出的 provider ID（见下文[支持的服务](#支持的服务)的表格）永远不会注册。AnySearch 和 Keenable 不需要 key，想把这两家也排除在搜索池之外，只能用 `disable`。
- `enable` 是白名单：只注册列出的 ID，其余一律跳过；`"enable": ["osp-brave", "osp-jina"]` 只跑这两家。

两者同时配置时，**交集由 `disable` 胜出**：逐家的排除绝不会被批量白名单覆盖。

```jsonc
{
  "options": {
    "enable": ["osp-brave", "osp-jina", "osp-serper"],
    "disable": ["osp-serper", "osp-youcom"]
    // osp-serper 仍然不注册：disable 压过 enable。
    // osp-youcom 本来就不在白名单里，这条是冗余的。
  }
}
```

用集合运算来读：实际注册的池 = `enable − disable`。交集被剔除；`disable` 里不在 `enable` 中的 ID 从一开始就不在候选内，属于无害的冗余，不报警告。唯一会触发警告的冗余是交集，日志会点出其中的 ID。

```text
enable  = {osp-brave, osp-jina, osp-serper, osp-keenable, osp-linkup}
disable = {osp-keenable, osp-linkup, osp-youcom}
pool    =  osp-brave, osp-jina          -- enable 减 disable
```

无法生效的配置会在日志里提示，而不是被悄悄丢弃：写错的 ID（本包没注册的名字）会被点名，选项不是数组也会被点名。`enable` 如果最终一个已知 provider 都没匹配上，搜索池会是空的，日志里会写明这一点。

## 升级

```sh
# 从 npm 安装的
opencode plugin update opencode-search-plugin
# 从 GitHub 安装的
opencode plugin update github:guotree/opencode-search-plugin
# 更新所有过期插件
opencode plugin update
```

升级目标用的是配置时的说明符：npm 安装用包名，GitHub 安装只认自己的 `github:` 形式，用裸包名会报 `Plugin is not configured`。先跑 `opencode plugin check` 查看有哪些过期。未固定版本的安装会跟上新版本；固定过的会停在原地（npm 形式是 `@3.0.0`，GitHub 形式是 `#v3.0.0`），直到你用新 pin 重新执行 `plugin add`，或直接修改 `opencode.json(c)` 里的说明符。本地复制的文件用新版本覆盖旧文件即可。

## 卸载

```sh
# 从 npm 安装的
opencode plugin remove opencode-search-plugin
# 从 GitHub 安装的
opencode plugin remove github:guotree/opencode-search-plugin
```

同上：传入安装时使用的说明符。该命令修改的是全局配置；若插件是写在 `opencode.json(c)` 的 `plugins` 条目里或本地复制的文件，删掉对应条目、或删掉复制的 `.ts` 文件即可。`/connect` 里保存的密钥不受影响，重新装回就能继续用。只想关掉其中几家而不是整个插件，用上文的 `enable`/`disable`。

## 密钥

除 AnySearch 和 Keenable 外，每家服务都需要 API key。两种给法二选一：

- **OpenCode 内的 `/connect`**：按 provider 存储，轮换后无需重启，也不受环境变量变动影响。
- **环境变量**：作为兜底读取，无界面和 CI 场景下也能工作。

环境变量带命名空间前缀，形如 `OSP_<PROVIDER>_API_KEY`（例如 `OSP_BRAVE_API_KEY`），因此本插件读的 key 不会和其他工具导出的同厂商变量名撞车。存在 `/connect` 里的凭据无论如何都优先于环境变量。

没有 key 的 provider 会保持未绑定状态：它不在 websearch 池中，所以 `"provider": "random"` 绝不会把查询路由到一个注定失败的服务上。

AnySearch 和 Keenable 是例外。两家都有匿名层级，因此始终注册，只有存在 key 时才附带各自的凭据头。Keenable 的两层额度互不通用：有 key 时消耗每月 100,000 次的免费额度，无 key 的请求则改走 `/public` 端点，按速率限制：每个 IP 每小时 1,000 次、每秒 10 次，且与同一出口地址上的所有人共用。想摆脱这个共享池的不确定性，就得配一把 key。

密钥就位后，再决定 OpenCode 如何在它们之间做选择：

```jsonc
{ "websearch": { "provider": "random" } }
```

`random` 会把查询分散到所有已绑定的 provider。填具体 ID（例如 `"osp-brave"`）则固定用某一家，填 `false` 则完全关闭网页搜索。

## 支持的服务

下表每个 ID 都带 `osp-` 前缀，这是本包的命名空间。OpenCode 内置 provider 用的是裸厂商名（`exa`、`tavily`），厂商自己的插件也会注册裸名（Keenable 就已经有一个），所以前缀是避免撞名的唯一保障：既避开搜索池里的重复，也避开 `/connect` 里按 integration ID 存凭据的那张表。在 `websearch.provider` 和 `enable`/`disable` 里请原样使用带前缀的 ID。

命名空间同样体现在显示名上：`/connect` 里本包的每个条目都带 `(osp)` 标记（内置的 `DeepSeek` 旁边是 `DeepSeek (osp)`），存在这里的 key 不会和内置 provider 的混淆。搜索池里仍用纯品牌名，因为池中只有搜索 provider，不存在撞名问题。

| 服务 | ID | 密钥（环境变量 / `/connect`） | 匿名可用 | 说明 |
| --- | --- | --- | --- | --- |
| AnySearch | `osp-anysearch` | `OSP_ANYSEARCH_API_KEY` | 是 | 按 IP 的免费额度；意图路由，`cn` / `intl` 分区 |
| Bocha | `osp-bocha` | `OSP_BOCHA_API_KEY` | 否 | 结果格式兼容 Bing；按搜索次数计费，要求摘要时另按 token 计费 |
| Brave Search | `osp-brave` | `OSP_BRAVE_API_KEY` | 否 | 独立索引，最多 20 条结果 |
| DeepSeek | `osp-deepseek` | `OSP_DEEPSEEK_API_KEY` | 否 | 自研搜索引擎；每千次成功请求 5 元；限速 5 QPS |
| Jina | `osp-jina` | `OSP_JINA_API_KEY` | 否 | 页面正文按 token 计费，因此默认不取 |
| Keenable | `osp-keenable` | `OSP_KEENABLE_API_KEY` | 是 | 有 key 每月 100,000 次免费请求；无 key 层级按 IP 限速 |
| Linkup | `osp-linkup` | `OSP_LINKUP_API_KEY` | 否 | `flash` / `fast` / `standard` / `deep` 四档推理深度 |
| Metaso | `osp-metaso` | `OSP_METASO_API_KEY` | 否 | 按次搜索计费，不按结果条数 |
| Ollama | `osp-ollama` | `OSP_OLLAMA_API_KEY` | 否 | 个人档免费；每条 content 是整页 markdown，上下文偏重；上限 10 条，且不带日期 |
| Querit | `osp-querit` | `OSP_QUERIT_API_KEY` | 否 | 摘要缺失时回退到句子级匹配 |
| SerpApi | `osp-serpapi` | `OSP_SERPAPI_API_KEY` | 否 | 经 SerpApi 调用 Google；另有其自带的免费 1 小时服务端缓存 |
| Serper | `osp-serper` | `OSP_SERPER_API_KEY` | 否 | 经 Serper 调用 Google；按查询消耗积分计费 |
| You.com | `osp-youcom` | `OSP_YDC_API_KEY` | 否 | 网页与新闻结果合并；多种正文抽取模式 |

## 配置

所有配置项都是环境变量，OpenCode 启动时读取一次，改了要重启。默认值取自各家 API 文档，所以一开始什么都不设就是合理的起点。

### 十三家通用

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| `<PROVIDER>_CACHE_TTL` | `600000` | 同一条归一化查询可复用响应的毫秒数。`0` 关闭缓存。 |
| `<PROVIDER>_TIMEOUT` | `25000` | 等待 provider 返回的毫秒数，超时即失败。`0` 取消该期限，但保留取消能力。 |

### AnySearch

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| `ANYSEARCH_MAX_RESULTS` | `10` | 每次搜索的结果数，限制在 API 允许的 1–10 |
| `ANYSEARCH_TAG` | — | 把意图路由器固定到某个子域，例如 `code.doc` |
| `ANYSEARCH_ZONE` | — | `cn` 或 `intl` |
| `ANYSEARCH_LANGUAGE` | — | 首选结果语言，例如 `zh-CN` |
| `ANYSEARCH_FORMAT` | `markdown` | content 字段用 `markdown` 还是 `json` |
| `OSP_ANYSEARCH_API_KEY` | — | 可选；不设也能匿名使用 |

### Bocha

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| `BOCHA_COUNT` | `10` | 每次搜索的结果数，限制在 1–50（博查的上限） |
| `BOCHA_FRESHNESS` | — | `noLimit`、`oneDay`、`oneWeek`、`oneMonth`、`oneYear`、`YYYY-MM-DD` 单日，或 `YYYY-MM-DD..YYYY-MM-DD` 区间。不设即不传该参数，这也是文档的建议：博查会自行改写时间范围，而指定区间往往在该区间内找不到结果 |
| `BOCHA_SUMMARY` | 关 | `true` 用生成的摘要替换每条 snippet——上下文更多，单次调用的价格也更高 |

### Brave Search

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| `BRAVE_NUM` | `8` | 每次搜索的结果数，限制在 1–20（Brave 的上限） |
| `BRAVE_COUNTRY` | — | 两位国家代码，或 `ALL` |
| `BRAVE_LANG` | — | 结果语言，例如 `en`、`zh-hans`、`pt-br` |
| `BRAVE_FRESHNESS` | — | `pd`（24 小时）、`pw`（7 天）、`pm`（31 天）、`py`（365 天），或 `YYYY-MM-DDtoYYYY-MM-DD` |

### DeepSeek

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| `DEEPSEEK_COUNT` | `10` | 每次搜索的结果数，限制在 1–50（DeepSeek 的上限）。按请求计费，条数增多不加价 |

### Jina

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| `JINA_NUM` | `0` | 每次搜索的结果数，1–100。`0` 表示不传该参数，从而保留 Jina 更快、类型更全的结果 |
| `JINA_INCLUDE_CONTENT` | 关 | `true` 返回每条命中的整页 markdown，上下文和计费 token 都会大幅增加 |
| `JINA_GL` / `JINA_HL` | — | 国家 / 语言代码 |
| `JINA_LOCATION` | — | 模拟的城市级来源，例如 `Berlin` |
| `JINA_TIMEOUT` | `25000`；开启 `JINA_INCLUDE_CONTENT` 时为 `60000` | 唯一一个默认值随模式变化的 provider：抓取整页本来就比取摘要慢得多 |

### Keenable

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| `KEENABLE_MAX_RESULTS` | `10` | 每次搜索的结果数，限制在 1–50 |
| `KEENABLE_MODE` | — | `pro`（更深的检索）或 `realtime`（最快）；不设则沿用 Keenable 自己的默认值 |
| `KEENABLE_TITLE` | `opencode-search-plugin` | 作为 `X-Keenable-Title` 发出的应用名，无 key 端点靠它归属调用方 |
| `OSP_KEENABLE_API_KEY` | — | 可选；不设也能匿名使用 |

### Linkup

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| `LINKUP_DEPTH` | `fast` | `flash`、`fast`、`standard` 或 `deep` |
| `LINKUP_MAX_RESULTS` | `10` | 每次搜索的结果数，限制在 1–100 |

### Metaso

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| `METASO_SEARCH_SIZE` | `20` | 每次搜索的结果数，限制在 1–100 |
| `METASO_INCLUDE_RAW_CONTENT` | 关 | `true` 返回每条命中的完整原文，搜索成本不变，但上下文 token 大幅增加 |

### Ollama

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| `OLLAMA_MAX_RESULTS` | `5` | 每次搜索的结果数，限制在 1–10（API 的上限）。`content` 是整页 markdown 而非 snippet，即使默认 5 条也是数千字符的上下文 |

### Querit

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| `QUERIT_COUNT` | `8` | 每次搜索的结果数 |

### SerpApi

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| `SERPAPI_GL` / `SERPAPI_HL` | — | 国家 / 语言代码 |
| `SERPAPI_TBS` | — | 高级筛选，例如 `qdr:d`（一天内）、`qdr:y`（一年内） |

这里**刻意没有**结果条数的配置项：Google 已经废弃了 `num` 参数，SerpApi 无法遵守它。

### Serper

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| `SERPER_NUM` | `10` | 每次搜索的结果数，限制在 1–100 |
| `SERPER_GL` / `SERPER_HL` | — | 国家 / 语言代码 |
| `SERPER_TBS` | — | 时间筛选：`qdr:h`、`qdr:d`、`qdr:w`、`qdr:m`、`qdr:y` |

### You.com

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| `YOUCOM_COUNT` | `10` | 每个分区（网页、新闻各自）的结果数，限制在 1–100 |
| `YOUCOM_EXTRACTION` | `highlights` | `highlights` 返回直接回答问题的段落，`none` 只给原始摘要，`full_page` 会抓取每个命中的页面并按实时抓取的页数计费 |
| `YOUCOM_LANGUAGE` / `YOUCOM_COUNTRY` | — | 例如 `EN` / `US` |
| `YOUCOM_FRESHNESS` | — | `day`、`week`、`month`、`year`，或 `YYYY-MM-DDtoYYYY-MM-DD` |

## 一次查询的完整流程

1. OpenCode 向选定的 provider 发起查询。
2. 归一化后的查询（去首尾、压缩空白）先查内存缓存；命中则直接返回，重复查询免费且即时。
3. 未命中时重新解析密钥，因此在 `/connect` 里轮换的 key 立即对下一次搜索生效。
4. 发出请求，且带期限（`<PROVIDER>_TIMEOUT`，默认 25 秒）。OpenCode 自身并不给搜索加任何超时，所以没有这道期限的话，一个接受了连接却不再应答的 provider 会挂住整轮对话。失败时会带上 HTTP 状态码和响应体；如果是超时，报错会直接点明是超时。
5. 响应经 schema 解码，映射为 `{ url, title, content, time }`，然后写入缓存。

日期解析支持相对表述（`3 hours ago`、`3小时前`）、绝对格式（`Sep 30, 2026`、`31 Mar 2026`）和 ISO 8601。凡是宽松解析会凭空造出错误年份的字符串（比如 `Nov 1`，`Date.parse` 会读成 2001 年）一律丢弃，而不是返回一个错误的时间戳。

## 排错

```sh
# 插件加载了吗？失败了吗？
opencode plugin list

# 搜索池里到底有哪些 provider？
# 这里少了一家，说明它没有 key，或者被 `enable`/`disable` 排除了。
# AnySearch 和 Keenable 永远在列，因为它们都不需要 key。
opencode api get "/api/websearch/provider"
```

另外几个值得检查的地方：

- 某家 provider 不在池里：它没有 key，或者被 `disable`（或收窄后的 `enable`）过滤掉了。执行 `/connect` 或导出对应环境变量，然后重启；在 `/connect` 里做的凭据变更会自动重绑，不需要重启。本该在却不在的名字多半是拼写错误：日志会点出无法识别的 ID 和 `enable`/`disable` 的交集。
- 搜索报错 `Keenable rate limited the request (HTTP 429)`：无 key 层级每个 IP 每小时 1,000 次、每秒 10 次，且与同一出口地址上的其他人共用。改用 `OSP_KEENABLE_API_KEY` 就会记到你自己的额度上。
- 搜索报错 `Ollama API error 401`：`OSP_OLLAMA_API_KEY` 必须是 [ollama.com/settings/keys](https://ollama.com/settings/keys) 的账号 key。如果它存的是某个 Ollama 兼容代理的 token（OpenCode 官方文档里就有这种配置形状），到 `/connect` 给 **Ollama Search (osp)** 存一把真 key——/connect 凭据优先于环境变量。
- 搜索报错 `Bocha balance is exhausted (HTTP 403)`：账户余额用尽；到 [open.bocha.cn](https://open.bocha.cn) 充值。报错会带上博查自己的 `message` 文本和一个 `log_id`，联系他们客服时请附上。
- 搜索报错 `Bocha rate limited the request (HTTP 429)`：单账户的请求上限与总充值金额挂钩，余额少则天花板低。博查返回了 `Retry-After` 时，报错里会带上 `retry after Ns` 提示。
- 搜索报错 `Connect X in /connect, or set OSP_X_API_KEY`：key 在绑定和搜索之间消失了。重新连接或重新导出。
- 搜索报错 `X search timed out after 25000ms`：provider 接受了请求，但在期限内没有返回。重试通常就好；如果某家 provider 在你这边一贯偏慢，调大它的 `<PROVIDER>_TIMEOUT`。这道期限是刻意加的：没有它，一个卡住的 provider 会挂住整轮对话，因为 OpenCode 自身并不给搜索设置任何超时。
- 一切都很慢，或者积分烧得飞快：把 `*_CACHE_TTL` 保持在默认值。时间窗内的重复查询由内存直接返回。
- 改了插件文件却没反应：OpenCode 会监视插件并自动重载；如果没有，执行 `opencode service restart`。

日志在 `~/.local/share/opencode/log/opencode.log`；过滤 `loading plugin` 可以看到 OpenCode 解析到的每个插件及其入口文件。本插件关于 `enable`/`disable` 的警告也落在同一个文件里，带 `[opencode-search-plugin]` 前缀。

## 开发

```sh
npm install
npm run check     # 类型检查 + 测试
```

- `npm run typecheck`：对所有插件和测试做严格 TypeScript 检查。
- `npm test`：覆盖通用 provider 契约、各家行为、日期解析、聚合注册，以及仓库结构守卫。

`@opencode/plugin` 和 `effect` 声明为 **devDependencies**，而不是 `dependencies`。这两个模块由 OpenCode 在运行时提供，这也是单个 `.ts` 文件可以放进 `~/.config/opencode/plugins/` 且完全不需要 `node_modules` 的原因。若写成运行时依赖，`opencode plugin add` 会为了 100 KB 的插件源码安装 127 MB 的依赖树（仅 `effect` 就 47 MB，`@opencode/plugin` 还会拖进 `@aws-sdk`、`google-auth-library` 和 `@opentelemetry`）；放进 devDependencies 后，类型检查和测试照常可用，而使用者安装时拿不到这份依赖树。

存在结构测试，是因为每个文件必须保持可独立复制：一旦某个插件开始 import 同级模块、共享代码块不再是逐字相同的副本、或者某家的 ID 出现偏移，测试就会失败。详见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

[MIT](LICENSE)
