// 后台作业的渲染层入口：runtime 上的 listJobs / killJob 只往作业服务转发，
// 不参与会话运行时的创建与释放。这里锁两条回归点：
// 1. 列作业**不能**有「看一眼就创建会话运行时」的副作用；
// 2. 杀不存在的作业要抛出可直接展示给用户的中文错误。
import { afterEach, describe, expect, it } from "vitest";
import type { JobInfo } from "@/shared/contracts/job";
import type { Settings } from "@/shared/contracts/settings";
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
    defaultWorkingDir: null,
    services: [],
    defaultModel: null,
    thinkingLevel: "medium",
    permissionMode: "default",
    skillDirs: [],
    skillsEnabled: true,
    promptTemplateDirs: [],
    subagentsEnabled: true,
    disabledSubagentNames: [],
    mcpServers: [],
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
