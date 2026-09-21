// 搜索 provider 共用的 HTTP 与解析工具。
//
// 与抓取后端（fetch-http.ts）的区别：这里的请求目标是**固定的、由我们配置的**域名，
// 不是模型指定的 URL，所以不需要 SSRF 防护（公网判定 + 连接钉死）。
// 需要的是：超时、JSON 解析、以及一套**统一的错误提取**（见 extractProviderError）。

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { WebError } from "./types";

/** 搜索请求的默认超时：比抓取短 —— 搜索是交互式动作，慢就等于不可用 */
export const SEARCH_TIMEOUT_MS = 15_000;
/** 响应体上限：搜索结果 JSON 不该有 MB 级 */
const MAX_RESPONSE_BYTES = 4_000_000;

/** 产品 UA（与抓取后端同一口径：可归因，不伪装浏览器） */
export const SEARCH_USER_AGENT = "oint/0.1 (+https://github.com/qgming/oint)";

export interface HttpJsonResponse {
  status: number;
  /** 解析后的 JSON；响应不是 JSON 时为 undefined（SearXNG 未开 JSON 时会回 HTML） */
  json?: unknown;
  /** 原始文本（解析失败时用于诊断，已截断） */
  text: string;
}

export interface HttpJsonRequest {
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** 注入点：单测替换成不发真实请求的实现 */
export type HttpJsonFn = (request: HttpJsonRequest) => Promise<HttpJsonResponse>;

/**
 * 发一次 HTTP(S) 请求并把响应体当 JSON 解析。
 *
 * 用 node:http/https 而不是 Electron 的 net.request：这些是固定的第三方 API 调用，
 * 想要的是一个「普通的 HTTPS JSON 请求」，不希望掺入 session 的代理/凭据配置
 * （那是 ipc/services.ts 拉模型列表时的诉求，场景不同）。
 */
export const httpJson: HttpJsonFn = (options) => {
  return new Promise<HttpJsonResponse>((resolve, reject) => {
    const url = new URL(options.url);
    const isHttps = url.protocol === "https:";
    const requestFn = isHttps ? httpsRequest : httpRequest;
    const timeoutMs = options.timeoutMs ?? SEARCH_TIMEOUT_MS;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const onExternalAbort = () => controller.abort();
    options.signal?.addEventListener("abort", onExternalAbort, { once: true });

    const cleanup = () => {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onExternalAbort);
    };

    const request = requestFn(
      url,
      {
        method: options.method ?? "GET",
        headers: {
          "user-agent": SEARCH_USER_AGENT,
          accept: "application/json",
          ...options.headers,
        },
        signal: controller.signal,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let total = 0;
        response.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > MAX_RESPONSE_BYTES) {
            response.destroy();
            cleanup();
            reject(new WebError("搜索响应超过大小上限。", "WEB_PROVIDER_ERROR"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          cleanup();
          const text = Buffer.concat(chunks).toString("utf8");
          let json: unknown;
          try {
            json = JSON.parse(text);
          } catch {
            // 保留 undefined：调用方据此给出「不是 JSON」这类精确诊断
          }
          resolve({ status: response.statusCode ?? 0, json, text });
        });
        response.on("error", (error) => {
          cleanup();
          reject(new WebError(`读取搜索响应失败：${describe(error)}`, "WEB_PROVIDER_ERROR"));
        });
      },
    );

    request.on("error", (error) => {
      cleanup();
      reject(normalizeHttpError(error, controller.signal, timeoutMs));
    });

    if (options.body !== undefined) request.write(options.body);
    request.end();
  });
};

/** 错误描述：message 可能为空串，"抓取失败：" 这种没有信息量的文案要避免 */
function describe(error: unknown): string {
  if (error instanceof Error) {
    return error.message.trim() || error.name || "未知错误";
  }
  return String(error);
}

function normalizeHttpError(error: unknown, signal: AbortSignal, timeoutMs: number): WebError {
  if (error instanceof WebError) return error;
  if (signal.aborted) {
    // 分不清超时与取消会把超时报成「已取消」——用户会去猜是不是网络问题
    return new WebError(`搜索请求超时（${timeoutMs}ms）。`, "WEB_FETCH_TIMEOUT", { cause: error });
  }
  return new WebError(`搜索请求失败：${describe(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** 取字符串字段；非字符串或空串返回 undefined */
export function asString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * 从各家 API 的错误响应里取出人可读的原因。
 *
 * **必须按嵌套层级逐个探测**：实测四家的形状都不一样，
 * 而参考实现（dreamagent）只写了 `data.error || data.message`，于是 Tavily 的
 * 401（`{detail:{error:"Unauthorized: missing or invalid API key."}}`）
 * 两个字段都是 undefined，用户看到的是「未知错误」——
 * 真实原因（Key 填错了）就在手边却拿不到。这类缺陷不会崩、不会报错，
 * 只会让用户在一个明确的问题上反复摸索。
 *
 * 实测形状（2026-09-21，无 Key 直接打端点）：
 *   · Tavily → { detail: { error: "Unauthorized: …" } }
 *   · Exa    → { error: "Payment required…", tag: "X402_PAYMENT_REQUIRED" }
 *   · Serper → { message: "Unauthorized. Sign up…", statusCode: 403 }
 *   · Brave  → { error: { detail: "…" } }（文档形状）
 */
export function extractProviderError(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  const detail = payload.detail;
  const error = payload.error;
  const candidates: unknown[] = [
    payload.error,
    payload.message,
    payload.detail,
    isRecord(detail) ? detail.error : undefined,
    isRecord(detail) ? detail.message : undefined,
    isRecord(error) ? error.detail : undefined,
    isRecord(error) ? error.message : undefined,
  ];
  for (const candidate of candidates) {
    const text = asString(candidate);
    if (text !== undefined) return text;
  }
  return undefined;
}

/**
 * 把「非 2xx」统一转成带状态码的错误。
 *
 * 401/402/403 的区分很重要：402 表示「Key 有效但额度不足」，
 * 与「Key 无效」是两件该做不同处理的事 —— 设置面板据此提示（见 WebPanel）。
 */
export function httpStatusError(provider: string, status: number, payload: unknown): WebError {
  const reason = extractProviderError(payload);
  const suffix = reason === undefined ? "" : `：${reason}`;
  const hint =
    status === 401 || status === 403
      ? "（API Key 无效或未授权）"
      : status === 402
        ? "（API Key 有效，但账户额度不足）"
        : status === 429
          ? "（请求过于频繁）"
          : "";
  return new WebError(`${provider} 返回 HTTP ${status}${hint}${suffix}`, "WEB_PROVIDER_ERROR");
}

/** 把任意抛出的错误归一成 WebError（provider 内部统一出口） */
export function toProviderError(provider: string, error: unknown): WebError {
  if (error instanceof WebError) return error;
  return new WebError(
    `${provider} 搜索失败：${error instanceof Error ? error.message.trim() || error.name : String(error)}`,
    "WEB_PROVIDER_ERROR",
    { cause: error },
  );
}
