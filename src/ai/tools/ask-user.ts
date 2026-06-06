// ask_user —— 普通对话与团队协作共用的用户输入工具

import { Type, type Static } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";

import { initiateAskUser, type AskUserMode } from "@/ai/ask-user";
import { text, type ToolContext } from "./context";

const askUserParams = Type.Object({
  prompt: Type.String({
    description: "要问用户的问题。必须具体说明你需要用户补充什么。",
  }),
  mode: Type.Optional(
    Type.Union([
      Type.Literal("text"),
      Type.Literal("single"),
      Type.Literal("multiple"),
    ], {
      description:
        "输入方式：text=纯文本输入，single=单选，multiple=多选。若提供 options 但不填 mode，默认 single。",
    }),
  ),
  options: Type.Optional(
    Type.Array(Type.String({ description: "用户可选项标签" }), {
      description: "单选/多选时展示给用户的选项。建议 2-8 个。",
      minItems: 1,
      maxItems: 12,
    }),
  ),
  allowCustomInput: Type.Optional(
    Type.Boolean({
      description:
        "是否允许用户在选项之外补充自由输入。选项模式默认允许，text 模式始终允许。",
    }),
  ),
  customInputLabel: Type.Optional(
    Type.String({
      description: "自由输入框的标签，例如：其他 / 补充说明。",
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
      "支持纯文本、单选、多选；选项模式会在最后提供自由输入框供用户补充。用户提交后工具返回结构化答案，你再继续推理。",
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
        params.mode ?? (optionLabels.length > 0 ? "single" : "text");

      if (mode !== "text" && optionLabels.length === 0) {
        throw new Error("single/multiple 模式必须提供 options");
      }

      const options = optionLabels.map((label, index) => ({
        id: `option_${index}`,
        label,
      }));
      const allowCustomInput =
        mode === "text" ? true : (params.allowCustomInput ?? true);

      const result = await initiateAskUser({
        threadId: ctx.threadId,
        requesterId: ctx.requester?.id,
        requesterName: ctx.requester?.name,
        isTeam: ctx.isTeam,
        prompt,
        mode,
        options,
        allowCustomInput,
        customInputLabel: params.customInputLabel?.trim() || undefined,
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
