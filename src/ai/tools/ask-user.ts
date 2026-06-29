// ask_user —— 普通对话与团队协作共用的用户输入工具

import { Type, type Static } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";

import { initiateAskUser, type AskUserMode } from "@/ai/ask-user";
import { text, type ToolContext } from "./tool-context";

const askUserParams = Type.Object({
  prompt: Type.String({
    description: "要问用户的问题，支持 Markdown。必须具体说明你需要用户补充什么。",
  }),
  mode: Type.Optional(
    Type.Union([
      Type.Literal("input"),
      Type.Literal("single"),
      Type.Literal("multiple"),
    ], {
      description:
        "输入方式：input=自由输入，single=单选，multiple=多选。若提供 options 但不填 mode，默认 single。",
    }),
  ),
  options: Type.Optional(
    Type.Array(Type.String({ description: "用户可选项标签" }), {
      description: "single/multiple 模式展示给用户的普通选项。最后的自定义输入选项会自动追加，不需要放进 options。建议 2-8 个。",
      minItems: 1,
      maxItems: 12,
    }),
  ),
  customOptionLabel: Type.Optional(
    Type.String({
      description: "自定义输入选项的标签，例如：其他 / 补充说明。",
    }),
  ),
});

export function askUserTool(
  ctx: ToolContext,
): AgentTool<typeof askUserParams> {
  return {
    name: "ask_user",
    label: "询问用户",
    description:
      "暂停当前流程，向用户请求补充信息或选择。" +
      "支持 input 自由输入、single 单选、multiple 多选；单选/多选会在最后提供一个自定义输入选项供用户补充。prompt 支持 Markdown。用户提交后工具返回结构化答案，你再继续推理。",
    parameters: askUserParams,
    execute: async (_id, params: Static<typeof askUserParams>) => {
      const prompt = params.prompt.trim();
      if (!prompt) {
        throw new Error("prompt 不能为空");
      }

      const optionLabels = (params.options ?? [])
        .map((option) => option.trim())
        .filter(Boolean);
      const mode: AskUserMode =
        params.mode ?? (optionLabels.length > 0 ? "single" : "input");

      if (mode !== "input" && optionLabels.length === 0) {
        throw new Error("single/multiple 模式必须提供 options");
      }
      if (mode === "input" && optionLabels.length > 0) {
        throw new Error("input 模式不应提供 options；需要选项时请使用 single 或 multiple");
      }

      const options = optionLabels.map((label, index) => ({
        id: `option_${index}`,
        label,
      }));

      const result = await initiateAskUser({
        threadId: ctx.threadId,
        requesterId: ctx.requester?.id,
        requesterName: ctx.requester?.name,
        isTeam: ctx.isTeam,
        prompt,
        mode,
        options,
        customOptionLabel: params.customOptionLabel?.trim() || undefined,
      });

      return {
        content: text(JSON.stringify(result, null, 2)),
        details: {
          askUser: {
            prompt,
            mode,
            options,
            response: result,
          },
        },
      };
    },
  };
}
