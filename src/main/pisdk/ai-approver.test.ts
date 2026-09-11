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
  it("未选择默认路由模型时安全拒绝", async () => {
    const approver = createAiApprover({ getSettings: async () => makeSettings() });
    await expect(approver({ toolName: "write", argsText: "{}" })).resolves.toEqual({
      allow: false,
      reason: "未选择默认模型，已拒绝",
    });
  });

  it("读取设置失败时安全拒绝（用中性语言兜底）", async () => {
    const approver = createAiApprover({
      getSettings: async () => {
        throw new Error("磁盘错误");
      },
    });
    const result = await approver({ toolName: "write", argsText: "{}" });
    expect(result.allow).toBe(false);
    expect(result.reason).toContain("Failed to read settings");
  });
  it("系统提示词说明角色，用户消息用内置英文模板填入这次调用", async () => {
    let seen: { systemPrompt?: string; content?: string } = {};
    const models = fakeModels({ text: '{"allow": true, "reason": "ok"}' });
    const approver = createAiApprover({
      getSettings: async () => configuredSettings(),
      buildModels: () => {
        const fake = models as unknown as {
          completeSimple: (
            model: unknown,
            params: { systemPrompt?: string; messages?: { content?: unknown }[] },
          ) => unknown;
        };
        return {
          completeSimple: (
            model: unknown,
            params: { systemPrompt?: string; messages?: { content?: unknown }[] },
          ) => {
            seen = {
              systemPrompt: params.systemPrompt,
              content:
                typeof params.messages?.[0]?.content === "string"
                  ? params.messages[0].content
                  : undefined,
            };
            return fake.completeSimple(model, params);
          },
        } as unknown as typeof models;
      },
    });

    await approver({ toolName: "write", argsText: '{"path":"a.ts"}', workingDir: "D:/work" });
    expect(seen.systemPrompt).toContain("tool-call safety reviewer for Oint");
    expect(seen.content).toContain("Tool: write");
    expect(seen.content).toContain('{"path":"a.ts"}');
    expect(seen.content).toContain("Working directory: D:/work");
    // 理由语言跟随界面语言（zh-CN）
    expect(seen.content).toContain("written in Simplified Chinese");
    expect(seen.content).not.toContain("{{");
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

  it("英文界面下的兜底理由也是英文", async () => {
    const approver = createAiApprover({
      getSettings: async () => configuredSettings({ language: "en-US" }),
      buildModels: () => fakeModels({ text: "I think it is fine" }),
    });
    await expect(approver({ toolName: "bash", argsText: "{}" })).resolves.toEqual({
      allow: false,
      reason: "AI verdict could not be parsed — denied",
    });
  });

  it("英文界面且未选默认模型时拒绝理由为英文", async () => {
    const approver = createAiApprover({
      getSettings: async () => makeSettings({ language: "en-US" }),
    });
    await expect(approver({ toolName: "write", argsText: "{}" })).resolves.toEqual({
      allow: false,
      reason: "No default model selected — denied",
    });
  });
});
