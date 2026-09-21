// 网络搜索设置面板：契约形状与交互约束。
//
// 只测**纯逻辑**（provider 元数据、默认值、Key 的「留空即保留」语义）——
// 组件渲染在本仓库没有测试设施（vitest 的 ui project 只收 *.test.tsx，
// 而这个面板依赖 Select/Dialog 等 Radix 组件，渲染测试的性价比低于它的脆弱度）。

import { describe, expect, it } from "vitest";
import {
  DEFAULT_SEARXNG_INSTANCES,
  DEFAULT_WEB_SEARCH_SETTINGS,
  WEB_SEARCH_PROVIDER_META,
  WEB_SEARCH_PROVIDERS,
} from "@/shared/contracts/web";

describe("provider 元数据", () => {
  it("每个 provider 都有元数据（面板按它渲染下拉项与提示）", () => {
    for (const id of WEB_SEARCH_PROVIDERS) {
      const meta = WEB_SEARCH_PROVIDER_META[id];
      expect(meta, id).toBeDefined();
      expect(meta.label.length, id).toBeGreaterThan(0);
      expect(meta.hint.length, id).toBeGreaterThan(0);
    }
  });

  it("只有 searxng 不需要 Key", () => {
    expect(WEB_SEARCH_PROVIDER_META.searxng.needsKey).toBe(false);
    for (const id of ["tavily", "exa", "serper", "brave"] as const) {
      expect(WEB_SEARCH_PROVIDER_META[id].needsKey, id).toBe(true);
    }
  });

  it("需要 Key 的 provider 都给了获取地址（面板渲染外链）", () => {
    for (const id of WEB_SEARCH_PROVIDERS) {
      const meta = WEB_SEARCH_PROVIDER_META[id];
      if (!meta.needsKey) continue;
      expect(meta.keyUrl, id).toMatch(/^https:\/\//);
    }
  });

  it("免 Key 的 provider 不给获取地址（那个链接对它没有意义）", () => {
    expect(WEB_SEARCH_PROVIDER_META.searxng.keyUrl).toBeUndefined();
  });
});

describe("默认设置", () => {
  it("默认启用且用免 Key 的 searxng（开箱即用）", () => {
    expect(DEFAULT_WEB_SEARCH_SETTINGS.enabled).toBe(true);
    expect(DEFAULT_WEB_SEARCH_SETTINGS.provider).toBe("searxng");
  });

  it("默认不带任何 Key（不能把作者的凭据发出去）", () => {
    for (const id of WEB_SEARCH_PROVIDERS) {
      expect(DEFAULT_WEB_SEARCH_SETTINGS[id].apiKey, id).toBe("");
    }
  });

  it("默认实例清单为空（表示「用内置清单」）", () => {
    expect(DEFAULT_WEB_SEARCH_SETTINGS.searxng.instances).toBe("");
  });

  it("上限落在面板允许的区间里（否则输入框一打开就是非法值）", () => {
    expect(DEFAULT_WEB_SEARCH_SETTINGS.maxResults).toBeGreaterThanOrEqual(1);
    expect(DEFAULT_WEB_SEARCH_SETTINGS.maxResults).toBeLessThanOrEqual(20);
    expect(DEFAULT_WEB_SEARCH_SETTINGS.fetchMaxOutputChars).toBeGreaterThanOrEqual(1000);
    expect(DEFAULT_WEB_SEARCH_SETTINGS.fetchMaxOutputChars).toBeLessThanOrEqual(1_000_000);
    expect(DEFAULT_WEB_SEARCH_SETTINGS.fetchTimeoutMs / 1000).toBeGreaterThanOrEqual(1);
    expect(DEFAULT_WEB_SEARCH_SETTINGS.fetchTimeoutMs / 1000).toBeLessThanOrEqual(120);
  });
});

describe("内置 SearXNG 实例清单", () => {
  it("至少有一个实例（否则免 Key 的默认选项不可用）", () => {
    expect(DEFAULT_SEARXNG_INSTANCES.length).toBeGreaterThan(0);
  });

  it("每一项都是合法的 https 地址（面板直接把它当 placeholder 显示）", () => {
    for (const instance of DEFAULT_SEARXNG_INSTANCES) {
      expect(instance, instance).toMatch(/^https:\/\/[a-z0-9.-]+$/i);
      // 构造一次确认它真的是合法 URL（正则漏掉的边界由它兜住）
      expect(() => new URL(instance), instance).not.toThrow();
    }
  });

  it("运营方分散：没有同一主机下的多个实例", () => {
    // thejot.org 有多个子域可用，但同一运营方是同一故障域 —— 全列进来只是虚假的冗余
    const hosts = DEFAULT_SEARXNG_INSTANCES.map((instance) => new URL(instance).hostname);
    expect(new Set(hosts).size).toBe(hosts.length);
  });
});
