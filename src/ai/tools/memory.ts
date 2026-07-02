import { Type, type Static } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";

import {
  archiveMemory,
  createMemory,
  deleteMemory,
  memoryApiConfigFromSettings,
  projectKeyFromWorkingDir,
  searchMemories,
} from "@/lib/memory";
import type { MemoryScope, MemoryType } from "@/lib/memory";
import { useConfigStore } from "@/stores/config-store";
import { text, type ToolContext } from "./tool-context";

const memoryScopeSchema = Type.Union([
  Type.Literal("global"),
  Type.Literal("project"),
]);

const memoryTypeSchema = Type.Union([
  Type.Literal("preference"),
  Type.Literal("profile"),
  Type.Literal("project"),
  Type.Literal("instruction"),
  Type.Literal("correction"),
  Type.Literal("communication"),
  Type.Literal("workflow"),
  Type.Literal("tool"),
  Type.Literal("goal"),
  Type.Literal("constraint"),
]);

const searchMemoryParams = Type.Object({
  query: Type.String({ description: "要检索的用户偏好、身份信息、历史约定或项目上下文" }),
  scopes: Type.Optional(
    Type.Array(memoryScopeSchema, {
      description: "检索范围。留空时检索全局记忆；若当前有工作目录，也检索该项目记忆。",
    }),
  ),
  topK: Type.Optional(
    Type.Number({
      description: "返回结果数量 (1-20)，默认使用设置中的记忆 TopK",
      minimum: 1,
      maximum: 20,
    }),
  ),
});

const rememberMemoryParams = Type.Object({
    content: Type.String({ description: "要长期记住的一句话事实、偏好、约定或纠正" }),
    type: Type.Optional(memoryTypeSchema),
    scope: Type.Optional(memoryScopeSchema),
    tags: Type.Optional(Type.Array(Type.String(), { description: "用于管理和筛选的短标签" })),
    structured: Type.Optional(
        Type.Record(Type.String(), Type.String(), {
            description: "键值对形式的结构化数据，如 {\"theme\": \"dark\", \"language\": \"zh-CN\"}。可选。",
        }),
    ),
});

const forgetMemoryParams = Type.Object({
  memoryId: Type.Optional(Type.String({ description: "要忘记的记忆 ID。优先使用 search_memory 返回的 ID。" })),
  query: Type.Optional(Type.String({ description: "没有 ID 时，用自然语言查找最相关的一条记忆并忘记" })),
  deletePermanently: Type.Optional(
    Type.Boolean({ description: "是否永久删除。默认 false，仅关闭并从检索中隐藏。" }),
  ),
});

function memoryRuntime(ctx: ToolContext) {
  const settings = useConfigStore.getState().settings;
  if (!settings.memory?.enabled) {
    return { error: "全局记忆已关闭。请在设置 > 全局记忆 中开启。" };
  }
  const config = memoryApiConfigFromSettings(settings);
  if (!config) {
    return { error: "记忆未配置嵌入模型。请先在设置 > 嵌入配置 中配置 embeddings。" };
  }
  return {
    settings,
    config,
    projectKey: projectKeyFromWorkingDir(ctx.workingDir),
  };
}

function defaultScopes(ctx: ToolContext): MemoryScope[] {
  const settings = useConfigStore.getState().settings;
  const scopes: MemoryScope[] = ["global"];
  if (settings.memory?.projectMemoryEnabled && projectKeyFromWorkingDir(ctx.workingDir)) {
    scopes.push("project");
  }
  return scopes;
}

function formatMemoryType(type: MemoryType): string {
  const labels: Record<MemoryType, string> = {
    preference: "偏好",
    profile: "画像",
    project: "项目",
    instruction: "指令",
    correction: "纠正",
    communication: "沟通",
    workflow: "工作流",
    tool: "工具",
    goal: "目标",
    constraint: "约束",
  };
  return labels[type] ?? type;
}

function formatScope(scope: MemoryScope): string {
  return scope === "project" ? "项目" : "全局";
}

/**
 * 检测新记忆与相似记忆之间是否存在潜在语义冲突。
 * 采用轻量级否定词检测：高相似度下，一方含否定词而另一方不含，则视为潜在矛盾。
 * 阈值设得较高，宁可漏报也不要误报。
 */
function detectContradictions(
  newContent: string,
  similarMemories: any[],
): Array<{ id: string; content: string; score: number }> {
  const CONTRADICTION_THRESHOLD = 0.75;

  // 中英文常见否定词（仅用于判断语气是否相反）
  const negationPatterns = [
    /不|没|非|无|否|别|未|休|莫|勿/,
    /not|no|never|don't|doesn't|won't|can't|isn't|aren't|didn't|couldn't|shouldn't|wouldn't/i,
  ];

  const newHasNegation = negationPatterns.some((p) => p.test(newContent));

  return similarMemories
    .filter((mem) => {
      if (typeof mem.score !== "number" || mem.score < CONTRADICTION_THRESHOLD) return false;
      if (!mem.content || typeof mem.content !== "string") return false;

      const memHasNegation = negationPatterns.some((p) => p.test(mem.content));

      // 高相似度下，仅当肯定/否定语气相反时才认为可能冲突
      return newHasNegation !== memHasNegation;
    })
    .map((mem) => ({
      id: String(mem.id ?? ""),
      content: mem.content,
      score: mem.score,
    }));
}

/**
 * 将结构化键值对序列化后附加到记忆内容中。
 */
function buildMemoryContent(content: string, structured?: Record<string, string>): string {
  if (!structured || Object.keys(structured).length === 0) return content;

  const structuredStr = Object.entries(structured)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
  return `${content} [${structuredStr}]`;
}

/**
 * 格式化单条记忆内容；若内容末尾包含 [k=v; ...] 结构化标记，则解析并展示。
 */
function formatMemoryContent(content: string): string {
  const structuredMatch = content.match(/\[(.+)]$/);
  if (!structuredMatch) return content;

  const raw = structuredMatch[1];
  const pairs = raw.split("; ").map((pair) => pair.split("="));
  if (pairs.length === 0 || pairs.some((p) => p.length !== 2)) return content;

  const formattedPairs = pairs.map(([k, v]) => `  ${k}: ${v}`).join("\n");
  return `${content}\n结构化数据:\n${formattedPairs}`;
}

export function searchMemoryTool(ctx: ToolContext): AgentTool<typeof searchMemoryParams> {
  return {
    name: "search_memory",
    label: "检索记忆",
    description:
      "检索长期记忆。需要了解用户偏好、身份、长期目标、历史纠正或当前项目约定时使用。",
    parameters: searchMemoryParams,
    executionMode: "parallel",
    execute: async (_id, params: Static<typeof searchMemoryParams>) => {
      const runtime = memoryRuntime(ctx);
      if ("error" in runtime) {
        const message = runtime.error ?? "记忆不可用";
        return { content: text(message), details: { error: message } };
      }

      const configured = runtime.settings.memory!;
      const requestedScopes = params.scopes?.length ? params.scopes : defaultScopes(ctx);
      const scopes = requestedScopes.filter(
        (scope) =>
          scope === "global" ||
          (runtime.projectKey && runtime.settings.memory?.projectMemoryEnabled),
      ) as MemoryScope[];
      if (scopes.length === 0) {
        return {
          content: text("当前没有可检索的记忆范围。项目记忆需要先设置工作目录。"),
          details: { results: [] },
        };
      }
      const topK = params.topK ?? configured.retrieval.topK;
      // 用户未指定阈值时使用更宽松的默认值，避免检索不到相近记忆
      const threshold = configured.retrieval.threshold ?? 0.5;

      try {
        const result = await searchMemories({
          query: params.query,
          scopes,
          projectKey: runtime.projectKey,
          topK,
          threshold,
          config: runtime.config,
        });

        if (result.results.length === 0) {
          return {
            content: text(`未找到与「${params.query}」相关的长期记忆。`),
            details: { results: [] },
          };
        }

        const markdown = result.results
          .map((memory, index) => {
            const tags = memory.tags.length > 0 ? ` 标签: ${memory.tags.join(", ")}` : "";
            return `### ${index + 1}. ${formatScope(memory.scope)} / ${formatMemoryType(memory.type)} / ${memory.score.toFixed(3)}\nID: ${memory.id}${tags}\n\n${formatMemoryContent(memory.content)}`;
          })
          .join("\n\n---\n\n");

        return {
          content: text(`找到 ${result.results.length} 条相关记忆：\n\n${markdown}`),
          details: { results: result.results },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "未知错误";
        return {
          content: text(`检索记忆失败: ${message}`),
          details: { error: message },
        };
      }
    },
  };
}

export function rememberMemoryTool(ctx: ToolContext): AgentTool<typeof rememberMemoryParams> {
  return {
    name: "remember_memory",
    label: "写入记忆",
    description:
      "在用户明确要求记住，或需要修正长期偏好/项目约定时写入记忆。不要写入密码、密钥、验证码等敏感信息。",
    parameters: rememberMemoryParams,
    executionMode: "parallel",
    execute: async (_id, params: Static<typeof rememberMemoryParams>) => {
      const runtime = memoryRuntime(ctx);
      if ("error" in runtime) {
        const message = runtime.error ?? "记忆不可用";
        return { content: text(message), details: { error: message } };
      }

      const scope = (params.scope ?? (runtime.projectKey ? "project" : "global")) as MemoryScope;
      if (scope === "project" && !runtime.settings.memory?.projectMemoryEnabled) {
        return {
          content: text("项目记忆已关闭，未写入。"),
          details: { error: "project_memory_disabled" },
        };
      }
      if (scope === "project" && !runtime.projectKey) {
        return {
          content: text("当前会话没有工作目录，无法写入项目记忆。"),
          details: { error: "missing_project_key" },
        };
      }

      const type = (params.type ?? (scope === "project" ? "project" : "preference")) as MemoryType;

      // 写入前先检测语义冲突（轻量级否定词检测，阈值较高，宁可漏报也不误报）
      try {
        const similarResults = await searchMemories({
          query: params.content,
          scopes: [scope],
          projectKey: runtime.projectKey,
          topK: 5,
          threshold: 0.5, // 降低阈值以捕获更多潜在矛盾候选，最终过滤仍由 detectContradictions 负责
          config: runtime.config,
        });

        const contradictions = detectContradictions(params.content, similarResults.results);
        if (contradictions.length > 0) {
          const conflictList = contradictions
            .map((c) => `- 已有记忆 [${c.id}]: "${c.content}" (相似度: ${c.score.toFixed(2)})`)
            .join("\n");
          return {
            content: text(
              `⚠️ 检测到潜在矛盾记忆：\n${conflictList}\n\n新记忆: "${params.content}"\n\n请确认是否仍要写入。如果这是有意的更新（用户改变了偏好），请直接重新调用并确认。`,
            ),
            details: { contradictions },
          };
        }
      } catch {
        // 冲突检测失败不应阻塞正常写入
      }

      const finalContent = buildMemoryContent(params.content, params.structured);

      try {
        const result = await createMemory({
          memory: {
            content: finalContent,
            type,
            scope,
            projectKey: scope === "project" ? runtime.projectKey : undefined,
            sourceThreadId: ctx.threadId,
            confidence: 1,
            tags: params.tags ?? [],
          },
          config: runtime.config,
          // 提高去重阈值，减少因内容相似而意外覆盖已有记忆
          dedupeThreshold: 0.95,
          sensitiveFilter: runtime.settings.memory?.sensitiveFilter ?? true,
        });

        return {
          content: text(
            result.deduped
              ? `已更新相似记忆：${result.memory.content}`
              : `已写入长期记忆：${result.memory.content}`,
          ),
          details: result,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "未知错误";
        return {
          content: text(`写入记忆失败: ${message}`),
          details: { error: message },
        };
      }
    },
  };
}

export function forgetMemoryTool(ctx: ToolContext): AgentTool<typeof forgetMemoryParams> {
  return {
    name: "forget_memory",
    label: "忘记记忆",
    description:
      "关闭或删除长期记忆。优先先用 search_memory 找到准确 memoryId，再调用本工具。",
    parameters: forgetMemoryParams,
    executionMode: "parallel",
    execute: async (_id, params: Static<typeof forgetMemoryParams>) => {
      const runtime = memoryRuntime(ctx);
      if ("error" in runtime) {
        const message = runtime.error ?? "记忆不可用";
        return { content: text(message), details: { error: message } };
      }

      let memoryId = params.memoryId?.trim();
      try {
        if (!memoryId && params.query?.trim()) {
          const result = await searchMemories({
            query: params.query,
            scopes: defaultScopes(ctx),
            projectKey: runtime.projectKey,
            topK: 1,
            threshold: runtime.settings.memory?.retrieval.threshold ?? 0.62,
            config: runtime.config,
          });
          memoryId = result.results[0]?.id;
        }

        if (!memoryId) {
          return {
            content: text("没有找到要忘记的记忆。请先检索并提供 memoryId。"),
            details: { error: "memory_not_found" },
          };
        }

        if (params.deletePermanently) {
          await deleteMemory({ id: memoryId });
          return {
            content: text(`已永久删除记忆：${memoryId}`),
            details: { id: memoryId, deleted: true },
          };
        }

        const result = await archiveMemory({ id: memoryId, archived: true });
        return {
          content: text(`已关闭记忆：${result.memory.content}`),
          details: { memory: result.memory },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "未知错误";
        return {
          content: text(`忘记记忆失败: ${message}`),
          details: { error: message },
        };
      }
    },
  };
}
