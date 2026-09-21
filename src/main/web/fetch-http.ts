// 匿名 HTTP(S) 抓取 provider。
//
// 与 dsh 的 dsh-web-fetch-http 同构，但用 node:http/https（理由见 network.ts 顶部）。
// 默认值对齐 dsh：5MB 响应 / 30s 超时 / 5 跳同源重定向 / 显式产品 UA。
//
// 分层（这是本文件的关键结构）：
//   · network.ts  —— 公网判定与连接钉死（纯逻辑，可单测）
//   · html.ts     —— HTML→文本（纯函数，可单测）
//   · 本文件       —— 传输：重定向策略、字节/字符上限、charset、Content-Type 分类
//
// 非 2xx 是**结果而不是错误**（与 dsh 一致）：状态码是被抓取资源状态的一部分，
// 模型需要看到 404 才能判断「这个页面不在了」。WebError 只用于
// 「无法安全获取或表示这个资源」。

import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { extractPageText } from "./html";
import { createPinnedLookup, type ResolvedAddress, resolvePublicAddresses } from "./network";
import {
  WebError,
  type WebFetchProviderImpl,
  type WebFetchRequest,
  type WebFetchResult,
} from "./types";

/** URL 长度上限（固定，不可配置 —— 与 dsh 一致） */
export const MAX_URL_LENGTH = 2048;
/** 响应体字节上限 */
export const MAX_RESPONSE_BYTES = 5_000_000;
/** 同源重定向最大跳数 */
export const MAX_REDIRECTS = 5;
/** 单次抓取的总超时（毫秒） */
export const DEFAULT_TIMEOUT_MS = 30_000;
/** 参与正文提取的字符上限（上限之内的正文再由工具层按 maxChars 收口） */
const BODY_CHAR_CAP = 2_000_000;

/**
 * 显式产品 UA。
 *
 * 刻意**不伪装浏览器**（dsh 同款口径）：抓取方应当可被站点识别与归因，
 * 伪装成 Chrome 会让站点无法区分「一个 agent 在读文档」与「一个真人在浏览」。
 * 代价是少数站点会直接拒绝非浏览器 UA —— 那时错误里会带上状态码，用户能看懂。
 */
export const USER_AGENT = "oint/0.1 (+https://github.com/qgming/oint)";

const ACCEPT_HEADER =
  "text/html,application/xhtml+xml,text/plain;q=0.9,application/json;q=0.8,application/xml;q=0.7";

export interface HttpFetchOptions {
  timeoutMs?: number;
  /** 注入点：单测里替换成不发真实请求的实现 */
  resolveAddresses?: typeof resolvePublicAddresses;
  /** 注入点：单测里替换掉真实的 https.request */
  requestOnce?: RequestOnce;
}

/** 一次请求的结果：响应 + 关闭函数（连接池清理） */
export interface RequestOnceResult {
  response: IncomingMessage;
  close: () => void;
}

export type RequestOnce = (
  url: URL,
  addresses: ResolvedAddress[],
  headers: Record<string, string>,
  signal: AbortSignal,
) => Promise<RequestOnceResult>;

/** 解析并校验 URL：只接受 http/https、无内嵌凭据、长度受限 */
export function validateFetchUrl(input: string): URL {
  const trimmed = input.trim();
  if (trimmed === "") {
    throw new WebError("URL 不能为空。", "WEB_INVALID_URL");
  }
  if (trimmed.length > MAX_URL_LENGTH) {
    throw new WebError(`URL 超过 ${MAX_URL_LENGTH} 字符上限。`, "WEB_INVALID_URL");
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch (error) {
    throw new WebError(`不是合法的 URL：${trimmed}`, "WEB_INVALID_URL", { cause: error });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new WebError(
      `不支持的协议「${url.protocol}」——只允许 http 与 https。`,
      "WEB_INVALID_URL",
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new WebError("URL 里不允许内嵌凭据。", "WEB_BLOCKED_URL");
  }
  return url;
}

/** 同源判定：协议 + 主机名 + 端口三者都相同 */
export function isSameOrigin(a: URL, b: URL): boolean {
  return a.protocol === b.protocol && a.hostname === b.hostname && a.port === b.port;
}

/** Content-Type → 正文类型；不支持时 undefined */
export function classifyContentType(raw: string | undefined): "html" | "text" | undefined {
  const mime = (raw ?? "").replace(/;.*$/s, "").trim().toLowerCase();
  if (mime === "text/html" || mime === "application/xhtml+xml") return "html";
  if (mime.startsWith("text/")) return "text";
  if (mime === "application/json" || mime === "application/xml") return "text";
  if (mime.endsWith("+json") || mime.endsWith("+xml")) return "text";
  return undefined;
}

/** 从 Content-Type 里取 charset（只认头部声明，不看 <meta charset>） */
export function parseCharset(raw: string | undefined): string | undefined {
  const matched = /;\s*charset\s*=\s*"?([^";]+)"?/i.exec(raw ?? "");
  return matched?.[1]?.trim().toLowerCase();
}

/**
 * 构造解码器。
 *
 * 声明了但无法识别的 charset 时**抛错而不是回退 UTF-8** ——
 * 宁可响亮失败也不要返回乱码（dsh 同款口径）。
 */
function decoderForCharset(charset: string | undefined): TextDecoder {
  if (charset === undefined) return new TextDecoder("utf-8");
  try {
    return new TextDecoder(charset);
  } catch (error) {
    throw new WebError(`不支持的字符集「${charset}」。`, "WEB_UNSUPPORTED_CONTENT_TYPE", {
      cause: error,
    });
  }
}

/** 重定向状态码 */
function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/**
 * 默认的请求实现：用**已验证地址**作为 lookup，连接钉死。
 *
 * 每次请求建自己的 agent/dispatcher 效果：地址集合是这次请求专属的，
 * 不复用到其它请求（复用会让「这一次的校验」泄漏给下一次）。
 * node:http/https 的 `lookup` 选项天然是每请求的，所以这里不需要额外处理。
 */
const defaultRequestOnce: RequestOnce = (url, addresses, headers, signal) =>
  new Promise<RequestOnceResult>((resolve, reject) => {
    const isHttps = url.protocol === "https:";
    const requestFn = isHttps ? httpsRequest : httpRequest;
    const request = requestFn(
      url,
      {
        method: "GET",
        headers,
        signal,
        // 钉死：只回已验证的地址，不做第二次解析
        lookup: createPinnedLookup(addresses) as never,
      },
      (response) => {
        resolve({
          response,
          close: () => {
            request.destroy();
          },
        });
      },
    );
    request.on("error", (error) => {
      reject(normalizeFetchError(error, signal, "连接失败"));
    });
    request.end();
  });

/**
 * 判断信号是因为**超时**还是**调用方取消**而中止。
 *
 * 两者都会让 `signal.aborted === true`，必须靠 `signal.reason` 区分：
 * `AbortSignal.timeout()` 的 reason 是 name 为 "TimeoutError" 的 DOMException，
 * 而 `controller.abort()` 的 reason 由调用方给（通常不是 TimeoutError）。
 * 分不清的后果是把超时报成「已取消」——用户看到「取消了」但自己根本没取消，
 * 只能去猜是不是网络问题。
 */
function isTimeoutAbort(signal: AbortSignal): boolean {
  return signal.reason instanceof Error && signal.reason.name === "TimeoutError";
}

/**
 * 把任意错误归一成带码的 WebError。
 *
 * 两条不变式：
 *   1. **消息永不为空** —— `error.message` 可以是空串（Node 的某些网络错误就是），
 *      直接拼进模板会得到「抓取失败：」这种没有信息量的文案；
 *   2. 超时与取消分开报码。
 */
function normalizeFetchError(error: unknown, signal: AbortSignal, fallback: string): WebError {
  if (error instanceof WebError) return error;
  if (signal.aborted) {
    return isTimeoutAbort(signal)
      ? new WebError("抓取超时。", "WEB_FETCH_TIMEOUT", { cause: error })
      : new WebError("抓取已取消。", "WEB_ABORTED", { cause: error });
  }
  const described =
    (error instanceof Error ? error.message : String(error)).trim() ||
    (error instanceof Error ? error.name : "") ||
    fallback;
  return new WebError(`抓取失败：${described}`, "WEB_PROVIDER_ERROR", { cause: error });
}

/** 读取响应体，按字节上限截断 */
async function readCapped(
  response: IncomingMessage,
  maxBytes: number,
): Promise<{ bytes: Buffer; truncatedByBytes: boolean }> {
  // Content-Length 声明超限：立即拒绝（与「流式超限」处理不同，见下）
  const declared = Number(response.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maxBytes) {
    response.destroy();
    throw new WebError(
      `响应体超过 ${maxBytes} 字节上限（声明 ${declared} 字节）。`,
      "WEB_FETCH_TOO_LARGE",
    );
  }

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let truncatedByBytes = false;

    response.on("data", (chunk: Buffer) => {
      if (truncatedByBytes) return;
      const remaining = maxBytes - total;
      if (chunk.length > remaining) {
        chunks.push(chunk.subarray(0, remaining));
        total += remaining;
        // 流式超限：**截断而不是拒绝** —— 服务器少报 Content-Length 时
        // 仍给出有界可用的主体（与 dsh 一致）
        truncatedByBytes = true;
        response.destroy();
        resolve({ bytes: Buffer.concat(chunks), truncatedByBytes });
        return;
      }
      chunks.push(chunk);
      total += chunk.length;
    });
    response.on("end", () => {
      resolve({ bytes: Buffer.concat(chunks), truncatedByBytes });
    });
    response.on("error", (error) => {
      reject(
        new WebError(`读取响应失败：${error.message}`, "WEB_PROVIDER_ERROR", { cause: error }),
      );
    });
  });
}

/** 读响应并解码成正文 */
async function readBody(response: IncomingMessage): Promise<{
  statusCode: number;
  kind: "html" | "text";
  text: string;
  truncated: boolean;
  title?: string;
}> {
  const contentType = response.headers["content-type"];
  const kind = classifyContentType(contentType);
  if (kind === undefined) {
    response.destroy();
    throw new WebError(
      `不支持的内容类型「${contentType ?? "未声明"}」——只能读取 HTML 与文本。`,
      "WEB_UNSUPPORTED_CONTENT_TYPE",
    );
  }
  const decoder = decoderForCharset(parseCharset(contentType));

  const { bytes, truncatedByBytes } = await readCapped(response, MAX_RESPONSE_BYTES);
  const decoded = decoder.decode(bytes);
  // 解码后可能超出字符上限（多字节编码），再收一次
  const overChars = decoded.length > BODY_CHAR_CAP;
  const body = overChars ? decoded.slice(0, BODY_CHAR_CAP) : decoded;

  if (kind === "text") {
    return {
      statusCode: response.statusCode ?? 0,
      kind,
      text: body,
      truncated: truncatedByBytes || overChars,
    };
  }

  // HTML：交给 html.ts 提正文；它自己也有上限与守卫
  const page = extractPageText(body, BODY_CHAR_CAP);
  return {
    statusCode: response.statusCode ?? 0,
    kind,
    text: page.content,
    truncated: truncatedByBytes || overChars || page.truncated,
    ...(page.title === "" ? {} : { title: page.title }),
  };
}

/**
 * 抓取一个 URL。
 *
 * 流程（每一步都有对应测试）：
 *   1. 校验 URL（协议、凭据、长度）；
 *   2. 解析并校验公网地址（任一非公网即拒绝）；
 *   3. 用钉死的 lookup 发请求；
 *   4. 3xx → 只跟随**同源**重定向，每一跳都回到第 2 步；
 *   5. 非 3xx → 按 Content-Type 分类、有界读取、解码。
 */
export function createHttpFetchProvider(options: HttpFetchOptions = {}): WebFetchProviderImpl {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const resolveAddresses = options.resolveAddresses ?? resolvePublicAddresses;
  const requestOnce = options.requestOnce ?? defaultRequestOnce;

  return {
    async fetch(request: WebFetchRequest): Promise<WebFetchResult> {
      const externalSignal = request.signal;
      if (externalSignal?.aborted === true) {
        throw new WebError("抓取已取消。", "WEB_ABORTED", { cause: externalSignal.reason });
      }

      // 总超时：一个信号管住所有跳，避免 5 跳各 30s = 150s
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const signal =
        externalSignal === undefined
          ? timeoutSignal
          : AbortSignal.any([externalSignal, timeoutSignal]);

      let currentUrl = validateFetchUrl(request.url);
      let redirects = 0;

      for (;;) {
        // 每一跳都重新解析与校验地址（同源重定向也要 —— 地址可能变）
        const addresses = await raceTimeout(resolveAddresses(currentUrl.hostname, signal), signal);

        const { response, close } = await requestOnce(
          currentUrl,
          addresses,
          {
            "user-agent": USER_AGENT,
            accept: ACCEPT_HEADER,
            "accept-language": "en, zh-CN;q=0.8",
          },
          signal,
        ).catch((error: unknown) => {
          throw normalizeFetchError(error, signal, "请求发送失败");
        });

        const status = response.statusCode ?? 0;

        if (!isRedirectStatus(status)) {
          try {
            const body = await readBody(response);
            // 最终 URL：重定向之后的地址（非 2xx 也返回，状态码在 body 里）
            return {
              url: currentUrl.toString(),
              statusCode: body.statusCode,
              content: body.text,
              truncated: body.truncated,
              ...(body.title === undefined ? {} : { title: body.title }),
            };
          } finally {
            close();
          }
        }

        // --- 重定向 ---
        try {
          if (redirects >= MAX_REDIRECTS) {
            response.destroy();
            throw new WebError(`重定向超过 ${MAX_REDIRECTS} 跳上限。`, "WEB_REDIRECT_BLOCKED");
          }
          const location = response.headers.location;
          if (location === undefined || location === "") {
            response.destroy();
            throw new WebError(
              `重定向响应（HTTP ${status}）没有 Location 头。`,
              "WEB_PROVIDER_ERROR",
            );
          }

          let target: URL;
          try {
            target = new URL(location, currentUrl);
          } catch (error) {
            response.destroy();
            throw new WebError(`非法的重定向 Location「${location}」。`, "WEB_PROVIDER_ERROR", {
              cause: error,
            });
          }
          const validated = validateFetchUrl(target.toString());
          if (!isSameOrigin(validated, currentUrl)) {
            response.destroy();
            /**
             * 跨源重定向**拒绝**并要求重新发起调用。
             *
             * 理由：新的源需要一次全新的公网地址验证，而「跟随重定向」这个动作
             * 是服务端发起的、模型看不见的 —— 让模型显式再调一次，
             * 用户与日志里都能看到「它去了哪里」。
             */
            throw new WebError(
              `跨源重定向到 ${validated.origin} 不会被自动跟随（当前在 ${currentUrl.origin}）。`,
              "WEB_REDIRECT_BLOCKED",
            );
          }

          response.destroy();
          currentUrl = validated;
          redirects += 1;
        } finally {
          close();
        }
      }
    },
  };
}

/** 给一个 Promise 套上超时信号（DNS 解析这类不可取消的操作要能中止等待） */
function raceTimeout<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(
      isTimeoutAbort(signal)
        ? new WebError("抓取超时。", "WEB_FETCH_TIMEOUT", { cause: signal.reason })
        : new WebError("抓取已取消。", "WEB_ABORTED", { cause: signal.reason }),
    );
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(
        isTimeoutAbort(signal)
          ? new WebError("抓取超时。", "WEB_FETCH_TIMEOUT", { cause: signal.reason })
          : new WebError("抓取已取消。", "WEB_ABORTED", { cause: signal.reason }),
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}
