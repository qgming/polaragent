/**
 * 会话面板（内容区顶栏右侧那颗按钮 + 它的浮层）的渲染测试。
 *
 * 盯住三件事：
 * 1. 按钮的出现条件 —— 没有活动会话时不渲染（这些区块全都以「当前会话」为口径）；
 * 2. 浮层里五个区块都在（环境信息 / 任务清单 / 后台作业 / 产物 / 参考）；
 * 3. **动态** —— 徽标与列表跟着 store 走，不是打开时的快照。
 *
 * 待办与作业两块的行为细节由 TodoPanel.test.tsx / JobPanel.test.tsx 覆盖，这里只验容器。
 */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/renderer/i18n";
import { useChatStore } from "@/renderer/stores/chat-store";
import type { JobInfo } from "@/shared/contracts/job";
import { SessionPanel } from "./SessionPanel";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeAll(async () => {
  await i18n.changeLanguage("zh-CN");
});

/** 作业：默认一条在跑的，用来验徽标计数 */
function job(over: Partial<JobInfo> = {}): JobInfo {
  return {
    id: "job-1",
    sessionId: "s1",
    command: "npm run dev",
    cwd: "D:/dev/polaragent",
    status: "running",
    startedAt: Date.now(),
    totalBytes: 0,
    truncated: false,
    ...over,
  };
}

beforeEach(() => {
  vi.stubGlobal("oint", {
    jobs: { list: vi.fn(async () => []), kill: vi.fn(async () => job()) },
  });
  useChatStore.setState({
    activeSessionId: null,
    sessions: [],
    messagesBySession: {},
    jobsBySession: {},
  });
});

const trigger = () => screen.queryByRole("button", { name: "会话面板" });
const badge = (slot: string) =>
  document.querySelector(`[data-slot="${slot}"]`)?.textContent ?? null;

describe("SessionPanel", () => {
  it("没有活动会话时不渲染按钮", () => {
    render(<SessionPanel />);
    expect(trigger()).toBeNull();
  });

  it("打开浮层：五个区块标题都在，空态与徽标口径正确", async () => {
    useChatStore.setState({ activeSessionId: "s1" });
    render(<SessionPanel />);

    expect(trigger()).not.toBeNull();
    fireEvent.click(trigger() as HTMLElement);

    for (const title of ["环境信息", "任务清单", "后台作业", "产物", "参考"]) {
      expect(await screen.findByText(title)).toBeTruthy();
    }

    // 区块默认收起（与设计图一致：只有任务清单在有内容时自动展开），展开后才看得到内容
    fireEvent.click(await screen.findByRole("button", { name: "展开或收起后台作业" }));

    // 空态：区块仍然在，只是给一句话；没有可数的东西就不摆一个「0」
    expect(screen.getByText("还没有后台作业")).toBeTruthy();

    // 动态：打开着往 store 里塞一条在跑的作业 → 列表与徽标立刻跟上
    await act(async () => {
      useChatStore.setState({ jobsBySession: { s1: [job()] } });
    });
    expect(screen.getByText("npm run dev")).toBeTruthy();
    expect(badge("job-count")).toBe("1");

    // 换成一条已退出的：徽标回 0，且停止按钮不再出现
    await act(async () => {
      useChatStore.setState({
        jobsBySession: { s1: [job({ status: "exited", exitCode: 0, endedAt: Date.now() })] },
      });
    });
    expect(badge("job-count")).toBe("0");
    expect(screen.queryByRole("button", { name: "停止" })).toBeNull();
  });

  it("切换会话立刻换成另一个会话的口径", async () => {
    useChatStore.setState({
      activeSessionId: "s1",
      jobsBySession: { s1: [job()], s2: [] },
    });
    render(<SessionPanel />);
    fireEvent.click(trigger() as HTMLElement);
    // 徽标在收起态也可见；这里先展开，好在切会话后读到空态
    fireEvent.click(await screen.findByRole("button", { name: "展开或收起后台作业" }));
    expect(badge("job-count")).toBe("1");

    await act(async () => {
      useChatStore.setState({ activeSessionId: "s2" });
    });
    // s2 没有作业：列表空、徽标不渲染、按钮仍在
    expect(await screen.findByText("还没有后台作业")).toBeTruthy();
    expect(badge("job-count")).toBeNull();
    expect(trigger()).not.toBeNull();
  });
});
