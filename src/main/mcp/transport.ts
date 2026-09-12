// MCP 传输层：把「一条 JSON 文本」送出去、把入站消息读回来。
//
// 两种实现共用一个接口，client.ts 对传输方式无感知：
// - stdio：本地子进程 + NDJSON（MCP 最主要的用法，npx / uvx / 本地二进制都走它）
// - http：远端 streamable-http 端点 + POST（应答可能是 JSON，也可能是 SSE 流）
//
// 两种实现都不做协议解析：分帧交给 jsonrpc.ts 的 splitter，语义交给 client.ts。

import { spawn } from "node:child_process";
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
 * cmd.exe 下的参数转义（仅在 shell 模式生效）。
 *
 * 含空白或 shell 元字符的参数必须带引号，否则 cmd 会把一个路径拆成两段；
 * 引号内的双引号用 \" 兜住 —— 这是 best effort：cmd 的转义规则本身不完整，
 * 真正有歧义的参数（含 % 或 !）建议写成 .cmd 脚本再调用。
 */
function quoteForShell(arg: string): string {
  if (arg === "") return '""';
  if (!/[\s"^&|<>()]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '\\"')}"`;
}

/** 失败诊断里保留的 stderr 行数 */
const STDERR_TAIL_LINES = 20;

export interface StdioTransportOptions {
  config: McpServerConfig;
  warn?: (message: string) => void;
}

/**
 * 创建 stdio 传输：spawn 一个子进程，stdout 走 NDJSON，stderr 只拿来诊断。
 *
 * Windows 上固定开 shell：npx / uvx 这些最常见的启动命令是 .cmd 垫片，
 * 不开 shell 会直接 ENOENT（Node 20.12 起不再允许直接 spawn .cmd）。
 */
export function createStdioTransport(options: StdioTransportOptions): McpTransport {
  const { config } = options;
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const useShell = process.platform === "win32";
  // Windows 走 cmd 解析：命令与参数都要自己引号化，否则含空格的路径会被 cmd 截断
  const command = useShell ? quoteForShell(config.command) : config.command;
  const args = useShell ? config.args.map(quoteForShell) : config.args;
  const cwd = config.cwd.trim() === "" ? undefined : config.cwd.trim();

  const child = spawn(command, args, {
    ...(cwd === undefined ? {} : { cwd }),
    env: { ...process.env, ...config.env },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    ...(useShell ? { shell: true } : {}),
  });

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
