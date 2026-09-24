// MCP 传输层：把「一条 JSON 文本」送出去、把入站消息读回来。
//
// 两种实现共用一个接口，client.ts 对传输方式无感知：
// - stdio：本地子进程 + NDJSON（MCP 最主要的用法，npx / uvx / 本地二进制都走它）
// - http：远端 streamable-http 端点 + POST（应答可能是 JSON，也可能是 SSE 流）
//
// 两种实现都不做协议解析：分帧交给 jsonrpc.ts 的 splitter，语义交给 client.ts。

import { spawn } from "node:child_process";
import { buildChildEnv } from "@/main/security/child-env";
import type { McpServerConfig } from "@/shared/contracts/mcp";
import { createLineSplitter, createSseSplitter } from "./jsonrpc";

/** 传输层：只负责「字节进、字节出」，断开要能被观察到 */
export interface McpTransport {
  /** 人类可读的传输描述（日志用） */
  readonly label: string;
  /** 发一条消息（分帧由实现负责） */
  send(text: string): Promise<void>;
  /** 订阅入站消息；每条参数都是一段完整的 JSON 文本 */
  onMessage(listener: (text: string) => void): void;
  /** 订阅断开；注册时若已经断开会立刻回调，避免调用方永远等下去 */
  onClose(listener: (reason: string) => void): void;
  /** 失败诊断补充（stdio 给 stderr 尾巴，http 给状态码），没有信息时返回空串 */
  describeFailure(): string;
  /** 协商出的协议版本：http 用它填 MCP-Protocol-Version 头 */
  setProtocolVersion(version: string): void;
  close(): Promise<void>;
}

/** 监听器集合：断开前注册的回调都要跑到，断开后注册的立刻补一次 */
function createListenerSet(snapshotOnClose: () => string | null) {
  const listeners = new Set<(value: string) => void>();
  return {
    add(listener: (value: string) => void): void {
      const closed = snapshotOnClose();
      if (closed !== null) {
        listener(closed);
        return;
      }
      listeners.add(listener);
    },
    emit(value: string): void {
      for (const listener of [...listeners]) {
        try {
          listener(value);
        } catch {
          // 单个监听器出错不影响其它监听器与传输本身
        }
      }
    },
    clear(): void {
      listeners.clear();
    },
  };
}

// --- stdio -------------------------------------------------------------------

/**
 * `cmd.exe` 会当成语法解释的字符。
 *
 * `%` 与 `!` 是变量展开与延迟展开 —— **这两个恰恰是旧实现漏掉的**（它的判据正则
 * 是 `/[\s"^&|<>()]/`，不含 `%` `!`），而它们能把一个"看起来只是个参数"的字符串
 * 变成一次展开或一次命令替换。
 */
const CMD_METACHARACTERS = /[%!&|<>^"\r\n]/;

/**
 * 这个命令是否必须经过 Windows 的命令解释器。
 *
 * 判据是**文件扩展名**而不是「我们在 Windows 上」：`npx` / `uvx` 这些最常见的启动
 * 方式是 `.cmd` 垫片，Node 20.12 起不允许直接 spawn，必须经 `cmd.exe`；
 * 而一个真正的 `.exe` **不需要**解释器，多套一层只会多一次注入面。
 */
export function needsWindowsInterpreter(command: string): boolean {
  return process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
}

/**
 * 找出会让 `cmd.exe` 重新解释的参数；返回第一个有问题的值，全部安全时返回 undefined。
 *
 * **为什么是"拒绝"而不是"再引号化一次"**：cmd 的转义规则本身不完整（旧实现的注释
 * 自己写着"真正有歧义的参数（含 % 或 !）建议写成 .cmd 脚本再调用"，也就是知道并在
 * 事实上接受了这个洞）。与其继续猜转义，不如把判据变成一个**封闭的、可审计的规则**：
 * 参数里出现 cmd 的元字符就拒绝启动，并把是哪一个报给用户。
 *
 * 代价是「参数里真的要带 `&` 或 `%`」的 MCP server 起不来 —— 那种情况应该写成
 * 一个 `.cmd` 包装脚本，而不是指望宿主把转义猜对。
 */
export function findCmdUnsafeArg(command: string, args: readonly string[]): string | undefined {
  if (CMD_METACHARACTERS.test(command)) return command;
  return args.find((arg) => CMD_METACHARACTERS.test(arg));
}

/** 失败诊断里保留的 stderr 行数 */
const STDERR_TAIL_LINES = 20;

export interface StdioTransportOptions {
  config: McpServerConfig;
  warn?: (message: string) => void;
}

/**
 * 一个「永远起不来」的传输：注册即报告失败。
 *
 * 用途是**拒绝启动**时保持接口形状不变（见 createStdioTransport 里对歧义参数的拒绝）。
 * 不在这里抛异常是因为调用方（mcp-servers 的连接池）把「启动失败」当作一种正常的
 * 连接状态来展示；抛出去会让一次坏配置拖垮整轮 reload，而用户需要看到的是
 * 「这一台起不来，原因是什么」。
 */
function failedTransport(reason: string, warn: (message: string) => void): McpTransport {
  warn(reason);
  return {
    label: "stdio:(拒绝启动)",
    async send() {
      throw new Error(reason);
    },
    // 没有任何报文会到达：不注册监听，也不假装注册了
    onMessage() {},
    onClose(listener) {
      // 立刻回调 —— 否则调用方会一直等一个永远不来的连接
      listener(reason);
    },
    describeFailure: () => reason,
    setProtocolVersion() {},
    async close() {},
  };
}

/**
 * 创建 stdio 传输：spawn 一个子进程，stdout 走 NDJSON，stderr 只拿来诊断。
 *
 * ## 两条与「命令怎么被启动」有关的纪律
 *
 * **1. `command` 是一个可执行 token，不是 shell 命令串。**
 * 旧实现在 Windows 上恒定 `shell: true`，并把命令与每个参数各自引号化后**拼成一条
 * 字符串**交给 shell。那条路有两个问题：拼接本身的转义规则不完整（`%` 与 `!` 是
 * cmd 的变量展开与延迟展开字符，而判据正则不含它们），而更根本的是它把「一个参数」
 * 交给了「一个会解释语法的解析器」。
 *
 * 现在的形状：**参数永远逐项传递**（Node 自己负责平台引号化），只有确认目标是
 * `.cmd` / `.bat` 垫片时才经 `cmd.exe`，且**任何含 cmd 元字符的命令或参数一律拒绝启动**
 * （见 findCmdUnsafeArg）。这与 Agent Plugins 规范 §7.2.1 的要求一致：
 * *"Clients MAY use a platform-specific command interpreter when required … but MUST
 * preserve `command` as one token and pass `args` separately."*
 *
 * **2. 子进程只拿到白名单环境变量。**
 * 旧实现是 `{...process.env, ...config.env}` —— 用户自己填的 server 拿到用户的环境变量
 * 还算合理，但一旦 server 由第三方插件声明（`mcp.json`），提供者就从"用户"变成了
 * "插件作者"，同一条继承立刻变成提权面。改成白名单后 `config.env` 仍是显式通道，
 * 用户想传什么就在配置里写。
 */
export function createStdioTransport(options: StdioTransportOptions): McpTransport {
  const { config } = options;
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const cwd = config.cwd.trim() === "" ? undefined : config.cwd.trim();
  const useInterpreter = needsWindowsInterpreter(config.command);

  /*
    经解释器之前先拒绝歧义参数。
    这里**不抛异常**（构造传输时抛会让整个 MCP 池的 reload 失败），而是起一个
    "永远起不来"的传输：把拒绝原因当作关闭理由报出去 —— 面板上显示的就是
    「无法启动 xxx：参数含 cmd 元字符」，与其它启动失败的呈现一致。
  */
  const unsafe = useInterpreter ? findCmdUnsafeArg(config.command, config.args) : undefined;
  if (unsafe !== undefined) {
    return failedTransport(
      `无法启动 ${config.command}：参数含有 cmd 会解释的字符（% ! & | < > ^ " 换行），` +
        `拒绝经命令解释器启动。请改用一个 .cmd 包装脚本，或去掉该参数。`,
      warn,
    );
  }

  const child = spawn(
    useInterpreter ? (process.env.ComSpec ?? "cmd.exe") : config.command,
    // 经解释器时把命令本身也作为**一个 argv 项**传进去（/c 之后的第一项），
    // 而不是拼进一个字符串 —— 拼接才是旧实现的病根。
    useInterpreter ? ["/d", "/s", "/c", config.command, ...config.args] : config.args,
    {
      ...(cwd === undefined ? {} : { cwd }),
      env: buildChildEnv(process.env, config.env),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      // shell 永远关掉：需要解释器时我们显式调用它，不让 Node 再套一层
      shell: false,
    },
  );

  let closedReason: string | null = null;
  // 报文的快照恒为 null：关闭后到达的报文直接丢掉，不该被当成「断开原因」回调给监听者
  const messageListeners = createListenerSet(() => null);
  const closeListeners = createListenerSet(() => closedReason);
  const stderrTail: string[] = [];

  const splitter = createLineSplitter((text) => messageListeners.emit(text));
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => splitter.push(chunk));
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    for (const line of chunk.split(/\r?\n/)) {
      const text = line.trim();
      if (text === "") continue;
      stderrTail.push(text);
      if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift();
      warn(`[mcp:${config.id}] ${text}`);
    }
  });

  const finish = (reason: string): void => {
    if (closedReason !== null) return;
    closedReason = reason;
    closeListeners.emit(reason);
    messageListeners.clear();
    closeListeners.clear();
  };

  child.on("error", (error: Error) => {
    finish(`无法启动 ${config.command}：${error.message}`);
  });
  // 用 close 而不是 exit 收尾：EXIT 事件可能早于 stdout 排空，
  // 最后一条应答（例如 tools/call 的结果）会在派发前被丢掉，调用方拿到假的「连接已断开」。
  child.on("close", (code, signal) => {
    const detail = signal === null ? `退出码 ${code ?? "未知"}` : `信号 ${signal}`;
    finish(`进程已结束（${detail}）`);
  });

  return {
    label: `stdio:${config.command}`,
    async send(text) {
      if (closedReason !== null) throw new Error(`连接已断开：${closedReason}`);
      await new Promise<void>((resolve, reject) => {
        child.stdin.write(`${text}\n`, "utf8", (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
    onMessage(listener) {
      messageListeners.add(listener);
    },
    onClose(listener) {
      closeListeners.add(listener);
    },
    describeFailure() {
      return stderrTail.length === 0 ? "" : `stderr：${stderrTail.join(" / ")}`;
    },
    setProtocolVersion() {
      // stdio 不需要版本头
    },
    async close() {
      finish("已主动关闭");
      if (!child.killed) child.kill();
      // 进程可能忽略信号：不 await，交给退出事件收尾
    },
  };
}

// --- http（streamable-http） --------------------------------------------------

/**
 * 单次 HTTP 请求的兜底超时。
 *
 * 必须 ≥ client.ts 里最大的一档请求预算（tools/call 的 120 秒），否则远端工具跑到一半
 * 就被传输层掐断，客户端那边的宽限形同虚设。等不到应答时由客户端自己的定时器先报错。
 */
const HTTP_TIMEOUT_MS = 130_000;

export interface HttpTransportOptions {
  config: McpServerConfig;
  /** 注入 fetch（测试用）；缺省用全局 fetch */
  fetchImpl?: typeof fetch;
}

/**
 * 创建 streamable-http 传输。
 *
 * 一次 send = 一次 POST，应答按 content-type 分流：application/json 直接当一条消息，
 * text/event-stream 走 SSE 分帧。刻意不做：长连 SSE 通道（server 主动推送）、
 * 断线续传（Last-Event-ID）—— 这套客户端的工具调用是「一问一答」，用不上。
 */
export function createHttpTransport(options: HttpTransportOptions): McpTransport {
  const { config } = options;
  const doFetch = options.fetchImpl ?? fetch;
  let closedReason: string | null = null;
  // 报文的快照恒为 null（见 stdio 传输的同名注释）
  const messageListeners = createListenerSet(() => null);
  const closeListeners = createListenerSet(() => closedReason);
  let sessionId: string | null = null;
  let protocolVersion = "";
  let lastFailure = "";

  const finish = (reason: string): void => {
    if (closedReason !== null) return;
    closedReason = reason;
    closeListeners.emit(reason);
    messageListeners.clear();
    closeListeners.clear();
  };

  return {
    label: `http:${config.url}`,
    async send(text) {
      if (closedReason !== null) throw new Error(`连接已断开：${closedReason}`);
      const response = await doFetch(config.url, {
        method: "POST",
        headers: {
          // 用户头先铺，内部必需头后压：content-type / accept 决定分帧，不能被配置写坏
          ...config.headers,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(sessionId === null ? {} : { "mcp-session-id": sessionId }),
          ...(protocolVersion === "" ? {} : { "mcp-protocol-version": protocolVersion }),
        },
        body: text,
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      const nextSession = response.headers.get("mcp-session-id");
      if (nextSession !== null && nextSession !== "") sessionId = nextSession;
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        lastFailure = `HTTP ${response.status}`;
        throw new Error(`HTTP ${response.status}${body === "" ? "" : `：${body.slice(0, 300)}`}`);
      }
      // 202 之类的空应答：没有消息可派发，直接返回
      const contentType = response.headers.get("content-type") ?? "";
      const body = await response.text();
      if (contentType.includes("text/event-stream")) {
        createSseSplitter((payload) => messageListeners.emit(payload)).push(body);
        return;
      }
      if (body.trim() !== "") messageListeners.emit(body);
    },
    onMessage(listener) {
      messageListeners.add(listener);
    },
    onClose(listener) {
      closeListeners.add(listener);
    },
    describeFailure() {
      return lastFailure;
    },
    setProtocolVersion(version) {
      protocolVersion = version;
    },
    async close() {
      finish("已主动关闭");
    },
  };
}
