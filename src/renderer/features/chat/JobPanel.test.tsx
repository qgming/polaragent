/**
 * 后台作业区块（JobPanel）的渲染测试（ui project / jsdom）。
 *
 * 区块从「贴在输入框上沿的独立面板」迁进了会话面板，语义变了两处，测试跟着改：
 *   · 区块**始终渲染**：没有作业时给空态文案（展开后可见），不再整块消失；
 *     折叠头默认收起，收起时内容不在 DOM 里
 *   · 行尾的「进行中 / 总数」改成折叠头右侧的计数徽标，只数还在跑的；
 *     全部收尾时徽标转绿（0 也照给，表示「都结束了」）
 *
 * 验的仍是**数据链**而不只是外观：作业从真 store 读（主进程事件经 event-bridge 写进
 * `jobsBySession` 的同一条路径），停止按钮写回 store 的 killJob，只换掉 window.oint
 * 这个进程边界 —— 点击必须真的调用 jobs.kill，且载荷是「当前会话 + 那一条作业」。
 * 这条链断了（区块没接 store、点了没发 IPC、同 id 被追加成两条）这里就会红。
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/renderer/i18n";
import { useChatStore } from "@/renderer/stores/chat-store";
import type { JobInfo } from "@/shared/contracts";
import { JobPanel } from "./JobPanel";

// vitest 未开 globals，RTL 的自动清理不会注册，必须手动
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// 断言用中文词条：初始语言跟着 navigator.language 走，测试里不能依赖它
beforeAll(async () => {
  await i18n.changeLanguage("zh-CN");
});

/** 一次后台作业的完整快照（契约里的必填字段都在，测试按需覆盖） */
function job(overrides: Partial<JobInfo> & { id: string }): JobInfo {
  return {
    sessionId: "s1",
    command: "npm run dev",
    cwd: "D:/proj",
    status: "running",
    startedAt: 1000,
    totalBytes: 0,
    truncated: false,
    ...overrides,
  };
}

/** kill 的替身：默认返回主进程结算后的快照（status = killed） */
const kill = vi.fn(async (): Promise<JobInfo> => job({ id: "job-1", status: "killed" }));
const list = vi.fn(async (): Promise<JobInfo[]> => []);

beforeEach(() => {
  kill.mockClear();
  list.mockClear();
  vi.stubGlobal("oint", { jobs: { list, kill } });
  useChatStore.setState({ activeSessionId: "s1", jobsBySession: {} });
});

/** 把作业塞进当前会话（模拟 job-changed 已经到过 / 补拉已完成） */
function seed(jobs: JobInfo[], sessionId = "s1") {
  useChatStore.setState({ activeSessionId: sessionId, jobsBySession: { [sessionId]: jobs } });
}

const rows = (container: HTMLElement) => container.querySelectorAll('[data-slot="job-row"]');

/** 折叠头的无障碍名称（toggleLabel）就是它认人的方式；区块默认收起，内容要展开才在 DOM 里 */
const expand = () => {
  fireEvent.click(screen.getByRole("button", { name: "展开或收起后台作业" }));
};

/** 折叠头右侧的计数徽标：undefined = 没有作业，不摆一个「0」 */
const badgeEl = () => document.querySelector('[data-slot="job-count"]');
const badge = () => badgeEl()?.textContent ?? null;

describe("JobPanel", () => {
  it("没有作业时区块仍然渲染：展开后给空态文案，且不渲染徽标", () => {
    const { container } = render(<JobPanel />);

    // 折叠头始终在（区块不再整块消失），只是内容默认收起
    expect(container.querySelector('[data-slot="job-panel"]')).not.toBeNull();
    expect(screen.getByText("后台作业")).toBeTruthy();
    expect(badge()).toBeNull();

    expand();
    expect(screen.getByText("还没有后台作业")).toBeTruthy();
    expect(rows(container)).toHaveLength(0);
    expect(badge()).toBeNull();
  });

  it("别的会话的作业不显示在当前会话里", () => {
    useChatStore.setState({
      activeSessionId: "s1",
      jobsBySession: { "s-other": [job({ id: "job-9", command: "pnpm watch" })] },
    });
    const { container } = render(<JobPanel />);
    expand();

    // s1 自己仍是空态：别的会话那条既不进列表、也不进徽标
    expect(rows(container)).toHaveLength(0);
    expect(screen.queryByText("pnpm watch")).toBeNull();
    expect(screen.getByText("还没有后台作业")).toBeTruthy();
    expect(badge()).toBeNull();
  });

  it("每条作业显示命令、状态、退出码与截断提示；徽标只数还在跑的", () => {
    seed([
      job({ id: "job-1", startedAt: Date.now() }),
      job({
        id: "job-2",
        command: "npm run build",
        status: "exited",
        exitCode: 0,
        endedAt: Date.now(),
        totalBytes: 42_000,
        truncated: true,
      }),
      job({
        id: "job-3",
        command: "bad-cmd",
        status: "failed",
        exitCode: 127,
        endedAt: Date.now(),
      }),
    ]);
    render(<JobPanel />);
    expand();

    // 命令原样显示，作业 id 与状态徽标在各自那一行
    expect(screen.getByText("npm run dev")).toBeTruthy();
    expect(screen.getByText("npm run build")).toBeTruthy();
    expect(screen.getByText("运行中")).toBeTruthy();
    expect(screen.getByText("已退出")).toBeTruthy();
    expect(screen.getByText("失败")).toBeTruthy();
    // 退出码与截断提示只在有值时出现
    expect(screen.getByText("退出码 0")).toBeTruthy();
    expect(screen.getByText("退出码 127")).toBeTruthy();
    expect(screen.getByText("输出已截断")).toBeTruthy();
    // running 显示已运行时长，终态显示结束时间
    expect(screen.getByText(/^已运行 /)).toBeTruthy();
    expect(screen.getAllByText(/结束$/).length).toBe(2);
    // 徽标口径变了：不再是「进行中 / 总数」，只数还在跑的（三条里一条）
    expect(badge()).toBe("1");
  });

  it("只有 running 的作业才有停止按钮，点击后调用 jobs.kill（进行中禁用并转圈）", async () => {
    // 卡住 kill：用它验证点击后的进行态，再由测试放行
    let release: (() => void) | undefined;
    const slowKill = vi.fn(async (): Promise<JobInfo> => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return job({ id: "job-1", status: "killed", endedAt: Date.now() });
    });
    vi.stubGlobal("oint", { jobs: { list, kill: slowKill } });

    seed([
      job({ id: "job-1", startedAt: Date.now() }),
      job({ id: "job-2", command: "sleep 1", status: "exited", exitCode: 0, endedAt: Date.now() }),
    ]);
    render(<JobPanel />);
    expand();

    // 终态的进程已经没了：整块只有一个停止按钮
    expect(screen.getAllByRole("button", { name: "停止" })).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    await waitFor(() => expect(slowKill).toHaveBeenCalledWith("s1", "job-1"));

    // 进行中：按钮切成「停止中」并禁用，避免重复点
    const busy = screen.getByRole("button", { name: "停止中" }) as HTMLButtonElement;
    expect(busy.disabled).toBe(true);

    release?.();
    // 主进程返回已结算的快照：就地覆盖同一条，按钮消失、状态变「已停止」
    await waitFor(() => expect(screen.queryByRole("button", { name: "停止" })).toBeNull());
    expect(screen.getByText("已停止")).toBeTruthy();
  });

  it("job-changed 更新同一条作业而不是新增一条，徽标跟着回 0 并转绿", () => {
    seed([job({ id: "job-1", startedAt: Date.now() })]);
    const { container } = render(<JobPanel />);
    expand();
    expect(rows(container)).toHaveLength(1);
    expect(badge()).toBe("1");

    // 事件从主进程推过来：走 store 的 applyEvent，等价于 event-bridge 那条链
    act(() => {
      useChatStore.getState().applyEvent("s1", {
        type: "job-changed",
        job: job({ id: "job-1", status: "exited", exitCode: 0, endedAt: Date.now() }),
      });
    });

    expect(rows(container)).toHaveLength(1);
    expect(useChatStore.getState().jobsBySession.s1).toHaveLength(1);
    expect(screen.getByText("已退出")).toBeTruthy();
    expect(screen.queryByText("运行中")).toBeNull();
    // 一条都不在跑了：徽标回 0，语气切成完成（绿）
    expect(badge()).toBe("0");
    expect(badgeEl()?.className).toContain("text-emerald-600");
  });

  it("新作业接在尾部（与 job_list 的最老在前一致）", () => {
    seed([job({ id: "job-1", command: "npm run dev" })]);
    const { container } = render(<JobPanel />);
    expand();

    act(() => {
      useChatStore.getState().applyEvent("s1", {
        type: "job-changed",
        job: job({ id: "job-2", command: "vite build" }),
      });
    });

    expect(rows(container)).toHaveLength(2);
    expect([...rows(container)].map((row) => row.textContent)).toEqual([
      expect.stringContaining("npm run dev"),
      expect.stringContaining("vite build"),
    ]);
  });

  it("job-removed 后该条从列表里消失", () => {
    seed([
      job({ id: "job-1", command: "npm run dev" }),
      job({ id: "job-2", command: "vite build" }),
    ]);
    const { container } = render(<JobPanel />);
    expand();
    expect(rows(container)).toHaveLength(2);

    act(() => {
      useChatStore.getState().applyEvent("s1", { type: "job-removed", id: "job-1" });
    });

    expect(rows(container)).toHaveLength(1);
    expect(screen.queryByText("npm run dev")).toBeNull();
    expect(screen.getByText("vite build")).toBeTruthy();
  });

  it("会话切换时用 jobs.list 补拉（事件没到过的历史作业也能恢复）", async () => {
    list.mockResolvedValueOnce([job({ id: "job-7", command: "tail -f app.log" })]);
    const { container } = render(<JobPanel />);
    expand();
    expect(rows(container)).toHaveLength(0);
    expect(screen.getByText("还没有后台作业")).toBeTruthy();

    await act(async () => {
      await useChatStore.getState().loadJobs("s1");
    });

    expect(list).toHaveBeenCalledWith("s1");
    expect(rows(container)).toHaveLength(1);
    expect(screen.getByText("tail -f app.log")).toBeTruthy();
    // 补拉回来的这条还在跑：徽标按「进行中数量」给 1，列表也列出了它
    expect(badge()).toBe("1");
  });

  it("折叠头整行可点：默认收起，点开后列出作业，再点收起", () => {
    seed([job({ id: "job-1", command: "npm run dev" })]);
    const { container } = render(<JobPanel />);

    const trigger = screen.getByRole("button", { name: "展开或收起后台作业" });
    // 迁到会话面板后默认收起：收起时内容不在 DOM 里，徽标（在折叠头上）照常显示
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(rows(container)).toHaveLength(0);
    expect(badge()).toBe("1");

    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(rows(container)).toHaveLength(1);
    expect(screen.getByText("npm run dev")).toBeTruthy();

    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(rows(container)).toHaveLength(0);
  });
});
