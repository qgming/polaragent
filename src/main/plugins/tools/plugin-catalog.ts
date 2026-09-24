// `plugin_tools` —— 插件内层工具的目录。
//
// ## 为什么网关之外还需要它
//
// 网关（`plugin__<key>__call`）的描述里只列了内层工具的**名字与说明**，
// **没有参数的 schema** —— 因为 schema 可能很长，几十个工具塞进一条描述会把
// 上下文撑爆。但那意味着模型知道"有个叫 hash 的工具"却不知道要传什么。
//
// `mcp_tools` 解决的正是同一件事（MCP 的聚合形态下它是读参数 schema 的唯一通道），
// 所以这里**照它的形状做**：三级查询，不传列全部、传 plugin 列它的工具与 schema、
// 再传 tool 给单个工具的完整定义。
//
// 两个目录工具并存而不是合成一个：它们的数据源、权限面与失效方式都不同
//（MCP 的 server 可能连不上，插件的进程可能没起来），合并会让"哪一边出问题了"
// 变得读不出来。

import type {
  AgentHarnessTool,
  AgentToolResult,
  ExecutionToolContext,
} from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { PluginToolDecl } from "@/shared/contracts/plugin-rpc";

/** 工具名。与 `mcp_tools` 并列，前缀区分数据源 */
export const PLUGIN_CATALOG_TOOL_NAME = "plugin_tools";

/** 目录里的一台"插件" */
export interface PluginCatalogEntry {
  pluginId: string;
  pluginName: string;
  tools: readonly PluginToolDecl[];
}

export interface PluginCatalogSource {
  /** 当前**在跑**的插件的工具清单。进程没起来的插件不在其中 */
  catalog: () => PluginCatalogEntry[];
}

const DESCRIPTION = `列出插件提供的工具，以及每个工具需要什么参数。

插件工具不在工具表里逐个出现 —— 每个插件只占一个网关（\`plugin__<key>__call\`），
内层工具通过它的 tool 参数指定。**调用前先用这个工具拿到参数 schema。**

- \`plugin_tools()\` —— 列出所有提供了工具的插件
- \`plugin_tools({ plugin: "<id>" })\` —— 列出该插件的全部工具与它们的参数
- \`plugin_tools({ plugin: "<id>", tool: "<name>" })\` —— 给出单个工具的完整定义

插件的工具只在它的进程**正在运行**时可用：插件被停用或崩溃后，网关还在（名字要保持稳定），
但调用会返回一句说明。`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createPluginCatalogTool<
  TContext extends ExecutionToolContext = ExecutionToolContext,
>(source: PluginCatalogSource): AgentHarnessTool<TContext> {
  const parameters = Type.Object(
    {
      plugin: Type.Optional(
        Type.String({ description: "插件的 id（不传则列出所有提供工具的插件）" }),
      ),
      tool: Type.Optional(Type.String({ description: "工具名（要与 plugin 一起传）" })),
    },
    { additionalProperties: false },
  );

  return {
    name: PLUGIN_CATALOG_TOOL_NAME,
    label: PLUGIN_CATALOG_TOOL_NAME,
    description: DESCRIPTION,
    parameters,
    async execute(_toolCallId, params): Promise<AgentToolResult<unknown>> {
      const args = isRecord(params) ? params : {};
      const pluginId = typeof args.plugin === "string" ? args.plugin.trim() : "";
      const toolName = typeof args.tool === "string" ? args.tool.trim() : "";
      const catalog = source.catalog();

      /*
        参数不认识时给一句**可读错误**而不是抛异常 —— 与 MCP 目录工具、
        与插件工具包装层同一口径：模型要的是"读得懂的纠正"。
      */
      const fail = (text: string): AgentToolResult<unknown> =>
        ({
          content: [{ type: "text", text: `Error: ${text}` }],
        }) as unknown as AgentToolResult<unknown>;

      /** 一段纯文本结果。`details` 是内核要求的字段，这里没有额外结构化数据可给 */
      const say = (text: string): AgentToolResult<unknown> =>
        ({ content: [{ type: "text", text }] }) as unknown as AgentToolResult<unknown>;

      if (pluginId === "") {
        if (toolName !== "") {
          return fail(
            'tool 必须与 plugin 一起传：plugin_tools({ plugin: "<id>", tool: "<name>" })。',
          );
        }
        if (catalog.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "当前没有插件提供工具。（插件被停用、进程没起来，或它本来就不注册工具。）",
              },
            ],
          } as unknown as AgentToolResult<unknown>;
        }
        const lines = catalog.map(
          (entry) =>
            `- ${entry.pluginId}（${entry.pluginName}）：${entry.tools.length} 个工具 —— ${entry.tools
              .map((tool) => tool.name)
              .join(", ")}`,
        );
        return {
          content: [
            {
              type: "text",
              text: `提供了工具的插件：\n${lines.join("\n")}\n\n用 plugin_tools({ plugin: "<id>" }) 看某个插件的工具与参数。`,
            },
          ],
        } as unknown as AgentToolResult<unknown>;
      }

      const entry = catalog.find((item) => item.pluginId === pluginId);
      if (entry === undefined) {
        return fail(
          `没有正在提供工具的插件「${pluginId}」。可用：${
            catalog.map((item) => item.pluginId).join(", ") || "（无）"
          }`,
        );
      }

      if (toolName === "") {
        // **参数 schema 原样给出去** —— 这正是这个工具存在的理由
        const blocks = entry.tools.map((tool) =>
          [
            `### ${tool.name}`,
            tool.description,
            "参数：",
            JSON.stringify(tool.parameters, null, 2),
          ].join("\n"),
        );
        return {
          content: [
            {
              type: "text",
              text: `插件「${entry.pluginName}」（${entry.pluginId}）的工具：\n\n${blocks.join("\n\n")}`,
            },
          ],
        } as unknown as AgentToolResult<unknown>;
      }

      const tool = entry.tools.find((item) => item.name === toolName);
      if (tool === undefined) {
        return fail(
          `插件「${entry.pluginId}」没有名为「${toolName}」的工具。可用：${entry.tools
            .map((item) => item.name)
            .join(", ")}`,
        );
      }
      return say(
        [
          `工具：${tool.name}`,
          `插件：${entry.pluginId}`,
          "",
          tool.description,
          "",
          "参数：",
          JSON.stringify(tool.parameters, null, 2),
          "",
          `调用方式：用网关 plugin__…__call 调用时传 { tool: "${tool.name}", args: { … } }。`,
        ].join("\n"),
      );
    },
  } as AgentHarnessTool<TContext>;
}
