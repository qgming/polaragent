// 知识库检索工具
// src/ai/tools/knowledge.ts

import { Type, type Static } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";

import { queryKnowledge } from "@/lib/knowledge";
import { useConfigStore } from "@/stores/config-store";
import { text, type ToolContext } from "./tool-context";

const searchKnowledgeParams = Type.Object({
  query: Type.String({ description: "检索关键词或问题" }),
  knowledgeBaseIds: Type.Optional(
    Type.Array(Type.String(), {
      description: "要检索的知识库 ID 列表，留空则检索所有已启用的知识库",
    }),
  ),
  topK: Type.Optional(
    Type.Number({
      description: "返回结果数量 (1-20)，默认 5",
      minimum: 1,
      maximum: 20,
    }),
  ),
});

export function searchKnowledgeTool(
  ctx: ToolContext,
): AgentTool<typeof searchKnowledgeParams> {
  return {
    name: "search_knowledge",
    label: "检索知识库",
    description:
      "在已启用的知识库中检索相关文档片段。用于获取项目文档、技术规范、历史资料等上下文信息。",
    parameters: searchKnowledgeParams,
    execute: async (_id, params: Static<typeof searchKnowledgeParams>) => {
      const settings = useConfigStore.getState().settings;
      const knowledgeConfig = settings.knowledge;

      if (!knowledgeConfig || !knowledgeConfig.embedding.apiKey) {
        return {
          content: text("知识库未配置。请前往设置 > 知识库配置嵌入模型。"),
          details: { error: "未配置" },
        };
      }

      // 获取当前会话选中的知识库 ID 列表（从 context 传入）
      const kbIds = params.knowledgeBaseIds || ctx.knowledgeBaseIds || [];
      if (kbIds.length === 0) {
        return {
          content: text("当前会话未选择知识库。请在输入框点击知识库按钮选择。"),
          details: { results: [] },
        };
      }

      const topK = params.topK ?? knowledgeConfig.retrieval.topK;
      const threshold = knowledgeConfig.retrieval.threshold;

      try {
        // 跨库检索并合并结果
        const allResults = await Promise.all(
          kbIds.map((kbId) =>
            queryKnowledge({
              kbId,
              query: params.query,
              config: {
                embedding: knowledgeConfig.embedding,
              },
              topK,
              threshold,
            }),
          ),
        );

        const merged = allResults
          .flatMap((r: any) => r.results)
          .sort((a: any, b: any) => b.score - a.score)
          .slice(0, topK);

        if (merged.length === 0) {
          return {
            content: text(`未找到与「${params.query}」相关的内容。`),
            details: { results: [] },
          };
        }

        const markdown = merged
          .map(
            (r: any, i: number) =>
              `### ${i + 1}. ${r.file} (相似度: ${r.score.toFixed(3)})\n\n${r.text}\n`,
          )
          .join("\n---\n\n");

        return {
          content: text(
            `找到 ${merged.length} 条相关内容：\n\n${markdown}`,
          ),
          details: { results: merged },
        };
      } catch (error) {
        return {
          content: text(
            `检索失败: ${error instanceof Error ? error.message : "未知错误"}`,
          ),
          details: { error: String(error) },
        };
      }
    },
  };
}
