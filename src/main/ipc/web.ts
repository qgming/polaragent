// 网络搜索的探测通道。
//
// 只做一件事：用**给定的**（可能还没保存的）配置做一次真实检索，把结果或错误回给面板。
//
// 为什么需要「给定配置」而不是读已保存的：用户在面板里填了 Key，要先验证再保存 ——
// 若只读已保存值，就得先存一次坏的配置才能测。
//
// 刻意**不提供**「列出 provider」之类的通道：provider 集合是编译期常量，
// 走 shared/contracts/web.ts 的 WEB_SEARCH_PROVIDERS 即可，不需要 IPC。

import { ipcMain } from "electron";
import { createApiProviders } from "@/main/web/search/providers";
import { createSearxngProvider } from "@/main/web/search/searxng";
import { isWebError } from "@/main/web/types";
import { IPC } from "@/shared/contracts/ipc";
import type {
  WebSearchProviderConfig,
  WebTestRequest,
  WebTestResult,
} from "@/shared/contracts/web";
import { DEFAULT_WEB_SEARCH_SETTINGS, WEB_SEARCH_PROVIDERS } from "@/shared/contracts/web";

/** 探测用的查询：一条几乎必然有结果的通用查询 */
const PROBE_QUERY = "test";

/** 探测用的条数：只要知道「通不通」，不需要 8 条 */
const PROBE_LIMIT = 3;

/**
 * 用草稿配置发一次真实检索。
 *
 * provider 用**临时构造的**（不动全局设置）：`resolve` 直接回传面板给的那份配置，
 * 于是「测试连接」与「是否已保存」完全解耦。
 */
async function testProvider(request: WebTestRequest): Promise<WebTestResult> {
  const provider = request.provider;
  if (!WEB_SEARCH_PROVIDERS.includes(provider)) {
    return { ok: false, code: "WEB_TEST_FAILED", reason: `未知的搜索服务：${provider}` };
  }

  // 只替换被测试的那个 provider，其余保持默认（它们不会被访问到）
  const settings = {
    ...DEFAULT_WEB_SEARCH_SETTINGS,
    provider,
    [provider]: request.config,
  } as typeof DEFAULT_WEB_SEARCH_SETTINGS;
  const resolve = () => settings;

  const impl =
    provider === "searxng"
      ? createSearxngProvider({ resolve })
      : createApiProviders({ resolve })[provider];

  try {
    const result = await impl.search({ query: PROBE_QUERY, maxResults: PROBE_LIMIT });
    const sample = result.sources[0]?.title ?? result.sources[0]?.url;
    return {
      ok: true,
      provider,
      count: result.sources.length,
      ...(sample === undefined ? {} : { sample }),
    };
  } catch (error) {
    // 带码的错误按码回报：面板据此区分 401/402/403（见 WebPanel 的错误分级）
    if (isWebError(error)) {
      return { ok: false, code: error.code, reason: error.message };
    }
    return {
      ok: false,
      code: "WEB_TEST_FAILED",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * 校验面板传来的请求形状。
 *
 * 渲染层可能传来任意东西（它自己也拼不出合法形状以外的，但 IPC 边界要自己守住）——
 * 与 ipc/permissions.ts 的 assertWritableRule 同款口径。
 */
function parseTestRequest(raw: unknown): WebTestRequest | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  const provider = record.provider;
  if (typeof provider !== "string" || !WEB_SEARCH_PROVIDERS.includes(provider as never)) {
    return undefined;
  }
  const config = record.config;
  if (typeof config !== "object" || config === null) return undefined;
  const fields = config as Record<string, unknown>;
  return {
    provider: provider as WebTestRequest["provider"],
    config: {
      // apiKey 必填（可为空串）；其余字段按类型过滤，非法值直接丢弃
      apiKey: typeof fields.apiKey === "string" ? fields.apiKey : "",
      ...(typeof fields.instances === "string" ? { instances: fields.instances } : {}),
      ...(fields.searchDepth === "basic" || fields.searchDepth === "advanced"
        ? { searchDepth: fields.searchDepth }
        : {}),
      ...(typeof fields.includeAnswer === "boolean" ? { includeAnswer: fields.includeAnswer } : {}),
      ...(fields.type === "neural" || fields.type === "keyword" ? { type: fields.type } : {}),
      ...(typeof fields.gl === "string" ? { gl: fields.gl } : {}),
      ...(typeof fields.hl === "string" ? { hl: fields.hl } : {}),
      ...(typeof fields.country === "string" ? { country: fields.country } : {}),
      ...(typeof fields.searchLang === "string" ? { searchLang: fields.searchLang } : {}),
    } satisfies WebSearchProviderConfig,
  };
}

export function registerWebIpc(): void {
  ipcMain.handle(IPC.web.test, async (_event, raw: unknown): Promise<WebTestResult> => {
    const request = parseTestRequest(raw);
    if (request === undefined) {
      return { ok: false, code: "WEB_TEST_FAILED", reason: "请求参数不合法" };
    }
    return testProvider(request);
  });
}

/** 供单测复用：不发 IPC，直接测逻辑与参数校验 */
export const __testing = { testProvider, parseTestRequest };
