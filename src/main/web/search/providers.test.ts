// 搜索 provider 单测。
//
// **全部离线**：HTTP 全部是注入的假实现，所以既不打真实请求，也不会因网络而 flaky。
// 假响应体的形状取自**实测**（见 http.ts 的 extractProviderError 注释与
// docs/web-tools-plan.md §6.3）—— 尤其是 Tavily 的错误嵌在 detail.error 里，
// 只写 data.error 会丢掉真实原因。

import { describe, expect, it, vi } from "vitest";
import type { WebSearchSettings } from "@/shared/contracts/web";
import { DEFAULT_WEB_SEARCH_SETTINGS } from "@/shared/contracts/web";
import type { HttpJsonFn, HttpJsonResponse } from "../http";
import { extractProviderError } from "../http";
import type { WebProviderSearchRequest } from "../types";
import { WebError } from "../types";
import { createApiProviders } from "./providers";
import { createSearxngProvider } from "./searxng";

/** 构造一个假 HTTP：记录请求，回固定的响应 */
function fakeHttp(response: Partial<HttpJsonResponse>): {
  http: HttpJsonFn;
  calls: { url: string; method?: string; body?: string; headers?: Record<string, string> }[];
} {
  const calls: { url: string; method?: string; body?: string; headers?: Record<string, string> }[] =
    [];
  const http: HttpJsonFn = async (options) => {
    calls.push({
      url: options.url,
      ...(options.method === undefined ? {} : { method: options.method }),
      ...(options.body === undefined ? {} : { body: options.body }),
      ...(options.headers === undefined ? {} : { headers: options.headers }),
    });
    return { status: 200, text: "", ...response };
  };
  return { http, calls };
}

function settingsWith(overrides: Partial<WebSearchSettings>): WebSearchSettings {
  return { ...DEFAULT_WEB_SEARCH_SETTINGS, ...overrides };
}

const request: WebProviderSearchRequest = { query: "test query", maxResults: 5 };

describe("SearXNG provider", () => {
  it("永远可用（免 Key，实例不可达是执行期错误）", () => {
    const provider = createSearxngProvider({ resolve: () => settingsWith({}) });
    expect(provider.available()).toBe(true);
  });

  it("请求带上 format=json 与查询串", async () => {
    const { http, calls } = fakeHttp({ json: { results: [{ url: "https://a.test" }] } });
    const provider = createSearxngProvider({ http, resolve: () => settingsWith({}) });
    await provider.search(request);

    const call = calls[0];
    expect(call?.url).toContain("format=json");
    expect(call?.url).toContain("q=test+query");
    // 默认用内置清单的第一个
    expect(call?.url.startsWith("https://search.thejot.org/search")).toBe(true);
  });

  it("映射 title / url / content / publishedDate", async () => {
    const { http } = fakeHttp({
      json: {
        results: [
          {
            title: "标题",
            url: "https://a.test",
            content: "摘要",
            publishedDate: "2026-01-02",
            engine: "duckduckgo",
          },
        ],
      },
    });
    const provider = createSearxngProvider({ http, resolve: () => settingsWith({}) });
    const result = await provider.search(request);

    expect(result.sources).toEqual([
      { url: "https://a.test", title: "标题", snippet: "摘要", publishedAt: "2026-01-02" },
    ]);
    expect(result.instance).toBe("https://search.thejot.org");
  });

  it("publishedDate 为 null 时不写进 source（实测常见形态）", async () => {
    const { http } = fakeHttp({
      json: { results: [{ title: "T", url: "https://a.test", content: "S", publishedDate: null }] },
    });
    const provider = createSearxngProvider({ http, resolve: () => settingsWith({}) });
    const result = await provider.search(request);
    // null 不能被当成字符串写进 details（渲染层按 string | undefined 读）
    expect(result.sources[0]).not.toHaveProperty("publishedAt");
  });

  it("丢弃没有 url 的结果项", async () => {
    const { http } = fakeHttp({
      json: { results: [{ title: "无链接" }, { title: "T", url: "https://a.test" }] },
    });
    const provider = createSearxngProvider({ http, resolve: () => settingsWith({}) });
    const result = await provider.search(request);
    expect(result.sources).toHaveLength(1);
  });

  it("按 URL 去重", async () => {
    const { http } = fakeHttp({
      json: {
        results: [
          { title: "A", url: "https://a.test" },
          { title: "B", url: "https://a.test" },
        ],
      },
    });
    const provider = createSearxngProvider({ http, resolve: () => settingsWith({}) });
    expect((await provider.search(request)).sources).toHaveLength(1);
  });

  it("answers 数组拼成 answer", async () => {
    const { http } = fakeHttp({
      json: { results: [{ url: "https://a.test" }], answers: ["答案一", "答案二"] },
    });
    const provider = createSearxngProvider({ http, resolve: () => settingsWith({}) });
    expect((await provider.search(request)).answer).toBe("答案一\n答案二");
  });

  it("answers 为空时不带 answer 字段", async () => {
    const { http } = fakeHttp({ json: { results: [{ url: "https://a.test" }], answers: [] } });
    const provider = createSearxngProvider({ http, resolve: () => settingsWith({}) });
    expect(await provider.search(request)).not.toHaveProperty("answer");
  });

  it("unresponsive_engines 非空时报出条数（不是错误）", async () => {
    const { http } = fakeHttp({
      json: {
        results: [{ url: "https://a.test" }],
        unresponsive_engines: [
          ["google", "timeout"],
          ["bing", "error"],
        ],
      },
    });
    const provider = createSearxngProvider({ http, resolve: () => settingsWith({}) });
    expect((await provider.search(request)).unresponsive).toBe(2);
  });

  it("实例返回 HTML（未开 JSON）时给出可操作的错误", async () => {
    const { http } = fakeHttp({ json: undefined, text: "<!DOCTYPE html><html>…" });
    const provider = createSearxngProvider({ http, resolve: () => settingsWith({}) });
    await expect(provider.search(request)).rejects.toThrowError(/未开启 JSON 输出/);
  });

  it("非 2xx 转成带状态码的错误", async () => {
    const { http } = fakeHttp({ status: 429, json: { error: "too many requests" } });
    const provider = createSearxngProvider({ http, resolve: () => settingsWith({}) });
    await expect(provider.search(request)).rejects.toThrowError(/429/);
  });

  it("自定义实例清单优先于内置清单", async () => {
    const { http, calls } = fakeHttp({ json: { results: [{ url: "https://a.test" }] } });
    const provider = createSearxngProvider({
      http,
      resolve: () =>
        settingsWith({ searxng: { apiKey: "", instances: "https://mine.test\nhttps://b.test" } }),
    });
    await provider.search(request);
    expect(calls[0]?.url.startsWith("https://mine.test/search")).toBe(true);
  });

  it("实例清单里的非法项被丢弃，不影响合法的那些", async () => {
    const { http, calls } = fakeHttp({ json: { results: [{ url: "https://a.test" }] } });
    const provider = createSearxngProvider({
      http,
      resolve: () =>
        settingsWith({
          searxng: { apiKey: "", instances: "not-a-url\nfile:///etc/passwd\nhttps://ok.test" },
        }),
    });
    await provider.search(request);
    expect(calls[0]?.url.startsWith("https://ok.test/search")).toBe(true);
  });

  it("不传实例配置时用内置清单", async () => {
    const { http, calls } = fakeHttp({ json: { results: [{ url: "https://a.test" }] } });
    const provider = createSearxngProvider({ http, resolve: () => settingsWith({}) });
    await provider.search(request);
    expect(calls[0]?.url).toContain("search.thejot.org");
  });
});

/**
 * 逐实例回退。
 *
 * 为什么需要它：公共实例会被上游搜索引擎限流，而**限流的表现是
 * 「HTTP 200 + results: []」** —— 长得像「真的没搜到」。
 * 实测同一个实例连查四次，可能前三次 20 条、第四次 0 条。
 * 只用第一个实例会让一条本来能答的问题直接失败。
 */
describe("SearXNG 逐实例回退", () => {
  const twoInstances = "https://first.test\nhttps://second.test";

  /** 按 URL 前缀决定回什么，用来模拟「第一个挂了、第二个好」 */
  function routedHttp(routes: Record<string, Partial<HttpJsonResponse>>): {
    http: HttpJsonFn;
    hosts: string[];
  } {
    const hosts: string[] = [];
    const http: HttpJsonFn = async (options) => {
      const host = new URL(options.url).host;
      hosts.push(host);
      return { status: 200, text: "", ...(routes[host] ?? { json: { results: [] } }) };
    };
    return { http, hosts };
  }

  const withInstances = () => settingsWith({ searxng: { apiKey: "", instances: twoInstances } });

  it("第一个实例空结果时自动试第二个", async () => {
    const { http, hosts } = routedHttp({
      "first.test": { json: { results: [] } },
      "second.test": { json: { results: [{ title: "T", url: "https://a.test" }] } },
    });
    const provider = createSearxngProvider({ http, resolve: withInstances });
    const result = await provider.search(request);

    expect(hosts).toEqual(["first.test", "second.test"]);
    expect(result.sources).toHaveLength(1);
    // 命中者被回报：用户能看见是谁答的
    expect(result.instance).toBe("https://second.test");
  });

  it("第一个实例报错时也试第二个", async () => {
    const { http, hosts } = routedHttp({
      "first.test": { status: 500, json: { error: "boom" } },
      "second.test": { json: { results: [{ url: "https://a.test" }] } },
    });
    const provider = createSearxngProvider({ http, resolve: withInstances });
    expect((await provider.search(request)).sources).toHaveLength(1);
    expect(hosts).toEqual(["first.test", "second.test"]);
  });

  it("第一个实例未开 JSON 时试第二个", async () => {
    const { http, hosts } = routedHttp({
      "first.test": { text: "<!DOCTYPE html>" },
      "second.test": { json: { results: [{ url: "https://a.test" }] } },
    });
    const provider = createSearxngProvider({ http, resolve: withInstances });
    expect((await provider.search(request)).sources).toHaveLength(1);
    expect(hosts).toEqual(["first.test", "second.test"]);
  });

  it("最多只试 3 个实例（清单很长时不至于让一次检索拖几十秒）", async () => {
    const many = "https://a.test\nhttps://b.test\nhttps://c.test\nhttps://d.test\nhttps://e.test";
    const { http, hosts } = routedHttp({});
    const provider = createSearxngProvider({
      http,
      resolve: () => settingsWith({ searxng: { apiKey: "", instances: many } }),
    });
    await expect(provider.search(request)).rejects.toThrowError();
    expect(hosts).toEqual(["a.test", "b.test", "c.test"]);
  });

  it("全部失败时把每个实例的原因都列出来（用户才能判断该怎么办）", async () => {
    const { http } = routedHttp({
      "first.test": { status: 429, json: { error: "too many requests" } },
      "second.test": { text: "<html>not json</html>" },
    });
    const provider = createSearxngProvider({ http, resolve: withInstances });
    try {
      await provider.search(request);
      throw new Error("应当抛出");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("first.test");
      expect(message).toContain("second.test");
      expect(message).toContain("429");
      expect(message).toContain("未开启 JSON");
      // 给出下一步
      expect(message).toContain("设置");
    }
  });

  it("所有实例都返回空时，报的是「逐个原因」而不是假装成功", async () => {
    // 都被限流：unresponsive 非空，原因里要体现出来
    const { http } = routedHttp({
      "first.test": {
        json: { results: [], unresponsive_engines: [["google", "CAPTCHA"]] },
      },
      "second.test": { json: { results: [], unresponsive_engines: [["bing", "timeout"]] } },
    });
    const provider = createSearxngProvider({ http, resolve: withInstances });
    await expect(provider.search(request)).rejects.toThrowError(/被限流或无响应/);
  });

  it("调用方取消时不再试下一个实例", async () => {
    const hosts: string[] = [];
    const http: HttpJsonFn = async (options) => {
      hosts.push(new URL(options.url).host);
      throw new WebError("抓取已取消。", "WEB_ABORTED");
    };
    const provider = createSearxngProvider({ http, resolve: withInstances });
    await expect(provider.search(request)).rejects.toThrowError(
      expect.objectContaining({ code: "WEB_ABORTED" }),
    );
    // 取消是调用方的意图，继续试别的实例既无意义也让「停」变慢
    expect(hosts).toEqual(["first.test"]);
  });

  it("自定义实例优先于内置清单（用户写的排前面）", async () => {
    const { http, hosts } = routedHttp({
      "mine.test": { json: { results: [{ url: "https://a.test" }] } },
    });
    const provider = createSearxngProvider({
      http,
      resolve: () => settingsWith({ searxng: { apiKey: "", instances: "https://mine.test" } }),
    });
    await provider.search(request);
    expect(hosts).toEqual(["mine.test"]);
  });
});

describe("API providers · 可用性", () => {
  it("没有 Key 时 available() 为 false", () => {
    const providers = createApiProviders({ resolve: () => settingsWith({}) });
    for (const id of ["tavily", "exa", "serper", "brave"] as const) {
      expect(providers[id].available(), id).toBe(false);
    }
  });

  it("填了 Key 时 available() 为 true（不做网络探测）", () => {
    const http = vi.fn<HttpJsonFn>();
    const providers = createApiProviders({
      http,
      resolve: () => settingsWith({ tavily: { apiKey: "tvly-x" } }),
    });
    expect(providers.tavily.available()).toBe(true);
    // 关键：可用性检查**不发请求**
    expect(http).not.toHaveBeenCalled();
  });

  it("空白 Key 视为未配置", () => {
    const providers = createApiProviders({
      resolve: () => settingsWith({ tavily: { apiKey: "   " } }),
    });
    expect(providers.tavily.available()).toBe(false);
  });

  it("没有 Key 时调用抛 WEB_PROVIDER_CREDENTIAL_MISSING", async () => {
    const providers = createApiProviders({ resolve: () => settingsWith({}) });
    await expect(providers.tavily.search(request)).rejects.toThrowError(
      expect.objectContaining({ code: "WEB_PROVIDER_CREDENTIAL_MISSING" }),
    );
  });
});

describe("Tavily", () => {
  const withKey = () => settingsWith({ tavily: { apiKey: "tvly-secret" } });

  it("请求带 api_key 与 max_results", async () => {
    const { http, calls } = fakeHttp({ json: { results: [{ url: "https://a.test" }] } });
    const providers = createApiProviders({ http, resolve: withKey });
    await providers.tavily.search({ query: "q", maxResults: 3 });

    const body = JSON.parse(calls[0]?.body ?? "{}") as Record<string, unknown>;
    expect(calls[0]?.url).toBe("https://api.tavily.com/search");
    expect(body.api_key).toBe("tvly-secret");
    expect(body.max_results).toBe(3);
    expect(body.search_depth).toBe("basic");
  });

  it("includeAnswer 开启时带 include_answer 并取出 answer", async () => {
    const { http, calls } = fakeHttp({
      json: { results: [{ title: "T", url: "https://a.test", content: "S" }], answer: "42" },
    });
    const providers = createApiProviders({
      http,
      resolve: () => settingsWith({ tavily: { apiKey: "k", includeAnswer: true } }),
    });
    const result = await providers.tavily.search(request);
    expect(JSON.parse(calls[0]?.body ?? "{}")).toMatchObject({ include_answer: true });
    expect(result.answer).toBe("42");
  });

  it("answer 为布尔 false 时不带出 answer（未开 include_answer 的形态）", async () => {
    const { http } = fakeHttp({
      json: { results: [{ url: "https://a.test" }], answer: false },
    });
    const providers = createApiProviders({ http, resolve: withKey });
    expect(await providers.tavily.search(request)).not.toHaveProperty("answer");
  });

  it("映射 results 的 title/url/content", async () => {
    const { http } = fakeHttp({
      json: { results: [{ title: "T", url: "https://a.test", content: "C", score: 0.9 }] },
    });
    const providers = createApiProviders({ http, resolve: withKey });
    expect((await providers.tavily.search(request)).sources).toEqual([
      { url: "https://a.test", title: "T", snippet: "C" },
    ]);
  });

  /**
   * 实测形状（2026-09-21 无 Key 直接打端点）：
   *   HTTP 401 {"detail":{"error":"Unauthorized: missing or invalid API key."}}
   * 参考实现只取 data.error || data.message（都是 undefined），
   * 于是用户看到「未知错误」——真实原因就在 detail.error 里。
   */
  it("401 的嵌套错误被正确取出（不能报成「未知错误」）", async () => {
    const { http } = fakeHttp({
      status: 401,
      json: { detail: { error: "Unauthorized: missing or invalid API key." } },
    });
    const providers = createApiProviders({ http, resolve: withKey });
    await expect(providers.tavily.search(request)).rejects.toThrowError(
      /Unauthorized: missing or invalid API key\./,
    );
  });

  it("401 的错误文案点明「Key 无效」", async () => {
    const { http } = fakeHttp({ status: 401, json: { detail: { error: "x" } } });
    const providers = createApiProviders({ http, resolve: withKey });
    await expect(providers.tavily.search(request)).rejects.toThrowError(/API Key 无效或未授权/);
  });
});

describe("Exa", () => {
  const withKey = () => settingsWith({ exa: { apiKey: "exa-secret", type: "neural" } });

  it("用 x-api-key 头认证", async () => {
    const { http, calls } = fakeHttp({ json: { results: [{ url: "https://a.test" }] } });
    const providers = createApiProviders({ http, resolve: withKey });
    await providers.exa.search(request);
    expect(calls[0]?.headers?.["x-api-key"]).toBe("exa-secret");
    expect(calls[0]?.url).toBe("https://api.exa.ai/search");
  });

  it("请求带 num_results 与 type", async () => {
    const { http, calls } = fakeHttp({ json: { results: [{ url: "https://a.test" }] } });
    const providers = createApiProviders({ http, resolve: withKey });
    await providers.exa.search({ query: "q", maxResults: 7 });
    expect(JSON.parse(calls[0]?.body ?? "{}")).toMatchObject({
      num_results: 7,
      type: "neural",
    });
  });

  it("snippet 取不到时回落到 text", async () => {
    const { http } = fakeHttp({
      json: { results: [{ title: "T", url: "https://a.test", text: "正文摘录" }] },
    });
    const providers = createApiProviders({ http, resolve: withKey });
    expect((await providers.exa.search(request)).sources[0]?.snippet).toBe("正文摘录");
  });

  /** 实测：HTTP 402 {"error":"Payment required…","tag":"X402_PAYMENT_REQUIRED"} */
  it("402 提示「额度不足」而不是「Key 无效」", async () => {
    const { http } = fakeHttp({
      status: 402,
      json: { error: "Payment required to access this resource", tag: "X402_PAYMENT_REQUIRED" },
    });
    const providers = createApiProviders({ http, resolve: withKey });
    await expect(providers.exa.search(request)).rejects.toThrowError(
      /API Key 有效，但账户额度不足/,
    );
  });
});

describe("Serper", () => {
  const withKey = () => settingsWith({ serper: { apiKey: "serper-key", gl: "cn", hl: "zh-cn" } });

  it("映射 organic[].link → url", async () => {
    const { http } = fakeHttp({
      json: { organic: [{ title: "T", link: "https://a.test", snippet: "S" }] },
    });
    const providers = createApiProviders({ http, resolve: withKey });
    expect((await providers.serper.search(request)).sources).toEqual([
      { url: "https://a.test", title: "T", snippet: "S" },
    ]);
  });

  it("带 gl / hl", async () => {
    const { http, calls } = fakeHttp({ json: { organic: [] } });
    const providers = createApiProviders({ http, resolve: withKey });
    await providers.serper.search(request);
    expect(JSON.parse(calls[0]?.body ?? "{}")).toMatchObject({ gl: "cn", hl: "zh-cn" });
  });

  it("organic 缺失时返回空数组而不是抛", async () => {
    const { http } = fakeHttp({ json: { searchParameters: {} } });
    const providers = createApiProviders({ http, resolve: withKey });
    expect((await providers.serper.search(request)).sources).toEqual([]);
  });

  /** 实测：HTTP 403 {"message":"Unauthorized. Sign up for a free account.","statusCode":403} */
  it("403 的 message 被取出（不是 error 字段）", async () => {
    const { http } = fakeHttp({
      status: 403,
      json: { message: "Unauthorized. Sign up for a free account.", statusCode: 403 },
    });
    const providers = createApiProviders({ http, resolve: withKey });
    await expect(providers.serper.search(request)).rejects.toThrowError(
      /Unauthorized\. Sign up for a free account\./,
    );
  });
});

describe("Brave", () => {
  const withKey = () => settingsWith({ brave: { apiKey: "brave-key" } });

  it("用 x-subscription-token 头，GET 请求带查询参数", async () => {
    const { http, calls } = fakeHttp({ json: { web: { results: [] } } });
    const providers = createApiProviders({ http, resolve: withKey });
    await providers.brave.search({ query: "hello world", maxResults: 4 });

    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.headers?.["x-subscription-token"]).toBe("brave-key");
    expect(calls[0]?.url).toContain("q=hello+world");
    expect(calls[0]?.url).toContain("count=4");
  });

  it("映射 web.results[].description → snippet", async () => {
    const { http } = fakeHttp({
      json: { web: { results: [{ title: "T", url: "https://a.test", description: "D" }] } },
    });
    const providers = createApiProviders({ http, resolve: withKey });
    expect((await providers.brave.search(request)).sources).toEqual([
      { url: "https://a.test", title: "T", snippet: "D" },
    ]);
  });

  it("web.results 缺失时返回空数组", async () => {
    const { http } = fakeHttp({ json: {} });
    const providers = createApiProviders({ http, resolve: withKey });
    expect((await providers.brave.search(request)).sources).toEqual([]);
  });

  it("country / searchLang 可选", async () => {
    const { http, calls } = fakeHttp({ json: { web: { results: [] } } });
    const providers = createApiProviders({
      http,
      resolve: () => settingsWith({ brave: { apiKey: "k", country: "CN", searchLang: "zh" } }),
    });
    await providers.brave.search(request);
    expect(calls[0]?.url).toContain("country=CN");
    expect(calls[0]?.url).toContain("search_lang=zh");
  });
});

describe("extractProviderError", () => {
  it("取顶层 error", () => {
    expect(extractProviderError({ error: "boom" })).toBe("boom");
  });

  it("取顶层 message（Serper 形态）", () => {
    expect(extractProviderError({ message: "Unauthorized", statusCode: 403 })).toBe("Unauthorized");
  });

  it("取 detail.error（Tavily 形态）", () => {
    expect(
      extractProviderError({ detail: { error: "Unauthorized: missing or invalid API key." } }),
    ).toBe("Unauthorized: missing or invalid API key.");
  });

  it("取 error.detail（Brave 文档形态）", () => {
    expect(extractProviderError({ error: { detail: "bad token" } })).toBe("bad token");
  });

  it("非对象 / 找不到时返回 undefined", () => {
    expect(extractProviderError(null)).toBeUndefined();
    expect(extractProviderError("string")).toBeUndefined();
    expect(extractProviderError({})).toBeUndefined();
    expect(extractProviderError({ error: 42 })).toBeUndefined();
  });

  it("空串不算有效原因（避免空文案）", () => {
    expect(extractProviderError({ error: "   ", message: "real" })).toBe("real");
  });
});
