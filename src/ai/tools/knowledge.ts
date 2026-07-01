// 知识库检索工具
// src/ai/tools/knowledge.ts

import { Type, type Static } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";

import { pMap, REMOTE_CONCURRENCY } from "@/lib/concurrency";
import { queryKnowledge } from "@/lib/knowledge";
import { useConfigStore } from "@/stores/config-store";
import { CACHE_TTL as CACHE_TTL_CONSTANTS } from "@/config/constants";
import { text, type ToolContext } from "./tool-context";

// 查询缓存：缓存键 -> { 结果, 时间戳 }
const queryCache = new Map<string, { results: any[]; timestamp: number }>();
const CACHE_TTL = CACHE_TTL_CONSTANTS.KNOWLEDGE;

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
    executionMode: "parallel",
    execute: async (_id, params: Static<typeof searchKnowledgeParams>) => {
      const settings = useConfigStore.getState().settings;
      const knowledgeConfig = settings.knowledge;

      if (!knowledgeConfig || !knowledgeConfig.embedding.apiKey) {
        return {
          content: text("知识库未配置。请前往设置 > 知识库配置嵌入模型。"),
          details: { error: "未配置" },
        };
      }

      const kbIds = params.knowledgeBaseIds || ctx.knowledgeBaseIds || [];
      if (kbIds.length === 0) {
        return {
          content: text("当前会话未选择知识库。请在输入框点击知识库按钮选择。"),
          details: { results: [] },
        };
      }

      const topK = params.topK ?? knowledgeConfig.retrieval.topK;
      const threshold = knowledgeConfig.retrieval.threshold;

      // 生成缓存键
      const cacheKey = `${params.query}:${kbIds.sort().join(",")}:${topK}:${threshold}`;

      // 检查缓存
      const cached = queryCache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        const markdown = cached.results
          .map(
            (r: any, i: number) =>
              `### ${i + 1}. ${r.file} (相似度: ${r.score.toFixed(3)})\n\n${r.text}\n`,
          )
          .join("\n---\n\n");

        return {
          content: text(
            `找到 ${cached.results.length} 条相关内容（缓存）：\n\n${markdown}`,
          ),
          details: { results: cached.results, cached: true },
        };
      }

      try {
        // 跨库检索并合并结果（受控并发，避免多个 embedding 请求同时打满）
        const allResults = await pMap(
          kbIds,
          (kbId) =>
            queryKnowledge({
              kbId,
              query: params.query,
              config: {
                embedding: knowledgeConfig.embedding,
              },
              topK,
              threshold,
            }).catch(() => ({ results: [] })), // 部分失败不影响其他库
          { concurrency: REMOTE_CONCURRENCY },
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

        // 缓存结果
        queryCache.set(cacheKey, { results: merged, timestamp: Date.now() });

        // 简单的缓存清理
        if (queryCache.size > 100) {
          const oldestKey = Array.from(queryCache.keys())[0];
          queryCache.delete(oldestKey);
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
