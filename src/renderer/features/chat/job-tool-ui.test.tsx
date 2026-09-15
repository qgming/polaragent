/**
 * 后台作业在主会话里的呈现（JobStatus pill）。
 *
 * 钉的是本次改动最要紧的那条规则：**作业的状态以 store 为准，不以 details 里的快照为准**。
 *
 * 为什么必须测这一条：`bash_background` 落进转录的 details 是**启动那一刻**的快照
 *（status: running），此后只有进程退出时才被主进程回填一次；而 store 里那份
 * `jobsBySession` 一直跟着 `job-changed` 事件走。两条数据源同时挂在一条 part 上时，
 * 读错了哪一份是看不出来的 —— 界面照样渲染，只是显示的状态是旧的。
 * 这个症状（重启后一条早就结束的作业一直显示「运行中」）正是这一整轮要修的东西，
 * 所以这里从**渲染结果**上断言，而不是只测解析函数。
 *
 * 断言口径取用户看得到的两件事：pill 上的状态词、以及展开后的输出正文。
 */
import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/renderer/i18n";
import { useChatStore } from "@/renderer/stores/chat-store";
import type { JobInfo } from "@/shared/contracts";
import { ToolCallPart } from "./ToolParts";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// 断言用中文词条：初始语言跟着 navigator.language 走，测试里不能依赖它
beforeAll(async () => {
  await i18n.changeLanguage("zh-CN");
});

beforeEach(() => {
  useChatStore.setState({ activeSessionId: "s1", jobsBySession: {} });
});

/** 作业快照（契约里的必填字段都在，测试按需覆盖） */
function job(overrides: Partial<JobInfo> = {}): JobInfo {
  return {
    id: "job-1",
    sessionId: "s1",
    command: "pnpm dev",
    cwd: "D:/app",
    status: "running",
    startedAt: 1_000,
    totalBytes: 0,
    truncated: false,
    ...overrides,
  };
}

/**
 * 直接渲染 ToolCallPart。
 *
 * addResult / resume / respondToApproval 是 aui 在真实运行时里注入的三个回调，
 * 这条分支一个都用不到（作业 pill 不写回结果、也不参与审批）—— 为了测这一条分支
 * 去搭一整个 AssistantRuntimeProvider 只会让用例更难读，所以按最小可用形状补齐。
 */
function renderPart({
  toolName = "bash_background",
  artifact,
  result,
}: {
  toolName?: string;
  artifact?: unknown;
  result?: unknown;
}) {
  const props = {
    type: "tool-call",
    toolCallId: "call-1",
    toolName,
    args: { command: "pnpm dev" },
    argsText: '{"command":"pnpm dev"}',
    artifact,
    result,
    status: { type: "complete" },
    addResult: () => {},
    resume: () => {},
    respondToApproval: async () => {},
  } as unknown as ToolCallMessagePartProps;

  return render(<ToolCallPart {...props} />);
}

/** 把作业塞进当前会话（模拟 job-changed 已经到过 / 补拉已完成） */
function seed(jobs: JobInfo[]) {
  useChatStore.setState({ activeSessionId: "s1", jobsBySession: { s1: jobs } });
}

describe("作业工具的状态 pill", () => {
  it("store 里那条才是权威：快照还写着运行中，也要照 store 的终态显示", () => {
    // 快照停在启动那一刻（details 的真实形状），store 已经被 job-changed 更新为退出
    seed([job({ status: "exited", exitCode: 0, endedAt: 3_000 })]);

    renderPart({ artifact: { job: job() } });

    expect(screen.getByText(/pnpm dev/)).toBeTruthy();
    expect(screen.getByText(/已退出/)).toBeTruthy();
    expect(screen.queryByText(/运行中/)).toBeNull();
  });

  it("反过来同样成立：快照是终态、store 里还在跑时显示运行中", () => {
    // 这条走的是「进程被重新拉起来」这类少见情形，但两条数据源的优先级只该有一份定义，
    // 不能只在一个方向上对
    seed([job()]);

    renderPart({ artifact: { job: job({ status: "exited", exitCode: 0, endedAt: 3_000 }) } });

    expect(screen.getByText(/运行中/)).toBeTruthy();
  });

  it("store 里查不到这条作业时退回快照，不是空白 pill", () => {
    // 切走再切回、或重启后还没补拉完时会出现这个窗口：快照是此刻唯一的依据
    seed([]);

    renderPart({ artifact: { job: job({ status: "failed" }) } });

    expect(screen.getByText(/失败/)).toBeTruthy();
  });

  it("点 pill 就地展开输出，再点收起：输出是这次调用的结果，不是另外一条消息", () => {
    seed([job({ status: "exited", exitCode: 0, endedAt: 3_000 })]);

    renderPart({
      artifact: { job: job({ status: "exited", exitCode: 0, endedAt: 3_000 }) },
      result: "ready in 320ms\nLocal: http://localhost:5173/",
    });

    // 默认收起：一条构建日志可以上千行，一进来就铺开会把对话节奏冲散
    expect(screen.queryByText(/ready in 320ms/)).toBeNull();
    const pill = screen.getByRole("button", { name: /pnpm dev/ });
    expect(pill.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(pill);
    expect(screen.getByText(/ready in 320ms/)).toBeTruthy();
    expect(screen.getByText("作业输出")).toBeTruthy();
    expect(pill.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(pill);
    expect(screen.queryByText(/ready in 320ms/)).toBeNull();
  });

  it("还没有结果时不摆一个点了没反应的按钮", () => {
    // 流式期（结果还没回填）与「这次调用确实没输出」都会走到这里：pill 只报状态，
    // 不给一个可点但什么都不发生的控件 —— 那种「点了没反应」正是这个功能被报过的毛病
    seed([job()]);

    renderPart({ artifact: { job: job() } });

    expect(screen.getByText(/运行中/)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("job_list 一次列出多条时报出条数", () => {
    // 只说「列出了」会被读成「只列了一条」，而它可能一次带回来五个作业
    const many = [job({ id: "job-1" }), job({ id: "job-2", command: "pnpm test" })];
    seed(many);

    renderPart({ toolName: "job_list", artifact: { jobs: many } });

    expect(screen.getByText(/共 2 个作业/)).toBeTruthy();
  });

  it("失败闸门不拦作业：一次跑挂的作业仍然是一颗有结论的 pill", () => {
    // 与子智能体不同，作业走的是 ToolCallPart 里那条独立分支 —— isError 只说明「命令没跑成」，
    // 而那正是这条 pill 要显示的信息，藏进红叉折叠行反而看不出它跑挂了
    seed([job({ status: "exited", exitCode: 1, endedAt: 2_000 })]);

    renderPart({
      artifact: { job: job({ status: "exited", exitCode: 1, endedAt: 2_000 }) },
      result: "退出码 1（用时 1s）",
    });

    expect(screen.getByText(/已退出/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /pnpm dev/ }));
    expect(screen.getByText(/退出码 1/)).toBeTruthy();
  });

  it("启动就失败时也给出「失败」结论，而不是一枚编出来的「运行中」", () => {
    // bash_background 起不来时（cwd 不存在、shell 不可用等）工具返回的是占位快照：
    // id 固定 job-0、status failed，store 里当然没有它 —— 这时 pill 必须落到快照那份上，
    // 并把工具结果里那句原因摊开。绝不能在 store 查不到时退回「运行中」：
    // 一次根本没跑起来的作业显示成「运行中」，比显示成一条错误更糟。
    renderPart({
      artifact: { job: job({ id: "job-0", status: "failed" }) },
      result: "Error: could not start the background job: spawn ENOENT",
    });

    expect(screen.getByText(/失败/)).toBeTruthy();
    expect(screen.queryByText(/运行中/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /pnpm dev/ }));
    expect(screen.getByText(/spawn ENOENT/)).toBeTruthy();
  });
});
