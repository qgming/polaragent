// WebService：provider 选择 + 结果上限 + 错误归一。
//
// 为什么要有这一层而不是在工具里直接 switch provider：
//   1. **选择规则只有一份**（配置的 id → 可用性检查 → 明确的错误）；
//   2. **结果上限在服务层强制**：超量返回的 provider 不可能泄漏超出调用方要求的来源；
//   3. 工具层因此完全不知道 provider 是谁 —— 工具名、schema、结果格式不会被
//      「哪个 provider 在跑」影响。这是 dsh 分层最核心的收益
//      （见 docs/web-tools-research.md §1.4）。
//
// 与 dsh 的差异：dsh 有「未配置 id 且多个可用 provider → 报歧义」这一档。
// Oint 的设置里 provider 是**必选单值**（默认 searxng），不存在「未配置」状态，
// 所以那一档不会发生 —— 少一个分支、少一种错误，行为更好预测。

import type { WebSearchProvider, WebSearchSettings } from "@/shared/contracts/web";
import {
  type WebConfigResolver,
  WebError,
  type WebFetchProviderImpl,
  type WebFetchRequest,
  type WebFetchResult,
  type WebSearchProviderImpl,
  type WebSearchRequest,
  type WebSearchResult,
  type WebService,
} from "./types";

export interface CreateWebServiceOptions {
  resolve: WebConfigResolver;
  /**
   * 每个 provider 的实现。做成参数而不是在这里 import 具体实现：
   * 单测可以只提供 1–2 个假的，不必拖进 node:https 与设置存储。
   */
  searchProviders: Record<WebSearchProvider, WebSearchProviderImpl>;
  fetchProvider: WebFetchProviderImpl;
}

/** 所有 provider 都要实现的公共部分：把上限与取消语义收在一处 */
export function createWebService(options: CreateWebServiceOptions): WebService {
  return {
    /**
     * 抓取正文上限：每次现取设置，于是面板里改完立即生效。
     *
     * 这个访问器存在的唯一理由是**让设置真的有人消费** ——
     * 工具层只依赖 WebService 接口、拿不到 Settings，
     * 若没有它，`fetchMaxOutputChars` 就只是一个「存下来、显示出来、从不生效」的字段。
     *
     * 返回 Promise 以对齐 WebService 的契约（装配层要先刷新快照再读）；
     * 基础实现本身是同步的（它直接读 resolve thunk）。
     */
    async fetchOutputLimit(): Promise<number> {
      return options.resolve().fetchMaxOutputChars;
    },

    async search(request: WebSearchRequest): Promise<WebSearchResult> {
      const settings = options.resolve();
      const provider = resolveSearchProvider(options.searchProviders, settings);
      /**
       * 上限的归属在服务层：
       * - 调用方没传 → 用设置里的 maxResults；
       * - 调用方传了 → 取**两者较小值**（模型可以往小里收紧，但不能放大）。
       *
       * 这样「部署方控制成本」与「模型按需少取几条」各管各的，互不越权。
       */
      const cap = Math.min(request.maxResults ?? settings.maxResults, settings.maxResults);
      const result = await provider.search({ ...request, maxResults: cap });
      // provider 超量返回时截断并标记（与 dsh 的 capSources 同款：上限由 seam 拥有）
      if (result.sources.length <= cap) return { ...result, provider: provider.id };
      return {
        ...result,
        provider: provider.id,
        sources: result.sources.slice(0, cap),
        truncated: true,
      };
    },

    fetch(request: WebFetchRequest): Promise<WebFetchResult> {
      return options.fetchProvider.fetch(request);
    },
  };
}

/**
 * provider 选择。
 *
 * 规则（与 dsh 逐条对齐）：
 *   · 总开关关闭 → WEB_DISABLED
 *   · 当前 provider 不可用 → WEB_PROVIDER_CREDENTIAL_MISSING（带「去设置里填」的指引）
 *   · 否则用它
 *
 * 注意 `available()` 是**廉价局部检查**，不是可用性探测 —— 所以这里不发网络请求，
 * 选择因此是快且确定的。
 */
export function resolveSearchProvider(
  providers: Record<WebSearchProvider, WebSearchProviderImpl>,
  settings: WebSearchSettings,
): WebSearchProviderImpl {
  if (!settings.enabled) {
    throw new WebError("网络搜索已在设置中关闭。", "WEB_DISABLED");
  }
  const provider = providers[settings.provider];
  if (!provider.available()) {
    throw new WebError(
      `${settings.provider} 尚未配置完成（缺少 API Key）。` +
        "请在「设置 → 网络搜索」中填写，或切换到免 Key 的 SearXNG。",
      "WEB_PROVIDER_CREDENTIAL_MISSING",
    );
  }
  return provider;
}

export interface CreateDefaultWebServiceOptions {
  resolve: WebConfigResolver;
  /**
   * 真实实现。
   *
   * 做成参数而不是在这里 import：provider 与抓取后端会拉起 node:http(s)，
   * 而单测关心的是选择规则与上限，不该付这份加载成本。
   * 生产环境的装配点见 main/web/index.ts 的 createProductionWebService。
   */
  searchProviders: Record<WebSearchProvider, WebSearchProviderImpl>;
  fetchProvider: WebFetchProviderImpl;
}

/**
 * 装配入口：把五个 provider 与抓取后端合成一个 WebService。
 *
 * 存在的意义是**把「装配」与「使用」分开**：runtime 只依赖 WebService 接口，
 * 而具体有哪几个 provider、抓取后端怎么配，只有这里知道。
 */
export function createDefaultWebService(options: CreateDefaultWebServiceOptions): WebService {
  return createWebService({
    resolve: options.resolve,
    searchProviders: options.searchProviders,
    fetchProvider: options.fetchProvider,
  });
}
