[English](README.md) · **简体中文**

# opencode-search-plugin

九个相互独立的 [OpenCode](https://opencode.ai) v2 插件，各自注册一个网页搜索 provider。每个文件都能单独使用：复制一个进你的插件目录，或者安装这个包一次拿全九个。

[AnySearch](https://www.anysearch.com/) · [Brave Search](https://brave.com/search/api/) · [Jina](https://jina.ai/) · [Linkup](https://www.linkup.so/) · [Metaso](https://metaso.cn/) · [Querit](https://querit.ai/) · [SerpApi](https://serpapi.com/) · [Serper](https://serper.dev/) · [You.com](https://you.com/)

## 为什么做这个插件

OpenCode v2 内置了五个网页搜索 provider：`exa`、`firecrawl`、`parallel`、`tavily`、`tinyfish`。在这个范围之外，还有大量搜索 API 提供免费额度或免费层级，足以支撑 agent 的日常检索而不必为此付费。

本仓库为其中九家补上了插件，把可用池从五个 provider 扩到十四个。AnySearch 无需任何 key 即可使用；其余八家只在你提供 key 之后才会绑定，因此装上这个包也不会把查询路由到一个注定失败的服务上。至于哪几家值得用，取决于它们各自当前的免费额度，长期依赖某家之前建议先确认它的定价。

## 安装

### 一次性装全九个：包安装

```sh
# 从 GitHub 安装（追加 #v1.0.1 可固定到该 tag）
opencode plugin add github:guotree/opencode-search-plugin

# 或从 npm 安装（追加 @1.0.1 可固定到该版本）
opencode plugin add opencode-search-plugin
```

或者写进 `opencode.json(c)`：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["github:guotree/opencode-search-plugin"]
}
```

### 只要一两个：直接复制文件

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

装包会注册全部九家，但没有 key 的 provider 永远不会进入搜索池——见下文[密钥](#密钥)。想让它们连注册表都不出现：

```jsonc
{
  "plugins": [
    {
      "package": "github:guotree/opencode-search-plugin",
      "options": { "disable": ["serper", "serpapi", "youcom"] }
    }
  ]
}
```

`disable` 填的是下表中的 provider ID。

## 密钥

除 AnySearch 外，每家服务都需要 API key。两种给法二选一：

- **OpenCode 内的 `/connect`** —— 按 provider 存储，轮换后无需重启，且不受环境变量变动影响。
- **环境变量** —— 作为兜底读取，因此在无界面和 CI 场景下也能工作。

没有 key 的 provider 会保持未绑定状态：它不在 websearch 池中，所以 `"provider": "random"` 绝不会把查询路由到一个注定失败的服务上。

AnySearch 是例外。它有匿名额度，因此始终注册，只有存在 key 时才附带 `Authorization` 头。

密钥就位后，再决定 OpenCode 如何在它们之间做选择：

```jsonc
{ "websearch": { "provider": "random" } }
```

`random` 会把查询分散到所有已绑定的 provider。填具体 ID（例如 `"brave"`）则固定用某一家，填 `false` 则完全关闭网页搜索。

## 支持的服务

| 服务 | ID | 密钥（环境变量 / `/connect`） | 匿名可用 | 说明 |
| --- | --- | --- | --- | --- |
| AnySearch | `anysearch` | `ANYSEARCH_API_KEY` | 是 | 按 IP 的免费额度；意图路由，`cn` / `intl` 分区 |
| Brave Search | `brave` | `BRAVE_SEARCH_API_KEY` | 否 | 独立索引，最多 20 条结果 |
| Jina | `jina` | `JINA_API_KEY` | 否 | 页面正文按 token 计费，因此默认不取 |
| Linkup | `linkup` | `LINKUP_API_KEY` | 否 | `flash` / `fast` / `standard` / `deep` 四档推理深度 |
| Metaso | `metaso` | `METASO_API_KEY` | 否 | 按次搜索计费，不按结果条数 |
| Querit | `querit` | `QUERIT_API_KEY` | 否 | 摘要缺失时回退到句子级匹配 |
| SerpApi | `serpapi` | `SERPAPI_API_KEY` | 否 | 经 SerpApi 调用 Google；另有其自带的免费 1 小时服务端缓存 |
| Serper | `serper` | `SERPER_API_KEY` | 否 | 经 Serper 调用 Google；按查询消耗积分计费 |
| You.com | `youcom` | `YDC_API_KEY` | 否 | 网页与新闻结果合并；多种正文抽取模式 |

## 配置

所有配置项都是环境变量，OpenCode 启动时读取一次——改了要重启。默认值取自各家 API 文档，所以一开始什么都不设就是合理的起点。

### 九家通用

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| `<PROVIDER>_CACHE_TTL` | `600000` | 同一条归一化查询可复用响应的毫秒数。`0` 关闭缓存。 |

### AnySearch

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| `ANYSEARCH_MAX_RESULTS` | `10` | 每次搜索的结果数，限制在 API 允许的 1–10 |
| `ANYSEARCH_TAG` | — | 把意图路由器固定到某个子域，例如 `code.doc` |
| `ANYSEARCH_ZONE` | — | `cn` 或 `intl` |
| `ANYSEARCH_LANGUAGE` | — | 首选结果语言，例如 `zh-CN` |
| `ANYSEARCH_FORMAT` | `markdown` | content 字段用 `markdown` 还是 `json` |
| `ANYSEARCH_API_KEY` | — | 可选；不设也能匿名使用 |

### Brave Search

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| `BRAVE_NUM` | `8` | 每次搜索的结果数，限制在 1–20（Brave 的上限） |
| `BRAVE_COUNTRY` | — | 两位国家代码，或 `ALL` |
| `BRAVE_LANG` | — | 结果语言，例如 `en`、`zh-hans`、`pt-br` |
| `BRAVE_FRESHNESS` | — | `pd`（24 小时）、`pw`（7 天）、`pm`（31 天）、`py`（365 天），或 `YYYY-MM-DDtoYYYY-MM-DD` |

### Jina

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| `JINA_NUM` | `0` | 每次搜索的结果数，1–100。`0` 表示不传该参数，从而保留 Jina 更快、类型更全的结果 |
| `JINA_INCLUDE_CONTENT` | 关 | `true` 返回每条命中的整页 markdown——上下文和计费 token 都会大幅增加 |
| `JINA_GL` / `JINA_HL` | — | 国家 / 语言代码 |
| `JINA_LOCATION` | — | 模拟的城市级来源，例如 `Berlin` |

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
2. 归一化后的查询（去首尾、压缩空白）先查内存缓存；命中则直接返回——重复查询免费且即时。
3. 未命中时重新解析密钥，因此在 `/connect` 里轮换的 key 立即对下一次搜索生效。
4. 发出请求；失败时会带上 HTTP 状态码和响应体，让你看到服务方到底说了什么。
5. 响应经 schema 解码，映射为 `{ url, title, content, time }`，然后写入缓存。

日期解析支持相对表述（`3 hours ago`、`3小时前`）、绝对格式（`Sep 30, 2026`、`31 Mar 2026`）和 ISO 8601。凡是宽松解析会凭空造出错误年份的字符串——比如 `Nov 1`，`Date.parse` 会读成 2001 年——一律丢弃，而不是返回一个错误的时间戳。

## 排错

```sh
# 插件加载了吗？失败了吗？
opencode plugin list

# 搜索池里到底有哪些 provider？
# 这里少了一家，说明它没有 key，或者被写进了 `disable`。
opencode api get "/api/websearch/provider"
```

另外几个值得检查的地方：

- **某家 provider 不在池里** —— 它没有 key。执行 `/connect` 或导出对应环境变量，然后重启；在 `/connect` 里做的凭据变更会自动重绑，不需要重启。
- **搜索报错 `Connect X in /connect, or set X_API_KEY`** —— key 在绑定和搜索之间消失了。重新连接或重新导出。
- **一切都很慢、或者积分烧得飞快** —— 把 `*_CACHE_TTL` 保持在默认值。时间窗内的重复查询由内存直接返回。
- **改了插件文件却没反应** —— OpenCode 会监视插件并自动重载；如果没有，执行 `opencode service restart`。

日志在 `~/.local/share/opencode/log/opencode.log`；过滤 `loading plugin` 可以看到 OpenCode 解析到的每个插件及其入口文件。

## 开发

```sh
npm install
npm run check     # 类型检查 + 测试
```

- `npm run typecheck` —— 对所有插件和测试做严格 TypeScript 检查。
- `npm test` —— 覆盖通用 provider 契约、各家行为、日期解析、聚合注册，以及仓库结构守卫。

`@opencode/plugin` 和 `effect` 声明为 **devDependencies**，而不是 `dependencies`。这两个模块由 OpenCode 在运行时提供——这正是单个 `.ts` 文件可以放进 `~/.config/opencode/plugins/` 且完全不需要 `node_modules` 的原因。若写成运行时依赖，`opencode plugin add` 会为了 100 KB 的插件源码安装 127 MB 的依赖树（仅 `effect` 就 47 MB，`@opencode/plugin` 还会拖进 `@aws-sdk`、`google-auth-library` 和 `@opentelemetry`）；放进 devDependencies 后，类型检查和测试照常可用，而使用者安装时拿不到这份依赖树。

存在结构测试，是因为每个文件必须保持可独立复制：一旦某个插件开始 import 同级模块、共享代码块不再是逐字相同的副本、或者某家的 ID 出现偏移，测试就会失败。详见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

[MIT](LICENSE)
