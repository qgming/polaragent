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
      const threshold = configured.retrieval.threshold;

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
            return `### ${index + 1}. ${formatScope(memory.scope)} / ${formatMemoryType(memory.type)} / ${memory.score.toFixed(3)}\nID: ${memory.id}${tags}\n\n${memory.content}`;
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
      try {
        const result = await createMemory({
          memory: {
            content: params.content,
            type,
            scope,
            projectKey: scope === "project" ? runtime.projectKey : undefined,
            sourceThreadId: ctx.threadId,
            confidence: 1,
            tags: params.tags ?? [],
          },
          config: runtime.config,
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
