// WebService 的选择规则与结果上限；provider 全部用假实现，不发任何网络请求。

import { describe, expect, it } from "vitest";
import { DEFAULT_WEB_SEARCH_SETTINGS } from "@/shared/contracts/web";
import { createWebService, resolveSearchProvider } from "./service";
import {
  WebError,
  type WebFetchProviderImpl,
  type WebSearchProviderImpl,
  type WebSearchResult,
} from "./types";

/** 假 provider：记录调用次数、最后一次收到的 maxResults，返回可配置的结果 */
function fakeProvider(
  available: boolean,
  result: Partial<WebSearchResult> = {},
): WebSearchProviderImpl & { calls: number; lastMax?: number } {
  const provider = {
    id: "searxng" as const,
    calls: 0,
    lastMax: undefined as number | undefined,
    available: () => available,
    async search(request: { maxResults?: number }) {
      provider.calls += 1;
      provider.lastMax = request.maxResults;
      return { sources: [{ url: "https://a.test" }], truncated: false, ...result };
    },
  };
  return provider;
}

function fakeFetch(): WebFetchProviderImpl {
  return {
    async fetch({ url }) {
      return { url, statusCode: 200, content: "body", truncated: false };
    },
  };
}

/** 用给定的 provider 集合构造 service；五个 provider 位置都填同一个假实现 */
function serviceWith(
  provider: WebSearchProviderImpl & { calls?: number },
  overrides: Partial<typeof DEFAULT_WEB_SEARCH_SETTINGS> = {},
) {
  const providers = {
    searxng: provider,
    tavily: provider,
    exa: provider,
    serper: provider,
    brave: provider,
  };
  return createWebService({
    resolve: () => ({ ...DEFAULT_WEB_SEARCH_SETTINGS, ...overrides }),
    searchProviders: providers,
    fetchProvider: fakeFetch(),
  });
}

describe("resolveSearchProvider", () => {
  const providers = {
    searxng: fakeProvider(true),
    tavily: fakeProvider(false),
    exa: fakeProvider(false),
    serper: fakeProvider(false),
    brave: fakeProvider(false),
  };

  it("总开关关闭时抛 WEB_DISABLED（优先于 provider 检查）", () => {
    expect(() =>
      resolveSearchProvider(providers, { ...DEFAULT_WEB_SEARCH_SETTINGS, enabled: false }),
    ).toThrowError(expect.objectContaining({ code: "WEB_DISABLED" }));
  });

  it("选中的 provider 不可用时抛 WEB_PROVIDER_CREDENTIAL_MISSING", () => {
    try {
      resolveSearchProvider(providers, { ...DEFAULT_WEB_SEARCH_SETTINGS, provider: "tavily" });
      throw new Error("应当抛出");
    } catch (error) {
      expect(error).toBeInstanceOf(WebError);
      expect((error as WebError).code).toBe("WEB_PROVIDER_CREDENTIAL_MISSING");
      // 文案要说清「去哪配」，否则用户只能猜
      expect((error as WebError).message).toContain("设置");
    }
  });

  it("选中的 provider 可用时返回它", () => {
    const resolved = resolveSearchProvider(providers, DEFAULT_WEB_SEARCH_SETTINGS);
    expect(resolved.id).toBe("searxng");
  });
});

describe("WebService.search", () => {
  it("正常返回 provider 的结果，并填上 provider id", async () => {
    const provider = fakeProvider(true);
    const service = serviceWith(provider);
    const result = await service.search({ query: "x" });
    expect(result.sources).toHaveLength(1);
    expect(result.provider).toBe("searxng");
    expect(provider.calls).toBe(1);
  });

  it("未传 maxResults 时用设置里的上限", async () => {
    const provider = fakeProvider(true);
    const service = serviceWith(provider, { maxResults: 5 });
    await service.search({ query: "x" });
    expect(provider.lastMax).toBe(5);
  });

  it("传了更小的 maxResults 时用模型给的值（模型只能收紧）", async () => {
    const provider = fakeProvider(true);
    const service = serviceWith(provider, { maxResults: 8 });
    await service.search({ query: "x", maxResults: 2 });
    expect(provider.lastMax).toBe(2);
  });

  it("传了更大的 maxResults 时仍被设置上限夹住（模型不能放大）", async () => {
    const provider = fakeProvider(true);
    const service = serviceWith(provider, { maxResults: 3 });
    await service.search({ query: "x", maxResults: 100 });
    expect(provider.lastMax).toBe(3);
  });

  it("provider 超量返回时由服务层截断并标记 truncated", async () => {
    // provider 无视 maxResults 返回 5 条
    const provider = fakeProvider(true, {
      sources: Array.from({ length: 5 }, (_, index) => ({ url: `https://a${index}.test` })),
    });
    const service = serviceWith(provider, { maxResults: 3 });
    const result = await service.search({ query: "x" });
    expect(result.sources).toHaveLength(3);
    expect(result.truncated).toBe(true);
    // 按原顺序保留前 N 条（provider 的排序就是相关性排序，不能打乱）
    expect(result.sources.map((source) => source.url)).toEqual([
      "https://a0.test",
      "https://a1.test",
      "https://a2.test",
    ]);
  });

  it("provider 已在上限内时不改动 truncated", async () => {
    const provider = fakeProvider(true, {
      sources: [{ url: "https://a.test" }, { url: "https://b.test" }],
      truncated: false,
    });
    const service = serviceWith(provider);
    const result = await service.search({ query: "x" });
    expect(result.sources).toHaveLength(2);
    expect(result.truncated).toBe(false);
  });

  it("provider 自己标了 truncated 时保持为 true", async () => {
    const provider = fakeProvider(true, { truncated: true });
    const service = serviceWith(provider);
    const result = await service.search({ query: "x" });
    expect(result.truncated).toBe(true);
  });

  it("关闭开关后 search 抛 WEB_DISABLED，且不调用 provider", async () => {
    const provider = fakeProvider(true);
    const service = serviceWith(provider, { enabled: false });
    await expect(service.search({ query: "x" })).rejects.toThrowError(
      expect.objectContaining({ code: "WEB_DISABLED" }),
    );
    expect(provider.calls).toBe(0);
  });
});

describe("WebService.fetch", () => {
  it("透传给抓取 provider", async () => {
    const service = serviceWith(fakeProvider(true));
    const result = await service.fetch({ url: "https://example.com" });
    expect(result.statusCode).toBe(200);
    expect(result.url).toBe("https://example.com");
  });
});

/**
 * 抓取输出上限的取数纪律。
 *
 * 这一组是真实缺陷的回归守卫：`fetchMaxOutputChars` 最初被存下来、
 * 在设置面板上显示，却**没有任何消费者**（工具层用硬编码的 20_000）。
 * 补上访问器之后又踩了第二个坑：它当时是同步的，读的是**缓存快照**，
 * 于是第一次调用回落到默认值、之后读到上一次的陈旧值
 * —— 实测上限设 600 却输出 136KB，改成 3000 又输出 600。
 *
 * 现在它返回 Promise 并要求装配层**先刷新再读**（见 index.ts），下面钉住这两条。
 */
describe("WebService.fetchOutputLimit", () => {
  it("返回设置里的值（不是硬编码默认值）", async () => {
    const service = serviceWith(fakeProvider(true), { fetchMaxOutputChars: 1234 });
    await expect(service.fetchOutputLimit()).resolves.toBe(1234);
  });

  it("每次调用都重新读设置（不是构造时快照）", async () => {
    let limit = 1000;
    const providers = {
      searxng: fakeProvider(true),
      tavily: fakeProvider(false),
      exa: fakeProvider(false),
      serper: fakeProvider(false),
      brave: fakeProvider(false),
    };
    const service = createWebService({
      resolve: () => ({ ...DEFAULT_WEB_SEARCH_SETTINGS, fetchMaxOutputChars: limit }),
      searchProviders: providers,
      fetchProvider: fakeFetch(),
    });

    expect(await service.fetchOutputLimit()).toBe(1000);
    limit = 7000;
    expect(await service.fetchOutputLimit()).toBe(7000);
  });

  it("契约是异步的（同步读会拿到陈旧快照 —— 那个坑实测踩过）", () => {
    const service = serviceWith(fakeProvider(true));
    // 既靠类型系统、也靠这个用例守住这条约束
    expect(service.fetchOutputLimit()).toBeInstanceOf(Promise);
  });
});
