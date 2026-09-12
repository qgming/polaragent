/**
 * 思考档位的解析（渲染层口径）与「目录 → 配置」补丁。
 *
 * 这两处决定用户看到什么、以及自动匹配会不会覆盖用户的修改，都是行为契约，值得钉住：
 * 就近降级的规则必须与内核一致，否则 chip 上显示「高」而请求发的是「中」。
 */

import { describe, expect, it } from "vitest";
import type { ModelCatalogEntry } from "@/shared/contracts/models";
import type { ModelEntry } from "@/shared/contracts/settings";
import { catalogPatch, hasManualCapability } from "../settings/model-entry";
import { clampLevel, resolveThinking, supportedLevels, thinkingLabelKey } from "./thinking";

describe("supportedLevels", () => {
  it("显式配过就以此为准，并按强弱顺序排好", () => {
    const entry: ModelEntry = {
      id: "m",
      reasoning: true,
      thinkingLevels: ["high", "off", "medium"],
    };
    expect(supportedLevels(entry)).toEqual(["off", "medium", "high"]);
  });

  it("没配过时按 reasoning 推断", () => {
    expect(supportedLevels({ id: "m", reasoning: true })).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
    ]);
    expect(supportedLevels({ id: "m", reasoning: false })).toEqual(["off"]);
    expect(supportedLevels({ id: "m" })).toEqual(["off"]);
  });

  it("非推理模型即使配了档位也只有「关闭」（内核不会发 reasoning，列出来就是假承诺）", () => {
    expect(supportedLevels({ id: "m", reasoning: false, thinkingLevels: ["off", "high"] })).toEqual(
      ["off"],
    );
    expect(supportedLevels({ id: "m", thinkingLevels: ["low", "high"] })).toEqual(["off"]);
  });

  it("空数组视为「没有信息」，退回推断（而不是「一档都不能选」）", () => {
    expect(supportedLevels({ id: "m", reasoning: true, thinkingLevels: [] })).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
    ]);
  });

  it("只含未知取值的数组同样退回推断", () => {
    const entry = { id: "m", reasoning: true, thinkingLevels: ["nonsense" as never] };
    expect(supportedLevels(entry)).toHaveLength(5);
  });
});

describe("clampLevel（与内核同款就近规则）", () => {
  it("支持就直接返回", () => {
    expect(clampLevel(["off", "medium"], "medium")).toBe("medium");
  });

  it("不支持时优先往高找（宁可多想一点，也不悄悄降智）", () => {
    expect(clampLevel(["off", "medium", "high"], "low")).toBe("medium");
  });

  it("往高找不到才往低找", () => {
    expect(clampLevel(["off", "medium"], "high")).toBe("medium");
  });

  it("只有一档时就是它", () => {
    expect(clampLevel(["off"], "high")).toBe("off");
  });
});

describe("resolveThinking", () => {
  it("模型支持设置里的档位 → 原样，不提示", () => {
    const result = resolveThinking("high", { id: "m", reasoning: true });
    expect(result).toEqual({
      wanted: "high",
      levels: ["off", "minimal", "low", "medium", "high"],
      level: "high",
      clamped: false,
    });
  });

  it("模型不支持 → 就近降级并标记 clamped", () => {
    const result = resolveThinking("high", {
      id: "m",
      reasoning: true,
      thinkingLevels: ["off", "medium"],
    });
    expect(result.level).toBe("medium");
    expect(result.clamped).toBe(true);
    expect(result.wanted).toBe("high");
  });

  it("非推理模型只列关闭，且把设置里的档位降到关闭", () => {
    const result = resolveThinking("medium", { id: "m", reasoning: false });
    expect(result.levels).toEqual(["off"]);
    expect(result.level).toBe("off");
    expect(result.clamped).toBe(true);
  });

  it("没有模型信息时不限制（没有任何依据去限制用户）", () => {
    const result = resolveThinking("medium", null);
    expect(result.levels).toHaveLength(5);
    expect(result.level).toBe("medium");
    expect(result.clamped).toBe(false);
  });
});

describe("thinkingLabelKey", () => {
  it("每一档都有对应词条键", () => {
    expect(thinkingLabelKey("off")).toBe("chat.thinkingOff");
    expect(thinkingLabelKey("minimal")).toBe("chat.thinkingMinimal");
    expect(thinkingLabelKey("low")).toBe("chat.thinkingLow");
    expect(thinkingLabelKey("medium")).toBe("chat.thinkingMedium");
    expect(thinkingLabelKey("high")).toBe("chat.thinkingHigh");
  });
});

describe("catalogPatch（匹配后自动填什么）", () => {
  const entry = (over: Partial<ModelCatalogEntry> = {}): ModelCatalogEntry => ({
    catalogId: "anthropic/claude-opus-4-5",
    name: "Claude Opus 4.5",
    contextWindow: 200000,
    maxTokens: 64000,
    reasoning: true,
    input: ["text", "image"],
    supportsImages: true,
    supportedThinking: ["minimal", "low", "medium", "high"],
    thinkingSource: "pi-ai",
    ...over,
  });

  it("元数据与能力一起写入", () => {
    expect(catalogPatch(entry())).toEqual({
      name: "Claude Opus 4.5",
      contextWindow: 200000,
      maxTokens: 64000,
      reasoning: true,
      acceptsImages: true,
      thinkingLevels: ["minimal", "low", "medium", "high"],
    });
  });

  it("档位是推断值（非目录）时不写进配置：猜测不该固化成用户配置", () => {
    const patch = catalogPatch(entry({ thinkingSource: "reasoning" }));
    expect(patch.acceptsImages).toBe(true);
    expect(patch).not.toHaveProperty("thinkingLevels");
  });

  it("目录说不支持图片时写入 false（而不是留空）", () => {
    expect(catalogPatch(entry({ supportsImages: false })).acceptsImages).toBe(false);
  });
});

describe("hasManualCapability", () => {
  it("默认（未配）为 false，配过任一项即为 true", () => {
    expect(hasManualCapability({ id: "m" })).toBe(false);
    expect(hasManualCapability({ id: "m", acceptsImages: false })).toBe(true);
    expect(hasManualCapability({ id: "m", thinkingLevels: ["off"] })).toBe(true);
  });
});
