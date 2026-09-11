// ai-approver 单测：只验证安全拒绝与解析分支；通过注入假 models 完全避免网络请求。
import type { MutableModels } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { ModelServiceConfig, Settings } from "@/shared/contracts/settings";
import { createAiApprover } from "./ai-approver";

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    theme: "system",
    language: "zh-CN",
    density: "comfortable",
    chatFont: "",
    chatFontSize: 14,
    defaultWorkingDir: null,
    services: [],
    defaultModel: null,
    thinkingLevel: "medium",
    permissionMode: "default",
    aiApprovalModel: null,
    skillDirs: [],
    disabledSkillNames: [],
    ...overrides,
  };
}

const service: ModelServiceConfig = {
  id: "svc-a",
  name: "服务 A",
  baseUrl: "https://api.test/v1",
  apiKey: "sk-test",
  wireFormat: "openai-completions",
  models: [{ id: "m1" }],
};

/** 假 completeSimple：返回固定文本或抛指定异常，不触碰网络 */
function fakeModels(behavior: { text?: string; error?: unknown }): MutableModels {
  return {
    completeSimple: async () => {
      if (behavior.error !== undefined) throw behavior.error;
      return {
        role: "assistant",
        content: [{ type: "text", text: behavior.text ?? "" }],
        api: "openai-completions",
        provider: "svc-a",
        model: "m1",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      };
    },
  } as unknown as MutableModels;
}

function configuredSettings(overrides: Partial<Settings> = {}): Settings {
  return makeSettings({
    services: [service],
    defaultModel: { serviceId: "svc-a", modelId: "m1" },
    ...overrides,
  });
}

describe("createAiApprover", () => {
  it("未配置模型时安全拒绝", async () => {
    const approver = createAiApprover({ getSettings: async () => makeSettings() });
    await expect(approver({ toolName: "write", argsText: "{}" })).resolves.toEqual({
      allow: false,
      reason: "未配置审批模型",
    });
  });

  it("读取设置失败时安全拒绝", async () => {
    const approver = createAiApprover({
      getSettings: async () => {
        throw new Error("磁盘错误");
      },
    });
    const result = await approver({ toolName: "write", argsText: "{}" });
    expect(result.allow).toBe(false);
    expect(result.reason).toContain("读取设置失败");
  });

  it("解析模型输出的 JSON 决定（代码块包裹也可识别）", async () => {
    const approver = createAiApprover({
      getSettings: async () => configuredSettings(),
      buildModels: () =>
        fakeModels({ text: '```json\n{"allow": true, "reason": "读取目录安全"}\n```' }),
    });
    await expect(approver({ toolName: "bash", argsText: '{"command":"ls"}' })).resolves.toEqual({
      allow: true,
      reason: "读取目录安全",
    });
  });

  it("非法输出默认拒绝", async () => {
    const approver = createAiApprover({
      getSettings: async () => configuredSettings(),
      buildModels: () => fakeModels({ text: "我觉得没问题" }),
    });
    await expect(approver({ toolName: "bash", argsText: "{}" })).resolves.toEqual({
      allow: false,
      reason: "AI 审批结果解析失败，已拒绝",
    });
  });

  it("allow 字段非布尔值默认拒绝", async () => {
    const approver = createAiApprover({
      getSettings: async () => configuredSettings(),
      buildModels: () => fakeModels({ text: '{"allow": "yes", "reason": "ok"}' }),
    });
    await expect(approver({ toolName: "bash", argsText: "{}" })).resolves.toEqual({
      allow: false,
      reason: "AI 审批结果缺少 allow 字段，已拒绝",
    });
  });

  it("超时按拒绝处理", async () => {
    const timeout = new Error("aborted");
    timeout.name = "TimeoutError";
    const approver = createAiApprover({
      getSettings: async () => configuredSettings(),
      buildModels: () => fakeModels({ error: timeout }),
    });
    await expect(approver({ toolName: "bash", argsText: "{}" })).resolves.toEqual({
      allow: false,
      reason: "AI 审批超时，已拒绝",
    });
  });
});
