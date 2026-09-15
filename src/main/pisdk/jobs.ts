// 后台作业服务：把「长任务」摘出回合 —— 起一个后台进程，用工具去读输出 / 列表 / 杀掉它。
//
// 为什么需要它：内核的 bash 工具没有默认超时（bash.js 的 schema 写着 "no default timeout"），
// 一条 `npm run dev` 会把整轮运行无限期挂住。作业的语义与 bash 相反：**活过这一轮**。
//
// 三件事在这里定下来，别处不要再各写一份：
// 1. **shell 解析**：与内核 bash 工具同一套 —— 复用 exec-env 的 resolveBashPath()（它在 Windows
//    上会排除 System32 的 WSL 入口）。解析不到时退回系统 shell（Windows 的 ComSpec，即 cmd.exe），
//    与内核 getShellConfig 的兜底一致；**绝不**自己去用 System32\bash.exe，否则每条命令都会掉进 WSL。
// 2. **输出缓冲（drain 语义）**：head + tail 有界采样（默认 64 KiB = 头部 8 KiB + 尾部 56 KiB），
//    中间丢弃的字节计入 truncated / 丢失计数；另记绝对字节游标，read() 只返回上次读之后的新增内容。
//    这与 codex 的做法一致：进程活着时不能让它因为没人读输出就把管道写满卡死，也不能把整份日志
//    留在内存里。kill 掉进程树也同理（Windows 的 taskkill /T、POSIX 的进程组）。
// 3. **退出只上报，不发言**：进程退出后更新状态、发 job-changed、调用 deps.onExited(job)；
//    「要不要叫醒模型、叫醒几次」是运行时的事（见 runtime.ts 的作业唤醒预算），服务本身不发提示消息。
//
// 与 approvals / interactions 的关系：形态同源（未决表 + 事件桥 + 会话收尾），但**刻意不合并** ——
// 那两个是「挂起一个 Promise 等外部结算」，作业是「一条真实进程的生命周期 + 有界输出缓冲」，
// 抽一个共用的基类只会把两条互不相干的业务耦在一起。

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type { ChatEvent, ChatEventEnvelope } from "@/shared/contracts/chat";
import type { JobInfo, JobReadResult } from "@/shared/contracts/job";
import { resolveBashPath } from "./exec-env";

/** 同一会话内最多保留的作业数（含已结束、等着被模型补读输出的那些） */
const DEFAULT_MAX_JOBS = 16;
/** 每个作业的输出缓冲上限（字节）：头部 8 KiB + 尾部 56 KiB */
const DEFAULT_BUFFER_BYTES = 64 * 1024;
/** 头部采样大小：留着看启动阶段的报错与版本号 */
const HEAD_BYTES = 8 * 1024;
/** 单次 read 的等待上限：模型不该在这里一等几分钟 */
const DEFAULT_WAIT_MS = 30_000;
/** 等待期间多久回头看一眼（进程还在跑、又还没有新输出时） */
const WAIT_POLL_MS = 25;
/** peekTail 默认带出的字节数（通知文案用） */
const DEFAULT_TAIL_BYTES = 2 * 1024;

export interface JobServiceDeps {
  /** 发往渲染进程的事件；带会话 id（后台会话的作业也只画在它自己那里） */
  emit: (payload: ChatEventEnvelope) => void;
  /**
   * 作业退出（正常 / 失败 / 被杀）后的回调。
   *
   * 通知模型、清点唤醒预算都是调用方的事：本服务只保证「每个作业恰好回调一次」，
   * 且在 cancelSession / dispose 这类**主动清理**导致的退出时**不回调**（用户已经不要它了）。
   */
  onExited?: (job: JobInfo) => void;
  /** 同一会话的作业数上限；缺省 DEFAULT_MAX_JOBS */
  maxJobs?: number;
  /** 每个作业的输出缓冲上限（字节）；缺省 DEFAULT_BUFFER_BYTES */
  bufferBytes?: number;
}

export interface JobStartInput {
  sessionId: string;
  command: string;
  /** 进程工作目录（会话 cwd，由调用方解析好） */
  cwd: string;
  /**
   * 启动这次作业的工具调用 id（可选）：作业结束时 runtime 用它把结论
   * **回填到那次 `bash_background` 调用**上，而不是往对话里发一条新消息。
   * 不传就不回填（作业照常跑，结果仍可由 job_output 读到）。
   */
  toolCallId?: string;
}

export interface JobReadOptions {
  /**
   * 最多等这么久（毫秒）：等作业先产出一点输出、或直接退出。
   *
   * 缺省 0（立刻返回当前已积累内容），上限 30_000 —— 模型等输出不该比这更久，
   * 到点还没动静就再调一次 read。
   */
  waitMs?: number;
}

export interface JobService {
  /** 起一个后台作业，立即发出 job-changed 并返回快照 */
  start(input: JobStartInput): Promise<JobInfo>;
  /** 该会话的全部作业（最老在前，与 job_list 的展示顺序一致） */
  list(sessionId: string): JobInfo[];
  get(id: string): JobInfo | undefined;
  /** drain 读输出：返回上次 read 之后的新增内容 */
  read(sessionId: string, id: string, options?: JobReadOptions): Promise<JobReadResult>;
  /** 杀作业（连带进程树）；作业不存在或不属于该会话时当作「找不到」并抛错 */
  kill(sessionId: string, id: string): Promise<JobInfo>;
  /** 关闭会话时清理：杀掉该会话全部作业并移除记录（用户主动清理 → 不触发 onExited） */
  cancelSession(sessionId: string): void;
  /** 进程退出（杀全部作业），用于应用退出 */
  dispose(): Promise<void>;
  /**
   * 启动这次作业的工具调用 id（记在内部记录里，不进 JobInfo）。
   *
   * 运行时在作业退出时靠它把结论回填到那次 `bash_background` 调用上 ——
   * 那是「作业的结论」该出现的地方，而不是往对话里发一条新消息。
   * 未知 id（作业已被淘汰 / 记录已清）返回 undefined，调用方据此跳过回填。
   */
  toolCallIdOf(id: string): string | undefined;
  /** 取最近一段输出（不推进 read 游标）；通知文案用它带出「最后几行」 */
  peekTail(id: string, maxBytes?: number): string;
  /**
   * 该会话是否已被 cancelSession 标记清理。
   *
   * 运行时在 onExited 里必须问一句：作业退出与用户关闭会话可能几乎同时发生，
   * 此时**不该**再往一个已经关掉的会话里注入通知。
   */
  isSuppressed(sessionId: string): boolean;
}

/**
 * 服务内部的作业记录：对外快照（JobInfo）+ 进程句柄 + 输出缓冲 + 读取游标。
 *
 * `toolCallId` 是**故意留在这里、不进 JobInfo 的**：它唯一的用途是「作业结束时
 * 把结论回填到启动它的那次工具调用上」（见 runtime 的 deliverJobResult）。
 * JobInfo 是共享契约、会随 ChatEvent 结构化克隆送进渲染进程，
 * 而渲染层拿到 toolCallId 也没有消费方 —— 与其把它暴露成公共字段，
 * 不如留在这份内部记录里，边界更清楚。
 */
interface JobEntry {
  job: JobInfo;
  /** spawn 成功后接上的进程句柄（stdout / stderr / 退出事件都在它身上） */
  child?: ChildProcess;
  buffer: DrainBuffer;
  /** 上一次 read 返回到的绝对字节位置（drain 语义的游标） */
  readCursor: number;
  /** 是否已结算过终态：spawn 的 error 与 close 事件都只允许结算一次 */
  settled: boolean;
  /** 启动这次作业的工具调用 id：作业结束时据此把结果回填到那次调用上 */
  toolCallId?: string;
  /** 启动这次作业的 agent 名（回填时用于文案与面板显示，缺省时按 id 兜底） */
  agentLabel?: string;
}

/** 一次读取要返回的文本 + 读完之后的新游标 */
interface DrainRead {
  text: string;
  position: number;
}

/** 跨过被丢弃区间时插在拼接处的省略标记（模型必须知道自己漏了什么） */
function omissionMarker(bytes: number): string {
  return `\n...[${bytes} bytes omitted]...\n`;
}

/**
 * head + tail 有界缓冲：写侧永不阻塞，读侧按绝对游标 drain。
 *
 * 布局（按字节位置从左到右）：
 * ```
 * head（最早，≤headBytes） | drainHead + drainTail（滚动窗口，≤bufferBytes） | 新写入
 *                          ↑ 超出 bufferBytes 的部分在这里被丢弃
 * ```
 * 读游标落在被丢弃区间时，返回的文本里以 `...[N bytes omitted]...` 明示缺口 —— 模型必须
 * 知道自己漏了什么，否则会把「中间没报错」当成「中间没发生」。
 *
 * 为什么还要 head：滚动窗口只保尾部时，一条「启动 3 秒后开始刷日志」的进程会把最初的
 * 报错顶出去，而那几行恰恰是模型最需要的。头部 8 KiB 单独钉住，代价是内存上限 +8 KiB。
 */
class DrainBuffer {
  /** 最早的 headBytes：一旦填满就不再增长 */
  private head = "";
  /** 被丢弃的字节数（单调增长；>0 即 truncated） */
  private dropped = 0;
  /** 滚动窗口的头部：只在把 head 超长的尾巴挪出来时填充 */
  private drainHead = "";
  /** 滚动窗口的尾部：新输出先落这里 */
  private drainTail = "";
  /** 从进程收到的字节总数（含已被丢弃的） */
  private total = 0;

  constructor(
    private readonly headBytes: number,
    private readonly bufferBytes: number,
  ) {}

  get totalBytes(): number {
    return this.total;
  }

  get droppedBytes(): number {
    return this.dropped;
  }

  get truncated(): boolean {
    return this.dropped > 0;
  }

  /** 写入一块输出；永不抛错、永不阻塞调用方 */
  add(chunk: string): void {
    if (chunk === "") return;
    this.total += Buffer.byteLength(chunk, "utf8");
    if (this.head.length < this.headBytes) {
      this.head += chunk;
    } else {
      this.drainTail += chunk;
    }
    this.normalize();
  }

  /**
   * 维持两条不变式：head ≤ headBytes 且 head 永远是最早那段；滚动窗口 ≤ bufferBytes。
   * 超出都从**最老**的一头丢，丢掉多少记进 dropped。
   */
  private normalize(): void {
    if (this.head.length > this.headBytes) {
      // head 超长的部分整体移进滚动窗口的头部：它比窗口里的任何内容都老
      this.drainHead = this.head.slice(this.headBytes) + this.drainHead;
      this.head = this.head.slice(0, this.headBytes);
    }
    while (this.drainHead.length + this.drainTail.length > this.bufferBytes) {
      const overflow =
        this.drainHead.length + this.drainTail.length - Math.max(this.bufferBytes, 0);
      // 弃掉窗口里**最老**的一头：drainHead 整体比 drainTail 老，先丢它。
      // 只丢 drainTail 有两个后果：drainHead 单独超限（一块输出就比整条缓冲大）时 drainTail
      // 是空的、循环永不收敛（主进程被卡死）；以及留下「旧的还在、新的先丢」的错位窗口。
      const droppedHead = this.drainHead.slice(0, overflow);
      this.drainHead = this.drainHead.slice(overflow);
      const rest = overflow - droppedHead.length;
      const droppedTail = rest > 0 ? this.drainTail.slice(0, rest) : "";
      if (rest > 0) this.drainTail = this.drainTail.slice(rest);
      this.dropped += Buffer.byteLength(droppedHead + droppedTail, "utf8");
    }
  }

  /**
   * 读取 `[from, 当前 total)` 区间：返回文本 + 新游标。
   *
   * 跨过被丢弃区间时在拼接处插入省略标记；游标一律推进到当前 total，
   * 避免同一段缺口被反复报（模型再读一次只会拿到「没有新输出」）。
   */
  readFrom(from: number): DrainRead {
    const headEnd = Math.min(this.head.length, this.total);
    const window = this.drainHead + this.drainTail;
    // 窗口里存的是「最近的 window.length 字节」，起点就是 total - window.length。
    // （这里曾经多减了一个 head.length：每次 read 都会静默吞掉 head.length 字节的新输出）
    const windowStart = this.total - window.length;
    const start = Math.max(0, Math.min(from, this.total));
    let text = "";
    let cursor = start;

    if (cursor < headEnd) {
      text += this.head.slice(cursor, headEnd);
      cursor = headEnd;
    }

    const windowCursor = Math.max(cursor, windowStart);
    if (windowCursor > cursor) text += omissionMarker(windowCursor - cursor);
    const fromIndex = windowCursor - windowStart;
    if (window !== "" && fromIndex < window.length) {
      text += fromIndex <= 0 ? window : window.slice(fromIndex);
    }

    return { text, position: this.total };
  }

  /**
   * 取当前采样末尾的 `maxBytes` 字节（不推进任何游标）。
   *
   * 给通知文案用：作业退出时要把「最后几行」带进模型上下文，而这个读取**不能**消耗
   * job_output 的 drain 游标 —— 否则模型按通知里的提示再调一次 job_output 就什么也读不到。
   */
  tailPeek(maxBytes: number): string {
    const window = this.head + this.drainHead + this.drainTail;
    if (window === "" || maxBytes <= 0) return "";
    if (Buffer.byteLength(window, "utf8") <= maxBytes) return window;
    let sliced = window.slice(-maxBytes);
    // 别从半行或半个多字节字符开始：从第一个换行之后接起
    const newline = sliced.indexOf("\n");
    if (newline >= 0 && newline < sliced.length - 1) sliced = sliced.slice(newline + 1);
    return sliced;
  }
}

/** 通知文案里的尾部输出：最多 maxLines 行，超出时在开头注明省略了几行 */
function lastLines(text: string, maxLines: number): string {
  const lines = text.split(/\r?\n/);
  if (lines.length <= maxLines) return text;
  return `...(${lines.length - maxLines} lines omitted)\n${lines.slice(-maxLines).join("\n")}`;
}

/** 解析 shell：与内核 bash 工具同一套（见文件顶部的说明） */
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

/** 把毫秒等待夹到 [0, 上限]；非法值按 0 处理 */
function clampWaitMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) return 0;
  return Math.min(Math.floor(value), DEFAULT_WAIT_MS);
}

/** 快照：对外只暴露 JobInfo 的字段（内部引用一个都不漏） */
function snapshot(entry: JobEntry): JobInfo {
  return { ...entry.job };
}

export function createJobService(deps: JobServiceDeps): JobService {
  const maxJobs = deps.maxJobs ?? DEFAULT_MAX_JOBS;
  const bufferBytes = deps.bufferBytes ?? DEFAULT_BUFFER_BYTES;
  // 头部采样不超过缓冲的 1/8，保证「头 8K + 尾 56K」在缓冲被调小时也成立
  const headBytes = Math.min(HEAD_BYTES, Math.max(1, Math.floor(bufferBytes / 8)));

  const jobs = new Map<string, JobEntry>();
  /** sessionId → 该会话的作业 id（按创建顺序），用于上限淘汰与 cancelSession */
  const bySession = new Map<string, string[]>();
  /**
   * 全局自增序号：job-1、job-2 ……
   *
   * id 是 jobs 这张**全服务共用**作业表的键，必须全局唯一：按会话各自从 1 数，两个会话的第一个
   * 作业会撞成同一个 job-1，后一个把前一个从表里覆盖掉 —— 前一个就此失联（kill 不掉、读不到），
   * 最后还会被另一个会话的 cancelSession 顺手删掉。
   */
  let nextJobNumber = 0;
  /** 已清理的会话：清理期间与其后到来的退出事件都不通知模型 */
  const suppressedSessions = new Set<string>();
  /** shell 解析一次就够（失败也不重复探测） */
  let shellPromise: Promise<{ shell: string; args: string[] }> | undefined;

  function emitSafe(sessionId: string, event: ChatEvent): void {
    try {
      deps.emit({ sessionId, event });
    } catch (error) {
      console.warn(`发送作业事件失败：${String(error)}`);
    }
  }

  function idsOf(sessionId: string): string[] {
    return bySession.get(sessionId) ?? [];
  }

  function nextJobId(): string {
    nextJobNumber += 1;
    return `job-${nextJobNumber}`;
  }

  /** 登记一个作业（总表与会话索引一起维护，别处不要再各写一份） */
  function remember(sessionId: string, entry: JobEntry): void {
    jobs.set(entry.job.id, entry);
    bySession.set(sessionId, [...idsOf(sessionId), entry.job.id]);
  }

  /** 从会话索引里摘掉一个作业（不杀进程、不发事件） */
  function forget(sessionId: string, id: string): void {
    jobs.delete(id);
    const remaining = idsOf(sessionId).filter((candidate) => candidate !== id);
    if (remaining.length === 0) bySession.delete(sessionId);
    else bySession.set(sessionId, remaining);
  }

  function shell(): Promise<{ shell: string; args: string[] }> {
    shellPromise ??= resolveShell();
    return shellPromise;
  }

  /** 每个作业恰好结算一次：更新状态、发事件、按需回调 */
  function settle(entry: JobEntry, status: JobInfo["status"], exitCode?: number): void {
    if (entry.settled) return;
    entry.settled = true;
    entry.job.status = status;
    if (exitCode !== undefined) entry.job.exitCode = exitCode;
    entry.job.endedAt = Date.now();
    entry.job.totalBytes = entry.buffer.totalBytes;
    entry.job.truncated = entry.buffer.truncated;
    const info = snapshot(entry);
    emitSafe(info.sessionId, { type: "job-changed", job: info });
    // 主动清理（关会话 / 退出应用）时不要打扰已经不要这些作业的会话
    if (suppressedSessions.has(info.sessionId)) return;
    try {
      deps.onExited?.(info);
    } catch (error) {
      console.warn(`作业退出回调失败：${String(error)}`);
    }
  }

  function attach(entry: JobEntry, child: ChildProcess): void {
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    const onData = (chunk: string | Buffer): void => {
      entry.buffer.add(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
      entry.job.totalBytes = entry.buffer.totalBytes;
      entry.job.truncated = entry.buffer.truncated;
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (error: Error) => {
      // spawn 失败（cwd 不存在、可执行文件找不到）也会走到这里：没有退出码可言
      console.warn(`后台作业失败 ${entry.job.id}：${error.message}`);
      settle(entry, entry.job.status === "killed" ? "killed" : "failed");
    });
    child.on("close", (code: number | null) => {
      // 用 close 而不是 exit：close 保证 stdio 已经流干净，尾部输出不会缺最后一行
      settle(
        entry,
        entry.job.status === "killed" ? "killed" : code === 0 ? "exited" : "failed",
        code ?? undefined,
      );
    });
  }

  async function start(input: JobStartInput): Promise<JobInfo> {
    // 会话（重新）开始时撤销抑制标记：上次关闭留下的脏标记不能吃掉这次的第一个作业
    suppressedSessions.delete(input.sessionId);

    const ids = idsOf(input.sessionId);
    if (ids.length >= maxJobs) {
      // 先淘汰已结束的（最老的优先）：它们已经通知过、输出也多半被读过了。
      // 「保留活作业」优先于「保留老记录」—— 正在跑的进程才是用户真实占用的资源。
      const finished = ids
        .map((id) => jobs.get(id))
        .filter(
          (entry): entry is JobEntry => entry !== undefined && entry.job.status !== "running",
        );
      const stale = finished[0];
      if (stale !== undefined) {
        forget(input.sessionId, stale.job.id);
        emitSafe(input.sessionId, { type: "job-removed", id: stale.job.id });
      }
    }

    if (idsOf(input.sessionId).length >= maxJobs) {
      throw new Error(
        `会话内后台作业已达上限（${maxJobs} 个，全部仍在运行）：` +
          "请先用 job_kill 结束不再需要的作业，或等它们退出。",
      );
    }

    const { shell: shellPath, args } = await shell();
    const entry: JobEntry = {
      job: {
        id: nextJobId(),
        sessionId: input.sessionId,
        command: input.command,
        cwd: input.cwd,
        status: "running",
        startedAt: Date.now(),
        totalBytes: 0,
        truncated: false,
      },
      buffer: new DrainBuffer(headBytes, bufferBytes),
      readCursor: 0,
      settled: false,
      // 记下是谁起的它：作业结束时 runtime 靠这个把结论回填到那次调用上
      ...(input.toolCallId === undefined ? {} : { toolCallId: input.toolCallId }),
    };

    let child: ChildProcess;
    try {
      child = spawn(shellPath, [...args, input.command], {
        cwd: input.cwd,
        // env 只继承 process.env：会话需要什么变量是用户 shell profile 的事，
        // 这里注入额外变量会让「在 Oint 里跑」与「在终端里跑」变成两种行为
        env: process.env,
        // POSIX 上自成进程组，kill 时对 -pid 发信号即可覆盖整棵树（见 killProcessTree）
        detached: process.platform !== "win32",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      entry.job.status = "failed";
      entry.job.endedAt = Date.now();
      remember(input.sessionId, entry);
      emitSafe(input.sessionId, { type: "job-changed", job: snapshot(entry) });
      throw new Error(
        `后台作业启动失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }

    entry.child = child;
    if (typeof child.pid === "number") entry.job.pid = child.pid;
    remember(input.sessionId, entry);
    attach(entry, child);

    // 立刻发一次：渲染层要马上看到「起了一个作业」，而不是等它第一次输出
    const started = snapshot(entry);
    emitSafe(input.sessionId, { type: "job-changed", job: started });
    return started;
  }

  function list(sessionId: string): JobInfo[] {
    return idsOf(sessionId)
      .map((id) => jobs.get(id))
      .filter((entry): entry is JobEntry => entry !== undefined)
      .map(snapshot);
  }

  function get(id: string): JobInfo | undefined {
    const entry = jobs.get(id);
    return entry === undefined ? undefined : snapshot(entry);
  }

  /** 会话 fence：作业必须存在且属于这个会话，否则一律当作「找不到」 */
  function findOwned(sessionId: string, id: string): JobEntry | undefined {
    const entry = jobs.get(id);
    if (entry === undefined) return undefined;
    if (entry.job.sessionId !== sessionId) return undefined;
    return entry;
  }

  /** 等作业先产出输出或先退出；waitMs 到点就带着当前快照返回 */
  async function waitForNewOutput(entry: JobEntry, waitMs: number): Promise<void> {
    if (waitMs <= 0) return;
    const deadline = Date.now() + waitMs;
    const baseline = entry.buffer.totalBytes;
    while (Date.now() < deadline) {
      if (entry.job.status !== "running" || entry.buffer.totalBytes > baseline) return;
      await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS));
    }
  }

  async function read(
    sessionId: string,
    id: string,
    options?: JobReadOptions,
  ): Promise<JobReadResult> {
    const entry = findOwned(sessionId, id);
    if (entry === undefined) throw new Error(`找不到后台作业 ${id}（会话 ${sessionId}）`);

    await waitForNewOutput(entry, clampWaitMs(options?.waitMs));

    const drained = entry.buffer.readFrom(entry.readCursor);
    entry.readCursor = drained.position;
    entry.job.totalBytes = entry.buffer.totalBytes;
    entry.job.truncated = entry.buffer.truncated;
    return { job: snapshot(entry), output: drained.text, running: entry.job.status === "running" };
  }

  async function kill(sessionId: string, id: string): Promise<JobInfo> {
    const entry = findOwned(sessionId, id);
    if (entry === undefined) throw new Error(`找不到后台作业 ${id}（会话 ${sessionId}）`);

    if (entry.job.status === "running") {
      // 先记成 killed 再杀：close 事件到达时按这个标记结算，不会被非零退出码改写成 failed
      entry.job.status = "killed";
      if (typeof entry.job.pid === "number") {
        killProcessTree(entry.job.pid);
      } else {
        // 没有 pid（spawn 失败后留下的记录）：直接结算，否则它永远停在 running
        settle(entry, "killed");
      }
    }
    return snapshot(entry);
  }

  /** 清理该会话的全部作业：先标抑制再杀，退出事件因此不会去叫醒模型 */
  function cancelSession(sessionId: string): void {
    suppressedSessions.add(sessionId);
    for (const id of [...idsOf(sessionId)]) {
      const entry = jobs.get(id);
      if (entry === undefined) continue;
      if (entry.job.status === "running" && typeof entry.job.pid === "number") {
        entry.job.status = "killed";
        killProcessTree(entry.job.pid);
      }
      forget(sessionId, id);
      emitSafe(sessionId, { type: "job-removed", id });
    }
    bySession.delete(sessionId);
  }

  async function dispose(): Promise<void> {
    for (const sessionId of [...bySession.keys()]) cancelSession(sessionId);
    // 兜底：万一有作业的会话索引已经不在（不该发生），也别把进程漏下
    for (const entry of [...jobs.values()]) {
      if (entry.job.status === "running" && typeof entry.job.pid === "number") {
        entry.job.status = "killed";
        killProcessTree(entry.job.pid);
      }
    }
    jobs.clear();
    bySession.clear();
  }

  /** 启动这次作业的工具调用 id：作业退出时 runtime 靠它把结论回填到那次调用上 */
  function toolCallIdOf(id: string): string | undefined {
    return jobs.get(id)?.toolCallId;
  }


  function peekTail(id: string, maxBytes = DEFAULT_TAIL_BYTES): string {
    const entry = jobs.get(id);
    if (entry === undefined) return "";
    return lastLines(entry.buffer.tailPeek(maxBytes), 20);
  }

  function isSuppressed(sessionId: string): boolean {
    return suppressedSessions.has(sessionId);
  }

  return { start, list, get, read, kill, cancelSession, dispose, peekTail, isSuppressed, toolCallIdOf };
}
