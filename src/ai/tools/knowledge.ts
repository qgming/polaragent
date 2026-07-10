// 知识库检索工具
// src/ai/tools/knowledge.ts

import { Type, type Static } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";

import { pMap, REMOTE_CONCURRENCY } from "@/lib/concurrency";
import { queryKnowledge } from "@/lib/knowledge";
import { useConfigStore } from "@/stores/config-store";
import { CACHE_TTL as CACHE_TTL_CONSTANTS } from "@/config/constants";
import { text, type ToolContext } from "./tool-context";
import { progressUpdate, throwIfAborted, withDuration, nowMs } from "./tool-progress";

// 查询缓存：缓存键 -> { 结果, 时间戳 }
const queryCache = new Map<string, { results: any[]; timestamp: number }>();
const CACHE_TTL = CACHE_TTL_CONSTANTS.KNOWLEDGE;
const CACHE_CAPACITY = 100;

/**
 * 访问缓存并将该键移动到最近使用端，实现简单的 LRU 语义。
 */
function accessCache(key: string) {
  const value = queryCache.get(key);
  if (value) {
    queryCache.delete(key);
    queryCache.set(key, value);
  }
  return value;
}

/**
 * 当缓存超过容量时，移除最久未使用的条目（Map 头部的键）。
 */
function evictCache() {
  while (queryCache.size > CACHE_CAPACITY) {
    const oldestKey = queryCache.keys().next().value as string | undefined;
    if (oldestKey) queryCache.delete(oldestKey);
  }
}

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
  filePath: Type.Optional(
    Type.String({ description: "按文件路径或文件名过滤（支持部分匹配）" }),
  ),
  dateRange: Type.Optional(
    Type.Object(
      {
        start: Type.Optional(Type.String({ description: "起始日期 ISO 格式" })),
        end: Type.Optional(Type.String({ description: "结束日期 ISO 格式" })),
      },
      { description: "按文档更新日期过滤" },
    ),
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
    execute: async (_id, params: Static<typeof searchKnowledgeParams>, signal, onUpdate) => {
      const startedAt = nowMs();
      progressUpdate(onUpdate, {
        phase: "validating",
        summary: `准备检索知识库：${params.query}`,
        query: params.query,
      });
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
      throwIfAborted(signal);

      // 生成缓存键（包含过滤参数，避免不同过滤条件命中相同缓存）
      const cacheKey = `${params.query}:${kbIds.sort().join(",")}:${topK}:${threshold}:${
        params.filePath || ""
      }:${JSON.stringify(params.dateRange || {})}`;

      // 检查缓存（LRU：命中后移动到最近使用端）
      const cached = accessCache(cacheKey);
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
          details: withDuration({ results: cached.results, cached: true }, startedAt),
        };
      }

      try {
        progressUpdate(onUpdate, {
          phase: "fetching",
          summary: `正在检索 ${kbIds.length} 个知识库...`,
          knowledgeBaseIds: kbIds,
          topK,
        });
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
        throwIfAborted(signal);

        let merged = allResults
          .flatMap((r: any) => r.results)
          .sort((a: any, b: any) => b.score - a.score)
          .slice(0, topK);

        // 按文件路径过滤（结果中 file 字段通常为文件路径或文件名）
        if (params.filePath) {
          merged = merged.filter((r: any) =>
            (r.filePath ?? r.file ?? "").includes(params.filePath!),
          );
        }

        // 按日期范围过滤（仅在结果包含 updatedAt 时生效）
        if (params.dateRange) {
          const start = params.dateRange.start ? new Date(params.dateRange.start).getTime() : 0;
          const end = params.dateRange.end ? new Date(params.dateRange.end).getTime() : Infinity;
          merged = merged.filter((r: any) => {
            const date = r.updatedAt ? new Date(r.updatedAt).getTime() : 0;
            return date >= start && date <= end;
          });
        }

        if (merged.length === 0) {
          return {
            content: text(`未找到与「${params.query}」相关的内容。`),
            details: withDuration({ results: [] }, startedAt),
          };
        }

        // 缓存结果（写入后执行 LRU 淘汰）
        queryCache.set(cacheKey, { results: merged, timestamp: Date.now() });
        evictCache();

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
          details: withDuration({ results: merged }, startedAt),
        };
      } catch (error) {
        return {
          content: text(
            `检索失败: ${error instanceof Error ? error.message : "未知错误"}`,
          ),
          details: withDuration({ error: String(error) }, startedAt),
        };
      }
    },
  };
}
