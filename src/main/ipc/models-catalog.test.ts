import { describe, expect, it, vi } from "vitest";
import type { ModelCatalogEntry } from "@/shared/contracts/models";

// 纯函数测试不需要 Electron 运行时；mock 掉避免 import 真实 electron 失败
vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
  net: { fetch: vi.fn() },
  app: { getPath: vi.fn(() => "") },
}));

import { buildCatalogIndex, matchCatalogEntry, toCatalogEntry } from "./models-catalog";

/** 构造索引用的最小条目 */
function entry(catalogId: string, name = catalogId): ModelCatalogEntry {
  return {
    catalogId,
    name,
    contextWindow: 128000,
    maxTokens: 8192,
    reasoning: false,
    input: ["text"],
  };
}

describe("toCatalogEntry", () => {
  it("解析完整条目", () => {
    const raw = {
      id: "deepseek/deepseek-v4-flash",
      name: "DeepSeek V4 Flash",
      reasoning: true,
      modalities: { input: ["text"], output: ["text"] },
      limit: { context: 1000000, output: 384000 },
    };
    expect(toCatalogEntry(raw)).toEqual({
      catalogId: "deepseek/deepseek-v4-flash",
      name: "DeepSeek V4 Flash",
      contextWindow: 1000000,
      maxTokens: 384000,
      reasoning: true,
      input: ["text"],
    });
  });

  it("缺 limit 时用兜底值", () => {
    expect(toCatalogEntry({ id: "acme/model", name: "Model" })).toEqual({
      catalogId: "acme/model",
      name: "Model",
      contextWindow: 128000,
      maxTokens: 8192,
      reasoning: false,
      input: ["text"],
    });
  });

  it("limit 非法数值同样兜底", () => {
    const parsed = toCatalogEntry({
      id: "acme/model",
      name: "Model",
      limit: { context: 0, output: Number.NaN },
    });
    expect(parsed?.contextWindow).toBe(128000);
    expect(parsed?.maxTokens).toBe(8192);
  });

  it("input 只保留 text/image 并去重", () => {
    const parsed = toCatalogEntry({
      id: "acme/vision",
      name: "Vision",
      modalities: { input: ["image", "audio", "image", "text"] },
    });
    expect(parsed?.input).toEqual(["image", "text"]);
  });

  it("input 缺失或为空时兜底 text", () => {
    expect(toCatalogEntry({ id: "a/1", name: "A", modalities: { input: [] } })?.input).toEqual([
      "text",
    ]);
    expect(toCatalogEntry({ id: "a/2", name: "A" })?.input).toEqual(["text"]);
    expect(toCatalogEntry({ id: "a/3", name: "A", modalities: { input: "text" } })?.input).toEqual([
      "text",
    ]);
  });

  it("缺 id 或 name 返回 null", () => {
    expect(toCatalogEntry({ name: "无 id" })).toBeNull();
    expect(toCatalogEntry({ id: "a/1" })).toBeNull();
    expect(toCatalogEntry(null)).toBeNull();
    expect(toCatalogEntry("字符串")).toBeNull();
  });
});

describe("matchCatalogEntry", () => {
  const index = buildCatalogIndex([
    entry("deepseek/deepseek-v4-flash", "DeepSeek V4 Flash"),
    entry("openrouter/anthropic/claude-sonnet-4", "Claude Sonnet 4"),
  ]);

  it("精确匹配（大小写不敏感）", () => {
    expect(matchCatalogEntry(index, "deepseek/deepseek-v4-flash")?.catalogId).toBe(
      "deepseek/deepseek-v4-flash",
    );
    expect(matchCatalogEntry(index, "DeepSeek/DeepSeek-V4-Flash")?.catalogId).toBe(
      "deepseek/deepseek-v4-flash",
    );
  });

  it("忽略 provider 前缀匹配", () => {
    expect(matchCatalogEntry(index, "deepseek-v4-flash")?.catalogId).toBe(
      "deepseek/deepseek-v4-flash",
    );
  });

  it("结尾匹配兜底", () => {
    expect(matchCatalogEntry(index, "claude-sonnet-4")?.catalogId).toBe(
      "openrouter/anthropic/claude-sonnet-4",
    );
  });

  it("多候选时按 catalogId 字典序取第一个", () => {
    const multi = buildCatalogIndex([
      entry("z-provider/deepseek-v4-flash"),
      entry("a-provider/deepseek-v4-flash"),
      entry("m-provider/other/deepseek-v4-flash"),
    ]);
    expect(matchCatalogEntry(multi, "deepseek-v4-flash")?.catalogId).toBe(
      "a-provider/deepseek-v4-flash",
    );
    // 前缀剥离优先于结尾匹配
    const suffixOnly = buildCatalogIndex([
      entry("a-provider/other/deepseek-v4-flash"),
      entry("b-provider/deepseek-v4-flash"),
    ]);
    expect(matchCatalogEntry(suffixOnly, "deepseek-v4-flash")?.catalogId).toBe(
      "b-provider/deepseek-v4-flash",
    );
  });

  it("无匹配或空输入返回 null", () => {
    expect(matchCatalogEntry(index, "gpt-5")).toBeNull();
    expect(matchCatalogEntry(index, "   ")).toBeNull();
  });

  it("模糊匹配：小版本号写法差异也能命中最可能的一条", () => {
    const fuzzyIndex = buildCatalogIndex([
      entry("deepseek/deepseek-v4.1-flash", "DeepSeek V4.1 Flash"),
      entry("deepseek/deepseek-v4-flash", "DeepSeek V4 Flash"),
    ]);
    // 归一化后完全一致 → 直接命中（1000 分）
    expect(matchCatalogEntry(fuzzyIndex, "deepseek-v4.1-flash")?.catalogId).toBe(
      "deepseek/deepseek-v4.1-flash",
    );
  });

  it("模糊匹配：只在候选足够相似时才返回，否则 null", () => {
    const fuzzyIndex = buildCatalogIndex([entry("acme/some-very-specific-model", "Specific")]);
    // 词元完全不相交 → 放弃
    expect(matchCatalogEntry(fuzzyIndex, "totally-different-thing")).toBeNull();
  });

  it("模糊匹配：多候选时取分数最高者（而非字典序最小）", () => {
    const fuzzyIndex = buildCatalogIndex([
      entry("a-provider/deepseek-v4", "V4"),
      entry("z-provider/deepseek-v4-flash", "V4 Flash"),
    ]);
    // "deepseek-v4-flash" 归一化后与 z-provider 的尾部完全一致，分数更高
    expect(matchCatalogEntry(fuzzyIndex, "deepseek-v4-flash")?.catalogId).toBe(
      "z-provider/deepseek-v4-flash",
    );
  });
});
