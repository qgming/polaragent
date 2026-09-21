/**
 * 输入框「智能体模式」chip 的测试（ui project / jsdom）。
 *
 * 这个 chip 是模式功能的**唯一用户可见面**，而且它有两个容易搞错的地方：
 *
 * 1. **它写的是会话，不是设置**。权限 chip 写 `settings.permissionMode`（全局信任级别），
 *    而这个写会话索引（`sessions:set-mode`），`settings.agentMode` 只是新会话的默认值。
 *    写错地方的症状是「换个会话，模式跟着变了」——很容易被当成 feature 而不是 bug。
 * 2. **显示的是「生效值」**（会话绑定 ?? 设置默认），不是绑定值本身。
 *    只显示绑定值的话，没绑定过的会话会显示成空的或某个假的默认。
 *
 * 挂的是真 Composer + 真 store，只换掉 window.oint 的输出边界。
 */

import { AssistantRuntimeProvider, useExternalStoreRuntime } from "@assistant-ui/react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/renderer/i18n";
import { toThreadMessage } from "@/renderer/runtime/message-converter";
import { useChatStore } from "@/renderer/stores/chat-store";
import { useSettingsStore } from "@/renderer/stores/settings-store";
import type { AgentMode, SetSessionModeResult } from "@/shared/contracts";
import type { ChatMessage, SessionSummary } from "@/shared/contracts/session";
import type { Settings } from "@/shared/contracts/settings";
import { Composer } from "./Composer";

afterEach(cleanup);

beforeAll(async () => {
  await i18n.changeLanguage("zh-CN");
});

const SESSION_ID = "s1";
const EMPTY_MESSAGES: ChatMessage[] = [];

/** 会话夹具；agentMode = 该会话自己绑定的模式（null / 缺省 = 跟随默认） */
function session(agentMode: AgentMode | null): SessionSummary {
  return {
    id: SESSION_ID,
    title: "会话",
    createdAt: 0,
    updatedAt: 0,
    cwd: "D:\\proj",
    archived: false,
    pinned: false,
    messageCount: 0,
    model: null,
    agentMode,
  };
}

/** setMode 的返回值可控：用来验「运行中被拒绝」时给出说明 */
let setModeResult: SetSessionModeResult = { ok: true };
let setModeCalls: { id: string; mode: AgentMode | null }[] = [];

function stubBridge() {
  setModeResult = { ok: true };
  setModeCalls = [];
  vi.stubGlobal("oint", {
    skills: { list: vi.fn(async () => []) },
    prompts: { list: vi.fn(async () => []) },
    sessions: {
      setMode: vi.fn(async (id: string, mode: AgentMode | null) => {
        setModeCalls.push({ id, mode });
        return setModeResult;
      }),
    },
  });
}

function seedStores(options: {
  defaultMode?: AgentMode;
  sessionMode?: AgentMode | null;
  running?: boolean;
}) {
  useChatStore.setState({
    sessions: [session(options.sessionMode ?? null)],
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
      services: [],
      defaultModel: null,
      thinkingLevel: "medium",
      permissionMode: "default",
      agentMode: options.defaultMode ?? "standard",
      disabledSkillNames: [],
      disabledSubagentNames: [],
      mcpServers: [],
    } satisfies Settings,
    loaded: true,
  });
}

function Harness() {
  const runtime = useExternalStoreRuntime<ChatMessage>({
    messages: EMPTY_MESSAGES,
    isRunning: false,
    convertMessage: toThreadMessage,
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

beforeEach(() => {
  stubBridge();
});

describe("AgentModeChip 的摆放位置", () => {
  /**
   * **模式 chip 必须在权限 chip 的左侧**（用户明确要求的位置）。
   *
   * 这条断言存在的理由：这个顺序实现时**真的搞反过一次**（模式被放到了权限右边），
   * 而那种错误没有任何功能症状 —— 两个 chip 都能点、都生效，只是位置不对，
   * 所以只有断言才拦得住它。用 DOM 顺序比较，而不是「谁先出现」的模糊判断。
   */
  it("排在权限 chip 的左边", async () => {
    seedStores({ sessionMode: null });
    render(<Harness />);

    const modeChip = await screen.findByRole("button", { name: "智能体模式" });
    const permissionChip = screen.getByRole("button", { name: "权限模式" });

    // compareDocumentPosition 的 DOCUMENT_POSITION_FOLLOWING (4) 表示权限 chip 在模式之后
    expect(modeChip.compareDocumentPosition(permissionChip) & 4).toBeTruthy();
  });

  it("也排在模型与思考 chip 的左边（模式是这一排最靠前的选择）", async () => {
    seedStores({ sessionMode: null });
    render(<Harness />);

    const modeChip = await screen.findByRole("button", { name: "智能体模式" });
    for (const name of ["模型", "思考等级"]) {
      const other = screen.getByRole("button", { name });
      expect(modeChip.compareDocumentPosition(other) & 4).toBeTruthy();
    }
  });
});

describe("AgentModeChip 显示的生效模式", () => {
  it("会话没绑定过时显示设置里的默认模式", async () => {
    seedStores({ defaultMode: "orchestrate", sessionMode: null });
    render(<Harness />);

    const trigger = await screen.findByRole("button", { name: "智能体模式" });
    expect(trigger.textContent).toContain("编排者");
  });

  it("会话绑定过时**优先于**设置默认", async () => {
    // 设置默认编排者，会话绑定了智能体 → 显示智能体（与主进程装配提示时的判定一致）
    seedStores({ defaultMode: "orchestrate", sessionMode: "standard" });
    render(<Harness />);

    const trigger = await screen.findByRole("button", { name: "智能体模式" });
    expect(trigger.textContent).toContain("智能体");
    expect(trigger.textContent).not.toContain("编排者");
  });

  it("没绑定过时不显示「我改过这个会话」的记号，绑定过才显示", async () => {
    seedStores({ sessionMode: null });
    const { unmount } = render(<Harness />);
    const unbound = await screen.findByRole("button", { name: "智能体模式" });
    expect(unbound.textContent).not.toContain("·");
    unmount();

    seedStores({ sessionMode: "orchestrate" });
    render(<Harness />);
    const bound = await screen.findByRole("button", { name: "智能体模式" });
    expect(bound.textContent).toContain("·");
  });
});

describe("AgentModeChip 的菜单", () => {
  it("列出两个模式，并各自说明它改了什么", async () => {
    seedStores({ sessionMode: null });
    render(<Harness />);
    await openChip("智能体模式");

    // 名字（智能体 / 编排者）自己说明不了差别，所以每个选项都带一句说明
    expect(screen.getByText("自己判断任务类型，该做的直接做")).toBeDefined();
    expect(screen.getByText("先派子智能体去做，自己负责计划与验收")).toBeDefined();
  });

  it("选中项标出当前生效的那个", async () => {
    seedStores({ defaultMode: "orchestrate", sessionMode: null });
    render(<Harness />);
    await openChip("智能体模式");

    const pressed = screen
      .getAllByRole("button")
      .filter((button) => button.getAttribute("aria-pressed") === "true");
    expect(pressed).toHaveLength(1);
    expect(pressed[0]?.textContent).toContain("编排者");
  });
});

describe("AgentModeChip 的写入", () => {
  it("选一个模式 → 写**会话**（不是设置），并带上会话 id", async () => {
    seedStores({ defaultMode: "standard", sessionMode: null });
    render(<Harness />);
    await openChip("智能体模式");

    fireEvent.click(screen.getByText("编排者").closest("button") as HTMLElement);

    await waitFor(() => expect(setModeCalls).toEqual([{ id: SESSION_ID, mode: "orchestrate" }]));
  });

  it("写入成功后 chip 立即显示新模式（会话级就地更新）", async () => {
    seedStores({ defaultMode: "standard", sessionMode: null });
    render(<Harness />);
    const trigger = await openChip("智能体模式");

    fireEvent.click(screen.getByText("编排者").closest("button") as HTMLElement);

    await waitFor(() => expect(trigger.textContent).toContain("编排者"));
    // 会话索引里也写上了，切走再回来仍是新模式
    expect(useChatStore.getState().sessions[0]?.agentMode).toBe("orchestrate");
  });

  it("运行中 chip 禁用，点不开（主进程也会拒绝，这里省掉一次注定失败的往返）", async () => {
    seedStores({ sessionMode: null, running: true });
    render(<Harness />);

    const trigger = await screen.findByRole("button", { name: "智能体模式" });
    expect((trigger as HTMLButtonElement).disabled).toBe(true);
    expect(setModeCalls).toEqual([]);
  });

  it("被主进程拒绝时给出说明，而不是静默失败", async () => {
    setModeResult = { ok: false, reason: "running" };
    seedStores({ sessionMode: null });
    render(<Harness />);
    await openChip("智能体模式");

    // 菜单里再点一次：这次写入会被拒绝（模拟「刚好在点下去的瞬间开始跑了」）
    fireEvent.click(screen.getByText("编排者").closest("button") as HTMLElement);

    await waitFor(() => expect(screen.getByText(/运行中不能切换模式/)).toBeDefined());
  });
});
