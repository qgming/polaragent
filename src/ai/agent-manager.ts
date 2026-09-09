// Agent 管理器 —— 单一全局运行时，基于 pi-agent-core 0.85.1 AgentHarness
// src/ai/agent-manager.ts
//
// 生命周期模型：每个对话线程(threadId)对应一个 AgentHarness 实例，绑定该线程的
// pi Session（jsonl 持久化）。切换/删除会话即创建/销毁对应 harness。
// 不再按助手路由：统一使用默认 Provider/Model，系统提示来自 AGENTS.md + 项目提示词。

import {
  AgentHarness,
  BACKGROUND_CONTEXT,
  type AgentHarnessTool,
} from "@earendil-works/pi-agent-core";
import { formatSkillsForSystemPrompt } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import {
  requireModelService,
  resolveRuntimeModelId,
} from "./model-router";
import { buildAgentTools, type ToolContext } from "./tools";
import { openOrCreateSession } from "@/lib/session/personal";
import { openOrCreateScheduleSession } from "@/lib/session/schedule";
import { useConfigStore } from "@/stores/config-store";
import { useToolsStore } from "@/stores/tools-store";
import { useChatStore } from "@/stores/chat-store";
import { resolveSkillSelection, skillLoader } from "@/lib/skill";
import { reviewToolPermission } from "./tool-permissions";
import { pMap, LOCAL_IO_CONCURRENCY } from "@/lib/concurrency";
import {
  DEFAULT_TOOL_PERMISSION_MODE,
  type ToolPermissionMode,
} from "@/types/permissions";
import { buildModelsFromConfigs, resetModelsCache } from "./pi-models";
import { loadAgentsMdContent } from "./agents-md";
import {
  registerSessionResourceCleanup,
  cleanupSessionResources,
} from "@earendil-works/pi-ai";

// 子代理上下文：delegate_task 启动的临时专家子会话
export interface SubagentContext {
  isSubagent: true;
  parentThreadId: string;
  sessionId: string;
  task: string;
  agentName?: string;
  systemPrompt?: string;
}

export interface ScheduleContext {
  isSchedule: true;
  sessionId?: string;
}

interface CachedHarness {
  promise: Promise<AgentHarness>;
  configSignature: string;
  toolsRuntimeSignature: string;
  workingDirSignature: string;
}

function harnessBelongsToThread(key: string, threadId: string): boolean {
  return key.startsWith(`${threadId}::`) || key.startsWith(`${threadId}__`);
}

function normalizeWorkingDir(dir?: string): string {
  return (dir ?? "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
}

function isThreadRunning(threadId: string): boolean {
  const chatRunning = useChatStore.getState().runningThreadIds;
  return chatRunning.includes(threadId);
}

interface HarnessCreateOptions {
  workingDir?: string;
  permissionMode?: ToolPermissionMode;
  knowledgeBaseIds?: string[];
  subagentContext?: SubagentContext;
  scheduleContext?: ScheduleContext;
  projectId?: string;
  projectSystemPrompt?: string;
}

/**
 * Agent 管理器（单一全局运行时）
 */
export class AgentManager {
  // 按 scopedSessionId 缓存 harness
  private harnesses = new Map<string, CachedHarness>();
  private pendingCreations = new Map<string, Promise<AgentHarness>>();
  private registeredCleanupSessions = new Set<string>();

  /** 清空所有缓存的 harness（重新初始化运行时时调用）。 */
  clear() {
    for (const cached of this.harnesses.values()) {
      void cached.promise
        .then(async (harness) => {
          const lane = await harness.lane("main", BACKGROUND_CONTEXT);
          await lane.abort(BACKGROUND_CONTEXT);
        })
        .catch(() => undefined);
    }
    this.harnesses.clear();
    this.pendingCreations.clear();
    resetModelsCache();
  }

  getRuntimeModelId(): string {
    return resolveRuntimeModelId();
  }

  /**
   * 获取或创建某线程的 AgentHarness。
   */
  async getOrCreateHarness(
    threadId: string,
    options?: HarnessCreateOptions,
  ): Promise<AgentHarness> {
    const scopedSessionId =
      options?.subagentContext?.sessionId ??
      options?.scheduleContext?.sessionId ??
      threadId;
    const key = scopedSessionId;
    const configSignature = await runtimeConfigSignature(options?.subagentContext);
    const toolsRuntimeSignature = useToolsStore.getState().runtimeSignature;
    const workingDirSignature = JSON.stringify({
      dir: normalizeWorkingDir(options?.workingDir),
      permissionMode: options?.permissionMode ?? DEFAULT_TOOL_PERMISSION_MODE,
      knowledgeBaseIds: [...(options?.knowledgeBaseIds ?? [])].sort(),
      projectId: options?.projectId ?? "",
      projectSystemPrompt: options?.projectSystemPrompt ?? "",
    });

    // 1. 已创建完成：检查缓存并校验签名
    const cached = this.harnesses.get(key);
    if (cached) {
      if (
        cached.configSignature === configSignature &&
        cached.toolsRuntimeSignature === toolsRuntimeSignature &&
        cached.workingDirSignature === workingDirSignature
      ) {
        return cached.promise;
      }

      if (!isThreadRunning(threadId)) {
        void cached.promise
          .then(async (harness) => {
            const lane = await harness.lane("main", BACKGROUND_CONTEXT);
            await lane.abort(BACKGROUND_CONTEXT);
          })
          .catch(() => undefined);
      }
      this.harnesses.delete(key);
    }

    // 2. 正在创建中：复用 Pending Promise
    const pending = this.pendingCreations.get(key);
    if (pending) {
      return pending;
    }

    // 3. 开始创建
    const createPromise = this.createHarness(threadId, options)
      .then((harness) => {
        this.harnesses.set(key, {
          promise: Promise.resolve(harness),
          configSignature,
          toolsRuntimeSignature,
          workingDirSignature,
        });
        this.pendingCreations.delete(key);
        return harness;
      })
      .catch((err) => {
        this.pendingCreations.delete(key);
        throw err;
      });

    this.pendingCreations.set(key, createPromise);
    return createPromise;
  }

  private async createHarness(
    threadId: string,
    options?: HarnessCreateOptions,
  ): Promise<AgentHarness> {
    const service = requireModelService();
    const model = service.model;

    const subagentContext = options?.subagentContext;
    const scheduleContext = options?.scheduleContext;

    // 技能：全局启用的技能全部可用（不再按助手过滤）
    const allSkillIds = skillLoader.getEnabledSkills().map((skill) => skill.id);
    const mergedSkillIds = resolveSkillSelection(["*"], allSkillIds);
    const skills = skillLoader.toPiSkills(mergedSkillIds);

    // 异步检测 Computer Use 与 Browser Use 运行状态
    const [computerHealthResult, browserStatusResult] = await Promise.allSettled([
      window.polaragent?.computeruse?.health?.() ?? Promise.reject(new Error("unavailable")),
      window.polaragent?.browseruse?.status?.() ?? Promise.reject(new Error("unavailable")),
    ]);
    const computerUseAvailable =
      computerHealthResult.status === "fulfilled"
        ? Boolean(computerHealthResult.value?.ok)
        : undefined;
    const browserExtensionConnected =
      browserStatusResult.status === "fulfilled"
        ? Boolean(browserStatusResult.value?.connected)
        : undefined;

    const scopedSessionId =
      subagentContext?.sessionId ?? scheduleContext?.sessionId ?? threadId;

    const toolCtx: ToolContext = {
      threadId,
      projectId: options?.projectId,
      workingDir: options?.workingDir,
      permissionMode: options?.permissionMode ?? DEFAULT_TOOL_PERMISSION_MODE,
      isSubagent: !!subagentContext,
      parentThreadId: subagentContext?.parentThreadId,
      isBackground: !!scheduleContext,
      skills,
      knowledgeBaseIds: options?.knowledgeBaseIds,
      computerUseAvailable,
      browserExtensionConnected,
    };
    const tools = buildAgentTools(toolCtx);

    const [session, models, agentsMd] = await Promise.all([
      scheduleContext
        ? openOrCreateScheduleSession(scopedSessionId)
        : openOrCreateSession(scopedSessionId),
      Promise.resolve(
        buildModelsFromConfigs(useConfigStore.getState().providers.providers),
      ),
      loadAgentsMdContent(),
    ]);

    const skillsBlock = [
      formatSkillsForSystemPrompt(skills),
      skills.length > 0
        ? "需要使用某个技能时，请先调用 list_skills 确认可用技能，再调用 read_skill 读取该技能完整说明和目录树；如需读取 references、examples 或其他子文件，请继续调用 read_skill_file。不要用 read_file 直接读取技能文件。"
        : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    const memoryBlock = useConfigStore.getState().settings.memory?.enabled
      ? "你可以使用 search_memory 检索长期记忆。当用户偏好、身份画像、历史纠正、长期目标或当前项目约定可能影响回答时，请主动调用该工具；不要假设记忆会自动出现在提示词中。用户要求记住或忘记信息时，可分别使用 remember_memory 或 forget_memory。"
      : "";
    const projectPrompt = options?.projectSystemPrompt?.trim() || "";
    const subagentRolePrompt = subagentContext?.systemPrompt?.trim() || "";
    const delegationBlock = subagentContext
      ? [
          `你是由主对话助手临时调用的子代理${subagentContext.agentName ? `「${subagentContext.agentName}」` : ""}。主会话 ID：${subagentContext.parentThreadId}。`,
          `你的任务：${subagentContext.task}`,
          "专注完成该任务，给出可直接交给主助手使用的结论、证据、变更摘要或风险点。不要再次调用 delegate_task。",
        ].join("\n")
      : "当用户任务包含多步骤调研、代码审查、方案对比、实现拆分、测试验证或需要专业视角时，你应主动调用 delegate_task 创建临时子代理处理清晰子任务。可提供 temporaryAgentName 与 temporarySystemPrompt 描述子代理角色。主助手保留最终答复权，整合子代理结果后再回复用户；简单闲聊或单步问题不必委派。";

    const promptParts = [
      delegationBlock,
      subagentRolePrompt,
      agentsMd,
      projectPrompt,
      skillsBlock,
      memoryBlock,
    ];
    const systemPrompt = promptParts
      .map((part) => part?.trim())
      .filter((part): part is string => !!part)
      .join("\n\n");

    // pi 0.85: AgentHarness 通过静态 create 创建，tools 为原生 AgentHarnessTool，
    // toolContext 由 harness 在 execute 时注入。
    const { harness } = await AgentHarness.create(
      {
        session,
        models,
        model: model as Model<any>,
        tools: tools as AgentHarnessTool<ToolContext>[],
        toolContext: toolCtx,
        resources: { skills },
        systemPrompt,
      },
      BACKGROUND_CONTEXT,
    );

    await harness.setStreamOptions(
      {
        cacheRetention: "short",
        metadata: {
          sessionId: scopedSessionId,
        },
      },
      BACKGROUND_CONTEXT,
    );

    harness.hooks.on("before_tool", async (event) => {
      const decision = await reviewToolPermission({
        requesterName: subagentContext?.agentName ?? "助手",
        threadId,
        toolName: event.toolName,
        input: event.args as Record<string, unknown>,
        permissionMode: toolCtx.permissionMode,
        workingDir: options?.workingDir,
      });
      return decision.allow
        ? undefined
        : {
            block: {
              reason: decision.reason ?? "工具调用未通过权限审查。",
            },
          };
    });

    harness.hooks.on("before_compaction", (event) => {
      console.log(`[压缩] 会话 ${scopedSessionId} 即将压缩`, {
        source: event.reason === "manual" ? "manual" : "auto",
        tokensBefore: event.preparation?.tokensBefore,
      });
      return undefined;
    });

    if (!this.registeredCleanupSessions.has(scopedSessionId)) {
      this.registeredCleanupSessions.add(scopedSessionId);
      registerSessionResourceCleanup(() => {
        console.log(`[资源清理] 会话 ${scopedSessionId} 资源已释放`);
      });
    }

    return harness;
  }

  /** 销毁某线程的 harness */
  disposeThread(threadId: string): void {
    for (const [key, cached] of this.harnesses.entries()) {
      if (harnessBelongsToThread(key, threadId)) {
        void cached.promise
          .then(async (harness) => {
            const lane = await harness.lane("main", BACKGROUND_CONTEXT);
            await lane.abort(BACKGROUND_CONTEXT);
          })
          .catch(() => undefined);
        this.harnesses.delete(key);
        this.pendingCreations.delete(key);
        cleanupSessionResources(key);
        this.registeredCleanupSessions.delete(key);
      }
    }
  }

  /** 中止某个线程当前正在运行的 harness */
  abortThread(threadId: string): void {
    for (const [key, cached] of this.harnesses.entries()) {
      if (harnessBelongsToThread(key, threadId)) {
        void cached.promise
          .then(async (harness) => {
            const lane = await harness.lane("main", BACKGROUND_CONTEXT);
            await lane.abort(BACKGROUND_CONTEXT);
          })
          .catch(() => undefined);
      }
    }
  }

  /** 向指定线程插入 steering 消息 */
  async steerThread(threadId: string, text: string): Promise<number> {
    const targets = Array.from(this.harnesses.entries()).filter(([key]) =>
      harnessBelongsToThread(key, threadId),
    );
    let accepted = 0;
    await pMap(
      targets,
      async ([, cached]) => {
        try {
          const harness = await cached.promise;
          const lane = await harness.lane("main", BACKGROUND_CONTEXT);
          await lane.steer(text, undefined, BACKGROUND_CONTEXT);
          accepted += 1;
        } catch {
          // idle harness 忽略
        }
      },
      { concurrency: LOCAL_IO_CONCURRENCY },
    );
    return accepted;
  }

  /** 向指定线程追加 followUp 消息 */
  async followUpThread(threadId: string, text: string): Promise<number> {
    const targets = Array.from(this.harnesses.entries()).filter(([key]) =>
      harnessBelongsToThread(key, threadId),
    );
    let accepted = 0;
    await pMap(
      targets,
      async ([, cached]) => {
        try {
          const harness = await cached.promise;
          const lane = await harness.lane("main", BACKGROUND_CONTEXT);
          await lane.followUp(text, undefined, BACKGROUND_CONTEXT);
          accepted += 1;
        } catch {
          // idle harness 忽略
        }
      },
      { concurrency: LOCAL_IO_CONCURRENCY },
    );
    return accepted;
  }

  /** 排队下一轮附加用户消息 */
  async nextTurnThread(threadId: string, text: string): Promise<number> {
    const targets = Array.from(this.harnesses.entries()).filter(([key]) =>
      harnessBelongsToThread(key, threadId),
    );
    let accepted = 0;
    await pMap(
      targets,
      async ([, cached]) => {
        try {
          const harness = await cached.promise;
          const lane = await harness.lane("main", BACKGROUND_CONTEXT);
          await lane.nextRun(text, undefined, BACKGROUND_CONTEXT);
          accepted += 1;
        } catch {
          // 忽略已销毁的 harness
        }
      },
      { concurrency: LOCAL_IO_CONCURRENCY },
    );
    return accepted;
  }

  /** 中止所有线程当前正在运行的 harness */
  abortAll(): void {
    for (const cached of this.harnesses.values()) {
      void cached.promise
        .then(async (harness) => {
          const lane = await harness.lane("main", BACKGROUND_CONTEXT);
          await lane.abort(BACKGROUND_CONTEXT);
        })
        .catch(() => undefined);
    }
  }
}

async function runtimeConfigSignature(
  subagentContext?: SubagentContext,
): Promise<string> {
  const state = useConfigStore.getState();
  const service = requireModelService();
  const agentsMd = await loadAgentsMdContent();

  return JSON.stringify({
    providerId: service.provider.id,
    providerType: service.provider.type,
    baseURL: service.provider.baseURL,
    apiKey: service.provider.apiKey,
    modelId: service.model.id,
    agentsMd,
    memoryEnabled: state.settings.memory?.enabled ?? false,
    projectMemoryEnabled: state.settings.memory?.projectMemoryEnabled ?? false,
    subagent: Boolean(subagentContext),
    subagentName: subagentContext?.agentName ?? "",
    subagentSystemPrompt: subagentContext?.systemPrompt ?? "",
  });
}

// 导出单例
export const agentManager = new AgentManager();
