// Tavily / Exa / Serper / Brave 四个 provider。
//
// 它们的结构高度一致（发一次请求 → 从一个数组字段映射结果），所以放在一个文件里，
// 用一张「规格表」描述差异 —— 分成四个文件会有四份几乎相同的样板，
// 而它们真正的差异只有：端点、方法、认证方式、结果数组的路径、字段名。
//
// 错误提取统一走 http.ts 的 extractProviderError：实测四家的错误形状都不一样
// （Tavily 在 detail.error 里、Serper 用 message、Exa 用 error），
// 只写 data.error 会丢掉 Tavily 的真实原因。

import type { WebSearchProvider, WebSearchSettings, WebSource } from "@/shared/contracts/web";
import {
  asString,
  type HttpJsonFn,
  type HttpJsonRequest,
  httpJson,
  httpStatusError,
  toProviderError,
} from "../http";
import type {
  WebProviderSearchRequest,
  WebProviderSearchResult,
  WebSearchProviderImpl,
} from "../types";
import { WebError } from "../types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** 从嵌套路径取数组（如 Brave 的 web.results） */
function arrayAt(payload: unknown, path: readonly string[]): unknown[] {
  let current: unknown = payload;
  for (const key of path) {
    if (!isRecord(current)) return [];
    current = current[key];
  }
  return Array.isArray(current) ? current : [];
}

/** 各家的结果字段名归一：不同 provider 用 content / snippet / text / description */
function toSource(item: unknown, extra?: (item: Record<string, unknown>) => Partial<WebSource>) {
  if (!isRecord(item)) return undefined;
  const url = asString(item.url) ?? asString(item.link);
  if (url === undefined) return undefined;
  const title = asString(item.title);
  const snippet =
    asString(item.content) ??
    asString(item.snippet) ??
    asString(item.text) ??
    asString(item.description);
  return {
    url,
    ...(title === undefined ? {} : { title }),
    ...(snippet === undefined ? {} : { snippet }),
    ...extra?.(item),
  } satisfies WebSource;
}

/** 一个 provider 的静态规格 */
interface ProviderSpec {
  id: WebSearchProvider;
  label: string;
  /** 端点（固定域名） */
  endpoint: string;
  method: "GET" | "POST";
  /** 是否要求 API Key（决定 available() 与错误文案） */
  needsKey: boolean;
  /**
   * 构造请求。
   *
   * 返回 `undefined` 表示配置不完整（例如缺 Key）——
   * 但 available() 已经挡过一道，所以这里只作兜底。
   */
  build: (
    request: WebProviderSearchRequest,
    config: WebSearchSettings[WebSearchProvider],
  ) => HttpJsonRequest | undefined;
  /** 结果数组的路径 */
  resultPath: readonly string[];
  /** 对整份响应做额外解析（Tavily 的 answer） */
  extractAnswer?: (payload: unknown) => string | undefined;
}

const SPECS: readonly ProviderSpec[] = [
  {
    id: "tavily",
    label: "Tavily",
    endpoint: "https://api.tavily.com/search",
    method: "POST",
    needsKey: true,
    build: (request, config) => {
      const apiKey = config.apiKey.trim();
      if (apiKey === "") return undefined;
      return {
        url: "https://api.tavily.com/search",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          api_key: apiKey,
          query: request.query,
          search_depth: config.searchDepth ?? "basic",
          max_results: request.maxResults,
          ...(config.includeAnswer === true ? { include_answer: true } : {}),
        }),
      };
    },
    resultPath: ["results"],
    extractAnswer: (payload) => {
      if (!isRecord(payload)) return undefined;
      // include_answer 未开启时 Tavily 回 false（布尔），asString 会把它收成 undefined
      return asString(payload.answer);
    },
  },
  {
    id: "exa",
    label: "Exa",
    endpoint: "https://api.exa.ai/search",
    method: "POST",
    needsKey: true,
    build: (request, config) => {
      const apiKey = config.apiKey.trim();
      if (apiKey === "") return undefined;
      return {
        url: "https://api.exa.ai/search",
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": apiKey },
        body: JSON.stringify({
          query: request.query,
          num_results: request.maxResults,
          type: config.type ?? "neural",
          // 取正文摘录：Exa 的 snippet 常常为空，text 才有内容
          contents: { text: { maxCharacters: 1000 } },
        }),
      };
    },
    resultPath: ["results"],
  },
  {
    id: "serper",
    label: "Serper",
    endpoint: "https://google.serper.dev/search",
    method: "POST",
    needsKey: true,
    build: (request, config) => {
      const apiKey = config.apiKey.trim();
      if (apiKey === "") return undefined;
      return {
        url: "https://google.serper.dev/search",
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": apiKey },
        body: JSON.stringify({
          q: request.query,
          num: request.maxResults,
          ...(config.gl === undefined ? {} : { gl: config.gl }),
          ...(config.hl === undefined ? {} : { hl: config.hl }),
        }),
      };
    },
    resultPath: ["organic"],
  },
  {
    id: "brave",
    label: "Brave",
    endpoint: "https://api.search.brave.com/res/v1/web/search",
    method: "GET",
    needsKey: true,
    build: (request, config) => {
      const apiKey = config.apiKey.trim();
      if (apiKey === "") return undefined;
      const url = new URL("https://api.search.brave.com/res/v1/web/search");
      url.searchParams.set("q", request.query);
      url.searchParams.set("count", String(request.maxResults));
      if (config.country !== undefined) url.searchParams.set("country", config.country);
      if (config.searchLang !== undefined) {
        url.searchParams.set("search_lang", config.searchLang);
      }
      return {
        url: url.toString(),
        method: "GET",
        headers: { accept: "application/json", "x-subscription-token": apiKey },
      };
    },
    resultPath: ["web", "results"],
  },
];

export interface SearchProviderOptions {
  http?: HttpJsonFn;
  resolve?: () => WebSearchSettings;
}

/**
 * 按规格构造一个 provider。
 *
 * `available()` 只做**廉价局部检查**（Key 在不在），不发网络请求 ——
 * 把它做成真实探测会让每次工具调用先付一次往返，
 * 而工具可见性又必须与后端可用性解耦（见 web-tools-research.md §1.5）。
 */
function createFromSpec(spec: ProviderSpec, options: SearchProviderOptions): WebSearchProviderImpl {
  const http = options.http ?? httpJson;
  return {
    id: spec.id,
    available: () => {
      if (!spec.needsKey) return true;
      const config = options.resolve?.()[spec.id];
      return (config?.apiKey.trim() ?? "") !== "";
    },

    async search(request: WebProviderSearchRequest): Promise<WebProviderSearchResult> {
      const config = options.resolve?.()[spec.id];
      if (config === undefined) {
        throw new WebError(`${spec.label} 未配置。`, "WEB_PROVIDER_CREDENTIAL_MISSING");
      }
      const httpRequest = spec.build(request, config);
      if (httpRequest === undefined) {
        throw new WebError(
          `${spec.label} 尚未配置 API Key。请在「设置 → 网络搜索」中填写。`,
          "WEB_PROVIDER_CREDENTIAL_MISSING",
        );
      }

      let response: Awaited<ReturnType<HttpJsonFn>>;
      try {
        response = await http(httpRequest);
      } catch (error) {
        throw toProviderError(spec.label, error);
      }

      if (response.status < 200 || response.status >= 300) {
        throw httpStatusError(spec.label, response.status, response.json);
      }

      const sources: WebSource[] = [];
      const seen = new Set<string>();
      for (const item of arrayAt(response.json, spec.resultPath)) {
        const source = toSource(item);
        if (source === undefined || seen.has(source.url)) continue;
        seen.add(source.url);
        sources.push(source);
      }

      const answer = spec.extractAnswer?.(response.json);
      return {
        sources,
        truncated: sources.length > request.maxResults,
        ...(answer === undefined ? {} : { answer }),
      };
    },
  };
}

/** 按 id 索引，避免调用方依赖 SPECS 的数组顺序 */
const SPECS_BY_ID = new Map<WebSearchProvider, ProviderSpec>(SPECS.map((spec) => [spec.id, spec]));

function specFor(id: WebSearchProvider): ProviderSpec {
  const spec = SPECS_BY_ID.get(id);
  if (spec === undefined) throw new Error(`缺少 ${id} 的 provider 规格`);
  return spec;
}

/** 构造除 SearXNG 外的四个 provider（SearXNG 单独一个文件：实例逻辑更复杂） */
export function createApiProviders(
  options: SearchProviderOptions = {},
): Record<Exclude<WebSearchProvider, "searxng">, WebSearchProviderImpl> {
  return {
    tavily: createFromSpec(specFor("tavily"), options),
    exa: createFromSpec(specFor("exa"), options),
    serper: createFromSpec(specFor("serper"), options),
    brave: createFromSpec(specFor("brave"), options),
  };
}
