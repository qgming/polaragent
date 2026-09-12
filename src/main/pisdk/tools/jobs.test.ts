// 后台作业工具（bash_background / job_output / job_list / job_kill）测试：schema 边界、
// 给模型的文本、给渲染层的 details 形状（可结构化克隆）、以及只碰自己会话的作业。
//
// 作业服务是真的（跑真实 node 子进程），命令一律 `node <脚本文件名>`、cwd 是临时目录：
// 命令里不出现空格与引号 —— 引号在不同 shell 上（Git Bash / cmd.exe）表现不一致（与
// jobs.test.ts 同一套做法，原因见那里的文件头）。
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type AgentHarnessToolInvocation,
  BACKGROUND_CONTEXT,
  type ExecutionEnv,
} from "@earendil-works/pi-agent-core";
import { Value } from "typebox/value";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { JobInfo } from "@/shared/contracts/job";
import { createJobService, type JobService } from "../jobs";
import {
  BASH_BACKGROUND_TOOL_NAME,
  createJobTools,
  JOB_KILL_TOOL_NAME,
  JOB_LIST_TOOL_NAME,
  JOB_OUTPUT_TOOL_NAME,
} from "./jobs";

/** 短命脚本：写一行就退出（退出码 0） */
const SAY_SCRIPT = "say.cjs";
/** 长命脚本：靠 interval 挂在事件循环上，只有被 kill 才会退出 */
const STAY_SCRIPT = "stay.cjs";
/** 一次写 3000 字节的脚本：超过调小的缓冲上限，用来验证截断标记 */
const FLOOD_SCRIPT = "flood.cjs";

const SESSION = "s1";
const OTHER_SESSION = "s2";

let dir = "";
let originalPath = "";
const services: JobService[] = [];

function createService(options: { maxJobs?: number; bufferBytes?: number } = {}): JobService {
  const service = createJobService({
    emit: () => undefined,
    ...(options.maxJobs === undefined ? {} : { maxJobs: options.maxJobs }),
    ...(options.bufferBytes === undefined ? {} : { bufferBytes: options.bufferBytes }),
  });
  services.push(service);
  return service;
}

/** 作业命令：只跑 node 本体（process.execPath 含空格时退回 PATH 上的 node） */
function nodeCommand(file: string): string {
  const exe = /[\s"']/.test(process.execPath) ? "node" : process.execPath;
  return `${exe} ${file}`;
}

type JobTool = ReturnType<typeof createJobTools>[number];
type JobToolResult = Awaited<ReturnType<JobTool["execute"]>>;
type ToolParams = Parameters<JobTool["execute"]>[1];

const INVOCATION: AgentHarnessToolInvocation = {
  invocationId: "call-1",
  operationId: "op-1",
  turnId: "turn-1",
  getMemo: async () => undefined,
  setMemo: async () => {},
};

/** 作业工具只读 toolContext.env.cwd（缺省工作目录），最小替身即可 */
function toolContext(cwd = dir): { env: ExecutionEnv } {
  return { env: { cwd } as ExecutionEnv };
}

function toolsFor(sessionId: string, jobs: JobService): JobTool[] {
  return createJobTools({ sessionId, jobs });
}

function toolNamed(tools: JobTool[], name: string): JobTool {
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`工具不存在：${name}`);
  return tool;
}

function runTool(tool: JobTool, params: ToolParams, cwd = dir): Promise<JobToolResult> {
  return tool.execute("call-1", params, () => {}, toolContext(cwd), INVOCATION, BACKGROUND_CONTEXT);
}

function textOf(result: JobToolResult): string {
  return result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
}

/** 单个作业的 details（与 JobToolDetails 同形） */
function jobDetails(result: JobToolResult): JobInfo {
  return (result.details as { job: JobInfo }).job;
}

/** job_list 的 details（与 JobListToolDetails 同形） */
function listDetails(result: JobToolResult): JobInfo[] {
  return (result.details as { jobs: JobInfo[] }).jobs;
}

async function waitForStatus(
  service: JobService,
  id: string,
  status: JobInfo["status"],
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (service.get(id)?.status !== status) {
    if (Date.now() > deadline) throw new Error(`等待超时：${id} 没有变成 ${status}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "oint-job-tools-test-"));
  // 命令里不带引号意味着要用 PATH 上的 `node`：把 node 所在目录补进 PATH 保证能找到
  originalPath = process.env.PATH ?? "";
  process.env.PATH = `${path.dirname(process.execPath)}${path.delimiter}${originalPath}`;

  writeFileSync(path.join(dir, SAY_SCRIPT), "process.stdout.write('hello-from-job\\n');\n", "utf8");
  writeFileSync(path.join(dir, STAY_SCRIPT), "setInterval(() => {}, 1000);\n", "utf8");
  writeFileSync(
    path.join(dir, FLOOD_SCRIPT),
    "for (let i = 0; i < 30; i += 1) process.stdout.write('y'.repeat(100));\n",
    "utf8",
  );
});

afterAll(async () => {
  process.env.PATH = originalPath;
  // 进程刚被杀掉时 Windows 还锁着作为 cwd 的目录；删不掉也无妨，别让清理本身失败
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
});

afterEach(async () => {
  for (const service of services.splice(0)) await service.dispose();
});

describe("createJobTools", () => {
  it("四个工具的名字取自常量；schema 卡住缺参数、空串与越界 waitMs", () => {
    const service = createService();
    const tools = toolsFor(SESSION, service);

    expect(tools.map((tool) => tool.name)).toEqual([
      BASH_BACKGROUND_TOOL_NAME,
      JOB_OUTPUT_TOOL_NAME,
      JOB_LIST_TOOL_NAME,
      JOB_KILL_TOOL_NAME,
    ]);
    // 渲染层按 label 找图标：这里与工具名同源
    expect(tools.map((tool) => tool.label)).toEqual(tools.map((tool) => tool.name));

    const background = toolNamed(tools, BASH_BACKGROUND_TOOL_NAME);
    expect(Value.Check(background.parameters, { command: "npm run dev" })).toBe(true);
    expect(Value.Check(background.parameters, { command: "npm run dev", cwd: dir })).toBe(true);
    expect(Value.Check(background.parameters, {})).toBe(false); // 缺 command
    expect(Value.Check(background.parameters, { command: "" })).toBe(false); // 空命令
    expect(Value.Check(background.parameters, { command: "x", cwd: "" })).toBe(false);
    // 多余的键不收紧：模型多带一个字段不该让整次调用失败
    expect(Value.Check(background.parameters, { command: "x", extra: 1 })).toBe(true);

    const output = toolNamed(tools, JOB_OUTPUT_TOOL_NAME);
    expect(Value.Check(output.parameters, { id: "job-1" })).toBe(true);
    expect(Value.Check(output.parameters, { id: "job-1", waitMs: 0 })).toBe(true);
    expect(Value.Check(output.parameters, { id: "job-1", waitMs: 30_000 })).toBe(true);
    expect(Value.Check(output.parameters, {})).toBe(false);
    expect(Value.Check(output.parameters, { id: "" })).toBe(false);
    expect(Value.Check(output.parameters, { id: 1 })).toBe(false);
    expect(Value.Check(output.parameters, { id: "job-1", waitMs: 30_001 })).toBe(false);
    expect(Value.Check(output.parameters, { id: "job-1", waitMs: -1 })).toBe(false);
    expect(Value.Check(output.parameters, { id: "job-1", waitMs: "100" })).toBe(false);

    const list = toolNamed(tools, JOB_LIST_TOOL_NAME);
    expect(Value.Check(list.parameters, {})).toBe(true);

    const kill = toolNamed(tools, JOB_KILL_TOOL_NAME);
    expect(Value.Check(kill.parameters, { id: "job-1" })).toBe(true);
    expect(Value.Check(kill.parameters, {})).toBe(false);
    expect(Value.Check(kill.parameters, { id: "" })).toBe(false);
    expect(Value.Check(kill.parameters, { id: 1 })).toBe(false);
  });

  it("bash_background：文本带出可用的 job id 与 pid，cwd 取参数或会话工作目录", async () => {
    const service = createService();
    const tools = toolsFor(SESSION, service);
    const background = toolNamed(tools, BASH_BACKGROUND_TOOL_NAME);

    // 用长命作业：起完之后 pid 与 running 状态都稳定可见（短命作业会和它自己的退出赛跑）
    const explicit = await runTool(background, { command: nodeCommand(STAY_SCRIPT), cwd: dir });
    const started = jobDetails(explicit);
    expect(started.id).toBe("job-1");
    expect(started.cwd).toBe(dir);
    expect(started.status).toBe("running");
    expect(typeof started.pid).toBe("number");
    // 文本里的 id 必须真的能用：后续 job_output / job_kill 就靠它
    expect(textOf(explicit)).toContain(`Started ${started.id} (pid ${started.pid})`);
    expect(textOf(explicit)).toContain(JOB_OUTPUT_TOOL_NAME);
    expect(textOf(explicit)).toContain(JOB_KILL_TOOL_NAME);
    expect(service.get(started.id)?.status).toBe("running");

    // 不给 cwd：用 toolContext.env.cwd（会话工作目录）
    const implicit = await runTool(background, { command: nodeCommand(STAY_SCRIPT) });
    expect(jobDetails(implicit).cwd).toBe(dir);
    expect(jobDetails(implicit).id).toBe("job-2");
  });

  it("bash_background：起不来时返回可继续的错误文本与占位 details", async () => {
    const service = createService({ maxJobs: 1 });
    const tools = toolsFor(SESSION, service);
    const background = toolNamed(tools, BASH_BACKGROUND_TOOL_NAME);
    const output = toolNamed(tools, JOB_OUTPUT_TOOL_NAME);

    // 先占满唯一的名额（一个一直活着的作业）
    await runTool(background, { command: nodeCommand(STAY_SCRIPT) });
    const rejected = await runTool(background, { command: nodeCommand("nope.cjs") });

    expect(textOf(rejected).startsWith("Error: could not start the background job:")).toBe(true);
    expect(textOf(rejected)).toContain("已达上限");
    const placeholder = jobDetails(rejected);
    expect(placeholder).toMatchObject({
      id: "job-0",
      sessionId: SESSION,
      command: nodeCommand("nope.cjs"),
      cwd: dir,
      status: "failed",
      totalBytes: 0,
      truncated: false,
    });
    expect(structuredClone(rejected.details)).toEqual(rejected.details);

    // 占位 id 不是真作业：读它会得到「找不到」，模型据此换做法
    expect(textOf(await runTool(output, { id: "job-0" }))).toBe(
      "Error: 找不到后台作业 job-0（会话 s1）",
    );
  });

  it("job_output：文本含状态与退出码、带出输出；没有新输出时明说；找不到时报错", async () => {
    const service = createService();
    const tools = toolsFor(SESSION, service);
    const background = toolNamed(tools, BASH_BACKGROUND_TOOL_NAME);
    const output = toolNamed(tools, JOB_OUTPUT_TOOL_NAME);

    const started = jobDetails(await runTool(background, { command: nodeCommand(SAY_SCRIPT) }));
    await waitForStatus(service, started.id, "exited");

    const drained = await runTool(output, { id: started.id, waitMs: 5_000 });
    const text = textOf(drained);
    expect(text).toContain(`${started.id} exited (code 0)`);
    expect(text).toContain("hello-from-job");
    expect(text).toContain("bytes total");
    expect(text).not.toContain("some output dropped");
    expect(jobDetails(drained).status).toBe("exited");
    expect(jobDetails(drained).exitCode).toBe(0);
    expect(structuredClone(drained.details)).toEqual(drained.details);

    // 已经读干净的作业：再读一次要明说「没有新输出，它已经退出」
    expect(textOf(await runTool(output, { id: started.id }))).toContain(
      "(no new output; the job has exited)",
    );

    // 还活着的作业：waitMs 真的传给了服务（等满 100ms 才回来），文本说「还没有新输出」
    const running = jobDetails(await runTool(background, { command: nodeCommand(STAY_SCRIPT) }));
    const startedWaiting = Date.now();
    const empty = await runTool(output, { id: running.id, waitMs: 100 });
    expect(Date.now() - startedWaiting).toBeGreaterThanOrEqual(80);
    expect(textOf(empty)).toContain(`${running.id} still running`);
    expect(textOf(empty)).toContain("(no new output yet)");
    expect(jobDetails(empty).status).toBe("running");

    // 未知 id：文本直接给中文原因，details 是完整占位快照（渲染层不必判空）
    const missing = await runTool(output, { id: "job-404" });
    expect(textOf(missing)).toBe("Error: 找不到后台作业 job-404（会话 s1）");
    expect(jobDetails(missing)).toMatchObject({
      id: "job-404",
      sessionId: SESSION,
      command: "",
      cwd: "",
      status: "failed",
    });
    expect(structuredClone(missing.details)).toEqual(missing.details);
  });

  it("job_list：空列表与非空列表的文本、details（老作业在前、含状态与字节数）", async () => {
    const service = createService();
    const tools = toolsFor(SESSION, service);
    const background = toolNamed(tools, BASH_BACKGROUND_TOOL_NAME);
    const list = toolNamed(tools, JOB_LIST_TOOL_NAME);

    const empty = await runTool(list, {});
    expect(textOf(empty)).toBe("No background jobs in this session.");
    expect(listDetails(empty)).toEqual([]);
    expect(structuredClone(empty.details)).toEqual(empty.details);

    const finished = jobDetails(await runTool(background, { command: nodeCommand(SAY_SCRIPT) }));
    await waitForStatus(service, finished.id, "exited");
    const running = jobDetails(await runTool(background, { command: nodeCommand(STAY_SCRIPT) }));

    const listed = await runTool(list, {});
    const text = textOf(listed);
    expect(text.startsWith("2 background job(s):")).toBe(true);
    expect(text).toContain(`- ${finished.id} [exited] ${nodeCommand(SAY_SCRIPT)}`);
    expect(text).toContain(`- ${running.id} [running] ${nodeCommand(STAY_SCRIPT)}`);
    expect(text).toContain("bytes");
    expect(text).not.toContain("output truncated");
    expect(listDetails(listed).map((job) => job.id)).toEqual([finished.id, running.id]);
    expect(structuredClone(listed.details)).toEqual(listed.details);
  });

  it("输出被丢弃时：job_output 标 dropped + bytes omitted，job_list 标 truncated", async () => {
    const service = createService({ bufferBytes: 1_024 });
    const tools = toolsFor(SESSION, service);
    const background = toolNamed(tools, BASH_BACKGROUND_TOOL_NAME);
    const output = toolNamed(tools, JOB_OUTPUT_TOOL_NAME);
    const list = toolNamed(tools, JOB_LIST_TOOL_NAME);

    const job = jobDetails(await runTool(background, { command: nodeCommand(FLOOD_SCRIPT) }));
    await waitForStatus(service, job.id, "exited");

    const drained = await runTool(output, { id: job.id });
    expect(textOf(drained)).toContain("some output dropped");
    expect(textOf(drained)).toContain("bytes omitted");
    expect(jobDetails(drained).truncated).toBe(true);
    expect(jobDetails(drained).totalBytes).toBe(3_000);

    expect(textOf(await runTool(list, {}))).toContain("output truncated");
  });

  it("job_kill：找不到 id 时给错误文本与占位 details；成功时给出 killed 与后续读法", async () => {
    const service = createService();
    const tools = toolsFor(SESSION, service);
    const background = toolNamed(tools, BASH_BACKGROUND_TOOL_NAME);
    const kill = toolNamed(tools, JOB_KILL_TOOL_NAME);
    const list = toolNamed(tools, JOB_LIST_TOOL_NAME);

    const missing = await runTool(kill, { id: "job-404" });
    expect(textOf(missing)).toBe("Error: 找不到后台作业 job-404（会话 s1）");
    expect(jobDetails(missing)).toMatchObject({
      id: "job-404",
      sessionId: SESSION,
      status: "failed",
    });
    expect(structuredClone(missing.details)).toEqual(missing.details);

    const job = jobDetails(await runTool(background, { command: nodeCommand(STAY_SCRIPT) }));
    const killed = await runTool(kill, { id: job.id });
    expect(textOf(killed)).toContain(`${job.id} killed (${nodeCommand(STAY_SCRIPT)}).`);
    expect(textOf(killed)).toContain(JOB_OUTPUT_TOOL_NAME);
    expect(jobDetails(killed).status).toBe("killed");
    expect(structuredClone(killed.details)).toEqual(killed.details);
    // 杀完之后 job_list 的状态跟上
    expect(textOf(await runTool(list, {}))).toContain(`- ${job.id} [killed]`);
  });

  it("工具只碰自己会话的作业：另一个会话读不到、杀不掉", async () => {
    const service = createService();
    const mine = toolsFor(SESSION, service);
    const other = toolsFor(OTHER_SESSION, service);
    const job = jobDetails(
      await runTool(toolNamed(mine, BASH_BACKGROUND_TOOL_NAME), {
        command: nodeCommand(STAY_SCRIPT),
      }),
    );

    const readByOther = await runTool(toolNamed(other, JOB_OUTPUT_TOOL_NAME), { id: job.id });
    expect(textOf(readByOther)).toBe(`Error: 找不到后台作业 ${job.id}（会话 s2）`);
    const killByOther = await runTool(toolNamed(other, JOB_KILL_TOOL_NAME), { id: job.id });
    expect(textOf(killByOther)).toContain("找不到后台作业");
    expect(textOf(await runTool(toolNamed(other, JOB_LIST_TOOL_NAME), {}))).toBe(
      "No background jobs in this session.",
    );
    // 被拒绝的读取 / 杀进程不能影响作业本身
    expect(service.get(job.id)?.status).toBe("running");
  });

  it("四个工具的 details 都能结构化克隆（要过渲染进程那道边界）", async () => {
    const service = createService();
    const tools = toolsFor(SESSION, service);
    const background = toolNamed(tools, BASH_BACKGROUND_TOOL_NAME);
    const output = toolNamed(tools, JOB_OUTPUT_TOOL_NAME);
    const list = toolNamed(tools, JOB_LIST_TOOL_NAME);
    const kill = toolNamed(tools, JOB_KILL_TOOL_NAME);

    // 用长命作业：读它时还在跑，杀它时状态真的从 running 变 killed
    const started = await runTool(background, { command: nodeCommand(STAY_SCRIPT) });
    const job = jobDetails(started);
    const results: JobToolResult[] = [
      started,
      await runTool(output, { id: job.id }),
      await runTool(list, {}),
      await runTool(kill, { id: job.id }),
    ];

    for (const result of results) {
      expect(structuredClone(result.details)).toEqual(result.details);
    }
  });
});
