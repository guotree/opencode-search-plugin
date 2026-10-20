# opencode-search-plugin

[English](README.md) · **简体中文**

[![npm version](https://img.shields.io/npm/v/opencode-search-plugin.svg)](https://www.npmjs.com/package/opencode-search-plugin)
[![npm downloads](https://img.shields.io/npm/dm/opencode-search-plugin.svg)](https://www.npmjs.com/package/opencode-search-plugin)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**无需 API key，开箱即用的 OpenCode 网页搜索插件。**

AnySearch 和 Keenable 支持免配置直接使用。其余 provider 仅在配置对应 API key 后才会激活，避免产生意外账单。

在 OpenCode 的 `random` 模式下，当某个 provider 遇到 HTTP 429 限流时，系统会自动切换至下一个可用服务。未配置 key 的 provider 不会进入候选池，避免请求发送至未配置的服务。

```sh
opencode plugin add opencode-search-plugin
```

安装完成后，直接向 OpenCode 提问即可进行联网检索。

## 跳过 provider 选择提示

初次搜索时，OpenCode 默认会提示选择搜索服务。在配置中设置 `websearch.provider` 即可跳过此提示：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "websearch": { "provider": "random" }
}
```

`"random"` 会在单个会话中固定使用一个 provider，遇到限流时自动回退至其他可用服务。也可以填写具体 ID（如 `"osp-brave"`）指定固定 provider，或设为 `false` 完全禁用联网搜索。

<!-- TODO: 录一段 10 秒 GIF：
     配置 websearch.provider -> 提问 -> provider 正常应答带引用 -->

## 支持的 Provider

[AnySearch](https://www.anysearch.com/) · [Bocha](https://bocha.ai/) · [Brave Search](https://brave.com/search/api/) · [DeepSeek](https://api-docs.deepseek.com/guides/search/) · [Jina](https://jina.ai/) · [Kagi](https://kagi.com/) · [Keenable](https://keenable.ai/) · [Linkup](https://www.linkup.so/) · [Metaso](https://metaso.cn/) · [Moonshot](https://platform.kimi.ai/) · [Moonshot CN](https://platform.kimi.com/) · [Ollama](https://ollama.com/) · [Perplexity](https://www.perplexity.ai/) · [Querit](https://querit.ai/) · [SerpApi](https://serpapi.com/) · [Serper](https://serper.dev/) · [StepFun](https://platform.stepfun.com/) · [You.com](https://you.com/) · [Z.ai](https://z.ai/) · [Zhipu](https://bigmodel.cn/)

## 为什么做这个插件

OpenCode v2 内置了部分搜索服务：`exa`、`firecrawl`、`parallel`、`tavily` 与 `tinyfish`。此外，市面上许多外部搜索 API 同样提供免费层级或充足的免费调用额度。

本插件将这些搜索服务接入 OpenCode：

- AnySearch 和 Keenable 无需 API key 或注册账号即可直接使用。
- 多家服务提供免费额度，便于搭建低成本的备用搜索池。
- 扩充 OpenCode 的 `random` 模式候选池：单家服务返回 HTTP 429 时，OpenCode 会自动使用其他 provider 重试，保障搜索连续性。

## 安装

请根据使用需求选择安装方式。**推荐使用 npm**：发布的版本具有不可变性，使用 `@<version>` 锁定版本可确保构建始终一致。

### 1. 从 npm 安装（推荐）

```sh
# 追加 @<version> 可固定到指定版本
opencode plugin add opencode-search-plugin
```

或在 `opencode.json(c)` 中声明：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-search-plugin"]
}
```

### 2. 从 GitHub 安装

```sh
# 追加 #v<version> 可固定到指定 tag
opencode plugin add github:guotree/opencode-search-plugin
```

或在 `opencode.json(c)` 中声明：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["github:guotree/opencode-search-plugin"]
}
```

### 3. 本地复制文件

每个 provider 插件均为独立的单个 `.ts` 文件，无相对导入且无需构建步骤。将其放置于 OpenCode 自动发现插件的目录即可：

```text
~/.config/opencode/plugins/            # 全局
<project>/.opencode/plugins/           # 项目级别
```

若放置于非自动发现目录，需在配置中显式指定文件路径：

```jsonc
{ "plugins": ["./plugins/brave-search.ts"] }
```

> 请勿同时安装 npm 包并复制单独的插件文件。两者注册的是同一批 provider ID，会导致搜索池中出现重复服务。

### 过滤不需要的 Provider

安装插件包后会注册所有 provider，但未配置 API key 的 provider 会保持未激活状态（参见[密钥](#密钥)）。如需完全排除或限定特定 provider，可使用 `disable` 或 `enable` 配置项：

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

- `disable`：Provider ID 黑名单（参见下表）。由于 AnySearch 和 Keenable 无需 key 即可使用，`disable` 是将其移出搜索池的唯一方式。
- `enable`：Provider ID 白名单。仅注册指定的 ID，例如 `"enable": ["osp-brave", "osp-jina"]` 仅激活这两项。

若同时配置两者，**重叠项以 `disable` 为准**：

```jsonc
{
  "options": {
    "enable": ["osp-brave", "osp-jina", "osp-serper"],
    "disable": ["osp-serper", "osp-youcom"]
    // osp-serper 会被排除：disable 优先级高于 enable。
    // osp-youcom 本身不在 enable 中，会被安全忽略。
  }
}
```

生效集合为 `enable - disable`。重叠项会被自动剔除；若包含无效或未识别的 ID，插件会在日志中输出警告，而非静默失败。

## 升级

```sh
# 从 npm 安装
opencode plugin update opencode-search-plugin
# 从 GitHub 安装
opencode plugin update github:guotree/opencode-search-plugin
# 更新所有过期插件
opencode plugin update
```

更新时需使用安装时配置的插件标识符（specifier）：
- 从 npm 安装的，使用包名（`opencode-search-plugin`）。
- 从 GitHub 安装的，需使用完整的 `github:` 格式（若仅指定裸包名会提示 `Plugin is not configured`）。

运行 `opencode plugin check` 可先查看有哪些插件需要更新。未锁定版本的安装会更新至最新版本；锁定版本的安装（npm 为 `@<version>`，GitHub 为 `#v<version>`）会保持在指定版本，直至修改 `opencode.json(c)` 或使用新版本重新执行 `plugin add`。本地复制的文件直接用新版本覆盖旧文件即可。

## 卸载

```sh
# 从 npm 安装
opencode plugin remove opencode-search-plugin
# 从 GitHub 安装
opencode plugin remove github:guotree/opencode-search-plugin
```

卸载时同样需要传入安装时使用的插件标识符。该命令会更新全局配置。如果插件是在 `opencode.json(c)` 的 `plugins` 条目中声明或作为本地文件复制的，直接删除配置项或删除复制的 `.ts` 文件即可。`/connect` 中保存的凭据不会被清除，重新安装后可自动识别。若仅需关闭部分 provider 而非整个插件，请使用上文介绍的 `enable` / `disable` 配置项。

## 密钥

除 AnySearch 和 Keenable 外，其余 provider 均需要 API key。可通过以下两种方式之一提供凭据：

- **OpenCode 内的 `/connect`**：按 provider 存储，支持无需重启即时轮换，且不受环境变量变动影响。
- **环境变量**：作为兜底读取，适用于无界面、自动化或 CI 环境。

环境变量使用 `OSP_<PROVIDER>_API_KEY` 命名空间前缀（例如 `OSP_BRAVE_API_KEY`），避免与其他工具导出的同厂商变量名发生命名冲突。`/connect` 中配置的凭据始终优先于环境变量。

未配置 key 的 provider 会保持未绑定状态：它不会进入搜索池，确保 `"provider": "random"` 绝不会将查询路由至注定失败的服务。

AnySearch 和 Keenable 是例外情况。两者均包含匿名层级并默认注册，仅在配置 key 时附带认证凭据头。对于 Keenable，两种层级使用独立额度：配置 key 每月享有 100,000 次免费请求；免 key 请求改走 `/public` 端点，受速率限制（单个 IP 每小时 1,000 次、每秒 10 次，且与同一出口 IP 的其他用户共享）。配置 API key 可消除对共享 IP 限流的依赖。

配置好密钥后，由 `websearch.provider` 控制路由方式：`"random"` 会将查询分散至所有已绑定的 provider（参见[跳过 provider 选择提示](#跳过-provider-选择提示)）；填写具体 ID（如 `"osp-brave"`）则固定使用该 provider；设为 `false` 则完全关闭网页搜索。

## Provider 列表

下表中的 ID 均带有 `osp-` 前缀，用以避免与 OpenCode 内置渠道或官方插件命名冲突（它们使用的是 `exa`、`tavily` 这类直接名称）。在 `websearch.provider` 和 `enable` / `disable` 中请使用带前缀的完整 ID。

在 OpenCode 的 `/connect` 界面中，本插件的条目会带有 `(osp)` 后缀（如 `DeepSeek (osp)`），方便与内置同名服务区分。搜索池内部仍会显示无后缀的干净名称。

| Provider | ID | 密钥（环境变量 / `/connect`） | 匿名可用 | 说明 |
| --- | --- | --- | --- | --- |
| AnySearch | `osp-anysearch` | `OSP_ANYSEARCH_API_KEY` | 是 | 按 IP 提供免费额度；意图路由，`cn` / `intl` 分区 |
| Bocha | `osp-bocha` | `OSP_BOCHA_API_KEY` | 否 | 结果格式兼容 Bing；按搜索次数计费，请求摘要时另按 token 计费 |
| Brave Search | `osp-brave` | `OSP_BRAVE_API_KEY` | 否 | 独立索引，最多 20 条结果 |
| DeepSeek | `osp-deepseek` | `OSP_DEEPSEEK_API_KEY` | 否 | 自研搜索引擎；每千次成功请求 5 元；限速 5 QPS |
| Jina | `osp-jina` | `OSP_JINA_API_KEY` | 否 | 页面正文按 token 计费，因此默认不获取 |
| Kagi | `osp-kagi` | `OSP_KAGI_API_KEY` | 否 | 订阅制无广告索引，支持 lens；每千次请求 12 美元，无免费额度 |
| Keenable | `osp-keenable` | `OSP_KEENABLE_API_KEY` | 是 | 配置 key 每月享有 100,000 次免费请求；免 key 层级按 IP 限速 |
| Linkup | `osp-linkup` | `OSP_LINKUP_API_KEY` | 否 | 四档推理深度：`flash`、`fast`、`standard`、`deep` |
| Metaso | `osp-metaso` | `OSP_METASO_API_KEY` | 否 | 按次搜索计费，不按结果条数计费 |
| Moonshot | `osp-moonshot` | `OSP_MOONSHOT_API_KEY` | 否 | 月之暗面国际站（api.moonshot.ai）；独立搜索接口，成功搜索每次 0.002 美元（失败或空结果不计费）；与国内站为相互独立的账号体系 |
| Moonshot CN | `osp-moonshot-cn` | `OSP_MOONSHOT_CN_API_KEY` | 否 | 月之暗面国内站（api.moonshot.cn）；独立搜索接口，成功搜索每次 0.01 元（失败或空结果不计费）；与国际站为相互独立的账号体系 |
| Ollama | `osp-ollama` | `OSP_OLLAMA_API_KEY` | 否 | 个人档免费；每条结果包含整页 markdown，上下文偏重；上限 10 条，且不带发布日期 |
| Perplexity | `osp-perplexity` | `OSP_PERPLEXITY_API_KEY` | 否 | Search API 直接返回搜索结果，不包含生成的问答正文；按请求计费，每千次 5 美元，使用 `fast` 则为 1 美元 |
| Querit | `osp-querit` | `OSP_QUERIT_API_KEY` | 否 | 摘要缺失时回退至句子级匹配 |
| SerpApi | `osp-serpapi` | `OSP_SERPAPI_API_KEY` | 否 | 经 SerpApi 调用 Google；包含 SerpApi 自带的免费 1 小时服务端缓存 |
| Serper | `osp-serper` | `OSP_SERPER_API_KEY` | 否 | 经 Serper 调用 Google；按查询消耗积分计费 |
| StepFun | `osp-stepfun` | `OSP_STEPFUN_API_KEY` | 否 | 阶跃星辰国内站（api.stepfun.com）；独立搜索接口，每次 0.04 元；四种场景偏好（`programming`、`research`、`gov`、`business`）；不支持时间、域名与分页过滤，且每条结果都附带整页正文 |
| You.com | `osp-youcom` | `OSP_YDC_API_KEY` | 否 | 网页与新闻结果合并；提供多种正文抽取模式 |
| Z.ai | `osp-zai` | `OSP_ZAI_API_KEY` | 否 | 智谱国际站（api.z.ai）；独立搜索接口，按次计费，每次 0.01 美元（Search-Prime）；与国内站为相互独立的账号体系 |
| Zhipu | `osp-zhipu` | `OSP_ZHIPU_API_KEY` | 否 | 智谱国内站（open.bigmodel.cn）；独立搜索接口，不经过模型调用；按次计费，Search-Std 每次 0.01 元起，无免费额度；四款引擎（含搜狗、夸克） |

## 配置

配置项以环境变量形式在启动时加载。如修改了变量，需重启 OpenCode 方可生效。默认值均对齐上游 API 文档推荐。

### 通用配置（所有 Provider）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `<PROVIDER>_CACHE_TTL` | `600000` | 相同归一化查询复用缓存响应的毫秒数（`0` 表示禁用缓存）。命中会刷新条目的最近使用顺序，常用查询不会被先来后到挤出；空结果最多记忆 30 秒，避免上游偶发抖动把重试锁死整个缓存窗口 |
| `<PROVIDER>_TIMEOUT` | `25000` | 单次请求的超时毫秒数（`0` 表示取消超时限制，但保留取消信号） |

### AnySearch

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `ANYSEARCH_MAX_RESULTS` | `10` | 每次搜索的结果数，限制在 API 允许的 1–10 |
| `ANYSEARCH_TAG` | — | 固定意图路由的子领域，例如 `code.doc` |
| `ANYSEARCH_ZONE` | — | 区域分区：`cn` 或 `intl` |
| `ANYSEARCH_LANGUAGE` | — | 首选结果语言，例如 `zh-CN` |
| `ANYSEARCH_FORMAT` | `markdown` | `content` 字段格式：`markdown` 或 `json` |
| `OSP_ANYSEARCH_API_KEY` | — | 可选；未配置时使用免 key 匿名访问 |

### Bocha

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `BOCHA_COUNT` | `10` | 每次搜索的结果数，限制在 1–50（博查上限） |
| `BOCHA_FRESHNESS` | — | 时间筛选：`noLimit`、`oneDay`、`oneWeek`、`oneMonth`、`oneYear`、`YYYY-MM-DD` 或 `YYYY-MM-DD..YYYY-MM-DD`。官方文档建议不设此参数：博查会自行改写时间范围，固定区间可能导致检索结果为空 |
| `BOCHA_SUMMARY` | 关 | `true` 表示用生成的摘要替换 snippet（提供更多上下文，但单次调用成本更高） |

### Brave Search

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `BRAVE_NUM` | `8` | 每次搜索的结果数，限制在 1–20（Brave 上限） |
| `BRAVE_COUNTRY` | — | 两位国家代码，或 `ALL` |
| `BRAVE_LANG` | — | 结果语言代码，例如 `en`、`zh-hans`、`pt-br` |
| `BRAVE_FRESHNESS` | — | 时间筛选：`pd`（24 小时）、`pw`（7 天）、`pm`（31 天）、`py`（365 天）或 `YYYY-MM-DDtoYYYY-MM-DD` |

### DeepSeek

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DEEPSEEK_COUNT` | `10` | 每次搜索的结果数，限制在 1–50（DeepSeek 上限）。按请求计费，增加结果条数不产生额外费用 |

### Jina

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `JINA_NUM` | `0` | 每次搜索的结果数（1–100）。`0` 表示不传递该参数，以保留 Jina 更快且类型更全的结果 |
| `JINA_INCLUDE_CONTENT` | 关 | `true` 表示返回每条结果的整页 markdown，大幅增加上下文与计费 token |
| `JINA_GL` / `JINA_HL` | — | 国家 / 语言代码 |
| `JINA_LOCATION` | — | 模拟的城市级地理位置，例如 `Berlin` |
| `JINA_TIMEOUT` | `25000`（开启 `JINA_INCLUDE_CONTENT` 时为 `60000`） | 请求超时毫秒数；整页抓取模式下使用更长的默认超时时间 |

### Kagi

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `KAGI_NUM` | `8` | 每次搜索的结果数，限制在 1–1024（API 范围） |
| `KAGI_LENS` | — | 应用的 lens：内置 lens 标识（`programming`、`forums`、`pdfs` 等），或从 [kagi.com/settings/lenses](https://kagi.com/settings/lenses) 获取的可分享 lens ID |
| `KAGI_RECENT` | — | 时间筛选：`day`、`week` 或 `month`。以内联 lens 形式发送，因此设置了 `KAGI_LENS` 时被忽略；取值不在枚举内时报错并丢弃，而非发送后换来 400 |
| `KAGI_REGION` | — | ISO 3166-1 alpha-2 区域代码，例如 `us`、`cn` |

搜索走 Kagi v1 API（`POST kagi.com/api/v1/search`，密钥从 [kagi.com/api/keys](https://kagi.com/api/keys) 获取）。按量计费，每千次请求 12 美元，无免费额度、无匿名层级，因此每次请求都按计费处理，重复查询走共享缓存。请求会继承账号自身的设置——在 Kagi 网页端配置的屏蔽/置顶规则与摘要长度对 API 结果同样生效。`workflow` 固定为 `search`（网页结果）；图片、视频与新闻 workflow 返回的是其他结果集合，并非 agent 网页搜索所需。该端点也可在同一次请求内联抓取页面正文，但按 Extract API 单页价格另计费，因此本 Provider 不使用——统一映射 snippet。

### Keenable

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `KEENABLE_MAX_RESULTS` | `10` | 每次搜索的结果数，限制在 1–50 |
| `KEENABLE_MODE` | — | 检索模式：`pro`（深度检索）或 `realtime`（快速检索）；未设置则使用 Keenable 默认值 |
| `KEENABLE_TITLE` | `opencode-search-plugin` | 作为 `X-Keenable-Title` 发送的应用标识，无 key 端点依赖此标识统计调用 |
| `OSP_KEENABLE_API_KEY` | — | 可选；未配置时使用免 key 匿名访问 |

### Linkup

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `LINKUP_DEPTH` | `fast` | 推理深度：`flash`、`fast`、`standard` 或 `deep` |
| `LINKUP_MAX_RESULTS` | `10` | 每次搜索的结果数，限制在 1–100 |

### Metaso

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `METASO_SEARCH_SIZE` | `20` | 每次搜索的结果数，限制在 1–100 |
| `METASO_INCLUDE_RAW_CONTENT` | 关 | `true` 表示返回每条结果的完整原文；搜索费用不变，但会大幅消耗上下文 token |

### Moonshot

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `MOONSHOT_COUNT` | `5` | 每次搜索的结果数，限制在 1–20（API 上限，同时是 API 默认值） |
| `MOONSHOT_INCLUDE_CONTENT` | 关 | `true` 时发送 `include_content`，取每条结果的整页 `text` 正文而非摘要；搜索费用不变，但会大幅消耗上下文 token |

此 Provider 为月之暗面国际站（[platform.kimi.ai](https://platform.kimi.ai)），密钥从 [platform.kimi.ai 控制台](https://platform.kimi.ai/console/api-keys) 获取，搜索端点为 `api.moonshot.ai/v1/tools/search`。每次成功搜索 0.002 美元，且仅当响应包含至少一条结果时计费——失败与空结果不计费，重复查询走共享缓存。无免 key 匿名层级，因此仅在配置了密钥时加入搜索池。

该端点不支持分页、站点与时间过滤：`limit` 的 20 条即单次调用的全部结果，`sites` / `time_window` 属于 Pro 端点（价格高 50%，返回按相关性打分的 `chunks` 而非摘要），本 Provider 刻意不使用。查询词原样发送——规格未定义长度上限，且按原文检索、不改写。

搜索接口按累计充值分档限制 QPS（Tier0 为 1 QPS，最高 50），与聊天接口的限速额度相互独立；返回 429 时错误信息会附带 `X-RateLimit-Reset` 推导出的 `retry in Ns` 提示。

国内站（[platform.kimi.com](https://platform.kimi.com)）为独立账号体系、人民币计费，以独立 Provider 注册，即下表的 Moonshot CN（`osp-moonshot-cn`）。

### Moonshot CN

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `MOONSHOT_CN_COUNT` | `5` | 每次搜索的结果数，限制在 1–20（API 上限，同时是 API 默认值） |
| `MOONSHOT_CN_INCLUDE_CONTENT` | 关 | `true` 时发送 `include_content`，取每条结果的整页 `text` 正文而非摘要；搜索费用不变，但会大幅消耗上下文 token |

此 Provider 为月之暗面国内站（[platform.kimi.com](https://platform.kimi.com)），密钥从 [platform.kimi.com 控制台](https://platform.kimi.com/console/api-keys) 获取，搜索端点为 `api.moonshot.cn/v1/tools/search`。每次成功搜索 0.01 元，且仅当响应包含至少一条结果时计费——失败与空结果不计费，重复查询走共享缓存。请求与映射逻辑与上节国际站完全一致，包括按累计充值分档的搜索 QPS（Tier0 为 1，最高 50）。

国际站（[platform.kimi.ai](https://platform.kimi.ai)）为独立账号体系、美元计费，以独立 Provider 注册，即上表的 Moonshot（`osp-moonshot`）。

### Ollama

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `OLLAMA_MAX_RESULTS` | `5` | 每次搜索的结果数，限制在 1–10（API 上限）。每条结果均包含整页 markdown 正文而非摘要，默认 5 条即可提供丰富的上下文 |

### Perplexity

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PERPLEXITY_MAX_RESULTS` | `10` | 每次搜索的结果数，限制在 1–20（网页搜索上限为 20 条；`search_type=people` 支持至多 50 条） |
| `PERPLEXITY_SEARCH_TYPE` | — | 搜索类型：`web`（API 默认值，每千次 5 美元）、`fast`（每千次 1 美元，延迟更低）或 `people`；未设置则不传递该字段 |
| `PERPLEXITY_RECENCY` | — | 时效筛选：`hour`、`day`、`week`、`month` 或 `year` |
| `PERPLEXITY_COUNTRY` | — | 两位 ISO 3166-1 国家代码，例如 `US` |
| `PERPLEXITY_LANGUAGE` | — | 逗号分隔的 ISO 639-1 语言代码，例如 `en,zh`（至多发送 10 个，按快速上手文档中更严格的限制执行） |

此 Provider 未提供域名或信源过滤配置项：Perplexity API 未设置独立的新闻、Reddit 或学术垂直领域开关，其官方文档推荐在单次查询中通过 `search_domain_filter` 白名单进行过滤，而非作为全局配置项。

### Querit

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `QUERIT_COUNT` | `8` | 每次搜索的结果数 |

### SerpApi

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `SERPAPI_GL` / `SERPAPI_HL` | — | 国家 / 语言代码 |
| `SERPAPI_TBS` | — | 高级筛选参数，例如 `qdr:d`（一天内）、`qdr:y`（一年内） |

此 Provider 未提供结果条数配置项：由于 Google 已废弃 `num` 参数，SerpApi 无法支持自定义返回条数。

### Serper

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `SERPER_NUM` | `10` | 每次搜索的结果数，限制在 1–100 |
| `SERPER_GL` / `SERPER_HL` | — | 国家 / 语言代码 |
| `SERPER_TBS` | — | 时间筛选：`qdr:h`、`qdr:d`、`qdr:w`、`qdr:m`、`qdr:y` |

### StepFun

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `STEPFUN_COUNT` | `10` | 每次搜索的结果数，限制在 1–20（API 上限，同时是 API 默认值） |
| `STEPFUN_CATEGORY` | — | 场景偏好：`programming`、`research`、`gov` 或 `business`。不设置时检索全部场景（API 默认行为）；填写未知值时会输出警告并丢弃，而不是发送出去换来一个 400 |
| `STEPFUN_INCLUDE_CONTENT` | 关 | `true` 时返回每条结果的整页 `content` 正文而非摘要。正文无论如何都会随响应返回——此项只决定是否把它花在上下文 token 上 |
| `STEPFUN_CONTENT_CHARS` | `4000` | 读取正文时保留的码点数（`0` 表示全部保留）。按码点计数，因此不会把 emoji 截成半个 |

阶跃星辰只有国内站提供搜索接口：[platform.stepfun.com](https://platform.stepfun.com/interface-key) 的 `POST api.stepfun.com/v1/search`，每次 0.04 元。国际站没有对应接口（`api.stepfun.ai/v1/search` 返回 404，而其对话接口正常），因此不存在第二个可绑定的 provider——与月之暗面两站并存的情况不同。

该接口只有三个参数：`query`、`n`、`category`。没有分页（`n` 的 20 条即单次调用的全部结果）、没有时间范围、没有域名过滤、也没有安全搜索开关，因此插件刻意不暴露时效或站点筛选——它们在这里没有可映射的落点。`time` 是页面的**索引时间**（阶跃爬虫最后一次看到该页的时间），而非发布时间；由于它是接口唯一的时间字段，映射时作为 `published` 输出。

每条结果都带 `content` 整页正文，且没有参数可以关闭。这正是默认只读摘要的原因：正文无论如何都会在网络上被传输，但不必再被计入上下文 token。`STEPFUN_INCLUDE_CONTENT` 用于开启正文读取，`STEPFUN_CONTENT_CHARS` 负责截断。若某条结果的摘要为空，则回退到截断后的正文——空字符串不是值得交给 agent 的答案。阶跃文档没有「空结果不计费」的承诺（与月之暗面不同），因此按每次调用均计费处理，重复查询由共享缓存承接。文档中也没有搜索专用的配额——适用的是账号按累计充值分档的并发 / RPM 限制。

Chat Completions 的内置 `web_search` 工具是另一种能力——由模型自行判断是否搜索，且搜索结果还会作为 prompt token 再次计费——且 `step-5-preview` 并不支持它。本 Provider 调用的是独立搜索接口，与使用哪个模型无关。

### You.com

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `YOUCOM_COUNT` | `10` | 每个分区（网页、新闻各自）的结果数，限制在 1–100 |
| `YOUCOM_EXTRACTION` | `highlights` | 正文抽取模式：`highlights` 返回解答性段落，`none` 仅返回原始摘要，`full_page` 抓取完整页面并按抓取页数计费 |
| `YOUCOM_LANGUAGE` / `YOUCOM_COUNTRY` | — | 语言 / 国家代码，例如 `EN` / `US` |
| `YOUCOM_FRESHNESS` | — | 时效筛选：`day`、`week`、`month`、`year` 或 `YYYY-MM-DDtoYYYY-MM-DD` |

### Z.ai

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `ZAI_COUNT` | `10` | 每次搜索的结果数，限制在 1–50（API 上限） |
| `ZAI_RECENCY` | — | 时间筛选：`oneDay`、`oneWeek`、`oneMonth`、`oneYear` 或 `noLimit`。不设置时保留 API 的 `noLimit` 默认行为 |

国际站文档仅定义了 `search-prime`（0.01 美元/次）一款引擎，因此该值固定发送，不提供引擎配置项。每次调用均计费——没有免费额度——因此重复查询由共享缓存承接。与国内站不同，国际站文档未对查询长度设上限，查询将原样发送。

Z.ai 是智谱的国际站，拥有独立的账号体系：密钥从 [z.ai](https://z.ai/manage-apikey/apikey-list) 获取，与国内站不通用。将国内站密钥用于此 provider 会返回 HTTP 401，错误信息中会指明这一点。

### Zhipu

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `ZHIPU_COUNT` | `10` | 每次搜索的结果数，限制在 1–50（Zhipu 的上限） |
| `ZHIPU_ENGINE` | `search_std` | 搜索引擎：`search_std`（0.01 元/次）、`search_pro`（0.03 元/次，召回更高）、`search_pro_sogou` / `search_pro_quark`（0.05 元/次） |
| `ZHIPU_RECENCY` | — | 时间筛选：`oneDay`、`oneWeek`、`oneMonth`、`oneYear` 或 `noLimit`。不设置时保留 API 的 `noLimit` 默认行为 |
| `ZHIPU_CONTENT_SIZE` | — | 摘要长度：`medium`（API 默认）或 `high`，在同样按次计费下返回更完整的摘要 |

默认引擎 `search_std` 是价格最低的一档；`search_pro` 价格为其三倍，召回更高；搜狗 / 夸克引擎则以更高单价换取各自的信源池（搜狗覆盖腾讯生态与知乎内容，夸克偏重时效）。每次调用均计费——没有免费额度——因此重复查询由共享缓存承接。请求发出前会截断至 API `search_query` 的 70 字符上限；`count` 在 `search_pro_quark` 引擎上不发送（其文档未列出该字段），在 `search_pro_sogou` 上则取整到 10/20/30/40/50 之一。

此处的 Zhipu 指国内站（[open.bigmodel.cn](https://open.bigmodel.cn)），密钥从 [bigmodel.cn](https://bigmodel.cn/usercenter/proj-mgmt/apikeys) 获取。国际站（api.z.ai）为相互独立的账号体系，以独立 provider 形式注册，即上表的 Z.ai（`osp-zai`）。

## 查询处理流程

1. OpenCode 向当前分配的 provider 发起搜索请求。
2. 归一化后的搜索词（去除首尾空白并合并多余空格）优先匹配内存缓存。命中缓存时直接返回结果，不发起外部 API 请求。
3. 未命中缓存时，重新解析 API key，确保在 `/connect` 中轮换的密钥即时生效。
4. 请求发出时附带超时限制（`<PROVIDER>_TIMEOUT`，默认 25s），防止无响应的上游服务阻塞会话。
5. 返回的数据经过 schema 校验，映射为 `{ url, title, content, time }` 并写入缓存供后续相同查询复用。

时间解析支持相对时间（`3 hours ago`、`3小时前`）、绝对格式（`Sep 30, 2026`、`31 Mar 2026`）和 ISO 8601 时间戳。不完整的日期文本（如缺少年份的 `Nov 1`）会被直接忽略，避免宽容解析器推导出错误的年份。

## 排错

```sh
# 查看插件是否已加载及加载状态
opencode plugin list

# 查看当前搜索池中包含的 provider
# 若某 provider 未出现在列表中，说明其未配置 key，或被 enable/disable 规则排除
# AnySearch 和 Keenable 无需 key，始终处于列表中
opencode api get "/api/websearch/provider"
```

常见排查项：

- **Provider 未出现在搜索池中**：该 provider 未配置 API key，或被 `disable` 排除（或未包含在 `enable` 列表中）。可在 `/connect` 中配置密钥或设置对应环境变量后重启 OpenCode（在 `/connect` 中更新的凭据无需重启即可即时生效）。若已配置但仍未出现，请检查拼写：插件日志会在启动时对无法识别的 ID 以及 `enable` / `disable` 的冲突项输出警告。
- **搜索报错 `Keenable rate limited the request (HTTP 429)`**：免 key 匿名层级限制为单 IP 每小时 1,000 次、每秒 10 次，且与同一出口 IP 的其他用户共享。设置 `OSP_KEENABLE_API_KEY` 可使用独立的专属免费配额。
- **搜索报错 `Ollama API error 401`**：`OSP_OLLAMA_API_KEY` 必须是来自 [ollama.com/settings/keys](https://ollama.com/settings/keys) 的账户 API key。若环境变量中已配置用于 Ollama 兼容代理的 Bearer token，可在 `/connect` 中为 **Ollama Search (osp)** 配置专门的 API key，`/connect` 凭据优先级高于环境变量。
- **搜索报错 `Bocha balance is exhausted (HTTP 403)`**：账户余额已耗尽，可前往 [open.bocha.cn](https://open.bocha.cn) 充值。错误信息包含博查返回的 `message` 文本与 `log_id`，联系客服时可作为凭证。
- **搜索报错 `Bocha rate limited the request (HTTP 429)`**：博查单账户请求上限与累计充值金额相关。若博查返回了 `Retry-After` 响应头，错误信息中会包含 `retry after Ns` 提示。
- **搜索报错 `Zhipu rejected the API key (HTTP 401)`**：key 很可能来自智谱的另一个站点。国内站（[open.bigmodel.cn](https://open.bigmodel.cn)，provider `osp-zhipu`）与国际站（[api.z.ai](https://api.z.ai)，provider `osp-zai`）是相互独立的账号体系，密钥不通用。请使用签发 key 所属站点对应的 provider——bigmodel.cn 的 key 用 `osp-zhipu`，z.ai 的 key 用 `osp-zai`——或前往 [bigmodel.cn](https://bigmodel.cn/usercenter/proj-mgmt/apikeys) 获取国内站密钥。
- **搜索报错 `Zhipu rate limited the request (HTTP 429)`**：智谱按账户限制并发搜索数，对应 API 错误码 1701。若错误信息中附带 `retry after Ns` 提示，等待该时间或减少并发搜索即可恢复。
- **搜索报错 `Moonshot rejected the API key (HTTP 401)`（或 `Moonshot CN rejected...`）**：key 很可能来自月之暗面的另一个站点。国际站（[platform.kimi.ai](https://platform.kimi.ai)，provider `osp-moonshot`）与国内站（[platform.kimi.com](https://platform.kimi.com)，provider `osp-moonshot-cn`）在各自控制台签发密钥。请使用签发 key 所属站点对应的 provider——platform.kimi.ai 的 key 用 `osp-moonshot`，platform.kimi.com 的 key 用 `osp-moonshot-cn`——或前往目标站点的控制台获取密钥。
- **搜索报错 `Moonshot rate limited the search (HTTP 429)`（或 `Moonshot CN rate limited...`）**：搜索接口的 QPS 按账户累计充值分档（Tier0 为 1 QPS，最高 50）。若错误信息附带 `retry in Ns` 提示（来自 `X-RateLimit-Reset` 响应头），等待该时间或减少并发搜索即可恢复。
- **搜索报错 `StepFun rejected the API key (HTTP 401)`**：`OSP_STEPFUN_API_KEY` 必须是 [platform.stepfun.com/interface-key](https://platform.stepfun.com/interface-key) 签发的密钥，且个人账号需先完成实名认证才能付费调用。阶跃国际站不提供搜索接口，因此不存在「密钥来自另一个站点」这种情况。
- **搜索报错 `StepFun balance is insufficient (HTTP 402)`**：账户余额不足，请前往 [platform.stepfun.com](https://platform.stepfun.com) 充值。组织项目密钥会以 `insufficient_credit` 类型报告同一状态。
- **搜索报错 `StepFun refused the search on content review (HTTP 451)`**：查询词或其检索到的页面触发了内容审核。只能改写查询词；这不是密钥或配额问题。
- **StepFun 返回的结果偏短或在句中截断**：正文被截断至 `STEPFUN_CONTENT_CHARS`（默认 4000 码点），截断时以 `…` 结尾。可提高该上限，或关闭 `STEPFUN_INCLUDE_CONTENT` 改为读取摘要。
- **搜索报错 `Kagi API error 401`**：`OSP_KAGI_API_KEY` 必须是来自 [kagi.com/api/keys](https://kagi.com/api/keys) 的 Kagi API key，创建时需绑定支付方式——v1 API 为按量付费、不发放免费额度，未绑定计费的 key 会在此失败。错误信息内嵌 Kagi 的响应体，其中的 `meta.trace` 即向 developers@kagi.com 反馈时需要提供的请求追踪 ID。
- **搜索报错 `Connect X in /connect, or set OSP_X_API_KEY`**：凭据在 provider 注册与实际调用之间失效或丢失。请重新在 `/connect` 中配置或重新导出环境变量。
- **搜索报错 `X search timed out after 25000ms`**：上游服务在超时时限内未完成响应。通常重试即可恢复；若特定 provider 响应较慢，可提高对应的 `<PROVIDER>_TIMEOUT`。此限制是为防止无响应的上游服务导致整个会话永久阻塞（OpenCode 自身不对搜索设置超时限制）。
- **搜索延迟高或配额消耗过快**：建议保留 `*_CACHE_TTL` 的默认值。在缓存窗口内的重复查询将直接由内存提供响应，不产生外部网络请求或费用。
- **修改本地插件文件后未生效**：OpenCode 会监视插件文件并自动重载。若未自动重载，可执行 `opencode service restart` 重启服务。

日志位于 `~/.local/share/opencode/log/opencode.log`；过滤 `loading plugin` 可查看 OpenCode 解析的所有插件及其入口文件。本插件关于 `enable` / `disable` 配置的警告信息同样记录在该文件中，带有 `[opencode-search-plugin]` 前缀。

## 开发

```sh
npm install
npm run check     # 类型检查 + 测试
```

- `npm run typecheck`：对所有插件和测试执行严格的 TypeScript 类型检查。
- `npm test`：运行通用 provider 契约、单 provider 行为、日期解析、聚合注册以及仓库结构守卫测试。

`@opencode/plugin` 和 `effect` 声明为 **devDependencies**，而非 `dependencies`。这两个模块由 OpenCode 在运行时提供，这也是单个 `.ts` 文件可以直接在 `~/.config/opencode/plugins/` 中运行且完全无需 `node_modules` 的原因。若声明为运行时依赖，`opencode plugin add` 将为了 100 KB 的插件源码下载 127 MB 的依赖树（仅 `effect` 就占 47 MB，`@opencode/plugin` 还会引入 `@aws-sdk`、`google-auth-library` 与 `@opentelemetry`）；声明为 devDependencies 则既能满足开发时的类型检查与测试需求，又避免了为最终使用者引入多余依赖。

结构测试用于确保每个插件文件保持独立可复制性：若插件引入了同级模块依赖、共享代码块未保持逐字一致，或 provider ID 定义出现漂移，测试均会失败。详见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

[MIT](LICENSE)

## 友情链接

- [LINUX DO](https://linux.do/) — the new ideal community
