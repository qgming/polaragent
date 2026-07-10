// 助手目录工具 —— list_agents

import { Type, type Static } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";

import { useConfigStore } from "@/stores/config-store";
import { text, type ToolContext } from "./tool-context";

const listAgentsParams = Type.Object({
  includeCurrent: Type.Optional(
    Type.Boolean({
      description: "是否包含当前发起请求的助手，默认 true。",
    }),
  ),
});

export function listAgentsTool(
  ctx: ToolContext,
): AgentTool<typeof listAgentsParams> {
  return {
    name: "list_agents",
    label: "列出助手",
    description:
      "列出当前用户已安装及内置的助手，包含 ID、名称、类型和介绍。需要选择子代理或了解可用助手时先调用此工具。",
    parameters: listAgentsParams,
    executionMode: "parallel",
    execute: async (_id, params: Static<typeof listAgentsParams>) => {
      const includeCurrent = params.includeCurrent ?? true;
      const currentAgentId = ctx.requester?.id;
      const agents = useConfigStore
        .getState()
        .agents
        .filter((agent) => includeCurrent || agent.id !== currentAgentId)
        .map((agent) => ({
          id: agent.id,
          name: agent.name,
          description: agent.description,
          type: agent.type ?? (agent.id === "default" ? "builtin" : "custom"),
          category: agent.metadata?.category,
          tags: agent.metadata?.tags ?? [],
        }));

      if (agents.length === 0) {
        return {
          content: text("当前没有可用助手。"),
          details: { agents: [] },
        };
      }

      const lines = agents.map((agent) => {
        const typeLabel = agent.type === "builtin" ? "内置" : "自定义";
        const tagText = agent.tags.length > 0 ? `；标签：${agent.tags.join("、")}` : "";
        return `- ${agent.name} (${agent.id}, ${typeLabel}): ${agent.description}${tagText}`;
      });

      return {
        content: text(lines.join("\n")),
        details: { agents },
      };
    },
  };
}
