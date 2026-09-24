// 单个插件的进程：启动、握手、调用、停止。
//
// ## 为什么注入 `fork` 而不是直接调 `utilityProcess`
//
// 因为这一层真正要测的东西 —— 握手超时、调用超时、崩溃时挂起调用怎么办、
// 声明不合法时怎么拒 —— **全都不需要真进程**。把 `utilityProcess.fork` 写死在这里，
// 那些分支就只能靠"起一个真进程再想办法让它崩"来测，而那种测试是不可靠的。
//
// 所以 `fork` 是依赖：生产注入薄包装（process-host.ts），测试注入假的。
// 这也让 electron 不进这个模块 —— 它能在 node 单测里跑。
//
// ## 三条与"外部代码"有关的纪律
//
//  1. **每一步都有截止时间。** 插件进程是一段第三方代码：它可能死循环、可能在
//     一个永远不来的东西上等。没有截止时间的话，模型的整个回合会挂住，
//     而用户看到的是"发出去没反应"。
//  2. **环境变量走白名单。** 复用 `buildChildEnv`（P0 缺口三修的那一份）——
//     插件进程没有理由拿到宿主的 `OPENAI_API_KEY`。
//  3. **不合法就拒绝启动**，而不是"跳过那一条、留其余的"。静默跳过会让作者
//     以为自己注册成功了，而他没有任何途径知道宿主丢掉了它。

import path from "node:path";
import { buildChildEnv } from "@/main/security/child-env";
import { resolveRealPath, validateRealPathAccess } from "@/main/security/path-guard";
import type { PluginHookDecl, PluginHookEvent } from "@/shared/contracts/plugin";
import {
  type HostToPluginMessage,
  PLUGIN_RPC_VERSION,
  type PluginCommandDecl,
  type PluginHookPayload,
  type PluginHookResultMessage,
  type PluginReadyMessage,
  type PluginResultMessage,
  type PluginToHostMessage,
  type PluginToolDecl,
  validateCommandDecls,
  validateToolDecls,
} from "@/shared/contracts/plugin-rpc";
import type { HookOutcome } from "./hooks";

/** 一个已启动的进程句柄 —— 只留我们真正用到的那几个成员 */
export interface PluginProcessHandle {
  postMessage(message: unknown): void;
  /** 收到插件发来的消息；返回取消订阅函数 */
  onMessage(handler: (message: unknown) => void): () => void;
  /** 进程退出；返回取消订阅函数 */
  onExit(handler: (code: number) => void): () => void;
  kill(): void;
  /**
   * 子进程的 stderr（已经收到的那些）。
   *
   * **必须有这个出口。** 早先 fork 时用了 `stdio: "pipe"` 却从不读那两个管道，
   * 于是插件进程一启动就崩（比如 `.js` 被当成 ESM、`require` 不存在）时，
   * 宿主只能报"退出码 1"—— 而真正的错误原文就在那个没人读的 stderr 里。
   * 一个为了拿输出而设的管道，不读它等于没设。
   */
  readStderr?(): string;
}

/** 启动一个子进程。生产实现是 `utilityProcess.fork` 的薄包装 */
export type ForkPluginProcess = (
  entry: string,
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => PluginProcessHandle;

/** 一次工具调用的结果。**用返回值而不是异常**：调用方是模型工具层，
 *  它要的是"给模型看的一段错误文案"，不是异常 */
export type PluginCallResult = { ok: true; text: string } | { ok: false; error: string };

/**
 * 挂起请求的应答信封。
 *
 * 工具/命令的 `result` 与钩子的 `hookResult` **共用这一条结算路径**：
 * 超时、崩溃、正常应答三条路各写一份的话，"崩溃时忘记结算"这类漏会在某一条上出现，
 * 而它的症状是模型的回合永远等下去（这个教训已经在 send 的注释里记过一次了）。
 */
type PluginReply =
  | { ok: true; message: PluginResultMessage | PluginHookResultMessage }
  | { ok: false; error: string };

export interface PluginProcessOptions {
  pluginId: string;
  /** 插件根目录的**绝对路径**（已由注册表确认存在） */
  pluginDir: string;
  /** 清单里 `main` 的包内相对路径（`./main.js`） */
  entry: string;
  permissions: readonly string[];
  /**
   * 清单里声明的钩子（缺省 = 这个插件没有钩子）。
   *
   * 进程侧要拿它跟 `ready.hooks` **对账**：声明了却没实现、实现了却没声明，
   * 两种都拒绝加载（见 PluginReadyMessage.hooks 的说明）。
   *
   * 缺省而不是必填：调用点大多是测试与"不关心钩子"的场景，写一个 `hooks: []`
   * 只是噪音。真忘了传的后果是**响的** —— 插件在 `ready` 里报的钩子会被判成
   * "实现了未声明的钩子"而拒绝加载，不会被静默忽略。
   */
  hooks?: readonly PluginHookDecl[];
  /** 插件私有数据目录 */
  dataDir: string;
  fork: ForkPluginProcess;
  /** 握手截止时间（毫秒） */
  handshakeTimeoutMs?: number;
  /** 单次调用的截止时间（毫秒） */
  callTimeoutMs?: number;
  /** 单次钩子调用的截止时间（毫秒）。**比工具调用短得多**：它在工具执行的关键路径上 */
  hookTimeoutMs?: number;
  /** 插件主动打的日志（进诊断流，**不进模型上下文**） */
  onLog?: (level: "info" | "warn" | "error", message: string) => void;
}

export interface PluginProcess {
  readonly tools: PluginToolDecl[];
  readonly commands: PluginCommandDecl[];
  /** 调用插件的一个工具 */
  call(tool: string, args: unknown, workspaceDir: string): Promise<PluginCallResult>;
  /**
   * 执行插件的一个命令。
   *
   * 与 `call` **共用同一套请求/应答机制**（同一个 id 空间、同一个结果形状），
   * 区别只在插件侧把它当成哪种东西 —— 见 PluginRunMessage 的说明。
   */
  run(command: string, args: string, workspaceDir: string): Promise<PluginCallResult>;
  /** 调用插件的一个钩子（`hookId` 是清单里声明的 id） */
  hook(hookId: string, event: PluginHookEvent, payload: PluginHookPayload): Promise<HookOutcome>;
  /** 停掉进程（幂等） */
  stop(): void;
  readonly alive: boolean;
  /** 退出码；还没退出时是 null。诊断与「为什么它没了」都靠它 */
  readonly exitCode: number | null;
}

/** 握手失败 / 声明不合法 / 进程提前退出 —— 都归成这一类，带可读原因 */
export class PluginProcessStartError extends Error {
  readonly issues: string[];
  constructor(message: string, issues: string[] = []) {
    super(message);
    this.name = "PluginProcessStartError";
    this.issues = issues;
  }
}

/** 把已经收到的 stderr 拼进失败原因 —— 没有就不加，避免结尾多一个空行 */
function stderrTail(handle: PluginProcessHandle): string {
  const detail = handle.readStderr?.().trim() ?? "";
  return detail === "" ? "" : `：\\n${detail}`;
}

const DEFAULT_HANDSHAKE_TIMEOUT = 5000;
const DEFAULT_CALL_TIMEOUT = 120_000;
/**
 * 钩子调用的默认预算：**5 秒**（方案 §4.9 给"每个宿主钩子"的那个数字）。
 *
 * 与工具调用的 120s 差了 24 倍，理由是这个预算挂在**完全不同的路径**上：
 * 工具调用是模型主动发起的一次操作，等两分钟可以接受；而 `PreToolUse` 在**每一次**
 * 工具执行之前，它的超时直接加到用户感知的等待上 —— 一个卡住的钩子会让"每一步都卡 5 秒"。
 */
const DEFAULT_HOOK_TIMEOUT = 5000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function startPluginProcess(options: PluginProcessOptions): Promise<PluginProcess> {
  const handshakeTimeout = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT;
  const callTimeout = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT;
  const hookTimeout = options.hookTimeoutMs ?? DEFAULT_HOOK_TIMEOUT;

  /*
    **入口必须落在插件目录内**（realpath 版本）。

    清单校验已经做过一次，但那是纯字符串的形状检查，**挡不住符号链接**；
    而这里要真的把它交给一个子进程去执行 —— 执行一个指向插件目录外的文件，
    等于给了插件一个"让宿主替我跑别的目录里的代码"的口子。
  */
  const entryPath = await resolveRealPath(path.join(options.pluginDir, options.entry));
  const access = await validateRealPathAccess(entryPath, [options.pluginDir]);
  if (!access.ok) {
    throw new PluginProcessStartError(`插件入口跑出了插件目录：${options.entry}`);
  }

  const handle = options.fork(entryPath, {
    /*
      用 `pluginDir` 而不是 `dataDir` 作 cwd：插件是按包内的相对路径 require 自己的
      模块的（`require("./lib/x")`），cwd 不对会让它们全部找不到。

      **环境变量走白名单**（P0 缺口三那一份）：插件进程没有理由拿到宿主的
      `OPENAI_API_KEY` / `GITHUB_TOKEN`。要凭据就在清单里声明、由宿主显式注入。
    */
    cwd: options.pluginDir,
    env: buildChildEnv(process.env, {
      OINT_PLUGIN_ID: options.pluginId,
      OINT_PLUGIN_DATA: options.dataDir,
    }),
  });

  let alive = true;
  let ready = false;
  let exitCode: number | null = null;

  /** 一个挂起调用：结算函数 + 它的截止时间 */
  interface PendingCall {
    resolve: (reply: PluginReply) => void;
    deadline: ReturnType<typeof setTimeout>;
  }
  const pending = new Map<number, PendingCall>();
  let nextCallId = 1;

  /**
   * 结算一个挂起的请求。**超时、崩溃、正常应答三条路都走它** ——
   * 三条路各写一份的话，"崩溃时忘记结算"这类漏会在某一条上出现，
   * 而它的症状是模型的回合永远等下去。
   */
  const settle = (id: number, reply: PluginReply): void => {
    const entry = pending.get(id);
    if (entry === undefined) return;
    pending.delete(id);
    clearTimeout(entry.deadline);
    entry.resolve(reply);
  };

  const failAllPending = (reason: string): void => {
    for (const id of [...pending.keys()]) settle(id, { ok: false, error: reason });
  };

  let readyResolve: ((value: PluginReadyMessage) => void) | null = null;
  let readyReject: ((error: Error) => void) | null = null;
  const readyPromise = new Promise<PluginReadyMessage>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });

  const offMessage = handle.onMessage((raw) => {
    if (!isRecord(raw) || typeof raw.type !== "string") return;
    const message = raw as unknown as PluginToHostMessage;

    if (message.type === "ready") {
      // 版本不匹配就拒绝 —— 与清单的 apiVersion 同一条纪律：
      // 不认识的版本按旧版解释，字段对不上而没有任何提示
      if (message.v !== PLUGIN_RPC_VERSION) {
        readyReject?.(
          new PluginProcessStartError(
            `插件 RPC 版本不匹配：需要 ${PLUGIN_RPC_VERSION}，收到 ${String(message.v)}`,
          ),
        );
        return;
      }
      ready = true;
      readyResolve?.(message);
      return;
    }

    if (message.type === "log") {
      options.onLog?.(message.level, message.message);
      return;
    }

    if (message.type === "result" || message.type === "hookResult") {
      settle(message.id, { ok: true, message });
      return;
    }
  });

  const offExit = handle.onExit((code) => {
    alive = false;
    exitCode = code;
    if (!ready) {
      // 握手期间就退出了：把退出码报出来 —— 那是作者最需要的线索
      const detail = handle.readStderr?.().trim() ?? "";
      readyReject?.(
        new PluginProcessStartError(
          `插件进程在完成握手前退出（退出码 ${code}）${detail === "" ? "" : `：\\n${detail}`}`,
        ),
      );
    }
    // **挂起的调用必须结算**（见 settle 的说明）
    failAllPending(`插件进程已退出（退出码 ${code}）`);
  });

  const stop = (): void => {
    if (!alive) return;
    alive = false;
    offMessage();
    offExit();
    failAllPending("插件已停用");
    handle.kill();
  };

  // ── 握手 ──────────────────────────────────────────────────────────────────

  handle.postMessage({
    type: "init",
    v: PLUGIN_RPC_VERSION,
    pluginId: options.pluginId,
    permissions: [...options.permissions],
    dataDir: options.dataDir,
  } satisfies HostToPluginMessage);

  let timer: ReturnType<typeof setTimeout> | undefined;
  let readyMessage: PluginReadyMessage;
  try {
    readyMessage = await Promise.race([
      readyPromise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new PluginProcessStartError(
                `插件在 ${handshakeTimeout}ms 内没有完成握手${stderrTail(handle)}`,
              ),
            ),
          handshakeTimeout,
        );
      }),
    ]);
  } catch (error) {
    stop();
    throw error instanceof PluginProcessStartError
      ? error
      : new PluginProcessStartError(error instanceof Error ? error.message : String(error));
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }

  // ── 声明校验 ──────────────────────────────────────────────────────────────

  const tools = validateToolDecls(readyMessage.tools);
  const commands = validateCommandDecls(readyMessage.commands);
  const issues = [...tools.issues, ...commands.issues];
  if (issues.length > 0) {
    // 有任何一条不合法就整个拒绝（见文件头第 3 条纪律）
    stop();
    throw new PluginProcessStartError("插件声明的工具/命令不合法", issues);
  }

  /**
   * **钩子的声明与实现必须完全对上。**
   *
   * 两个方向的错都拒绝加载，理由见 `PluginReadyMessage.hooks` 的说明 ——
   * 一句话：对不上时，要么作者的策略根本没生效（他以为生效了），
   * 要么用户的所有工具调用被一个坏钩子挡住。
   */
  const hookIssues = checkHookCoverage(options.hooks ?? [], readyMessage.hooks);
  if (hookIssues.length > 0) {
    stop();
    throw new PluginProcessStartError("插件声明的钩子与实现对不上", hookIssues);
  }

  /**
   * 发一次请求并等应答。
   *
   * `call`（工具）、`run`（命令）与 `hook`（钩子）**共用这一份**：id 空间、超时、
   * 结算三条路都只有一处实现。复制一份的话，"崩溃时忘记结算"这类漏必然会在某一份上出现，
   * 而它的症状是模型的回合或用户的操作永远等下去。
   *
   * `timeoutMs` 由调用方给：钩子在工具执行的关键路径上，预算比工具调用短得多。
   */
  function send(
    request:
      | { type: "call"; tool: string; args: unknown; workspaceDir: string }
      | { type: "run"; command: string; args: string; workspaceDir: string }
      | { type: "hook"; hook: string; event: PluginHookEvent; payload: PluginHookPayload },
    timeoutMs: number,
  ): Promise<PluginReply> {
    if (!alive) return Promise.resolve({ ok: false, error: "插件进程已退出" });
    const id = nextCallId;
    nextCallId += 1;

    return new Promise<PluginReply>((resolve) => {
      const deadline = setTimeout(() => {
        settle(id, { ok: false, error: `插件在 ${timeoutMs}ms 内没有返回结果` });
      }, timeoutMs);
      pending.set(id, { resolve, deadline });

      try {
        handle.postMessage({ ...request, id } satisfies HostToPluginMessage);
      } catch (error) {
        settle(id, {
          ok: false,
          error: `消息发不出去：${error instanceof Error ? error.message : String(error)}`,
        });
      }
    });
  }

  /** 把一条 `result` 应答压成工具/命令的调用结果 */
  function toCallResult(reply: PluginReply): PluginCallResult {
    if (!reply.ok) return { ok: false, error: reply.error };
    const message = reply.message;
    if (message.type !== "result") {
      // 插件回了一个形状不对的应答（例如把钩子的结论回到工具的请求上）
      return { ok: false, error: "插件返回了类型不对的应答" };
    }
    return message.error === undefined
      ? { ok: true, text: message.text ?? "" }
      : { ok: false, error: message.error };
  }

  /** 把一条 `hookResult` 应答压成钩子的结论 */
  function toHookOutcome(reply: PluginReply): HookOutcome {
    if (!reply.ok) return { failure: reply.error };
    const message = reply.message;
    if (message.type !== "hookResult") return { failure: "插件返回了类型不对的应答" };
    if (message.error !== undefined && message.error.trim() !== "") {
      return { failure: message.error };
    }
    return {
      ...(typeof message.block === "string" ? { block: message.block } : {}),
      ...(typeof message.additionalContext === "string"
        ? { additionalContext: message.additionalContext }
        : {}),
    };
  }

  return {
    tools: tools.tools,
    commands: commands.commands,
    stop,

    call: (tool, args, workspaceDir) =>
      send({ type: "call", tool, args, workspaceDir }, callTimeout).then(toCallResult),
    run: (command, args, workspaceDir) =>
      send({ type: "run", command, args, workspaceDir }, callTimeout).then(toCallResult),
    hook: (hookId, event, payload) =>
      send({ type: "hook", hook: hookId, event, payload }, hookTimeout).then(toHookOutcome),

    get alive() {
      return alive;
    },
    get exitCode() {
      return exitCode;
    },
  };
}

/**
 * 声明的钩子与 `ready.hooks` 报的实现在两个方向上都要一致。
 *
 * 抽成导出函数是为了**能单独断言它**：这条规则的两个方向各对应一类真实故障
 *（策略静默失效 / 全量工具被拦），而它们的现象完全不同，值得各写一条用例。
 */
export function checkHookCoverage(
  declared: readonly PluginHookDecl[],
  implemented: unknown,
): string[] {
  const declaredIds = declared.map((hook) => hook.id);
  if (!Array.isArray(implemented)) {
    return declaredIds.length === 0
      ? []
      : [`插件声明了 ${declaredIds.length} 条钩子，但 ready 里没有 hooks 数组`];
  }
  const issues: string[] = [];
  const implementedSet = new Set(
    implemented.filter((entry): entry is string => typeof entry === "string"),
  );
  for (const id of declaredIds) {
    if (!implementedSet.has(id)) {
      // 这方向最危险：宿主会照常调用它，然后每次调用都失败（fail-closed 时全部被拦）
      issues.push(`清单声明了钩子「${id}」，但插件进程没有实现它`);
    }
  }
  for (const id of implementedSet) {
    if (!declaredIds.includes(id)) {
      // 这方向是静默失效：那一段代码永远不会被调用，而作者以为策略生效了
      issues.push(`插件实现了未声明的钩子「${id}」—— 它永远不会被调用，请在清单里声明它`);
    }
  }
  return issues;
}
