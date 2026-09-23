// 后台作业的渲染层入口：runtime 上的 listJobs / killJob 只往作业服务转发，
// 不参与会话运行时的创建与释放。这里锁两条回归点：
// 1. 列作业**不能**有「看一眼就创建会话运行时」的副作用；
// 2. 杀不存在的作业要抛出可直接展示给用户的中文错误。
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { JobInfo } from "@/shared/contracts/job";
import type { Settings } from "@/shared/contracts/settings";
import { DEFAULT_WEB_SEARCH_SETTINGS } from "@/shared/contracts/web";
import { createApprovalService } from "./approvals";
import type { JobService } from "./jobs";
import { type ChatRuntime, createChatRuntime } from "./runtime";
import type { SessionStore } from "./session-store";

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    theme: "system",
    language: "zh-CN",
    density: "comfortable",
    chatFont: "",
    chatFontSize: 14,
    services: [],
    defaultModel: null,
    thinkingLevel: "medium",
    permissionMode: "default",
    agentMode: "standard",
    disabledSubagentNames: [],
    mcpServers: [],
    systemMcpServerEnabled: {},
    webSearch: DEFAULT_WEB_SEARCH_SETTINGS,
    disabledSkillNames: [],
    ...overrides,
  };
}

/**
 * 会话存储探测器：createRuntime 的第一步就是 `sessionStore.open`，
 * 所以「open 有没有被调用」等价于「会话运行时有没有被创建」（本文件不提供可用的 open）。
 */
function makeSessionStoreProbe(): { store: SessionStore; opened: string[] } {
  const opened: string[] = [];
  const store = {
    open: async (sessionId: string) => {
      opened.push(sessionId);
      return null;
    },
  } as unknown as SessionStore;
  return { store, opened };
}

/** 造一个只依赖假会话存储的运行时；不注入 jobs，用的就是运行时内部那份作业服务 */
function makeRuntime(options: { jobs?: JobService } = {}): {
  runtime: ChatRuntime;
  opened: string[];
} {
  const { store, opened } = makeSessionStoreProbe();
  const settings = makeSettings();
  const runtime = createChatRuntime({
    getSettings: async () => settings,
    sessionStore: store,
    emit: () => undefined,
    approvals: createApprovalService({ getSettings: async () => settings, emit: () => undefined }),
    ...(options.jobs ? { jobs: options.jobs } : {}),
    resolveWorkingDir: async () => process.cwd(),
  });
  return { runtime, opened };
}

function jobInfo(overrides: Partial<JobInfo> = {}): JobInfo {
  return {
    id: "job-1",
    sessionId: "s1",
    command: "npm run dev",
    cwd: process.cwd(),
    status: "running",
    startedAt: Date.now(),
    totalBytes: 0,
    truncated: false,
    ...overrides,
  };
}

describe("后台作业的 runtime 接口", () => {
  let created: ChatRuntime | undefined;

  afterEach(async () => {
    await created?.dispose();
    created = undefined;
  });

  it("listJobs 对没有作业的会话返回空数组，且不创建会话运行时", async () => {
    const { runtime, opened } = makeRuntime();
    created = runtime;

    expect(runtime.listJobs("s-missing")).toEqual([]);
    // 关键：列表接口是一次纯读取，不能顺手把会话运行时（存储 + harness）建起来
    expect(opened).toEqual([]);

    // 反向确认探测器是活的：真正要建运行时的那条路径一定会走到 sessionStore.open
    await expect(runtime.send("s-missing", "你好")).rejects.toThrow("无法打开会话");
    expect(opened).toEqual(["s-missing"]);
  });

  it("killJob 对不存在的作业 id 抛中文错误，同样不创建会话运行时", async () => {
    const { runtime, opened } = makeRuntime();
    created = runtime;

    await expect(runtime.killJob("s1", "job-404")).rejects.toThrow(
      /找不到后台作业 job-404（会话 s1）/,
    );
    // 与 listJobs 一样是对作业表的操作：没有作业就不该拿会话运行时当替罪羊
    expect(opened).toEqual([]);
  });

  it("listJobs / killJob 把参数原样转给作业服务，kill 返回服务给的快照", async () => {
    const calls: { list: string[]; kill: Array<{ sessionId: string; id: string }> } = {
      list: [],
      kill: [],
    };
    const killed = jobInfo({ id: "job-7", status: "killed", endedAt: Date.now() });
    const jobs = {
      list: (sessionId: string) => {
        calls.list.push(sessionId);
        return [jobInfo({ sessionId, id: "job-8" })];
      },
      kill: async (sessionId: string, id: string) => {
        calls.kill.push({ sessionId, id });
        return killed;
      },
      // runtime.dispose() 会兜底调用作业服务的 dispose；替身只需能被收尾
      dispose: async () => undefined,
    } as unknown as JobService;
    const { runtime, opened } = makeRuntime({ jobs });
    created = runtime;

    expect(runtime.listJobs("s1").map((job) => job.id)).toEqual(["job-8"]);
    await expect(runtime.killJob("s1", "job-7")).resolves.toBe(killed);
    expect(calls.list).toEqual(["s1"]);
    expect(calls.kill).toEqual([{ sessionId: "s1", id: "job-7" }]);
    expect(opened).toEqual([]);
  });
});

/**
 * **作业结束不再往对话里发一条用户消息**（用户明确要求，与子智能体一致）。
 *
 * 这是一条容易回归的行为约定：结论应该以「那次调用的结果」出现，而不是一条看起来像
 * 用户自己说的话的消息。早先这里额外推过一条系统通知（带 `jobWake` 唤醒 + 唤醒预算 +
 * `pendingSynthetic` 来源标记），已随之下线。
 *
 * 为什么用源码级断言而不是行为断言：那段逻辑藏在 `createChatRuntime` 的闭包里，
 * 要真正触发它得先让会话运行时立起来（真实 harness + 真作业进程），
 * 为了防一条回归去搭那套成本太高。而这条约定的**违反形态是固定的一句话**
 *（`send`/`queue` 一条通知 + 一个唤醒预算计数），源码检查能稳定抓到它。
 * 断言当「防手滑」用，不当行为规格用 —— 真正的行为规格在 job-delivery.test.ts
 *（结论写成什么样）与渲染层的 job-tool-ui.test.tsx（界面上怎么显示）。
 */
describe("作业退出不产生对话消息（源码级回归保护）", () => {
  const source = readFileSync(new URL("./runtime.ts", import.meta.url), "utf8");

  it("notifyJobExit 只回填那次调用的结果，不调用 send / queue", () => {
    // 抓出 notifyJobExit 的函数体（到下一个顶层函数注释为止）
    const start = source.indexOf("function notifyJobExit(");
    expect(start, "notifyJobExit 不见了 —— 作业退出的投递路径被改到别处了").toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf("\n  /**", start + 10));

    expect(body).toContain("deliverJobResult(job)");
    expect(body).not.toContain("send(");
    expect(body).not.toContain("queue(");
  });

  it("唤醒预算那套机制整体不存在了（含它的常量、计数与系统来源标记）", () => {
    for (const dead of [
      "MAX_JOB_WAKES",
      "jobWakes",
      "pendingSynthetic",
      "jobWake",
      "buildJobNotice",
    ]) {
      expect(source.includes(dead), `${dead} 又回来了：作业结束会重新往对话里发消息`).toBe(false);
    }
  });
});
