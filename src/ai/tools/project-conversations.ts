import { Type, type Static } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";

import {
  formatProjectConversationList,
  formatProjectConversationMessages,
  listProjectConversations,
  readProjectConversation,
} from "@/lib/session/project-context";
import { text, type ToolContext } from "./tool-context";

const listProjectConversationsParams = Type.Object({
  query: Type.Optional(
    Type.String({
      description: "按会话标题过滤的关键词。留空则列出最近更新的项目会话。",
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      description: "返回会话数量，默认 20，最大 100。",
      minimum: 1,
      maximum: 100,
    }),
  ),
  includeCurrent: Type.Optional(
    Type.Boolean({
      description: "是否包含当前会话。默认 false。",
    }),
  ),
});

const readProjectConversationParams = Type.Object({
  conversationId: Type.String({
    description: "要读取的项目会话 ID。应先调用 list_project_conversations 获取。",
  }),
  maxMessages: Type.Optional(
    Type.Number({
      description: "读取最近多少条文本消息，默认 24，最大 200。",
      minimum: 1,
      maximum: 200,
    }),
  ),
  maxMessageChars: Type.Optional(
    Type.Number({
      description: "单条消息最大字符数，默认 1200，最大 8000。",
      minimum: 200,
      maximum: 8000,
    }),
  ),
});

export function listProjectConversationsTool(
  ctx: ToolContext,
): AgentTool<typeof listProjectConversationsParams> {
  return {
    name: "list_project_conversations",
    label: "列出项目会话",
    description:
      "项目会话专用工具。需要了解同一项目中有哪些其他对话、寻找可参考的历史会话时使用。返回会话标题、ID 和更新时间。",
    parameters: listProjectConversationsParams,
    executionMode: "parallel",
    execute: async (_id, params: Static<typeof listProjectConversationsParams>) => {
      if (!ctx.projectId) {
        return {
          content: text("当前会话不属于任何项目，无法列出项目会话。"),
          details: { conversations: [] },
        };
      }

      const conversations = await listProjectConversations({
        projectId: ctx.projectId,
        currentThreadId: params.includeCurrent ? undefined : ctx.threadId,
        query: params.query,
        limit: params.limit,
      });

      return {
        content: text(formatProjectConversationList(conversations)),
        details: { conversations },
      };
    },
  };
}

export function readProjectConversationTool(
  ctx: ToolContext,
): AgentTool<typeof readProjectConversationParams> {
  return {
    name: "read_project_conversation",
    label: "读取项目会话",
    description:
      "项目会话专用工具。按 ID 读取同一项目内某个历史会话的最近消息。用于补充上下文、查找用户之前的要求、方案、结论或约定。",
    parameters: readProjectConversationParams,
    executionMode: "parallel",
    execute: async (_id, params: Static<typeof readProjectConversationParams>) => {
      if (!ctx.projectId) {
        return {
          content: text("当前会话不属于任何项目，无法读取项目会话。"),
          details: { error: "missing_project_id" },
        };
      }

      const result = await readProjectConversation({
        projectId: ctx.projectId,
        conversationId: params.conversationId,
        maxMessages: params.maxMessages,
        maxMessageChars: params.maxMessageChars,
      });

      if (!result) {
        return {
          content: text(
            "没有找到该项目内的对应会话。请先调用 list_project_conversations 确认 conversationId。",
          ),
          details: { error: "conversation_not_found" },
        };
      }

      return {
        content: text(formatProjectConversationMessages(result)),
        details: result,
      };
    },
  };
}
