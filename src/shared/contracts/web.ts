// 网络搜索 / 网页抓取的共享契约。
//
// 与 settings.ts 的分工：本文件定义「web 能力长什么样」（provider 类型、结果形状、
// 工具名常量），settings.ts 只持有 `webSearch: WebSearchSettings` 这一个字段。
// 工具名常量的地位与 BROWSER_TOOL_NAMES 相同：权限层、UI 图标表、测试都按它登记，
// 避免三处各写一份字面量（见 browser.ts 的同款注释）。

/** 支持的搜索后端。'searxng' 是唯一的免 Key 选项，也是默认值。 */
export const WEB_SEARCH_PROVIDERS = ["searxng", "tavily", "exa", "serper", "brave"] as const;
export type WebSearchProvider = (typeof WEB_SEARCH_PROVIDERS)[number];

/**
 * 每个 provider 的配置。
 *
 * 为什么用一个宽结构而不是判别联合：这些字段是**逐 provider 可选**的，
 * 而设置面板要按 provider 切表单；判别联合会让「读取当前 provider 的配置」变成
 * 每次都要 narrow。
 */
export interface WebSearchProviderConfig {
  /**
   * API Key（searxng 不用）。
   *
   * ⚠️ 落盘时必须走 settings/store.ts 的 encodeApiKey，与 services[].apiKey 同一套 ——
   * 不要像 mcpServers 的 env/headers 那样明文落盘（那是已知待修问题）。
   */
  apiKey: string;
  /** tavily：检索深度 */
  searchDepth?: "basic" | "advanced";
  /** tavily：是否要求返回 AI 摘要 */
  includeAnswer?: boolean;
  /** exa：检索类型 */
  type?: "neural" | "keyword";
  /** serper：地区代码 */
  gl?: string;
  /** serper：语言代码 */
  hl?: string;
  /** searxng：自定义实例清单（换行或逗号分隔）；留空则用内置默认清单 */
  instances?: string;
  /** brave：国家代码 */
  country?: string;
  /** brave：搜索语言 */
  searchLang?: string;
}

export interface WebSearchSettings {
  /**
   * 总开关。关掉后两个工具都**不装配**，系统提示也不提。
   *
   * 这里用 enabled + provider 两个字段而不是三档枚举 —— 与本仓库既有的 settings 形态
   * 一致。若将来需要「只搜索不抓取」，再加 `fetchEnabled: boolean`，
   * 不要现在就把 enabled 提前做成枚举（枚举会多出「off 之外的档位怎么写」的问题）。
   */
  enabled: boolean;
  /** 当前选中的 provider */
  provider: WebSearchProvider;
  searxng: WebSearchProviderConfig;
  tavily: WebSearchProviderConfig;
  exa: WebSearchProviderConfig;
  serper: WebSearchProviderConfig;
  brave: WebSearchProviderConfig;
  /** 一次 web_search 返回的来源条数上限。与 dsh 一致：这是**配置上限，不是模型参数**。 */
  maxResults: number;
  /** web_fetch 的输出字符上限（头部 + 正文 + 尾注的总和） */
  fetchMaxOutputChars: number;
  /** web_fetch 的超时（毫秒）。是资源兜底，不是模型参数。 */
  fetchTimeoutMs: number;
}

/**
 * 工具名常量：权限层、UI 图标表与测试共用。
 *
 * 与 BROWSER_TOOL_NAMES 同构 —— 加工具时只改这里，权限名单与图标表跟着走。
 */
export const WEB_TOOL_NAMES = {
  search: "web_search",
  fetch: "web_fetch",
} as const;

/** 只读工具名单：进 permissions.ts 的 LOW_RISK_TOOLS（与 BROWSER_READ_ONLY_TOOL_NAMES 同构） */
export const WEB_READ_ONLY_TOOL_NAMES = [WEB_TOOL_NAMES.search, WEB_TOOL_NAMES.fetch] as const;

/** 一条搜索来源 */
export interface WebSource {
  url: string;
  title?: string;
  snippet?: string;
  publishedAt?: string;
}

/** web_search 的 details（渲染层按它画卡片；主进程与渲染层必须同一个形状） */
export interface WebSearchDetails {
  provider: string;
  /** searxng 实际命中的实例 */
  instance?: string;
  sources: WebSource[];
  truncated: boolean;
  answer?: string;
  /**
   * 有搜索引擎无响应时的提示（SearXNG 的 unresponsive_engines）。
   *
   * 它不是错误 —— 聚合搜索里部分引擎失败是常态 —— 但当结果很少时，
   * 给模型一句「部分搜索引擎无响应」比让它以为「网上就只有这些」要好。
   */
  unresponsive?: number;
}

/** web_fetch 的 details */
export interface WebFetchDetails {
  url: string;
  statusCode: number;
  title?: string;
  truncated: boolean;
}

/**
 * 错误码：与 dsh 的 WebError 词汇对齐，渲染层与模型都按 code 路由。
 *
 * 用开放字符串联合而不是 enum：新增 provider 时可能带来新的失败分类，
 * 而消费方（工具层的 describeWebError、面板的错误分级）都带 default 分支。
 */
export type WebErrorCode =
  | "WEB_DISABLED"
  | "WEB_INVALID_URL"
  | "WEB_BLOCKED_URL"
  | "WEB_UNSUPPORTED_CONTENT_TYPE"
  | "WEB_FETCH_TOO_LARGE"
  | "WEB_FETCH_TIMEOUT"
  | "WEB_REDIRECT_BLOCKED"
  | "WEB_PROVIDER_UNAVAILABLE"
  | "WEB_PROVIDER_CREDENTIAL_MISSING"
  | "WEB_PROVIDER_ERROR"
  | "WEB_ABORTED";

/** 默认值：设置面板的初始态与 store 的兜底共用一份 */
export const DEFAULT_WEB_SEARCH_SETTINGS: WebSearchSettings = {
  enabled: true,
  provider: "searxng",
  searxng: { apiKey: "", instances: "" },
  tavily: { apiKey: "", searchDepth: "basic", includeAnswer: false },
  exa: { apiKey: "", type: "neural" },
  serper: { apiKey: "", gl: "cn", hl: "zh-cn" },
  brave: { apiKey: "" },
  maxResults: 8,
  fetchMaxOutputChars: 200_000,
  fetchTimeoutMs: 30_000,
};

/**
 * 内置 SearXNG 实例清单。
 *
 * **放在共享契约里而不是 main/web/**：设置面板要显示它（「留空则用这些」），
 * 而渲染层不能 import `src/main/**`（主进程模块依赖 Node/Electron 运行时）。
 * 与 BROWSER_TOOL_NAMES 同一种处理：双端都要用的常量住在 shared。
 *
 * 为什么只有 5 个：公共实例的 `format=json` 是**实例所有者自行开关**的，
 * 绝大多数默认关闭 —— 表现为返回 HTML 页面而不是 JSON。
 * 清单越长，「挑一个」的失败率越高，而失败形态是「有时能搜、有时转圈很久才失败」。
 *
 * 选入标准（三者同时满足，实测方法与淘汰记录见 scripts/probe-searxng.mts）：
 *   1. 实测 format=json 可用且**连打 3 次都稳定返回结果**；
 *   2. **结果相关** —— 只看条数会放进「有结果但内容完全无关」的实例；
 *   3. **运营方分散** —— thejot.org 有 3 个子域都可用，但只取其一：
 *      同一运营方下的多个实例是同一处故障域，全列进来只是虚假的冗余。
 *
 * ⚠️ 这份清单会腐烂。发版前跑 `node scripts/probe-searxng.mjs` 重新筛选。
 */
export const DEFAULT_SEARXNG_INSTANCES: readonly string[] = [
  "https://search.thejot.org",
  "https://search.corrently.cloud",
  "https://search.hirad.it",
  "https://search.chgr.cc",
  "https://search.skyday.eu",
];

/**
 * provider 的展示信息：设置面板、错误文案与工具描述共用，避免多处各写一份。
 *
 * `keyUrl` 只在 needsKey 时有意义 —— 设置面板据此渲染一个「获取地址」链接。
 */
export const WEB_SEARCH_PROVIDER_META: Record<
  WebSearchProvider,
  {
    label: string;
    /** 是否需要 API Key */
    needsKey: boolean;
    /** 申请 Key 的地址 */
    keyUrl?: string;
    /** 设置面板上的一句话说明 */
    hint: string;
  }
> = {
  searxng: {
    label: "SearXNG",
    needsKey: false,
    hint: "免 Key，元搜索引擎；需要实例开启 JSON 输出",
  },
  tavily: {
    label: "Tavily",
    needsKey: true,
    keyUrl: "https://tavily.com",
    hint: "为 AI 优化的搜索 API，可选返回答案摘要",
  },
  exa: {
    label: "Exa",
    needsKey: true,
    keyUrl: "https://exa.ai",
    hint: "神经 / 关键词检索，偏技术内容",
  },
  serper: {
    label: "Serper",
    needsKey: true,
    keyUrl: "https://serper.dev",
    hint: "Google 搜索结果，可指定语言与地区",
  },
  brave: {
    label: "Brave",
    needsKey: true,
    keyUrl: "https://brave.com/search/api/",
    hint: "独立索引，隐私友好",
  },
};

/** 设置面板的「测试连接」请求：用草稿配置验证，与是否已保存无关 */
export interface WebTestRequest {
  provider: WebSearchProvider;
  config: WebSearchProviderConfig;
}

export type WebTestResult =
  | { ok: true; provider: WebSearchProvider; count: number; sample?: string }
  | { ok: false; code: WebErrorCode | "WEB_TEST_FAILED"; reason: string };
