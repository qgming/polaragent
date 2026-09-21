/**
 * 「会话实际用哪个模型」的判定（主进程与渲染层共用同一份）。
 *
 * 这层被两处消费：主进程据此决定请求发给谁，chip 与思考档位据此渲染。所以它必须只有一份
 * 实现 —— 这个文件就是把语义钉住的地方。
 */

import { describe, expect, it } from "vitest";
import type { ModelRef } from "./contracts/common";
import type { Settings } from "./contracts/settings";
import { DEFAULT_WEB_SEARCH_SETTINGS } from "./contracts/web";
import { hasModel, resolveEffectiveModelRef } from "./model-ref";

function settings(over: Partial<Settings> = {}): Settings {
  return {
    theme: "system",
    language: "zh-CN",
    density: "comfortable",
    chatFont: "",
    chatFontSize: 14,
    services: [
      {
        id: "svc-a",
        name: "A",
        baseUrl: "https://a.test/v1",
        apiKey: "",
        wireFormat: "openai-completions",
        models: [{ id: "a1" }, { id: "a2" }],
      },
      {
        id: "svc-b",
        name: "B",
        baseUrl: "https://b.test/v1",
        apiKey: "",
        wireFormat: "openai-completions",
        models: [{ id: "b1" }],
      },
    ],
    defaultModel: { serviceId: "svc-a", modelId: "a1" },
    thinkingLevel: "medium",
    permissionMode: "default",
    agentMode: "standard",
    disabledSkillNames: [],
    disabledSubagentNames: [],
    mcpServers: [],
    webSearch: DEFAULT_WEB_SEARCH_SETTINGS,
    ...over,
  };
}

describe("hasModel", () => {
  it("服务与模型都在才算可用", () => {
    expect(hasModel(settings(), { serviceId: "svc-a", modelId: "a2" })).toBe(true);
    expect(hasModel(settings(), { serviceId: "svc-a", modelId: "nope" })).toBe(false);
    expect(hasModel(settings(), { serviceId: "nope", modelId: "a1" })).toBe(false);
    expect(hasModel(settings(), null)).toBe(false);
  });

  it("服务存在但没有 baseUrl / 没有模型时不可用（与 providers 的装配口径一致）", () => {
    const broken = settings({
      services: [
        {
          id: "svc-a",
          name: "A",
          baseUrl: "   ",
          apiKey: "",
          wireFormat: "openai-completions",
          models: [{ id: "a1" }],
        },
      ],
    });
    expect(hasModel(broken, { serviceId: "svc-a", modelId: "a1" })).toBe(false);
  });
});

describe("resolveEffectiveModelRef", () => {
  it("会话绑定优先于默认模型", () => {
    const bound: ModelRef = { serviceId: "svc-b", modelId: "b1" };
    expect(resolveEffectiveModelRef(settings(), bound)).toEqual(bound);
  });

  it("没绑定时用默认模型", () => {
    expect(resolveEffectiveModelRef(settings(), null)).toEqual({
      serviceId: "svc-a",
      modelId: "a1",
    });
  });

  it("绑定失效（服务/模型被删）时回落默认，而不是卡在坏值上", () => {
    expect(resolveEffectiveModelRef(settings(), { serviceId: "gone", modelId: "x" })).toEqual({
      serviceId: "svc-a",
      modelId: "a1",
    });
  });

  it("默认模型也失效时返回 null（调用方据此提示先配置模型）", () => {
    const none = settings({ defaultModel: { serviceId: "gone", modelId: "x" } });
    expect(resolveEffectiveModelRef(none, null)).toBeNull();
    expect(resolveEffectiveModelRef(none, { serviceId: "gone", modelId: "y" })).toBeNull();
  });
});
