import { BACKGROUND_CONTEXT, type AgentToolResult, type ExecutionToolContext } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
  buildMcpToolDescription,
  createMcpTool,
  type McpToolDefinition,
  type McpToolDetails,
  normalizeInputSchema,
  truncateForModel,
} from "./mcp";

const definition: McpToolDefinition = {
  serverId: "mcp-test",
  serverName: "测试服务器",
  toolName: "read_file",
  description: "读取一个文件",
  inputSchema: { type: "object", properties: { path: { type: "string" } } },
};

/** 工具执行上下文：MCP 工具不看它，但内核签名要求传 */
function stubContext(): ExecutionToolContext {
  return { env: { cwd: process.cwd() } } as unknown as ExecutionToolContext;
}

/** 只跑一次 execute（内核实际会按完整签名调用，这里补齐 6 个参数位） */
function runTool(
  tool: ReturnType<typeof createMcpTool>,
  params: Record<string, unknown>,
): Promise<AgentToolResult<McpToolDetails>> {
  return tool.execute(
    "call-1",
    params,
    () => undefined,
    stubContext(),
    {
      invocationId: "inv",
      operationId: "op",
      turnId: "turn",
      getMemo: () => undefined,
      setMemo: () => undefined,
    } as unknown as Parameters<typeof tool.execute>[4],
    BACKGROUND_CONTEXT,
  ) as Promise<AgentToolResult<McpToolDetails>>;
}

function textOf(result: AgentToolResult<McpToolDetails>): string {
  const first = result.content[0];
  return first !== undefined && first.type === "text" ? first.text : "";
}

describe("normalizeInputSchema", () => {
  it("对象 schema 原样透传", () => {
    const schema = { type: "object", properties: { a: { type: "string" } } };
    expect(normalizeInputSchema(schema)).toBe(schema);
  });

  it("只给 properties 时补上 type: object", () => {
    expect(normalizeInputSchema({ properties: { a: { type: "string" } } })).toEqual({
      type: "object",
      properties: { a: { type: "string" } },
    });
  });

  it("非法 schema 退化成空对象 schema（宁可少信息，也不要工具加载失败）", () => {
    expect(normalizeInputSchema(undefined)).toEqual({
      type: "object",
      properties: {},
      additionalProperties: true,
    });
    expect(normalizeInputSchema("nope")).toEqual({
      type: "object",
      properties: {},
      additionalProperties: true,
    });
  });
});

describe("truncateForModel", () => {
  it("短文本不动", () => {
    expect(truncateForModel("hello")).toEqual({ text: "hello", truncated: false });
  });

  it("超长文本保留开头并给出截断提示", () => {
    const text = Array.from({ length: 2100 }, (_unused, index) => `line-${index}`).join("\n");
    const clipped = truncateForModel(text);
    expect(clipped.truncated).toBe(true);
    expect(clipped.text.startsWith("line-0\nline-1")).toBe(true);
    expect(clipped.text.includes("结果过长已截断")).toBe(true);
    expect(clipped.text.includes("line-2099")).toBe(false);
  });
});

describe("buildMcpToolDescription", () => {
  it("写明来源 server 与工具名，并带上截断提示", () => {
    const description = buildMcpToolDescription(definition);
    expect(description.includes("测试服务器")).toBe(true);
    expect(description.includes("read_file")).toBe(true);
    expect(description.includes("读取一个文件")).toBe(true);
  });

  it("server 没给描述时也有兜底文案", () => {
    const description = buildMcpToolDescription({ ...definition, description: "  " });
    expect(description.includes("未提供工具说明")).toBe(true);
  });
});

describe("createMcpTool", () => {
  it("工具名是限定名 mcp__<serverId>__<toolName>", () => {
    const tool = createMcpTool(definition, { callTool: async () => ({ text: "", isError: false }) });
    expect(tool.name).toBe("mcp__mcp-test__read_file");
    expect(tool.label).toBe("mcp__mcp-test__read_file");
  });

  it("调用成功：结果文本照原样回给模型，details 记录来源", async () => {
    const calls: { serverId: string; toolName: string; args: Record<string, unknown> }[] = [];
    const tool = createMcpTool(definition, {
      callTool: async (serverId, toolName, args) => {
        calls.push({ serverId, toolName, args });
        return { text: "文件内容", isError: false };
      },
    });

    const result = await runTool(tool, { path: "a.txt" });

    expect(textOf(result)).toBe("文件内容");
    expect(result.details).toMatchObject({
      qualifiedName: "mcp__mcp-test__read_file",
      serverId: "mcp-test",
      toolName: "read_file",
      isError: false,
      truncated: false,
    });
    expect(calls).toEqual([
      { serverId: "mcp-test", toolName: "read_file", args: { path: "a.txt" } },
    ]);
  });

  it("server 标记失败：前缀 Error: 让模型看到这是失败结果", async () => {
    const tool = createMcpTool(definition, {
      callTool: async () => ({ text: "找不到文件", isError: true }),
    });

    const result = await runTool(tool, {});

    expect(textOf(result)).toBe("Error: 找不到文件");
    expect(result.details.isError).toBe(true);
  });

  it("调用抛错（连接断开等）：文本化而不是让工具调用崩掉", async () => {
    const tool = createMcpTool(definition, {
      callTool: async () => {
        throw new Error("MCP server 未连接：mcp-test");
      },
    });

    const result = await runTool(tool, {});

    expect(textOf(result)).toBe("Error: 调用 MCP 工具失败：MCP server 未连接：mcp-test");
    expect(result.details.isError).toBe(true);
  });

  it("结果超长时截断并打标", async () => {
    const long = Array.from({ length: 3000 }, (_unused, index) => `row-${index}`).join("\n");
    const tool = createMcpTool(definition, {
      callTool: async () => ({ text: long, isError: false }),
    });

    const result = await runTool(tool, {});

    expect(result.details.truncated).toBe(true);
    expect(textOf(result).includes("结果过长已截断")).toBe(true);
  });
});
