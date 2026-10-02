import {
  type Context,
  defineService,
  type JsonValue,
  type ReplicatedState,
} from "@earendil-works/chord";
import type { ToolCall } from "@earendil-works/pi-ai";
import type { ToolExecutionResult } from "@earendil-works/pi-durable";
import Type from "typebox";
import { Value } from "typebox/value";

export type PluginToolDescriptor = {
  name: string;
  description: string;
  parameters: { [key: string]: JsonValue };
  replay?: "safe" | "unsafe";
  executionMode?: "parallel" | "sequential";
  outputLimits?: { maxBytes?: number; maxLines?: number; retain?: "head" | "tail" };
};
export type PluginAgentDescription = {
  tools: PluginToolDescriptor[];
  commands: { name: string; description: string }[];
  sections: { key: string; text: string }[];
};
export type PluginInvocation = {
  callId: string;
  taskId: string;
  conversationId: string;
  cwd: string;
};
export type PluginHookInvocation = { taskId: string; conversationId: string };
export type BeforeToolResult = { arguments?: { [key: string]: JsonValue }; block?: string };

/** Serializable part of native Durable extensions; task/commit callbacks stay in the Harness process. */
export interface PluginAgentService {
  readonly description: ReplicatedState<PluginAgentDescription>;
  execute(
    name: string,
    args: { [key: string]: JsonValue },
    invocation: PluginInvocation,
    context: Context,
  ): Promise<ToolExecutionResult>;
  command(name: string, args: string, cwd: string, context: Context): Promise<string>;
  beforeTool(
    call: ToolCall,
    invocation: PluginHookInvocation,
    context: Context,
  ): Promise<BeforeToolResult>;
  afterTool(
    call: ToolCall,
    result: ToolExecutionResult,
    invocation: PluginHookInvocation,
    context: Context,
  ): Promise<ToolExecutionResult>;
}
export const PluginAgent = defineService<PluginAgentService>("oint.plugin.agent");

const name = Type.String({ pattern: "^[a-zA-Z][a-zA-Z0-9_-]{0,39}$" });
const descriptionSchema = Type.Object(
  {
    tools: Type.Array(
      Type.Object(
        {
          name,
          description: Type.String({ maxLength: 12000 }),
          parameters: Type.Record(Type.String(), Type.Unknown()),
          replay: Type.Optional(Type.Union([Type.Literal("safe"), Type.Literal("unsafe")])),
          executionMode: Type.Optional(
            Type.Union([Type.Literal("parallel"), Type.Literal("sequential")]),
          ),
          outputLimits: Type.Optional(
            Type.Object(
              {
                maxBytes: Type.Optional(Type.Integer({ minimum: 1 })),
                maxLines: Type.Optional(Type.Integer({ minimum: 1 })),
                retain: Type.Optional(Type.Union([Type.Literal("head"), Type.Literal("tail")])),
              },
              { additionalProperties: false },
            ),
          ),
        },
        { additionalProperties: false },
      ),
      { maxItems: 64 },
    ),
    commands: Type.Array(
      Type.Object(
        { name, description: Type.String({ maxLength: 12000 }) },
        { additionalProperties: false },
      ),
      { maxItems: 64 },
    ),
    sections: Type.Array(
      Type.Object(
        {
          key: Type.String({ pattern: "^[a-z][a-z0-9_-]{0,39}$" }),
          text: Type.String({ maxLength: 32000 }),
        },
        { additionalProperties: false },
      ),
      { maxItems: 32 },
    ),
  },
  { additionalProperties: false },
);

export function validateAgentDescription(value: unknown): asserts value is PluginAgentDescription {
  if (!Value.Check(descriptionSchema, value)) throw new Error("插件 agent service 的描述不合法");
  for (const items of [
    value.tools,
    value.commands,
    value.sections.map((section) => ({ name: section.key })),
  ]) {
    if (new Set(items.map((item) => item.name)).size !== items.length)
      throw new Error("插件的工具、命令或 section 名称重复");
  }
  for (const tool of value.tools)
    if (tool.parameters.type !== "object")
      throw new Error(`工具 ${tool.name} 的参数必须是 object schema`);
}
