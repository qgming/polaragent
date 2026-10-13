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

import {
  type AppendMessage,
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/renderer/components/ui/tooltip";
import i18n from "@/renderer/i18n";
import { toThreadMessage } from "@/renderer/runtime/message-converter";
import { useChatStore } from "@/renderer/stores/chat-store";
import { useSettingsStore } from "@/renderer/stores/settings-store";
import type { AgentMode } from "@/shared/contracts";
import type { ChatMessage, SessionSummary } from "@/shared/contracts/session";
import type { Settings } from "@/shared/contracts/settings";
import { DEFAULT_WEB_SEARCH_SETTINGS } from "@/shared/contracts/web";
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

/** 记录 setMode 的调用：用来验「运行中也能切」「切了真的发出去」 */
let setModeCalls: { id: string; mode: AgentMode | null }[] = [];

function stubBridge() {
  setModeCalls = [];
  vi.stubGlobal("oint", {
    skills: { list: vi.fn(async () => []) },
    prompts: { list: vi.fn(async () => []) },
    chat: {
      startPlan: vi.fn(async () => ({ ok: true })),
      archivePlan: vi.fn(async () => ({ ok: true })),
      planHistory: vi.fn(async () => []),
      send: vi.fn(async () => undefined),
      controlGoal: vi.fn(async () => ({ ok: true })),
    },
    sessions: {
      list: vi.fn(async () => [session("orchestrate")]),
      setMode: vi.fn(async (id: string, mode: AgentMode | null) => {
        setModeCalls.push({ id, mode });
        // 契约里已无失败分支（见 SessionModeFailure），所以这里不再有可配的返回值
        return { ok: true as const };
      }),
    },
  });
}

function seedStores(options: {
  defaultMode?: AgentMode;
  sessionMode?: AgentMode | null;
  running?: boolean;
  /** 没有活动会话：chip 该禁用（没有可写入的会话） */
  noSession?: boolean;
}) {
  useChatStore.setState({
    sessions: options.noSession === true ? [] : [session(options.sessionMode ?? null)],
    activeSessionId: options.noSession === true ? null : SESSION_ID,
    messagesBySession: {},
    loadedSessions: {},
    runningBySession: options.running === true ? { [SESSION_ID]: true } : {},
    queueBySession: {},
    viewsBySession: {},
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
      systemMcpServerEnabled: {},
      webSearch: DEFAULT_WEB_SEARCH_SETTINGS,
    } satisfies Settings,
    loaded: true,
  });
}

const onNew = vi.fn(async (_message: AppendMessage) => {});

function Harness() {
  const runtime = useExternalStoreRuntime<ChatMessage>({
    messages: EMPTY_MESSAGES,
    isRunning: false,
    convertMessage: toThreadMessage,
    onNew: onNew,
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <TooltipProvider>
        <Composer />
      </TooltipProvider>
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
  onNew.mockClear();
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
    expect(trigger.textContent).toContain("编排");
  });

  it("会话绑定过时**优先于**设置默认", async () => {
    // 设置默认编排，会话绑定了智能体 → 显示智能体（与主进程装配提示时的判定一致）
    seedStores({ defaultMode: "orchestrate", sessionMode: "standard" });
    render(<Harness />);

    const trigger = await screen.findByRole("button", { name: "智能体模式" });
    expect(trigger.textContent).toContain("默认");
    expect(trigger.textContent).not.toContain("编排");
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
  it("只列出默认、编排两种模式，不带选项说明小字", async () => {
    seedStores({ sessionMode: null });
    render(<Harness />);
    await openChip("智能体模式");

    // 生效时机与选项说明这类小字已按产品要求移除，这里守住移除结果
    expect(screen.queryByText("直接处理任务并验证结果")).toBeNull();
    expect(screen.queryByText("按需委派有益的子任务，并整合与验证结果")).toBeNull();
    const modes = screen
      .getAllByRole("button")
      .filter((button) => button.hasAttribute("aria-pressed"));
    expect(modes).toHaveLength(2);
    expect(screen.queryByText("目标", { exact: true })).toBeNull();
  });

  it("选中项标出当前生效的那个", async () => {
    seedStores({ defaultMode: "orchestrate", sessionMode: null });
    render(<Harness />);
    await openChip("智能体模式");

    const pressed = screen
      .getAllByRole("button")
      .filter((button) => button.getAttribute("aria-pressed") === "true");
    expect(pressed).toHaveLength(1);
    expect(pressed[0]?.textContent).toContain("编排");
  });
});

describe("AgentModeChip 的写入", () => {
  it("选一个模式 → 写**会话**（不是设置），并带上会话 id", async () => {
    seedStores({ defaultMode: "standard", sessionMode: null });
    render(<Harness />);
    await openChip("智能体模式");

    fireEvent.click(screen.getByText("编排").closest("button") as HTMLElement);

    await waitFor(() => expect(setModeCalls).toEqual([{ id: SESSION_ID, mode: "orchestrate" }]));
  });

  it("写入成功后 chip 立即显示新模式（会话级就地更新）", async () => {
    seedStores({ defaultMode: "standard", sessionMode: null });
    render(<Harness />);
    const trigger = await openChip("智能体模式");

    fireEvent.click(screen.getByText("编排").closest("button") as HTMLElement);

    await waitFor(() => expect(trigger.textContent).toContain("编排"));
    // 会话索引里也写上了，切走再回来仍是新模式
    expect(useChatStore.getState().sessions[0]?.agentMode).toBe("orchestrate");
  });

  /**
   * 运行中**可以**切换（契约已改，见 shared/contracts/session.ts 的 SessionModeFailure）。
   *
   * 旧行为是「运行中置灰 + 主进程拒绝」，但那条限制在实现上并不成立：
   * 模式只影响系统提示，而系统提示每轮现算，所以写入之后下一轮自然生效，
   * 正在生成的那一轮不受影响。拒绝反而制造了「点了没反应」。
   */
  it("运行中 chip 仍可点，且切换会真的发出去", async () => {
    seedStores({ sessionMode: null, running: true });
    render(<Harness />);
    const trigger = await openChip("智能体模式");

    expect((trigger as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByText("编排").closest("button") as HTMLElement);

    await waitFor(() => expect(setModeCalls).toEqual([{ id: SESSION_ID, mode: "orchestrate" }]));
  });

  /**
   * 「下次发送」这类生效时机小字已按产品要求整体移除（chip 与菜单里都没有），
   * 这里守住移除结果，防止回归时又冒出来。
   */
  it("运行中也不显示生效时机小字（该提示已移除）", async () => {
    seedStores({ sessionMode: null, running: true });
    render(<Harness />);
    await openChip("智能体模式");

    expect(screen.queryByText(/下次发送/)).toBeNull();
  });

  it("没有活动会话时 chip 禁用（没有可写入的会话）", async () => {
    seedStores({ sessionMode: null, noSession: true });
    render(<Harness />);

    const trigger = await screen.findByRole("button", { name: "智能体模式" });
    expect((trigger as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("Native plans and work controls", () => {
  function seedPlan(
    status: "draft" | "ready" | "archived" = "ready",
    execution?: { finished?: boolean },
  ) {
    seedStores({ sessionMode: "standard" });
    const plan = {
      id: "plan-1",
      workId: "work-1",
      revision: 3,
      requirementsRevision: 2,
      status,
      title: "实施方案",
      markdown: "# Native plan\n\nRun the **checks**.",
    };
    useChatStore.setState({
      viewsBySession: {
        [SESSION_ID]: {
          generation: 1,
          revision: 1,
          state: {
            conversationId: 1,
            messages: [],
            reports: {},
            admittedRequestIds: [],
            running: false,
            runId: null,
            queue: [],
            compaction: null,
            usage: {
              uncachedInputTokens: 0,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            },
            workflow: {
              revision: 1,
              goal: null,
              execution: execution
                ? {
                    requestId: "req-1",
                    workId: "work-1",
                    workRevision: 4,
                    planRef: { planId: plan.id, revision: plan.revision },
                    plan,
                    contract: {
                      workId: "work-1",
                      revision: 4,
                      requirementsRevision: 2,
                      effects: "unrestricted",
                      requiresReview: false,
                      pendingInputIds: [],
                      approvedPlanRef: { planId: plan.id, revision: plan.revision },
                    },
                    status: "admitted" as const,
                    ...(execution.finished === undefined ? {} : { finished: execution.finished }),
                  }
                : null,
              work: {
                workId: "work-1",
                revision: 4,
                requirementsRevision: 2,
                effects: "read-only",
                requiresReview: true,
                pendingInputIds: [],
                approvedPlanRef: null,
              },
              plan,
            },
          },
        },
      },
    });
  }

  it("offers only two persistent execution styles", async () => {
    seedStores({});
    render(<Harness />);
    await openChip("智能体模式");
    expect(screen.queryByText("计划")).toBeNull();
    expect(screen.getByText("编排")).toBeDefined();
  });

  it("renders markdown without a filesystem path and starts the exact version", async () => {
    seedPlan();
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "查看计划" }));
    expect(
      within(screen.getByRole("dialog")).getByRole("heading", { name: "Native plan" }),
    ).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "Unsent draft" } });
    fireEvent.click(screen.getByRole("button", { name: "开始计划" }));
    await waitFor(() =>
      expect(window.oint.chat.startPlan).toHaveBeenCalledWith(SESSION_ID, {
        planId: "plan-1",
        revision: 3,
        workId: "work-1",
        workRevision: 4,
        requestId: expect.any(String),
      }),
    );
    expect((screen.getByRole("combobox") as HTMLTextAreaElement).value).toBe("Unsent draft");
    expect(setModeCalls).toEqual([]);
    expect(onNew).not.toHaveBeenCalled();
  });

  it.each(["draft", "archived"] as const)("cannot start a %s plan", (status) => {
    seedPlan(status);
    render(<Harness />);
    expect(screen.queryByRole("button", { name: "开始计划" })).toBeNull();
  });

  it("keeps the dock while the execution is still unfinished", () => {
    seedPlan("ready", {});
    render(<Harness />);
    expect(screen.getByRole("button", { name: "查看计划" })).toBeDefined();
  });

  it("hides the dock once the plan execution finished", () => {
    seedPlan("ready", { finished: true });
    render(<Harness />);
    expect(screen.queryByRole("button", { name: "查看计划" })).toBeNull();
  });

  it("keeps the draft when the selected version is stale", async () => {
    seedPlan();
    vi.mocked(window.oint.chat.startPlan).mockResolvedValueOnce({ ok: false, code: "stale" });
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "开始计划" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("计划版本已更新"));
  });

  it("loads history and displays an immutable older version", async () => {
    seedPlan();
    const plan = useChatStore.getState().viewsBySession[SESSION_ID]?.state.workflow?.plan;
    if (!plan) throw new Error("Missing seeded plan");
    vi.mocked(window.oint.chat.planHistory).mockResolvedValueOnce([
      { ...plan, revision: 1, markdown: "# Earlier version" },
    ]);
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "计划历史" }));
    await waitFor(() => expect(window.oint.chat.planHistory).toHaveBeenCalledWith(SESSION_ID));
    fireEvent.click(await screen.findByRole("button", { name: "实施方案 · 版本 1" }));
    expect(
      within(screen.getByRole("dialog")).getByRole("heading", { name: "Earlier version" }),
    ).toBeDefined();
    expect(
      within(screen.getByRole("dialog")).queryByRole("button", { name: "开始计划" }),
    ).toBeNull();
  });

  it("archives the displayed version", async () => {
    seedPlan();
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "归档计划" }));
    await waitFor(() =>
      expect(window.oint.chat.archivePlan).toHaveBeenCalledWith(SESSION_ID, {
        planId: "plan-1",
        revision: 3,
      }),
    );
  });

  it("sends revision instructions in the existing work without consuming the composer", async () => {
    seedPlan();
    render(<Harness />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "Other draft" } });
    fireEvent.click(screen.getByRole("button", { name: "修改计划" }));
    fireEvent.change(screen.getByRole("textbox", { name: "计划修改要求" }), {
      target: { value: "Include rollback" },
    });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "发送" }));
    await waitFor(() =>
      expect(window.oint.chat.send).toHaveBeenCalledWith(
        SESSION_ID,
        expect.stringContaining("Include rollback"),
        undefined,
        expect.any(String),
        undefined,
      ),
    );
    expect((screen.getByRole("combobox") as HTMLTextAreaElement).value).toBe("Other draft");
    expect(setModeCalls).toEqual([]);
  });

  it.each(["standard", "orchestrate"] as const)(
    "uses work constraints to explain goal controls in %s",
    async (mode) => {
      seedPlan();
      useChatStore.setState({ sessions: [session(mode)] });
      const workflow = useChatStore.getState().viewsBySession[SESSION_ID]?.state.workflow;
      if (!workflow) throw new Error("Missing seeded workflow");
      workflow.plan = null;
      workflow.goal = {
        id: "goal-1",
        workId: "work-1",
        revision: 1,
        objective: "Improve app",
        criteria: ["Tests pass"],
        status: "paused",
        progress: "",
        scope: "implementation",
        continuationCount: 0,
        continuationLimit: 10,
      };
      vi.mocked(window.oint.chat.controlGoal).mockResolvedValueOnce({ ok: false, code: "invalid" });
      render(<Harness />);
      fireEvent.click(screen.getByRole("button", { name: "继续目标" }));
      await waitFor(() =>
        expect(screen.getByRole("alert").textContent).toContain("当前工作仅允许只读操作"),
      );
      fireEvent.click(screen.getByRole("button", { name: "展开详情" }));
      expect(screen.getByText("Tests pass")).toBeDefined();
      act(() => {
        const snapshot = useChatStore.getState().viewsBySession[SESSION_ID];
        if (!snapshot || !workflow.goal) throw new Error("Missing seeded goal");
        useChatStore.setState({
          viewsBySession: {
            [SESSION_ID]: {
              ...snapshot,
              state: {
                ...snapshot.state,
                workflow: { ...workflow, goal: { ...workflow.goal, status: "completed" } },
              },
            },
          },
        });
      });
      expect(document.querySelector('[data-slot="composer-dock-goal"]')).toBeNull();
    },
  );

  it("does not carry a late plan error into another session", async () => {
    seedPlan();
    let finish!: (result: { ok: false; code: "stale" }) => void;
    vi.mocked(window.oint.chat.startPlan).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "开始计划" }));
    const snapshot = useChatStore.getState().viewsBySession[SESSION_ID];
    if (!snapshot) throw new Error("Missing seeded snapshot");
    act(() => useChatStore.setState({ activeSessionId: "s2", viewsBySession: { s2: snapshot } }));
    await act(async () => finish({ ok: false, code: "stale" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
