// 主进程内部的 web 能力契约。
//
// 刻意与 shared/contracts/web.ts 分开：
//   · 那边是**双端共享**的形状（设置、details、错误码、工具名常量）——
//     不能含函数，因为它要跨 IPC；
//   · 这边是**只在主进程存在**的 provider 接口（含函数）。

import type {
  WebErrorCode,
  WebSearchProvider,
  WebSearchSettings,
  WebSource,
} from "@/shared/contracts/web";

/**
 * 带码的错误：所有 provider 抛出的都是它。
 *
 * code 决定「下一步怎么办」，message 是给人/模型看的原因 ——
 * 工具层（pisdk/tools/web.ts 的 describeWebError）按 code 转成模型可读文案，
 * 设置面板按 code 分级提示（401/402/403 的区分见该文件）。
 */
export class WebError extends Error {
  readonly code: WebErrorCode;

  constructor(message: string, code: WebErrorCode, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "WebError";
    this.code = code;
  }
}

/** 把任意错误识别成 WebError（provider 内部统一抛它） */
export function isWebError(error: unknown): error is WebError {
  return error instanceof WebError;
}

export interface WebSearchRequest {
  query: string;
  /**
   * 调用方要求的结果上限。
   *
   * **缺省表示「用设置里的 maxResults」** —— 上限的归属在服务层，
   * 模型只能往小里收紧（它不该能自己决定一次取多少条来放大成本）。
   */
  maxResults?: number;
  signal?: AbortSignal;
}

/**
 * 传给 provider 的请求：`maxResults` **已由服务层定好**（必填）。
 *
 * 与 WebSearchRequest 分开是为了让「上限由谁决定」在类型上就明确：
 * provider 拿到的一定是具体数字，不需要自己兜底、也不该再改它。
 */
export interface WebProviderSearchRequest extends WebSearchRequest {
  maxResults: number;
}

/**
 * provider 自己返回的结果：**不含 provider 字段** —— 那是服务层的职责。
 *
 * 分开定义而不是让 provider 自己填 id：provider 填自己的 id 是一份必然正确的冗余，
 * 而漏填会让 details 里的 provider 变成 undefined（渲染层按它显示徽标）。
 * 由服务层统一盖章，就不存在「provider 忘了填」这种状态。
 */
export type WebProviderSearchResult = Omit<WebSearchResult, "provider">;

export interface WebSearchResult {
  /** 实际执行这次检索的 provider id（**服务层填**；工具层用它填 details） */
  provider: WebSearchProvider;
  /** provider 给出的答案/摘要（Tavily 的 answer、SearXNG 的 answers） */
  answer?: string;
  sources: WebSource[];
  /** searxng 实际命中的实例，供 details 记录 */
  instance?: string;
  truncated: boolean;
  /**
   * 有搜索引擎无响应时的条数（SearXNG 的 unresponsive_engines）。
   *
   * 它不是错误 —— 聚合搜索里部分引擎失败是常态 —— 但值得让模型知道，
   * 否则结果少时它会以为「网上就只有这些」。
   */
  unresponsive?: number;
}

export interface WebFetchRequest {
  url: string;
  signal?: AbortSignal;
}

export interface WebFetchResult {
  /** 重定向之后的最终 URL */
  url: string;
  statusCode: number;
  title?: string;
  /** 已渲染为文本（HTML 已去掉标签）或原样文本 */
  content: string;
  truncated: boolean;
}

export interface WebSearchProviderImpl {
  id: WebSearchProvider;
  /**
   * 廉价的可用性检查：只看本地配置，**绝不发网络请求**。
   *
   * 做成真实探测会让每次工具调用都先付一次网络往返，
   * 而工具可见性又必须与后端可用性解耦（见 docs/web-tools-research.md §1.5）。
   */
  available(): boolean;
  search(request: WebProviderSearchRequest): Promise<WebProviderSearchResult>;
}

export interface WebFetchProviderImpl {
  fetch(request: WebFetchRequest): Promise<WebFetchResult>;
}

export interface WebService {
  search(request: WebSearchRequest): Promise<WebSearchResult>;
  fetch(request: WebFetchRequest): Promise<WebFetchResult>;
  /**
   * 抓取正文的字符上限（来自设置 `fetchMaxOutputChars`）。
   *
   * 为什么由 service 暴露而不是工具层自己读设置：工具层只依赖 WebService 接口
   * （见 tools/web.ts 顶部注释），它拿不到 Settings。而 service 本来就持有
   * resolve thunk，读这个值是零成本的 —— 于是「设置里改上限」真的会生效，
   * 而不是一个只出现在界面上、没有任何消费者的死字段。
   *
   * **返回 Promise**：实现要先刷新设置快照才能给出当下的值。
   * 做成同步的话，第一次调用只能回落到默认值、之后又读到上一次的陈旧快照
   * （这个坑实测踩过：上限设 600 却输出 136KB，改成 3000 又输出 600）。
   */
  fetchOutputLimit(): Promise<number>;
}

/** 每次调用现取配置：改设置立即生效，不需要重建 service（与 dsh 的 resolve thunk 同款） */
export type WebConfigResolver = () => WebSearchSettings;
