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
  useChatStore.setState({
    activeSessionId: "s1",
    jobsBySession: {},
    jobsReconciledSessions: {},
  });
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
function seed(jobs: JobInfo[], sessionId = "s1") {
  useChatStore.setState({
    activeSessionId: sessionId,
    jobsBySession: { [sessionId]: jobs },
    jobsReconciledSessions: { [sessionId]: true },
  });
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

  /**
   * 终态是既成事实，running 只可能是一条陈旧断言 —— 所以优先级**刻意不对称**。
   *
   * 这一条早先写的是「两个方向都要成立」，那是错的：同一次运行不可能从终态回到 running。
   * 作业一旦结算就再也不会被拉起来（`jobs.start` 永远产生一条**新**作业，没有 resume），
   * 所以「终态 vs running」这对矛盾里终态必然更可信。按「谁后到谁赢」处理，
   * 等于允许一条陈旧断言把已经落定的结论重新翻回去 —— 正是本次要修的毛病。
   */
  it("终态不被 store 里的陈旧 running 盖回去", () => {
    // 同一次运行（id 与 startedAt 都一致），store 那份却还写着 running
    seed([job({ status: "running", startedAt: 1_000 })]);

    renderPart({
      artifact: { job: job({ status: "exited", exitCode: 0, startedAt: 1_000, endedAt: 3_000 }) },
    });

    expect(screen.getByText(/已退出/)).toBeTruthy();
    expect(screen.queryByText(/运行中/)).toBeNull();
  });

  /**
   * id 每次重启都从 `job-1` 重数（见 main/pisdk/jobs.ts 的 nextJobNumber），
   * 所以同一个会话里会同时存在「上次进程留下的 job-1」与「本次进程新起的 job-1」。
   *
   * 只按 id 认人，旧 pill 会认领到新作业的状态 —— 一条早就结束的历史作业看起来又在跑了，
   * 而这正是本次要修的那类症状的另一个入口。身份必须带上 startedAt。
   */
  it("同名不同次：转录里的 job-1 不认领本次进程新起的 job-1", () => {
    // store 里这条 job-1 是本次进程新起的（startedAt 晚得多），并不是快照那一条
    seed([job({ status: "running", startedAt: 9_000 })]);

    // 快照是上次进程留下的那条，早就结束了
    renderPart({
      artifact: { job: job({ status: "exited", exitCode: 0, startedAt: 1_000, endedAt: 2_000 }) },
    });

    // 认不出同一次运行 → 不拿新作业给它盖章；它自己的终态照原样显示
    expect(screen.getByText(/已退出/)).toBeTruthy();
    expect(screen.queryByText(/运行中/)).toBeNull();
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

  /**
   * 本次修复的核心回归：**重启后一条早就结束的作业一直显示「运行中」**。
   *
   * 这是真实报上来的症状，成因是两条数据源同时失效：
   *   · store 里没有它 —— 主进程的作业表只活在内存里，进程退出（重启应用）后 jobs.list 返回空；
   *   · 转录里那份 details 快照永远写着 running —— 它是**启动那一刻**写的，此后永不更新
   *     （退出时的结论只回填到内存里那条 part 上，不落盘）。
   *
   * 于是 `find(...) ?? detail.job` 的回退逻辑恰好落到最不可信的那一份上。
   * 判据必须是「状态本身的确定性」：对过账之后，权威列表里没有的 running 一律按已结束呈现。
   */
  it("重启后：对过账、权威列表里没有这条作业 → 不再显示「运行中」", () => {
    // 权威列表已经回来过，而且是空的（作业表随进程退出清空了）
    useChatStore.setState({
      activeSessionId: "s1",
      jobsBySession: { s1: [] },
      jobsReconciledSessions: { s1: true },
    });

    // 转录里那份快照停在启动那一刻
    renderPart({
      artifact: { job: job() },
      result: 'Started job-1 (pid 736) in D:/app: pnpm dev\nUse job_output {"id":"job-1"} …',
    });

    expect(screen.queryByText(/运行中/)).toBeNull();
    expect(screen.getByText(/已退出/)).toBeTruthy();
  });

  it("还没对过账时不降级：jobs.list 还在飞，running 照常显示", () => {
    // 启动那一瞬间转录先到、权威列表后到。此时无权下结论 ——
    // 提前把每条 running 都判成已结束只会闪一屏假的终态
    useChatStore.setState({
      activeSessionId: "s1",
      jobsBySession: {},
      jobsReconciledSessions: {},
    });

    renderPart({ artifact: { job: job() } });

    expect(screen.getByText(/运行中/)).toBeTruthy();
  });

  it("对账后降级的耗时：不摆一个编出来的读数", () => {
    // 这条作业的真实结局已无从得知（进程没了、作业表也清了）：我们不知道它跑了多久。
    // 一个会增长的秒数读起来像「还在跑」，而补一个 0 又读成「瞬间跑完」—— 两者都不真实，
    // 所以这一档干脆不显示耗时（见 jobElapsedReading）。
    useChatStore.setState({
      activeSessionId: "s1",
      jobsBySession: { s1: [] },
      jobsReconciledSessions: { s1: true },
    });

    renderPart({ artifact: { job: job() } });

    expect(screen.queryByText(/运行中/)).toBeNull();
    expect(screen.queryByText(/^(0s|0\.0s)$/)).toBeNull();
  });

  it("权威列表里有终态时，终态胜过快照里的 running（与到达顺序无关）", () => {
    // 作业退出后 close 事件先到、下次打开才补拉：两份都在内存里，
    // 但快照那份可能是「退出前最后一次 job_output」留下的 running
    seed([job({ status: "killed", endedAt: 5_000 })]);

    renderPart({ artifact: { job: job() } });

    expect(screen.getByText(/已停止/)).toBeTruthy();
    expect(screen.queryByText(/运行中/)).toBeNull();
  });
});
