// MCP 会话客户端：在传输层之上实现「握手 → 列工具 → 调工具」这条最小但完整的链路。
//
// 只依赖 MCP 的 tools 能力面（initialize / tools/list / tools/call）：
// resources、prompts、sampling、roots 一律不接 —— 本应用要的是「外部工具」，
// 不是把 MCP 的全部能力面搬进来。server 反过来请求我们时统一回「不支持」。
//
// 这一层不碰配置与进程池：一个 client 对应一个已经建好的连接，生命周期由
// mcp-servers.ts 管理，便于把「试连」做成一次性实例。

import type { McpServerConfig } from "@/shared/contracts/mcp";
import {
  describeError,
  encodeMessage,
  isRequest,
  isResponse,
  JSON_RPC_METHOD_NOT_FOUND,
  type JsonRpcFailure,
  type JsonRpcId,
  type JsonRpcIncoming,
  type JsonRpcRequest,
  parseIncoming,
} from "./jsonrpc";
import { createHttpTransport, createStdioTransport, type McpTransport } from "./transport";

/**
 * 我们对外声明的协议版本。
 *
 * 只用于握手声明：server 会回它自己支持的版本，我们照单收下（见 McpHandshake）。
 * 之所以敢这么松，是因为用到的三个方法（initialize / tools/list / tools/call）
 * 在 MCP 各修订版之间没有变化。
 */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

/** 客户端身份，仅用于 server 侧日志 */
const MCP_CLIENT_INFO = { name: "oint", version: "0.1.0" };

/** 握手超时：本地子进程启动 + 远端端点响应都在这个窗口内 */
const CONNECT_TIMEOUT_MS = 20_000;
/** tools/list 超时 */
const LIST_TIMEOUT_MS = 20_000;
/** tools/call 超时：外部工具可能真的在干活（拉网页、跑查询），给得比列工具宽 */
const CALL_TIMEOUT_MS = 120_000;
/** tools/list 分页上限：防止 server 给一个永远不结束的 cursor */
const MAX_TOOL_PAGES = 10;

/** 定时器句柄：Node 与 DOM 的 setTimeout 返回类型不同，取实际返回类型避免二义性 */
type TimerHandle = ReturnType<typeof setTimeout>;

export interface McpHandshake {
  protocolVersion: string;
  serverName: string;
  serverVersion: string;
}

export interface McpRemoteTool {
  /** server 内部的原始工具名 */
  name: string;
  description: string;
  /** JSON Schema（原样透传给模型，不做改写） */
  inputSchema: unknown;
  /** annotations.readOnlyHint；缺省表示 server 未声明 */
  readOnly?: boolean;
}

export interface McpCallResult {
  /** 已经文本化的结果（图片等非文本内容给一行占位说明） */
  text: string;
  /** server 自己标记的失败（协议层成功） */
  isError: boolean;
}

export interface McpClient {
  /** 失败时的补充诊断（stdio 是 stderr 尾巴，http 是最后一次状态码），没有信息时返回空串 */
  diagnostics(): string;
  connect(): Promise<McpHandshake>;
  listTools(): Promise<McpRemoteTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult>;
  /** 连接断开（进程退出 / 网络错误 / 主动关闭）时的回调 */
  onClosed(listener: (reason: string) => void): void;
  /** 传输描述，用于日志与界面提示 */
  readonly label: string;
  close(): Promise<void>;
}

export interface McpClientOptions {
  config: McpServerConfig;
  warn?: (message: string) => void;
  /** 注入传输（测试用）；缺省按 config.transport 建 */
  transport?: McpTransport;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** initialize 结果解析：字段缺失一律给空串，不让一个坏握手把整条链路打死 */
export function parseInitializeResult(result: unknown): McpHandshake {
  if (!isRecord(result)) return { protocolVersion: "", serverName: "", serverVersion: "" };
  const serverInfo = isRecord(result.serverInfo) ? result.serverInfo : {};
  return {
    protocolVersion: typeof result.protocolVersion === "string" ? result.protocolVersion : "",
    serverName: typeof serverInfo.name === "string" ? serverInfo.name : "",
    serverVersion: typeof serverInfo.version === "string" ? serverInfo.version : "",
  };
}

/** tools/list 结果解析：没有名字的条目直接丢掉（限定名需要它） */
export function parseToolListResult(result: unknown): {
  tools: McpRemoteTool[];
  nextCursor?: string;
} {
  if (!isRecord(result)) return { tools: [] };
  const list = Array.isArray(result.tools) ? result.tools : [];
  const tools: McpRemoteTool[] = [];
  for (const item of list) {
    if (!isRecord(item) || typeof item.name !== "string" || item.name === "") continue;
    const annotations = isRecord(item.annotations) ? item.annotations : {};
    tools.push({
      name: item.name,
      description: typeof item.description === "string" ? item.description : "",
      inputSchema: item.inputSchema,
      ...(typeof annotations.readOnlyHint === "boolean"
        ? { readOnly: annotations.readOnlyHint }
        : {}),
    });
  }
  const cursor = result.nextCursor;
  return cursor === undefined
    ? { tools }
    : { tools, nextCursor: typeof cursor === "string" ? cursor : "" };
}

/**
 * tools/call 结果 → 一段给模型看的文本。
 *
 * content 是数组，可能混着文本、图片、资源：文本原样拼接，非文本给一行占位 ——
 * 静默丢掉会让模型以为自己拿到了全部内容。
 */
export function formatCallResult(result: unknown): McpCallResult {
  if (!isRecord(result)) {
    return { text: "MCP server 返回了无法解析的结果。", isError: true };
  }
  const isError = result.isError === true;
  const parts: string[] = [];
  const content = Array.isArray(result.content) ? result.content : [];
  for (const item of content) {
    if (!isRecord(item)) continue;
    if (item.type === "text" && typeof item.text === "string") {
      parts.push(item.text);
      continue;
    }
    if (item.type === "image") {
      const mime = typeof item.mimeType === "string" ? item.mimeType : "未知类型";
      parts.push(`[图片 ${mime}：当前不把 MCP 返回的图片转交给模型]`);
      continue;
    }
    if (item.type === "resource" && isRecord(item.resource)) {
      const uri = typeof item.resource.uri === "string" ? item.resource.uri : "";
      const text = typeof item.resource.text === "string" ? item.resource.text : "";
      parts.push(`[资源 ${uri}]${text === "" ? "" : `\n${text}`}`);
      continue;
    }
    parts.push(`[${typeof item.type === "string" ? item.type : "未知"} 内容]`);
  }
  // structuredContent 只在没有文本内容时补上，避免与 content 重复
  if (parts.length === 0 && result.structuredContent !== undefined) {
    parts.push(JSON.stringify(result.structuredContent, null, 2));
  }
  if (parts.length === 0) {
    parts.push(isError ? "MCP server 未给出错误详情。" : "MCP server 未返回任何内容。");
  }
  return { text: parts.join("\n"), isError };
}

/** 按配置建传输 */
function createTransport(config: McpServerConfig, warn: (message: string) => void): McpTransport {
  return config.transport === "http"
    ? createHttpTransport({ config })
    : createStdioTransport({ config, warn });
}

export function createMcpClient(options: McpClientOptions): McpClient {
  const { config } = options;
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const transport = options.transport ?? createTransport(config, warn);

  let nextId = 1;
  let closedReason: string | null = null;
  const closedListeners = new Set<(reason: string) => void>();
  const pending = new Map<
    JsonRpcId,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: TimerHandle }
  >();

  const settleAll = (error: Error): void => {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  };

  const handleClose = (reason: string): void => {
    if (closedReason !== null) return;
    closedReason = reason;
    settleAll(new Error(`MCP 连接已断开：${reason}`));
    for (const listener of [...closedListeners]) {
      try {
        listener(reason);
      } catch {
        // 监听器异常不影响客户端收尾
      }
    }
  };
  transport.onClose(handleClose);

  /** server → client 的请求：我们没有任何反向能力，明确回「方法不存在」而不是静默挂起 */
  const rejectIncomingRequest = async (request: JsonRpcRequest): Promise<void> => {
    warn(`[mcp:${config.id}] server 发起了不支持的方法 ${request.method}，已回绝`);
    const failure: JsonRpcFailure = {
      jsonrpc: "2.0",
      id: request.id,
      error: {
        code: JSON_RPC_METHOD_NOT_FOUND,
        message: `客户端不支持 ${request.method}`,
      },
    };
    try {
      await transport.send(encodeMessage(failure));
    } catch {
      // 回绝失败没有补救手段：连接本身可能已经断了
    }
  };

  transport.onMessage((text) => {
    const message = parseIncomingSafe(text, config.id, warn);
    if (message === null) return;
    if (isResponse(message)) {
      const entry = pending.get(message.id);
      if (entry === undefined) return;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if ("error" in message) {
        entry.reject(new Error(describeError(message.error)));
      } else {
        entry.resolve(message.result);
      }
      return;
    }
    if (isRequest(message)) {
      void rejectIncomingRequest(message);
      return;
    }
    // 通知（日志、资源变更…）：本客户端不订阅，静默忽略
  });

  /** 发一条请求并等应答；超时与断开都会 reject */
  async function request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (closedReason !== null) throw new Error(`MCP 连接已断开：${closedReason}`);
    const id = nextId++;
    const response = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} 超时（${Math.round(timeoutMs / 1000)} 秒）`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
    });
    try {
      await transport.send(encodeMessage({ jsonrpc: "2.0", id, method, params }));
    } catch (error) {
      const entry = pending.get(id);
      if (entry !== undefined) {
        pending.delete(id);
        clearTimeout(entry.timer);
      }
      throw error instanceof Error ? error : new Error(String(error));
    }
    return response;
  }

  return {
    label: transport.label,
    diagnostics() {
      return transport.describeFailure();
    },
    async connect() {
      if (closedReason !== null) throw new Error(`MCP 连接已断开：${closedReason}`);
      const result = await request(
        "initialize",
        {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: MCP_CLIENT_INFO,
        },
        CONNECT_TIMEOUT_MS,
      );
      const handshake = parseInitializeResult(result);
      transport.setProtocolVersion(handshake.protocolVersion || MCP_PROTOCOL_VERSION);
      // 规范要求的就绪通知；服务器据此才开始接受后续请求
      await transport.send(
        encodeMessage({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
      );
      return handshake;
    },
    async listTools() {
      const tools: McpRemoteTool[] = [];
      const seen = new Set<string>();
      let cursor: string | undefined;
      for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
        const result = await request(
          "tools/list",
          cursor === undefined ? {} : { cursor },
          LIST_TIMEOUT_MS,
        );
        const parsed = parseToolListResult(result);
        for (const tool of parsed.tools) {
          if (seen.has(tool.name)) continue;
          seen.add(tool.name);
          tools.push(tool);
        }
        cursor = parsed.nextCursor;
        if (cursor === undefined || cursor === "") break;
      }
      return tools;
    },
    async callTool(name, args) {
      const result = await request("tools/call", { name, arguments: args }, CALL_TIMEOUT_MS);
      return formatCallResult(result);
    },
    onClosed(listener) {
      if (closedReason !== null) {
        listener(closedReason);
        return;
      }
      closedListeners.add(listener);
    },
    async close() {
      // 先标记关闭再关传输：close 触发的退出事件不该再回调一遍
      handleClose("已主动关闭");
      closedListeners.clear();
      await transport.close();
    },
  };
}

/** 解析失败只记一行日志：单个坏报文不该影响后续消息 */
function parseIncomingSafe(
  text: string,
  serverId: string,
  warn: (message: string) => void,
): JsonRpcIncoming | null {
  const message = parseIncoming(text);
  if (message === null) {
    warn(`[mcp:${serverId}] 收到无法解析的报文：${text.slice(0, 200)}`);
  }
  return message;
}
