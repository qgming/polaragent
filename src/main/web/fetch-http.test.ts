// 抓取后端单测。
//
// **全部离线**：DNS 解析与 HTTP 请求都通过注入点替换成假的，
// 所以这个文件既不发真实请求，也不会因为网络环境而 flaky。
// 真实网络只由 scripts/probe-web.mjs 覆盖。

import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  classifyContentType,
  createHttpFetchProvider,
  isSameOrigin,
  MAX_REDIRECTS,
  MAX_RESPONSE_BYTES,
  MAX_URL_LENGTH,
  parseCharset,
  type RequestOnce,
  type RequestOnceResult,
  validateFetchUrl,
} from "./fetch-http";
import type { ResolvedAddress } from "./network";
import { WebError } from "./types";

const PUBLIC_ADDRESS: ResolvedAddress[] = [{ address: "93.184.216.34", family: 4 }];

/** 造一个假的 IncomingMessage：把 body 灌进 Readable，再补上需要的字段 */
function fakeResponse(options: {
  status: number;
  headers?: Record<string, string>;
  body?: string;
  declareLength?: number;
}): IncomingMessage {
  const stream = Readable.from([Buffer.from(options.body ?? "", "utf8")]) as IncomingMessage;
  stream.statusCode = options.status;
  stream.headers = {
    ...(options.declareLength === undefined
      ? {}
      : { "content-length": String(options.declareLength) }),
    ...options.headers,
  };
  // destroy 在真实流上会触发 error/close；假的只需可调用
  stream.destroy = (() => stream) as typeof stream.destroy;
  return stream;
}

/** 收集每次请求的 URL，便于断言重定向行为 */
function fakeTransport(responder: (url: URL, call: number) => RequestOnceResult): {
  request: RequestOnce;
  urls: URL[];
} {
  const urls: URL[] = [];
  const request: RequestOnce = async (url) => {
    urls.push(url);
    return responder(url, urls.length);
  };
  return { request, urls };
}

/** 构造 provider：DNS 固定返回公网地址，HTTP 用给定的假实现 */
function providerWith(
  request: RequestOnce,
  options: { resolveFail?: WebError; timeoutMs?: number } = {},
) {
  return createHttpFetchProvider({
    timeoutMs: options.timeoutMs ?? 5_000,
    requestOnce: request,
    resolveAddresses: async () => {
      if (options.resolveFail !== undefined) throw options.resolveFail;
      return PUBLIC_ADDRESS;
    },
  });
}

describe("validateFetchUrl", () => {
  it("接受 http 与 https", () => {
    expect(validateFetchUrl("https://example.com/a?b=1").hostname).toBe("example.com");
    expect(validateFetchUrl("http://example.com").protocol).toBe("http:");
  });

  it("空串被拒绝", () => {
    expect(() => validateFetchUrl("   ")).toThrowError(
      expect.objectContaining({ code: "WEB_INVALID_URL" }),
    );
  });

  it("非 http(s) 协议被拒绝", () => {
    for (const url of ["file:///etc/passwd", "ftp://x/y", "data:text/html,x", "about:blank"]) {
      expect(() => validateFetchUrl(url), url).toThrowError(
        expect.objectContaining({ code: "WEB_INVALID_URL" }),
      );
    }
  });

  it("内嵌凭据被拒绝（WEB_BLOCKED_URL）", () => {
    expect(() => validateFetchUrl("https://user:pass@example.com")).toThrowError(
      expect.objectContaining({ code: "WEB_BLOCKED_URL" }),
    );
  });

  it("超长 URL 被拒绝", () => {
    const long = `https://example.com/${"a".repeat(MAX_URL_LENGTH)}`;
    expect(() => validateFetchUrl(long)).toThrowError(
      expect.objectContaining({ code: "WEB_INVALID_URL" }),
    );
  });

  it("非法 URL 被拒绝", () => {
    expect(() => validateFetchUrl("https://")).toThrowError(
      expect.objectContaining({ code: "WEB_INVALID_URL" }),
    );
  });
});

describe("isSameOrigin", () => {
  const base = new URL("https://example.com/a");
  it("协议/主机/端口都相同才算同源", () => {
    expect(isSameOrigin(new URL("https://example.com/b"), base)).toBe(true);
    expect(isSameOrigin(new URL("http://example.com/b"), base)).toBe(false);
    expect(isSameOrigin(new URL("https://other.com/b"), base)).toBe(false);
    expect(isSameOrigin(new URL("https://example.com:8443/b"), base)).toBe(false);
  });
});

describe("classifyContentType", () => {
  it("html 与 xhtml 归为 html", () => {
    expect(classifyContentType("text/html")).toBe("html");
    expect(classifyContentType("text/html; charset=utf-8")).toBe("html");
    expect(classifyContentType("application/xhtml+xml")).toBe("html");
  });

  it("text/* 与结构化文本归为 text", () => {
    expect(classifyContentType("text/plain")).toBe("text");
    expect(classifyContentType("application/json")).toBe("text");
    expect(classifyContentType("application/xml")).toBe("text");
    expect(classifyContentType("application/ld+json")).toBe("text");
    expect(classifyContentType("image/svg+xml")).toBe("text");
  });

  it("缺失与二进制类型返回 undefined", () => {
    expect(classifyContentType(undefined)).toBeUndefined();
    expect(classifyContentType("")).toBeUndefined();
    expect(classifyContentType("application/pdf")).toBeUndefined();
    expect(classifyContentType("image/png")).toBeUndefined();
    expect(classifyContentType("application/octet-stream")).toBeUndefined();
  });
});

describe("parseCharset", () => {
  it("取出 charset 参数", () => {
    expect(parseCharset("text/html; charset=UTF-8")).toBe("utf-8");
    expect(parseCharset('text/html; charset="gbk"')).toBe("gbk");
  });

  it("没有 charset 时 undefined", () => {
    expect(parseCharset("text/html")).toBeUndefined();
    expect(parseCharset(undefined)).toBeUndefined();
  });
});

describe("createHttpFetchProvider · 正常路径", () => {
  it("抓 HTML 并提取正文", async () => {
    const { request, urls } = fakeTransport(() => ({
      response: fakeResponse({
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
        body: "<html><head><title>标题</title></head><body><p>正文内容</p></body></html>",
      }),
      close: () => {},
    }));
    const result = await providerWith(request).fetch({ url: "https://example.com" });

    expect(result.statusCode).toBe(200);
    expect(result.content).toBe("正文内容");
    expect(result.title).toBe("标题");
    expect(result.truncated).toBe(false);
    expect(result.url).toBe("https://example.com/");
    expect(urls).toHaveLength(1);
  });

  it("纯文本原样返回", async () => {
    const { request } = fakeTransport(() => ({
      response: fakeResponse({
        status: 200,
        headers: { "content-type": "application/json" },
        body: '{"a":1}',
      }),
      close: () => {},
    }));
    const result = await providerWith(request).fetch({ url: "https://api.test/x" });
    expect(result.content).toBe('{"a":1}');
  });

  it("非 2xx 是**结果**而不是错误", async () => {
    const { request } = fakeTransport(() => ({
      response: fakeResponse({
        status: 404,
        headers: { "content-type": "text/html" },
        body: "<p>not found</p>",
      }),
      close: () => {},
    }));
    const result = await providerWith(request).fetch({ url: "https://example.com" });
    expect(result.statusCode).toBe(404);
    expect(result.content).toContain("not found");
  });

  it("请求头带产品 UA，且不带任何凭据", async () => {
    let seen: Record<string, string> = {};
    const request: RequestOnce = async (_url, _addresses, headers) => {
      seen = headers;
      return {
        response: fakeResponse({
          status: 200,
          headers: { "content-type": "text/plain" },
          body: "ok",
        }),
        close: () => {},
      };
    };
    await providerWith(request).fetch({ url: "https://example.com" });
    expect(seen["user-agent"]).toContain("oint/");
    expect(seen["user-agent"]).not.toContain("Mozilla");
    expect(seen.authorization).toBeUndefined();
    expect(seen.cookie).toBeUndefined();
  });

  it("把已验证的地址交给传输层（钉死的落点）", async () => {
    let seenAddresses: ResolvedAddress[] = [];
    const request: RequestOnce = async (_url, addresses) => {
      seenAddresses = addresses;
      return {
        response: fakeResponse({
          status: 200,
          headers: { "content-type": "text/plain" },
          body: "ok",
        }),
        close: () => {},
      };
    };
    await providerWith(request).fetch({ url: "https://example.com" });
    expect(seenAddresses).toEqual(PUBLIC_ADDRESS);
  });
});

describe("createHttpFetchProvider · 地址拒绝", () => {
  it("解析出非公网地址时拒绝，且**不发请求**", async () => {
    const request = vi.fn<RequestOnce>();
    const provider = providerWith(request, {
      resolveFail: new WebError("指向非公网地址", "WEB_BLOCKED_URL"),
    });
    await expect(provider.fetch({ url: "http://127.0.0.1" })).rejects.toThrowError(
      expect.objectContaining({ code: "WEB_BLOCKED_URL" }),
    );
    expect(request).not.toHaveBeenCalled();
  });

  it("跨源重定向被拒绝，且不跟随", async () => {
    const { request, urls } = fakeTransport(() => ({
      response: fakeResponse({
        status: 302,
        headers: { location: "https://evil.test/steal" },
      }),
      close: () => {},
    }));
    await expect(providerWith(request).fetch({ url: "https://example.com" })).rejects.toThrowError(
      expect.objectContaining({ code: "WEB_REDIRECT_BLOCKED" }),
    );
    // 只请求了原始 URL，没有打第二个源
    expect(urls).toHaveLength(1);
  });

  it("超过跳数上限被拒绝", async () => {
    const { request, urls } = fakeTransport((url) => ({
      response: fakeResponse({ status: 302, headers: { location: `${url.origin}/next` } }),
      close: () => {},
    }));
    await expect(providerWith(request).fetch({ url: "https://example.com" })).rejects.toThrowError(
      expect.objectContaining({ code: "WEB_REDIRECT_BLOCKED" }),
    );
    // 原始请求 + MAX_REDIRECTS 跳
    expect(urls).toHaveLength(MAX_REDIRECTS + 1);
  });

  it("重定向每一跳都重新解析地址（防 DNS 重绑定）", async () => {
    let resolveCalls = 0;
    const { request } = fakeTransport((url) => ({
      response:
        url.pathname === "/"
          ? fakeResponse({ status: 302, headers: { location: "/final" } })
          : fakeResponse({
              status: 200,
              headers: { "content-type": "text/plain" },
              body: "done",
            }),
      close: () => {},
    }));
    const provider = createHttpFetchProvider({
      requestOnce: request,
      resolveAddresses: async () => {
        resolveCalls += 1;
        return PUBLIC_ADDRESS;
      },
    });
    await provider.fetch({ url: "https://example.com/" });
    // 两次：原始请求一次 + 重定向后一次
    expect(resolveCalls).toBe(2);
  });

  it("重定向缺 Location 头时报错", async () => {
    const { request } = fakeTransport(() => ({
      response: fakeResponse({ status: 302 }),
      close: () => {},
    }));
    await expect(providerWith(request).fetch({ url: "https://example.com" })).rejects.toThrowError(
      expect.objectContaining({ code: "WEB_PROVIDER_ERROR" }),
    );
  });

  it("同源重定向正常跟随，最终 URL 是重定向后的地址", async () => {
    const { request, urls } = fakeTransport((url) => ({
      response:
        url.pathname === "/old"
          ? fakeResponse({ status: 301, headers: { location: "/new" } })
          : fakeResponse({
              status: 200,
              headers: { "content-type": "text/plain" },
              body: "moved",
            }),
      close: () => {},
    }));
    const result = await providerWith(request).fetch({ url: "https://example.com/old" });
    expect(result.url).toBe("https://example.com/new");
    expect(result.content).toBe("moved");
    expect(urls.map((url) => url.pathname)).toEqual(["/old", "/new"]);
  });
});

describe("createHttpFetchProvider · 上限与解码", () => {
  it("Content-Length 声明超限时立即拒绝", async () => {
    const { request } = fakeTransport(() => ({
      response: fakeResponse({
        status: 200,
        headers: { "content-type": "text/plain" },
        body: "x",
        declareLength: MAX_RESPONSE_BYTES + 1,
      }),
      close: () => {},
    }));
    await expect(providerWith(request).fetch({ url: "https://example.com" })).rejects.toThrowError(
      expect.objectContaining({ code: "WEB_FETCH_TOO_LARGE" }),
    );
  });

  it("流式读取超出字节上限时截断而不是拒绝", async () => {
    const { request } = fakeTransport(() => ({
      response: fakeResponse({
        status: 200,
        headers: { "content-type": "text/plain" },
        body: "a".repeat(MAX_RESPONSE_BYTES + 5000),
        // 故意少报 Content-Length，模拟服务器撒谎
        declareLength: 10,
      }),
      close: () => {},
    }));
    const result = await providerWith(request).fetch({ url: "https://example.com" });
    expect(result.truncated).toBe(true);
    expect(result.content.length).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);
  });

  it("不支持的内容类型被拒绝", async () => {
    const { request } = fakeTransport(() => ({
      response: fakeResponse({ status: 200, headers: { "content-type": "application/pdf" } }),
      close: () => {},
    }));
    await expect(
      providerWith(request).fetch({ url: "https://example.com/x.pdf" }),
    ).rejects.toThrowError(expect.objectContaining({ code: "WEB_UNSUPPORTED_CONTENT_TYPE" }));
  });

  it("缺失 Content-Type 被拒绝", async () => {
    const { request } = fakeTransport(() => ({
      response: fakeResponse({ status: 200, body: "x" }),
      close: () => {},
    }));
    await expect(providerWith(request).fetch({ url: "https://example.com" })).rejects.toThrowError(
      expect.objectContaining({ code: "WEB_UNSUPPORTED_CONTENT_TYPE" }),
    );
  });

  it("无法识别的 charset 报错而不是回退（宁可失败也不给乱码）", async () => {
    const { request } = fakeTransport(() => ({
      response: fakeResponse({
        status: 200,
        headers: { "content-type": "text/html; charset=not-a-real-charset" },
        body: "<p>x</p>",
      }),
      close: () => {},
    }));
    await expect(providerWith(request).fetch({ url: "https://example.com" })).rejects.toThrowError(
      expect.objectContaining({ code: "WEB_UNSUPPORTED_CONTENT_TYPE" }),
    );
  });

  it("声明 gbk 时按 gbk 解码", async () => {
    // "中文" 的 GBK 字节
    const gbkBytes = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]);
    const stream = Readable.from([gbkBytes]) as IncomingMessage;
    stream.statusCode = 200;
    stream.headers = { "content-type": "text/plain; charset=gbk" };
    stream.destroy = (() => stream) as typeof stream.destroy;

    const { request } = fakeTransport(() => ({ response: stream, close: () => {} }));
    const result = await providerWith(request).fetch({ url: "https://example.com" });
    expect(result.content).toBe("中文");
  });
});

describe("createHttpFetchProvider · 取消与超时", () => {
  it("传入已中止的信号时立即抛 WEB_ABORTED", async () => {
    const controller = new AbortController();
    controller.abort();
    const request = vi.fn<RequestOnce>();
    await expect(
      providerWith(request).fetch({ url: "https://example.com", signal: controller.signal }),
    ).rejects.toThrowError(expect.objectContaining({ code: "WEB_ABORTED" }));
    expect(request).not.toHaveBeenCalled();
  });

  it("超时抛 WEB_FETCH_TIMEOUT", async () => {
    // 传输层永不返回，让超时信号先到
    const request: RequestOnce = (_url, _addresses, _headers, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    const provider = providerWith(request, { timeoutMs: 50 });
    await expect(provider.fetch({ url: "https://example.com" })).rejects.toThrowError(
      expect.objectContaining({ code: "WEB_FETCH_TIMEOUT" }),
    );
  });
});
