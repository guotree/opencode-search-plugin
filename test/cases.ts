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
