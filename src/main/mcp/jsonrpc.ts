// MCP 的报文层：JSON-RPC 2.0 消息形状 + 两种分帧（stdio 的 NDJSON / HTTP 的 SSE）。
//
// 这一层刻意不持有连接：只做「文本 ↔ 消息」的双向转换，全部是纯函数，可以直接单测。
// 连接与请求-响应配对在 client.ts，配置与进程生命周期在 mcp-servers.ts。

export type JsonRpcId = number | string;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: JsonRpcErrorObject;
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

/** 入站消息：可能是对我们请求的应答，也可能是 server 发起的请求/通知 */
export type JsonRpcIncoming = JsonRpcResponse | JsonRpcRequest | JsonRpcNotification;

/** 标准错误码（我们只在「不认识的方法」上用得上） */
export const JSON_RPC_PARSE_ERROR = -32700;
export const JSON_RPC_METHOD_NOT_FOUND = -32601;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** 出站：一条消息 → 一行 JSON（分帧由传输层负责，stdio 补 \n，HTTP 直接当 body） */
export function encodeMessage(message: object): string {
  return JSON.stringify(message);
}

/**
 * 入站：一段 JSON 文本 → 消息；无法识别的输入返回 null（调用方记日志即可）。
 *
 * 宽松但不猜：缺 jsonrpc 版本、id 类型不对、既没 method 又没 result/error 都判为无效。
 * 批量数组一律忽略 —— MCP 不用 JSON-RPC 批量报文。
 */
export function parseIncoming(text: string): JsonRpcIncoming | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(raw) || raw.jsonrpc !== "2.0") return null;
  const hasId = typeof raw.id === "number" || typeof raw.id === "string";
  const params = raw.params === undefined ? {} : { params: raw.params };

  if (typeof raw.method === "string") {
    const method = raw.method;
    // 带 id 的是 server → client 的请求，不带 id 的是通知
    return hasId
      ? { jsonrpc: "2.0", id: raw.id as JsonRpcId, method, ...params }
      : { jsonrpc: "2.0", method, ...params };
  }
  if (!hasId) return null;
  const id = raw.id as JsonRpcId;

  if (raw.error !== undefined) {
    const error = raw.error;
    if (!isRecord(error) || typeof error.message !== "string") return null;
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: typeof error.code === "number" ? error.code : JSON_RPC_PARSE_ERROR,
        message: error.message,
        ...(error.data === undefined ? {} : { data: error.data }),
      },
    };
  }
  // result 为 null 是合法的成功应答；字段缺失（undefined）才算无效
  if (raw.result === undefined) return null;
  return { jsonrpc: "2.0", id, result: raw.result };
}

export function isResponse(message: JsonRpcIncoming): message is JsonRpcResponse {
  return !("method" in message);
}

/** 带 id 的方法调用：server 反过来问我们（例如 sampling / roots），我们一律回「不支持」 */
export function isRequest(message: JsonRpcIncoming): message is JsonRpcRequest {
  return "method" in message && "id" in message;
}

export function isNotification(message: JsonRpcIncoming): message is JsonRpcNotification {
  return "method" in message && !("id" in message);
}

/** 错误对象 → 人类可读文本（日志与 tool 结果都用它） */
export function describeError(error: JsonRpcErrorObject): string {
  return `${error.message}（code ${error.code}）`;
}

/** 分帧回调的公共形状：push 增量文本，内部自己攒不完整的尾巴 */
export interface FrameSplitter {
  push(chunk: string): void;
}

/**
 * NDJSON 分帧（stdio transport）：按 \n 切行，忽略空行与行尾 \r。
 *
 * 必须先攒再切：管道给到的 chunk 不保证落在行边界上，直接 JSON.parse 会在长消息上随机失败。
 */
export function createLineSplitter(onMessage: (text: string) => void): FrameSplitter {
  let buffer = "";
  return {
    push(chunk) {
      buffer += chunk;
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const text = buffer.slice(0, index).replace(/\r$/, "").trim();
        buffer = buffer.slice(index + 1);
        if (text !== "") onMessage(text);
        index = buffer.indexOf("\n");
      }
    },
  };
}

/** 从一段 SSE 事件块里取 data: 载荷；没有 data 行（心跳、注释）返回 null */
function readSseData(block: string): string | null {
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line === "" || line.startsWith(":")) continue;
    if (!line.startsWith("data:")) continue;
    // 规范：行首 "data:" 之后的一个空格是分隔符，不属于内容
    data.push(line.slice(5).replace(/^ /, ""));
  }
  return data.length === 0 ? null : data.join("\n");
}

/**
 * SSE 分帧（streamable-http transport）：按空行切事件块，只取 data 行。
 *
 * event: / id: / retry: 与注释行一律忽略 —— 我们只用 JSON-RPC 载荷，
 * 事件名与断线续传语义对这个客户端没有意义。
 */
export function createSseSplitter(onData: (payload: string) => void): FrameSplitter {
  let buffer = "";
  return {
    push(chunk) {
      buffer += chunk.replace(/\r\n/g, "\n");
      let index = buffer.indexOf("\n\n");
      while (index >= 0) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const payload = readSseData(block);
        if (payload !== null) onData(payload);
        index = buffer.indexOf("\n\n");
      }
    },
  };
}
