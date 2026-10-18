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
    envKey: "ANYSEARCH_API_KEY",
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
    envKey: "BOCHA_API_KEY",
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
    envKey: "BRAVE_SEARCH_API_KEY",
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
    envKey: "DEEPSEEK_API_KEY",
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
    envKey: "JINA_API_KEY",
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
    envKey: "KEENABLE_API_KEY",
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
    envKey: "LINKUP_API_KEY",
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
    envKey: "METASO_API_KEY",
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
    file: "ollama-search",
    pluginID: "ollama-search",
    providerID: "osp-ollama",
    displayName: "Ollama Search",
    envKey: "OLLAMA_API_KEY",
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
    file: "querit-search",
    pluginID: "querit-search",
    providerID: "osp-querit",
    displayName: "Querit",
    envKey: "QUERIT_API_KEY",
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
    envKey: "SERPAPI_API_KEY",
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
    envKey: "SERPER_API_KEY",
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
    file: "youcom-search",
    pluginID: "youcom-search",
    providerID: "osp-youcom",
    displayName: "You.com",
    envKey: "YDC_API_KEY",
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
]
