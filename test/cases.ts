import type { ProviderCase } from "./harness"

/**
 * One representative hit per provider, chosen so the mapping under test is the
 * field each API is actually documented to return. The expectations are what
 * OpenCode's agent sees as `url` / `title` / `content`.
 *
 * No fixture carries a date: date parsing is shared byte-for-byte across the
 * providers that emit one (asserted in structure.test.ts) and exercised
 * end-to-end through Brave in brave-search.test.ts.
 */
export const PROVIDER_CASES: readonly ProviderCase[] = [
  {
    file: "anysearch-search",
    pluginID: "anysearch-search",
    providerID: "osp-anysearch",
    displayName: "AnySearch",
    envKey: "OSP_ANYSEARCH_API_KEY",
    response: {
      code: 0,
      data: {
        results: [
          {
            title: "AnySearch hit",
            url: "https://example.com/anysearch",
            snippet: "AnySearch snippet",
          },
        ],
      },
    },
    expected: [
      {
        url: "https://example.com/anysearch",
        title: "AnySearch hit",
        content: "AnySearch snippet",
      },
    ],
  },
  {
    file: "bocha-search",
    pluginID: "bocha-search",
    providerID: "osp-bocha",
    displayName: "Bocha Search",
    envKey: "OSP_BOCHA_API_KEY",
    // The real envelope, including the `code`/`log_id`/`msg` that ride along
    // and the page fields this provider does not map. A null `dateLastCrawled`
    // is the shape Bocha's own example response uses for a page with no date:
    // it must decode to no `time`, not to a failure.
    response: {
      code: 200,
      log_id: "d71841ad20095f61",
      msg: null,
      data: {
        _type: "SearchResponse",
        queryContext: { originalQuery: "a query" },
        webPages: {
          webSearchUrl: "",
          totalEstimatedMatches: 8912791,
          value: [
            {
              id: null,
              name: "Bocha hit",
              url: "https://example.com/bocha",
              displayUrl: "https://example.com/bocha",
              snippet: "Bocha snippet",
              siteName: "example.com",
              siteIcon: "https://example.com/favicon.ico",
              dateLastCrawled: null,
              cachedPageUrl: null,
              language: null,
              isFamilyFriendly: null,
              isNavigational: null,
            },
          ],
          someResultsRemoved: true,
        },
        images: { value: [] },
        videos: null,
      },
    },
    expected: [
      { url: "https://example.com/bocha", title: "Bocha hit", content: "Bocha snippet" },
    ],
  },
  {
    file: "brave-search",
    pluginID: "brave-search",
    providerID: "osp-brave",
    displayName: "Brave Search",
    envKey: "OSP_BRAVE_API_KEY",
    response: {
      web: {
        results: [
          {
            title: "Brave hit",
            url: "https://example.com/brave",
            description: "Brave description",
          },
        ],
      },
    },
    expected: [
      {
        url: "https://example.com/brave",
        title: "Brave hit",
        content: "Brave description",
      },
    ],
  },
  {
    file: "deepseek-search",
    pluginID: "deepseek-search",
    providerID: "osp-deepseek",
    displayName: "DeepSeek",
    envKey: "OSP_DEEPSEEK_API_KEY",
    response: {
      results: [
        {
          title: "DeepSeek hit",
          url: "https://example.com/deepseek",
          summary: "DeepSeek summary",
        },
      ],
    },
    expected: [
      { url: "https://example.com/deepseek", title: "DeepSeek hit", content: "DeepSeek summary" },
    ],
  },
  {
    file: "jina-search",
    pluginID: "jina-search",
    providerID: "osp-jina",
    displayName: "Jina",
    envKey: "OSP_JINA_API_KEY",
    response: {
      data: [
        { title: "Jina hit", url: "https://example.com/jina", description: "Jina description" },
      ],
    },
    expected: [
      { url: "https://example.com/jina", title: "Jina hit", content: "Jina description" },
    ],
  },
  {
    file: "keenable-search",
    pluginID: "keenable-search",
    providerID: "osp-keenable",
    displayName: "Keenable",
    envKey: "OSP_KEENABLE_API_KEY",
    response: {
      query: "a query",
      mode: "pro",
      results: [
        {
          title: "Keenable hit",
          url: "https://example.com/keenable",
          description: "Keenable description",
          snippet: "Keenable snippet",
        },
      ],
    },
    expected: [
      {
        url: "https://example.com/keenable",
        title: "Keenable hit",
        content: "Keenable snippet",
      },
    ],
  },
  {
    file: "linkup-search",
    pluginID: "linkup-search",
    providerID: "osp-linkup",
    displayName: "Linkup",
    envKey: "OSP_LINKUP_API_KEY",
    response: {
      results: [
        {
          name: "Linkup hit",
          url: "https://example.com/linkup",
          content: "Linkup content",
        },
      ],
    },
    expected: [
      { url: "https://example.com/linkup", title: "Linkup hit", content: "Linkup content" },
    ],
  },
  {
    file: "metaso-search",
    pluginID: "metaso-search",
    providerID: "osp-metaso",
    displayName: "Metaso Search",
    envKey: "OSP_METASO_API_KEY",
    response: {
      webpages: [
        {
          title: "Metaso hit",
          link: "https://example.com/metaso",
          snippet: "Metaso snippet",
        },
      ],
    },
    expected: [
      { url: "https://example.com/metaso", title: "Metaso hit", content: "Metaso snippet" },
    ],
  },
  {
    file: "moonshot-cn-search",
    pluginID: "moonshot-cn-search",
    providerID: "osp-moonshot-cn",
    displayName: "Moonshot CN Search",
    envKey: "OSP_MOONSHOT_CN_API_KEY",
    // The real envelope, straight from the API reference: `authority`,
    // `icon`, `mime` and `site_name` ride along unread, and `text` reads as
    // "" without include_content, leaving the snippet as the content. No
    // `date` either: date parsing is shared byte-for-byte and exercised
    // end-to-end through Brave.
    response: {
      search_results: [
        {
          authority: "S",
          date: "",
          icon: "https://example.com/favicon.ico",
          mime: "text/html",
          site_name: "Example Site",
          snippet: "Moonshot CN snippet",
          text: "",
          title: "Moonshot CN hit",
          url: "https://example.com/moonshot-cn",
        },
      ],
    },
    expected: [
      {
        url: "https://example.com/moonshot-cn",
        title: "Moonshot CN hit",
        content: "Moonshot CN snippet",
      },
    ],
  },
  {
    file: "moonshot-search",
    pluginID: "moonshot-search",
    providerID: "osp-moonshot",
    displayName: "Moonshot Search",
    envKey: "OSP_MOONSHOT_API_KEY",
    // The real envelope, straight from the API reference: `authority`,
    // `icon`, `mime` and `site_name` ride along unread, and `text` reads as
    // "" without include_content, leaving the snippet as the content. No
    // `date` either: date parsing is shared byte-for-byte and exercised
    // end-to-end through Brave.
    response: {
      search_results: [
        {
          authority: "S",
          date: "",
          icon: "https://example.com/favicon.ico",
          mime: "text/html",
          site_name: "Example Site",
          snippet: "Moonshot snippet",
          text: "",
          title: "Moonshot hit",
          url: "https://example.com/moonshot",
        },
      ],
    },
    expected: [
      {
        url: "https://example.com/moonshot",
        title: "Moonshot hit",
        content: "Moonshot snippet",
      },
    ],
  },
  {
    file: "ollama-search",
    pluginID: "ollama-search",
    providerID: "osp-ollama",
    displayName: "Ollama Search",
    envKey: "OSP_OLLAMA_API_KEY",
    // The hosted API's flat envelope: results only, no dates, no wrapper.
    response: {
      results: [
        {
          title: "Ollama hit",
          url: "https://example.com/ollama",
          content: "Ollama content",
        },
      ],
    },
    expected: [
      { url: "https://example.com/ollama", title: "Ollama hit", content: "Ollama content" },
    ],
  },
  {
    file: "perplexity-search",
    pluginID: "perplexity-search",
    providerID: "osp-perplexity",
    displayName: "Perplexity",
    envKey: "OSP_PERPLEXITY_API_KEY",
    // The real envelope: `id` is required by the spec and `server_time` shows
    // up null in the quickstart's own examples. Neither is read, so both must
    // decode as passengers rather than as unknown keys that fail the schema.
    // `date`/`last_updated` stay out of the fixture -- date parsing is shared
    // and exercised end-to-end through Brave, as it is for every other provider.
    response: {
      results: [
        {
          title: "Perplexity hit",
          url: "https://example.com/perplexity",
          snippet: "Perplexity snippet",
        },
      ],
      id: "e38104d5-6bd7-4d82-bc4e-0a21179d1f77",
      server_time: null,
    },
    expected: [
      {
        url: "https://example.com/perplexity",
        title: "Perplexity hit",
        content: "Perplexity snippet",
      },
    ],
  },
  {
    file: "querit-search",
    pluginID: "querit-search",
    providerID: "osp-querit",
    displayName: "Querit",
    envKey: "OSP_QUERIT_API_KEY",
    response: {
      error_code: 200,
      results: {
        result: [
          {
            url: "https://example.com/querit",
            title: "Querit hit",
            snippet: "Querit snippet",
          },
        ],
      },
    },
    expected: [
      { url: "https://example.com/querit", title: "Querit hit", content: "Querit snippet" },
    ],
  },
  {
    file: "serpapi-search",
    pluginID: "serpapi-search",
    providerID: "osp-serpapi",
    displayName: "SerpApi",
    envKey: "OSP_SERPAPI_API_KEY",
    response: {
      organic_results: [
        {
          title: "SerpApi hit",
          link: "https://example.com/serpapi",
          snippet: "SerpApi snippet",
        },
      ],
    },
    expected: [
      { url: "https://example.com/serpapi", title: "SerpApi hit", content: "SerpApi snippet" },
    ],
  },
  {
    file: "serper-search",
    pluginID: "serper-search",
    providerID: "osp-serper",
    displayName: "Serper",
    envKey: "OSP_SERPER_API_KEY",
    response: {
      organic: [
        { title: "Serper hit", link: "https://example.com/serper", snippet: "Serper snippet" },
      ],
    },
    expected: [
      { url: "https://example.com/serper", title: "Serper hit", content: "Serper snippet" },
    ],
  },
  {
    file: "stepfun-search",
    pluginID: "stepfun-search",
    providerID: "osp-stepfun",
    displayName: "StepFun Search",
    envKey: "OSP_STEPFUN_API_KEY",
    // The real envelope, straight from the API reference: `query` and
    // `category` echo the request and `position` is the 1-based rank, none of
    // which is read. The fixture carries no `time`: date parsing is shared
    // byte-for-byte and exercised end-to-end through Brave. `content` is the
    // full page body, and it is present in every response -- the mapping reads
    // the snippet unless STEPFUN_INCLUDE_CONTENT asks otherwise.
    response: {
      query: "a query",
      category: "",
      results: [
        {
          url: "https://example.com/stepfun",
          position: 1,
          title: "StepFun hit",
          snippet: "StepFun snippet",
          content: "StepFun full page body",
        },
      ],
    },
    expected: [
      {
        url: "https://example.com/stepfun",
        title: "StepFun hit",
        content: "StepFun snippet",
      },
    ],
  },
  {
    file: "youcom-search",
    pluginID: "youcom-search",
    providerID: "osp-youcom",
    displayName: "You.com",
    envKey: "OSP_YDC_API_KEY",
    response: {
      results: {
        web: [
          {
            url: "https://example.com/youcom",
            title: "You.com hit",
            description: "You.com description",
          },
        ],
      },
    },
    expected: [
      {
        url: "https://example.com/youcom",
        title: "You.com hit",
        content: "You.com description",
      },
    ],
  },
  {
    file: "zai-search",
    pluginID: "zai-search",
    providerID: "osp-zai",
    displayName: "Z.ai Search",
    envKey: "OSP_ZAI_API_KEY",
    // The real envelope, straight from the international site's guide: same
    // hit shape as cn, with `id`/`created`/`request_id` riding along unread.
    // No `search_intent` -- the intl spec does not define it. No
    // `publish_date` either: date parsing is shared byte-for-byte and
    // exercised end-to-end through Brave.
    response: {
      created: 1748261757,
      id: "20250526201557dda85ca6801b467b",
      request_id: "20250526201557dda85ca6801b467b",
      search_result: [
        {
          title: "Z.ai hit",
          content: "Z.ai snippet",
          link: "https://example.com/zai",
          media: "Example Site",
          icon: "https://example.com/favicon.ico",
          refer: "ref_1",
        },
      ],
    },
    expected: [
      { url: "https://example.com/zai", title: "Z.ai hit", content: "Z.ai snippet" },
    ],
  },
  {
    file: "zhipu-search",
    pluginID: "zhipu-search",
    providerID: "osp-zhipu",
    displayName: "Zhipu Search",
    envKey: "OSP_ZHIPU_API_KEY",
    // The real envelope, straight from the API reference: `id`/`created`/
    // `request_id` ride along unread, `search_intent` echoes the rewrite the
    // intent recogniser produced, and `media`/`icon`/`refer` sit on the hit
    // next to the three fields mapped below. No `publish_date` -- date parsing
    // is shared byte-for-byte and exercised end-to-end through Brave.
    response: {
      created: 1748261757,
      id: "20250526201557dda85ca6801b467b",
      request_id: "20250526201557dda85ca6801b467b",
      search_intent: [
        { intent: "SEARCH_ALL", keywords: "财经 新闻", query: "搜索财经新闻" },
      ],
      search_result: [
        {
          title: "Zhipu hit",
          content: "Zhipu snippet",
          link: "https://example.com/zhipu",
          media: "示例网站",
          icon: "https://example.com/favicon.ico",
          refer: "ref_1",
        },
      ],
    },
    expected: [
      { url: "https://example.com/zhipu", title: "Zhipu hit", content: "Zhipu snippet" },
    ],
  },
]
