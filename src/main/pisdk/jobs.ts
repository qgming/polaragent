// Native tasks own lifecycle and documents own metadata, byte logs, drain cursors and reports.
// The only volatile state is the operating-system process handle, which cannot be replayed safely.
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import type { Context, JsonRepresentation } from "@earendil-works/chord";
import { awaitWithContext } from "@earendil-works/chord/context";
import {
  defineDoc,
  defineTask,
  type TaskId,
  type TaskRuntime,
  type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import type { ChatEventEnvelope } from "@/shared/contracts/chat";
import type { JobInfo, JobReadResult } from "@/shared/contracts/job";
import { resolveBashPath } from "./exec-env";
import { buildJobResult } from "./job-delivery";
import {
  createAttachmentRegistry,
  type NativeStateAttachment,
  stateContext,
  waitForDocument,
} from "./native-state";

type JobRecord = JsonRepresentation<{
  job: JobInfo;
  taskId: number;
  toolCallId?: string;
  cursor: number;
  head: string;
  tail: string;
  result?: { text: string; isError: boolean };
  suppressed: boolean;
}>;
export const JobsDoc = defineDoc<{ entries: Record<string, JobRecord> }>({
  kind: "oint.jobs",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ entries: {} }),
});
type JobInput = { id: string };
type JobPhase = { phase: "run" };
type JobRuntime = TaskRuntime<JobInput, JobPhase, JsonRepresentation<JobInfo>, object>;
export interface JobServiceDeps {
  emit: (payload: ChatEventEnvelope) => void;
  onExited?: (job: JobInfo) => void;
  maxJobs?: number;
  bufferBytes?: number;
}
export interface JobStartInput {
  sessionId: string;
  command: string;
  cwd: string;
  toolCallId?: string;
  api?: ToolExecutionApi;
  context?: Context;
}
export interface JobReadOptions {
  waitMs?: number;
  context?: Context;
}
export interface JobService {
  readonly taskDefinitions: readonly ReturnType<typeof createJobTask>[];
  attach(attachment: NativeStateAttachment): Promise<() => void>;
  start(input: JobStartInput): Promise<JobInfo>;
  list(sessionId: string): Promise<JobInfo[]>;
  get(id: string): Promise<JobInfo | undefined>;
  read(sessionId: string, id: string, options?: JobReadOptions): Promise<JobReadResult>;
  kill(sessionId: string, id: string): Promise<JobInfo>;
  cancelSession(sessionId: string): Promise<void>;
  dispose(): Promise<void>;
  toolCallIdOf(id: string): Promise<string | undefined>;
  peekTail(id: string, maxBytes?: number): Promise<string>;
  isSuppressed(sessionId: string): Promise<boolean>;
}

function outputTail(entry: JobRecord, maxBytes = 2048) {
  return Buffer.concat([Buffer.from(entry.head, "base64"), Buffer.from(entry.tail, "base64")])
    .subarray(-maxBytes)
    .toString("utf8");
}
function appendOutput(entry: JobRecord, chunk: Buffer, capacity: number) {
  const headLimit = Math.max(1, Math.floor(capacity / 8));
  let head = Buffer.from(entry.head, "base64");
  const fill = Math.min(Math.max(0, headLimit - head.length), chunk.length);
  head = Buffer.concat([head, chunk.subarray(0, fill)]);
  const tail = Buffer.concat([Buffer.from(entry.tail, "base64"), chunk.subarray(fill)]);
  entry.head = head.toString("base64");
  entry.tail = tail.subarray(-Math.max(1, capacity - headLimit)).toString("base64");
  entry.job.totalBytes += chunk.length;
  entry.job.truncated =
    entry.job.totalBytes > head.length + Buffer.from(entry.tail, "base64").length;
}
function drain(entry: JobRecord): string {
  const head = Buffer.from(entry.head, "base64");
  const tail = Buffer.from(entry.tail, "base64");
  const tailStart = entry.job.totalBytes - tail.length;
  let cursor = entry.cursor;
  const pieces: Buffer[] = [];
  if (cursor < head.length) {
    pieces.push(head.subarray(cursor));
    cursor = head.length;
  }
  if (cursor < tailStart) {
    pieces.push(Buffer.from(`\n...[${tailStart - cursor} bytes omitted]...\n`));
    cursor = tailStart;
  }
  if (cursor < entry.job.totalBytes) pieces.push(tail.subarray(cursor - tailStart));
  entry.cursor = entry.job.totalBytes;
  return Buffer.concat(pieces).toString("utf8");
}

function createJobTask(
  processes: Map<string, ChildProcess>,
  bufferBytes: number,
  onExited: (job: JobInfo) => void,
) {
  async function finish(
    runtime: JobRuntime,
    id: string,
    status: JobInfo["status"],
    context: Context,
    code?: number,
    note?: string,
  ) {
    let completed: JobInfo | undefined;
    await runtime.commit(async (tx) => {
      const entry = (await tx.doc(JobsDoc, runtime.conversationId)).entries[id];
      if (!entry) throw new Error("Background job document is missing");
      if (note) appendOutput(entry, Buffer.from(`${note}\n`), bufferBytes);
      entry.job.status = status;
      entry.job.endedAt = Date.now();
      if (code !== undefined) entry.job.exitCode = code;
      const result = buildJobResult(entry.job, outputTail(entry, 8000));
      if (result) entry.result = result;
      if (!entry.suppressed) completed = { ...entry.job };
      return {
        status: "terminal",
        outcome:
          status === "killed"
            ? { status: "aborted", result: entry.job }
            : status === "failed"
              ? {
                  status: "failed",
                  error: { message: note ?? `Process exited with code ${code ?? "unknown"}` },
                  result: entry.job,
                }
              : { status: "completed", result: entry.job },
      };
    }, context);
    if (completed) onExited(completed);
  }
  return defineTask<JobInput, JobPhase, JsonRepresentation<JobInfo>>({
    name: "oint.background-job",
    version: 1,
    initial: () => ({ phase: "run" }),
    phases: {
      async run(task, runtime, context) {
        // Commit before spawning. A crashed attempt is permanently interrupted, never rerun.
        if (await runtime.memo("spawn-attempted", context)) {
          await finish(
            runtime,
            task.input.id,
            "failed",
            context,
            undefined,
            "应用重启中断了后台进程；为避免重复副作用，命令未自动重跑。",
          );
          return;
        }
        await runtime.memo("spawn-attempted", true, context);
        const entry = (await runtime.snapshot(JobsDoc, task.conversationId, context))?.entries[
          task.input.id
        ];
        if (!entry) throw new Error("Background job document is missing");
        let writes = Promise.resolve();
        let child: ChildProcess | undefined;
        try {
          const shell = await resolveShell();
          const closed = new Promise<number | null>((resolve, reject) => {
            child = spawn(shell.shell, [...shell.args, entry.job.command], {
              cwd: entry.job.cwd,
              env: process.env,
              detached: process.platform !== "win32",
              windowsHide: true,
              stdio: ["ignore", "pipe", "pipe"],
            });
            processes.set(task.input.id, child);
            const onData = (chunk: Buffer) => {
              // Bound pending persistence as well as retained logs. Pipes apply OS backpressure.
              child?.stdout?.pause();
              child?.stderr?.pause();
              writes = writes.then(() =>
                runtime.commit(async (tx) => {
                  const current = (await tx.doc(JobsDoc, task.conversationId)).entries[
                    task.input.id
                  ];
                  if (current) appendOutput(current, chunk, bufferBytes);
                }, context),
              );
              void writes.then(
                () => {
                  child?.stdout?.resume();
                  child?.stderr?.resume();
                },
                () => {
                  if (child?.pid !== undefined) killProcessTreeSafe(child.pid);
                },
              );
            };
            child.stdout?.on("data", onData);
            child.stderr?.on("data", onData);
            child.once("error", reject);
            child.once("close", resolve);
          });
          void closed.catch(() => {});
          await runtime.commit(async (tx) => {
            const current = (await tx.doc(JobsDoc, task.conversationId)).entries[task.input.id];
            if (current && child?.pid !== undefined) current.job.pid = child.pid;
          }, context);
          const code = await awaitWithContext(closed, context);
          await writes;
          await finish(
            runtime,
            task.input.id,
            code === 0 ? "exited" : "failed",
            context,
            code ?? undefined,
          );
        } catch (error) {
          if (context.abortSignal?.aborted) throw error;
          await finish(runtime, task.input.id, "failed", context, undefined, String(error));
        } finally {
          if (context.abortSignal?.aborted && child?.pid !== undefined)
            killProcessTreeSafe(child.pid);
          processes.delete(task.input.id);
        }
      },
    },
    async abort(task, runtime, context) {
      const child = processes.get(task.input.id);
      if (child?.pid !== undefined) killProcessTreeSafe(child.pid);
      processes.delete(task.input.id);
      await finish(runtime, task.input.id, "killed", context);
    },
  });
}

export function createJobService(deps: JobServiceDeps): JobService {
  const attachments = createAttachmentRegistry();
  const processes = new Map<string, ChildProcess>();
  const task = createJobTask(processes, deps.bufferBytes ?? 64 * 1024, (job) => {
    try {
      deps.onExited?.(job);
    } catch (error) {
      console.warn(`作业退出回调失败：${String(error)}`);
    }
  });
  async function attach(attachment: NativeStateAttachment) {
    const detach = attachments.add(attachment);
    await attachment.harness.commit(
      (tx) => tx.doc(JobsDoc, attachment.conversationId),
      stateContext,
    );
    const watch = await attachment.harness.watchDoc(
      JobsDoc,
      attachment.conversationId,
      stateContext,
    );
    if (watch) {
      let previousIds: string[] = [];
      const publish = (value: typeof watch.value) => {
        const ids = Object.keys(value?.entries ?? {});
        for (const id of previousIds) {
          if (!ids.includes(id)) {
            try {
              deps.emit({
                sessionId: attachment.displaySessionId,
                event: { type: "job-removed", id },
              });
            } catch (error) {
              console.warn(`发送作业事件失败：${String(error)}`);
            }
          }
        }
        previousIds = ids;
        for (const entry of Object.values(value?.entries ?? {})) {
          try {
            deps.emit({
              sessionId: attachment.displaySessionId,
              event: { type: "job-changed", job: entry.job },
            });
          } catch (error) {
            console.warn(`发送作业事件失败：${String(error)}`);
          }
        }
      };
      publish(watch.value);
      watch.start(async (value) => publish(value));
    }
    return () => {
      detach();
      void watch?.stop();
    };
  }
  async function owned(sessionId: string, id: string, context = stateContext) {
    const attachment = attachments.require(sessionId);
    const entry = (await attachment.harness.snapshot(JobsDoc, attachment.conversationId, context))
      ?.entries[id];
    if (!entry) throw new Error(`找不到后台作业 ${id}（会话 ${sessionId}）`);
    return { attachment, entry };
  }
  async function find(id: string) {
    for (const attachment of attachments.all()) {
      const entry = (
        await attachment.harness.snapshot(JobsDoc, attachment.conversationId, stateContext)
      )?.entries[id];
      if (entry) return { attachment, entry };
    }
    return undefined;
  }
  async function start(input: JobStartInput) {
    const attachment = attachments.require(input.sessionId);
    const context = input.context ?? stateContext;
    if (input.api && attachment.conversationId !== input.api.conversationId)
      throw new Error("Job conversation mismatch");
    const commit = input.api
      ? input.api.commit.bind(input.api)
      : attachment.harness.commit.bind(attachment.harness);
    const id = await commit(async (tx) => {
      const doc = await tx.doc(JobsDoc, attachment.conversationId);
      const all = Object.values(doc.entries);
      if (all.length >= (deps.maxJobs ?? 16)) {
        const stale = all.find((entry) => entry.job.status !== "running");
        if (!stale)
          throw new Error(`会话内后台作业已达上限（${deps.maxJobs ?? 16} 个，全部仍在运行）`);
        delete doc.entries[stale.job.id];
      }
      const id = `job-${randomUUID()}`;
      const taskId = await tx.createTask(
        task,
        { id },
        {
          conversationId: attachment.conversationId,
          ownership: { kind: "conversation" },
          background: true,
        },
      );
      doc.entries[id] = {
        job: {
          id,
          sessionId: input.sessionId,
          command: input.command,
          cwd: input.cwd,
          status: "running",
          startedAt: Date.now(),
          totalBytes: 0,
          truncated: false,
        },
        taskId,
        cursor: 0,
        head: "",
        tail: "",
        suppressed: false,
        ...(input.toolCallId === undefined ? {} : { toolCallId: input.toolCallId }),
      };
      return id;
    }, context);
    attachment.harness.resume();
    return waitForDocument(
      await attachment.harness.watchDoc(JobsDoc, attachment.conversationId, context),
      (doc) => {
        const job = doc?.entries[id]?.job;
        return job && (job.pid !== undefined || job.status !== "running") ? job : undefined;
      },
      context,
    );
  }
  async function list(sessionId: string) {
    const attachment = attachments.require(sessionId);
    return Object.values(
      (await attachment.harness.snapshot(JobsDoc, attachment.conversationId, stateContext))
        ?.entries ?? {},
    ).map((entry) => entry.job);
  }
  async function read(
    sessionId: string,
    id: string,
    options?: JobReadOptions,
  ): Promise<JobReadResult> {
    const context = options?.context ?? stateContext;
    const { attachment, entry } = await owned(sessionId, id, context);
    const waitMs = Math.max(0, Math.min(30000, options?.waitMs ?? 0));
    if (waitMs > 0 && entry.job.status === "running" && entry.cursor === entry.job.totalBytes) {
      const watch = await attachment.harness.watchDoc(JobsDoc, attachment.conversationId, context);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          waitForDocument(
            watch,
            (doc) => {
              const current = doc?.entries[id];
              return current &&
                (current.job.status !== "running" || current.job.totalBytes > entry.job.totalBytes)
                ? true
                : undefined;
            },
            context,
          ),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, waitMs);
          }),
        ]);
      } finally {
        clearTimeout(timer);
        await watch?.stop();
      }
    }
    return attachment.harness.commit(async (tx) => {
      const current = (await tx.doc(JobsDoc, attachment.conversationId)).entries[id];
      if (!current) throw new Error(`找不到后台作业 ${id}`);
      const output = drain(current);
      return { job: { ...current.job }, output, running: current.job.status === "running" };
    }, context);
  }
  async function kill(sessionId: string, id: string) {
    const { attachment, entry } = await owned(sessionId, id);
    if (entry.job.status === "running") {
      await attachment.harness.abortTask(entry.taskId as TaskId, stateContext);
      await attachment.harness.waitForTask(entry.taskId as TaskId, stateContext);
    }
    return (await owned(sessionId, id)).entry.job;
  }
  async function cancelSession(sessionId: string) {
    const attachment = attachments.require(sessionId);
    await attachment.harness.commit(async (tx) => {
      for (const entry of Object.values((await tx.doc(JobsDoc, attachment.conversationId)).entries))
        entry.suppressed = true;
    }, stateContext);
    for (const job of await list(sessionId))
      if (job.status === "running") await kill(sessionId, job.id);
  }
  async function dispose() {
    for (const attachment of attachments.all()) await cancelSession(attachment.sessionId);
    for (const child of processes.values())
      if (child.pid !== undefined) killProcessTreeSafe(child.pid);
    processes.clear();
  }
  return {
    taskDefinitions: [task],
    attach,
    start,
    list,
    get: async (id) => (await find(id))?.entry.job,
    read,
    kill,
    cancelSession,
    dispose,
    toolCallIdOf: async (id) => (await find(id))?.entry.toolCallId,
    peekTail: async (id, maxBytes = 2048) => {
      const found = await find(id);
      return found ? outputTail(found.entry, maxBytes) : "";
    },
    isSuppressed: async (sessionId) => {
      const attachment = attachments.all().find((value) => value.sessionId === sessionId);
      if (!attachment) return true;
      const doc = await attachment.harness.snapshot(
        JobsDoc,
        attachment.conversationId,
        stateContext,
      );
      return Object.values(doc?.entries ?? {}).every((entry) => entry.suppressed);
    },
  };
}
async function resolveShell(): Promise<{ shell: string; args: string[] }> {
  const bash = resolveBashPath();
  if (bash !== undefined && existsSync(bash)) return { shell: bash, args: ["-c"] };
  if (process.platform === "win32") {
    // 与内核 getShellConfig 的兜底一致：没有可用的 bash 时用系统 shell。
    // 这里**绝不**回退到 System32\bash.exe —— 那是 WSL 入口，没配发行版会直接失败。
    return { shell: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c"] };
  }
  return { shell: "sh", args: ["-c"] };
}

/**
 * 杀掉整棵进程树。
 *
 * 一条 `npm run dev` 会派生 node / esbuild / 各种 watcher，只杀 shell 自己会留下孤儿进程
 * 继续占端口、继续写日志 —— 用户看到「已杀掉」但端口还占着，这是最坏的一种「成功」。
 *
 * - Windows：`taskkill /pid <pid> /T /F`（/T 连子进程，/F 强制）；Node 没有等价 API。
 * - POSIX：进程以 `detached: true` 起（自成进程组），对进程组发信号即覆盖全树；
 *   取负 pid 失败时退回杀单个 pid。
 *
 * 与内核 NodeExecutionEnv.exec 的超时 / 中断路径同一套做法。
 */
export function killProcessTree(pid: number): void {
  if (process.platform === "win32") {
    try {
      const child = spawn(
        path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
        ["/pid", String(pid), "/T", "/F"],
        { stdio: "ignore", detached: true, windowsHide: true },
      );
      // taskkill 缺失时 spawn 会异步发 error：必须消费掉，否则整个进程崩
      child.once("error", () => undefined);
    } catch {
      // 尽力而为：杀不掉也不该让调用方失败
    }
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // 进程已经没了
    }
  }
}

/**
 * pid 是否可用于杀进程树。
 *
 * 为什么必须判：node-pty 在 Windows 上的 conpty 代理把 innerPid 初始化为 0，
 * 极端时序下（进程起不来、或代理还没连上就退出）pid 会以 0 暴露出来。
 * 而 `taskkill /pid 0 /T /F` 在 Windows 上不是「什么都不做」——
 * 它会把 PID 0/4 名下的整棵系统进程树列出来尝试终止（实测会去动 System 进程）。
 * 所以「pid 为 0 就当没有 pid」，绝不能把它透传给 killProcessTree。
 */
function hasRealPid(pid: number): boolean {
  return Number.isInteger(pid) && pid > 0;
}

/** 只在 pid 有效时杀进程树；无效 pid 静默跳过（调用方本就没有可清理的东西） */
export function killProcessTreeSafe(pid: number): boolean {
  if (!hasRealPid(pid)) {
    console.warn(`跳过杀进程树：pid 无效（${pid}）`);
    return false;
  }
  killProcessTree(pid);
  return true;
}
