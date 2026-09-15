/**
 * 输入框两个 chip 的联动测试（ui project / jsdom）：**模型 chip 切会话模型**、
 * **思考 chip 按会话实际使用的模型列档位**。
 *
 * 这两条是本功能的用户可见面：模型是会话级的（不是全局默认），切换要即时生效；
 * 思考档位必须跟着「这个会话真正在用的模型」走，否则会出现「chip 按新模型显示、
 * 请求按旧模型发」。
 *
 * 挂的是真 Composer + 真 runtime + 真 store，只换掉 window.oint 的输出边界。
 */

import { AssistantRuntimeProvider, useExternalStoreRuntime } from "@assistant-ui/react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/renderer/i18n";
import { toThreadMessage } from "@/renderer/runtime/message-converter";
import { useChatStore } from "@/renderer/stores/chat-store";
import { useSettingsStore } from "@/renderer/stores/settings-store";
import type { ModelRef, SetSessionModelResult } from "@/shared/contracts";
import type { ChatMessage, SessionSummary } from "@/shared/contracts/session";
import type { ModelEntry, Settings } from "@/shared/contracts/settings";
import { Composer } from "./Composer";

// vitest 未开 globals，RTL 的自动清理不会注册，必须手动
afterEach(cleanup);

beforeAll(async () => {
  await i18n.changeLanguage("zh-CN");
});

const SESSION_ID = "s1";

const EMPTY_MESSAGES: ChatMessage[] = [];

/** 会话夹具；model = 该会话自己绑定的模型（null = 跟随默认） */
function session(model: ModelRef | null): SessionSummary {
  return {
    id: SESSION_ID,
    title: "会话",
    createdAt: 0,
    updatedAt: 0,
    cwd: "D:\\proj",
    archived: false,
    pinned: false,
    messageCount: 0,
    model,
  };
}

/** setModel 的返回值可控：用来验「运行中被拒绝」时菜单不关、并给出说明 */
let setModelResult: SetSessionModelResult = { ok: true };

/** Composer 挂载时会拉这两个清单；顺带记录 sessions.setModel 的调用 */
function stubBridge() {
  setModelResult = { ok: true };
  vi.stubGlobal("oint", {
    skills: { list: vi.fn(async () => []) },
    prompts: { list: vi.fn(async () => []) },
    sessions: { setModel: vi.fn(async () => setModelResult) },
  });
}

/** 灌 store：一个活跃会话 + 一个服务里两个模型（m1 为默认，m2 可被会话绑定） */
function seedStores(options: {
  models: ModelEntry[];
  defaultModelId: string;
  sessionModel?: ModelRef | null;
  thinkingLevel?: Settings["thinkingLevel"];
  running?: boolean;
}) {
  useChatStore.setState({
    sessions: [session(options.sessionModel ?? null)],
    activeSessionId: SESSION_ID,
    messagesBySession: {},
    loadedSessions: {},
    runningBySession: options.running === true ? { [SESSION_ID]: true } : {},
    queueBySession: {},
  });
  useSettingsStore.setState({
    settings: {
      theme: "light",
      language: "zh-CN",
      density: "comfortable",
      chatFont: "",
      chatFontSize: 14,
      defaultWorkingDir: null,
      services: [
        {
          id: "svc",
          name: "服务",
          baseUrl: "https://api.test/v1",
          apiKey: "",
          wireFormat: "openai-completions",
          models: options.models,
        },
      ],
      defaultModel: { serviceId: "svc", modelId: options.defaultModelId },
      thinkingLevel: options.thinkingLevel ?? "medium",
      permissionMode: "default",
      skillDirs: [],
      disabledSkillNames: [],
      skillsEnabled: true,
      promptTemplateDirs: [],
      subagentsEnabled: true,
      disabledSubagentNames: [],
      mcpServers: [],
    },
    loaded: true,
  });
}

function Harness() {
  const runtime = useExternalStoreRuntime<ChatMessage>({
    messages: EMPTY_MESSAGES,
    isRunning: false,
    convertMessage: toThreadMessage,
    // 这个用例不发送消息；给了 convertMessage 就必须一并给 onNew（库的类型要求）
    onNew: async () => {},
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Composer />
    </AssistantRuntimeProvider>
  );
}

/** 打开某个 chip 的弹层（触发键的无障碍名就是它的 aria-label） */
async function openChip(name: string) {
  const trigger = await screen.findByRole("button", { name });
  fireEvent.click(trigger);
  await waitFor(() => expect(trigger.getAttribute("aria-expanded")).toBe("true"));
  return trigger;
}

/** 弹层里那一排档位按钮的文案（顺序即渲染顺序） */
function levelLabels(): string[] {
  // 档位按钮都是 aria-pressed 的按钮；触发键本身不是
  return screen
    .getAllByRole("button")
    .filter((button) => button.getAttribute("aria-pressed") !== null)
    .map((button) => button.textContent ?? "");
}

const M1: ModelEntry = {
  id: "m1",
  name: "模型一",
  reasoning: true,
  thinkingLevels: ["off", "high"],
};
const M2: ModelEntry = {
  id: "m2",
  name: "模型二",
  reasoning: true,
  thinkingLevels: ["off", "medium"],
};

describe("思考 chip", () => {
  beforeEach(stubBridge);

  it("模型配了哪几档就只列哪几档（目录值，用户可改）", async () => {
    seedStores({ models: [M1], defaultModelId: "m1" });
    render(<Harness />);
    await openChip("思考等级");

    expect(levelLabels()).toEqual(["关闭", "高"]);
  });

  it("设置里的档位不被模型支持 → chip 显示降级后的档位，并给出说明", async () => {
    seedStores({ models: [M1], defaultModelId: "m1", thinkingLevel: "medium" });
    render(<Harness />);

    // 触发键上显示的是「实际会发出去」的档位（高），不是设置里的中
    const trigger = await screen.findByRole("button", { name: "思考等级" });
    expect(trigger.textContent).toContain("高");
    expect(trigger.textContent).not.toContain("中");

    fireEvent.click(trigger);
    expect(await screen.findByText("该模型不支持「中」，已按「高」发送")).toBeTruthy();
  });

  it("非推理模型：只剩「关闭」，设置里的档位被降级并提示", async () => {
    seedStores({
      models: [{ id: "m1", reasoning: false }],
      defaultModelId: "m1",
      thinkingLevel: "high",
    });
    render(<Harness />);
    await openChip("思考等级");

    expect(levelLabels()).toEqual(["关闭"]);
    expect(screen.getByText("该模型不支持「高」，已按「关闭」发送")).toBeTruthy();
  });

  it("没配档位但标了推理模型 → 五档全列，且不提示", async () => {
    seedStores({
      models: [{ id: "m1", reasoning: true }],
      defaultModelId: "m1",
      thinkingLevel: "high",
    });
    render(<Harness />);
    await openChip("思考等级");

    expect(levelLabels()).toEqual(["关闭", "最少", "低", "中", "高"]);
    expect(screen.queryByText(/该模型不支持/)).toBeNull();
  });

  it("点某一档会写回设置（chip 与实际请求同源）", async () => {
    seedStores({ models: [M1], defaultModelId: "m1", thinkingLevel: "off" });
    render(<Harness />);
    await openChip("思考等级");

    fireEvent.click(screen.getByRole("button", { name: "高" }));
    await waitFor(() => expect(useSettingsStore.getState().settings?.thinkingLevel).toBe("high"));
  });

  it("档位按**会话绑定的**模型列，而不是全局默认模型", async () => {
    // 默认是 m1（只支持 off/high），但会话绑定到 m2（支持 off/medium）
    seedStores({
      models: [M1, M2],
      defaultModelId: "m1",
      sessionModel: { serviceId: "svc", modelId: "m2" },
    });
    render(<Harness />);
    await openChip("思考等级");

    expect(levelLabels()).toEqual(["关闭", "中"]);
  });
});

describe("模型 chip（会话级切换）", () => {
  beforeEach(stubBridge);

  it("显示会话实际使用的模型；未绑定时跟随默认", async () => {
    seedStores({ models: [M1, M2], defaultModelId: "m2" });
    render(<Harness />);

    const trigger = await screen.findByRole("button", { name: "模型" });
    expect(trigger.textContent).toContain("模型二");
  });

  it("选一个模型会通过 IPC 写到**该会话**，并就地更新列表", async () => {
    seedStores({ models: [M1, M2], defaultModelId: "m1" });
    render(<Harness />);
    await openChip("模型");

    fireEvent.click(screen.getByRole("button", { name: /模型二/ }));

    await waitFor(() =>
      expect(window.oint.sessions.setModel).toHaveBeenCalledWith(SESSION_ID, {
        serviceId: "svc",
        modelId: "m2",
      }),
    );
    // 会话列表里的绑定同步更新，chip 与思考档位据此重算
    await waitFor(() =>
      expect(useChatStore.getState().sessions[0]?.model).toEqual({
        serviceId: "svc",
        modelId: "m2",
      }),
    );
    // 成功后菜单收起
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "模型" }).getAttribute("aria-expanded")).toBe(
        "false",
      ),
    );
  });

  it("菜单里只有具体模型：没有「跟随默认」这类额外选项", async () => {
    seedStores({
      models: [M1, M2],
      defaultModelId: "m1",
      sessionModel: { serviceId: "svc", modelId: "m2" },
    });
    render(<Harness />);
    await openChip("模型");

    // 只列模型行（每行都是模型名），不存在「跟随默认模型」这种行
    expect(screen.queryByText(/跟随默认/)).toBeNull();
    expect(screen.getByRole("button", { name: /模型一/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /模型二/ })).toBeTruthy();
    // 当前会话指定的模型被标为选中
    expect(screen.getByRole("button", { name: /模型二/ }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(screen.getByRole("button", { name: /模型一/ }).getAttribute("aria-pressed")).toBe(
      "false",
    );
  });

  it("未指定过模型的会话：菜单同样只列模型，默认模型被标为选中", async () => {
    seedStores({ models: [M1, M2], defaultModelId: "m1" });
    render(<Harness />);
    await openChip("模型");

    expect(screen.queryByText(/跟随默认/)).toBeNull();
    expect(screen.getByRole("button", { name: /模型一/ }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("运行中被拒绝时：菜单不关，并在菜单里说明原因", async () => {
    setModelResult = { ok: false, reason: "running" };
    seedStores({ models: [M1, M2], defaultModelId: "m1" });
    render(<Harness />);
    const trigger = await openChip("模型");

    fireEvent.click(screen.getByRole("button", { name: /模型二/ }));

    expect(await screen.findByText("运行中不能切换模型，先停止本轮")).toBeTruthy();
    // 失败时不关菜单：关掉就看不到原因了
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    // 也没有把绑定写进本地状态
    expect(useChatStore.getState().sessions[0]?.model).toBeNull();
  });

  it("目标模型不存在时给出另一条说明", async () => {
    setModelResult = { ok: false, reason: "no-model" };
    seedStores({ models: [M1, M2], defaultModelId: "m1" });
    render(<Harness />);
    await openChip("模型");

    fireEvent.click(screen.getByRole("button", { name: /模型二/ }));

    expect(await screen.findByText("该模型当前不可用（服务或模型可能已被删除）")).toBeTruthy();
  });
});
