// 插件界面的命令执行 —— `window.oint.exec` 的实现。
//
// ## 为什么界面需要它
//
// 界面只有 `storage` / `notify` / `writeText` / `fetch` 时，能做的东西很有限：
// 一切"读本地状态"的面板（Git 状态、依赖清单、构建产物）都做不了 ——
// 而 `fetch` 又出不了本机。`exec` 是这类面板唯一的入口。
//
// ## 它比 `fetch` 危险，所以约束更硬
//
// 出站请求最坏是"把数据发出去"，而跑命令最坏是"在用户机器上执行任意东西"。
// 所以这里有三道**彼此独立**的约束，缺任何一道都能被绕过：
//
//  1. **命令必须在清单的白名单里**（`shell.exec`）。判据是**命令名本身**
//     而不是整条命令行 —— 比对整条会被 `git; rm -rf /` 这类拼接绕过。
//  2. **参数逐项传递，`shell: false`**。永远不拼字符串，永远不经过 shell。
//     （与 P0 缺口六修 MCP 启动时同一条纪律。）
//  3. **工作目录必须在允许根之内**。否则 `git -C /etc` 这类参数能把命令指向任何地方 ——
//     参数是插件写的，宿主拦不住它的语义，只能拦住"从哪开始跑"。
//
// 另外两道与安全无关但必须有的：**超时**（一个 `git fetch` 挂住会把面板卡死）
// 与**输出上限**（`git log` 的输出可以很大，而它在主进程内存里）。

import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";
import { buildChildEnv } from "@/main/security/child-env";
import { resolveRealPath, validateRealPathAccess } from "@/main/security/path-guard";

/** 单次执行的默认超时。够 `git status` / `git log` 用完，又不至于让面板卡住 */
const DEFAULT_TIMEOUT_MS = 15_000;
/** 超时上限：插件可以要求更短，但不能要求更长 */
const MAX_TIMEOUT_MS = 60_000;
/** stdout / stderr 各自的上限 */
const MAX_OUTPUT_BYTES = 512 * 1024;
/** 参数个数与单个参数长度上限 */
const MAX_ARGS = 64;
const MAX_ARG_CHARS = 4096;

export interface SurfaceExecResult {
  /** 退出码；被信号杀掉时是 null */
  code: number | null;
  stdout: string;
  stderr: string;
  /** 输出被截断了吗（截断不是错误，但要如实告诉插件，否则它会解析半个 JSON） */
  truncated: boolean;
}

export interface SurfaceExecRequest {
  command: string;
  args: readonly string[];
  /** 工作目录（绝对路径）；调用方负责解析默认值 */
  cwd: string;
  /** 清单里 `shell.exec` 的白名单 */
  allowedCommands: readonly string[];
  /** 允许的工作目录根 */
  allowedRoots: readonly string[];
  timeoutMs?: number;
}

/** 失败一律抛这个 —— 里面有可直接显示给插件作者的原因 */
export class SurfaceExecError extends Error {
  readonly code = "BAD_REQUEST";
  constructor(message: string) {
    super(message);
    this.name = "SurfaceExecError";
  }
}

/**
 * 命令名归一：只取 basename 比较。
 *
 * 白名单里写的是**裸命令名**（清单校验器强制：不含路径与空格）。
 * 而插件可能传 `git` 也可能传 `C:\Program Files\Git\cmd\git.exe` ——
 * 两者都指向同一个程序，但字符串不同。所以比 basename（去掉扩展名）：
 * 这样"白名单里有 git"就真的意味着"能跑 git"，而不是"能跑恰好写成 git 的那一个"。
 */
function normalizeCommand(value: string): string {
  const base = path.basename(value.replace(/\\/g, "/"));
  return base.replace(/\.(exe|cmd|bat|com)$/i, "").toLowerCase();
}

/** 参数检查：只挡形状，不解释语义（语义拦不住，所以靠"从哪开始跑"来兜底） */
function checkArgs(args: readonly string[]): void {
  if (args.length > MAX_ARGS) {
    throw new SurfaceExecError(`参数最多 ${MAX_ARGS} 个（收到 ${args.length}）`);
  }
  for (const arg of args) {
    if (typeof arg !== "string") throw new SurfaceExecError("参数必须是字符串");
    if (arg.length > MAX_ARG_CHARS) {
      throw new SurfaceExecError(`单个参数最长 ${MAX_ARG_CHARS} 个字符`);
    }
    // NUL 会截断底层传给 execve 的字符串 —— 一类经典的"看起来是 A，实际是 B"
    if (arg.includes("\u0000")) throw new SurfaceExecError("参数里不能有 NUL 字符");
  }
}

export async function execForPlugin(request: SurfaceExecRequest): Promise<SurfaceExecResult> {
  const { command, args } = request;

  // ── ① 命令必须在白名单里 ──────────────────────────────────────────────────
  const wanted = normalizeCommand(command);
  const allowed = new Set(request.allowedCommands.map(normalizeCommand));
  if (wanted === "") throw new SurfaceExecError("命令不能为空");
  if (!allowed.has(wanted)) {
    throw new SurfaceExecError(
      request.allowedCommands.length === 0
        ? "插件没有在清单里声明 shell.exec 白名单，不能执行命令"
        : `"${wanted}" 不在插件的命令白名单里（${request.allowedCommands.join(", ")}）`,
    );
  }

  // ── ② 参数只做形状检查 ────────────────────────────────────────────────────
  checkArgs(args);

  // ── ③ 工作目录必须在允许根之内（realpath 版本，挡符号链接） ─────────────────
  const cwd = await resolveRealPath(request.cwd);
  const access = await validateRealPathAccess(cwd, [...request.allowedRoots]);
  if (!access.ok) {
    throw new SurfaceExecError(`不能在 ${cwd} 里执行命令（不在允许的工作目录内）`);
  }

  const timeoutMs = Math.min(request.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

  return new Promise<SurfaceExecResult>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(command, [...args], {
        cwd,
        // **永远不经过 shell**：字符串拼接是命令注入的唯一入口，直接不给它机会
        shell: false,
        // 环境变量走白名单（与 exec-env / MCP 启动同一条纪律）
        env: buildChildEnv(process.env),
        // 不给 stdin：一个等输入的 git（比如 credential prompt）会挂到超时
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      reject(
        new SurfaceExecError(`启动失败：${error instanceof Error ? error.message : String(error)}`),
      );
      return;
    }

    let stdout = "";
    let stderr = "";
    let truncated = false;
    let settled = false;

    const collect = (target: "out" | "err") => (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (target === "out") {
        if (stdout.length >= MAX_OUTPUT_BYTES) {
          truncated = true;
          return;
        }
        stdout += text;
      } else {
        if (stderr.length >= MAX_OUTPUT_BYTES) {
          truncated = true;
          return;
        }
        stderr += text;
      }
    };
    child.stdout?.on("data", collect("out"));
    child.stderr?.on("data", collect("err"));

    /*
      超时用 `kill()` 而不是"放弃等待"：放弃等待会把子进程留在那里跑，
      而一个还在跑的 `git fetch` 会继续占着网络与磁盘。
    */
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve({
        code: null,
        stdout: trimTo(stdout, truncated),
        stderr: `${trimTo(stderr, truncated)}\n[命令在 ${timeoutMs}ms 后超时，已终止]`.trim(),
        truncated: true,
      });
    }, timeoutMs);

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new SurfaceExecError(`执行失败：${error.message}`));
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code,
        stdout: trimTo(stdout, truncated),
        stderr: trimTo(stderr, truncated),
        truncated,
      });
    });
  });
}

/**
 * 按**已经知道的事实**截断并留标记。
 *
 * 早先这里自己判一次 `value.length > MAX_OUTPUT_BYTES`，而 `collect` 那边也在判一次
 * （它按"追加时的长度"决定要不要继续收）。两个判据在边界上不一致：
 * 收集正好停在上限时，`truncated` 是 true 而文本里**没有**那句提示 ——
 * 插件看到一个自称被截断、却看不出截在哪的结果。
 *
 * 现在只认调用方给的 `truncated`：**一处判定，一处使用**。
 */
function trimTo(value: string, truncated: boolean): string {
  if (!truncated && value.length <= MAX_OUTPUT_BYTES) return value;
  return `${value.slice(0, MAX_OUTPUT_BYTES)}\n[…输出被截断]`;
}
