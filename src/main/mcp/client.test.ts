import { describe, expect, it } from "vitest";
import type { McpServerConfig } from "@/shared/contracts/mcp";
import { createMcpClient } from "./client";
import { encodeMessage, type JsonRpcRequest, parseIncoming } from "./jsonrpc";
import type { McpTransport } from "./transport";

/** 一条最小可用的 server 配置（测试只用得到 id 与 transport） */
function makeConfig(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    id: "mcp-test",
    name: "test",
    enabled: true,
    transport: "stdio",
    command: "noop",
    args: [],
    env: {},
    cwd: "",
    url: "",
    headers: {},
    createdAt: 0,
    ...overrides,
  };
}

type Outcome = { result: unknown } | { error: { code: number; message: string } };

interface ScriptedTransport extends McpTransport {
  /** 出站报文原文（断言协议行为用） */
  sent: string[];
  /** 收到的通知方法名 */
  notifications: string[];
  /** 模拟 server 主动发一条报文 */
  push(text: string): void;
  /** 模拟连接断开 */
  emitClose(reason: string): void;
}

/**
 * 脚本化传输：send 时按 method 决定回什么，避免测试里猜微任务时序。
 * handler 返回 undefined 表示「故意不回」，用来测超时/断开路径。
 */
function createScriptedTransport(
  handler: (request: JsonRpcRequest) => Outcome | undefined,
): ScriptedTransport {
  const sent: string[] = [];
  const notifications: string[] = [];
  const messageListeners = new Set<(text: string) => void>();
  const closeListeners = new Set<(reason: string) => void>();
  let closed: string | null = null;

  const push = (text: string): void => {
    for (const listener of [...messageListeners]) listener(text);
  };

  return {
    label: "scripted",
    sent,
    notifications,
    push,
    emitClose(reason) {
      closed = reason;
      for (const listener of [...closeListeners]) listener(reason);
    },
    async send(text) {
      sent.push(text);
      const message = parseIncoming(text) as JsonRpcRequest | { method: string } | null;
      if (message === null) return;
      if (!("id" in message)) {
        notifications.push(message.method);
        return;
      }
      const outcome = handler(message);
      if (outcome === undefined) return;
      // 回执放在下一微任务：真实传输不会在 send 里同步回调
      queueMicrotask(() => push(encodeMessage({ jsonrpc: "2.0", id: message.id, ...outcome })));
    },
    onMessage(listener) {
      if (closed !== null) return;
      messageListeners.add(listener);
    },
    onClose(listener) {
      if (closed !== null) {
        listener(closed);
        return;
      }
      closeListeners.add(listener);
    },
    describeFailure() {
      return "stderr：boom";
    },
    setProtocolVersion() {
      // 版本头只对 http 传输有意义
    },
    async close() {
      if (closed !== null) return;
      closed = "已主动关闭";
      for (const listener of [...closeListeners]) listener(closed);
    },
  };
}

/** 标准握手应答 */
function initializeOutcome(): Outcome {
  return {
    result: {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "demo", version: "1.0.0" },
    },
  };
}

describe("createMcpClient", () => {
  it("握手：发 initialize，收到结果后发 notifications/initialized", async () => {
    const transport = createScriptedTransport((request) =>
      request.method === "initialize" ? initializeOutcome() : { result: {} },
    );
    const client = createMcpClient({ config: makeConfig(), transport });

    const handshake = await client.connect();

    expect(handshake).toEqual({
      protocolVersion: "2025-06-18",
      serverName: "demo",
      serverVersion: "1.0.0",
    });
    expect(transport.notifications).toEqual(["notifications/initialized"]);
    const first = parseIncoming(transport.sent[0] ?? "") as JsonRpcRequest;
    expect(first.method).toBe("initialize");
    expect(first.params).toMatchObject({ clientInfo: { name: "oint" } });
  });

  it("tools/list：跟随 nextCursor 翻页并按名字去重", async () => {
    const transport = createScriptedTransport((request) => {
      if (request.method === "initialize") return initializeOutcome();
      if (request.method === "tools/list") {
        const cursor = (request.params as { cursor?: string } | undefined)?.cursor;
        if (cursor === undefined) {
          return {
            result: {
              tools: [
                { name: "read_file", description: "读文件", inputSchema: { type: "object" } },
                { name: "stat", inputSchema: { type: "object" } },
              ],
              nextCursor: "page-2",
            },
          };
        }
        return {
          result: {
            tools: [
              // 与第一页重名：应被去重
              { name: "stat", inputSchema: { type: "object" } },
              {
                name: "write_file",
                annotations: { readOnlyHint: false },
                inputSchema: { type: "object" },
              },
            ],
          },
        };
      }
      return { result: {} };
    });
    const client = createMcpClient({ config: makeConfig(), transport });
    await client.connect();

    const tools = await client.listTools();

    expect(tools.map((tool) => tool.name)).toEqual(["read_file", "stat", "write_file"]);
    // 没给 description 的条目回落空串，readOnly 只在 server 声明时出现
    expect(tools[1]?.description).toBe("");
    expect(tools[1]?.readOnly).toBeUndefined();
    expect(tools[2]?.readOnly).toBe(false);
  });

  it("tools/call：结果文本化，并把参数原样传下去", async () => {
    const transport = createScriptedTransport((request) => {
      if (request.method === "initialize") return initializeOutcome();
      if (request.method === "tools/call") {
        return {
          result: {
            content: [{ type: "text", text: "hello" }],
            isError: false,
          },
        };
      }
      return { result: {} };
    });
    const client = createMcpClient({ config: makeConfig(), transport });
    await client.connect();

    const result = await client.callTool("greet", { who: "world" });

    expect(result).toEqual({ text: "hello", isError: false });
    const call = transport.sent
      .map((text) => parseIncoming(text) as JsonRpcRequest)
      .find((message) => message.method === "tools/call");
    expect(call?.params).toEqual({ name: "greet", arguments: { who: "world" } });
  });

  it("server 反向请求：回 -32601 而不是静默挂起", async () => {
    const transport = createScriptedTransport((request) =>
      request.method === "initialize" ? initializeOutcome() : { result: {} },
    );
    const client = createMcpClient({ config: makeConfig(), transport });
    await client.connect();
    transport.sent.length = 0;

    transport.push('{"jsonrpc":"2.0","id":"srv-1","method":"sampling/createMessage","params":{}}');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(transport.sent).toHaveLength(1);
    expect(parseIncoming(transport.sent[0] ?? "")).toEqual({
      jsonrpc: "2.0",
      id: "srv-1",
      error: { code: -32601, message: "客户端不支持 sampling/createMessage" },
    });
  });

  it("连接断开：挂在飞行中的请求以断开原因被拒绝", async () => {
    const transport = createScriptedTransport((request) =>
      // 故意不回 tools/call，等断开
      request.method === "initialize" ? initializeOutcome() : undefined,
    );
    const client = createMcpClient({ config: makeConfig(), transport });
    await client.connect();

    const pending = client.callTool("slow", {});
    transport.emitClose("进程已结束（退出码 1）");

    await expect(pending).rejects.toThrow("MCP 连接已断开");
  });

  it("协议错误：把 server 的 error 对象转成异常文本", async () => {
    const transport = createScriptedTransport((request) =>
      request.method === "initialize"
        ? initializeOutcome()
        : { error: { code: -32601, message: "method not found" } },
    );
    const client = createMcpClient({ config: makeConfig(), transport });
    await client.connect();

    await expect(client.listTools()).rejects.toThrow("method not found（code -32601）");
  });

  it("diagnostics 透传传输层的诊断信息", () => {
    const transport = createScriptedTransport(() => undefined);
    const client = createMcpClient({ config: makeConfig(), transport });
    expect(client.diagnostics()).toBe("stderr：boom");
  });
});
