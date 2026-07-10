// Agent 管理器 —— 基于 @earendil-works/pi-agent-core 的 AgentHarness
// src/ai/agent-manager.ts
//
// 生命周期模型：每个对话线程(threadId)对应一个 AgentHarness 实例，绑定该线程的
// pi Session（jsonl 持久化）。切换/删除会话即创建/销毁对应 harness。
//
// 另外保留各 Agent 的「运行时配置」(provider/model/systemPrompt 等)，
// 供标题生成等不走 harness 的轻量场景查询。

import { AgentHarness } from "@earendil-works/pi-agent-core";
import { formatSkillsForSystemPrompt } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import type { AgentConfig } from "@/types/config";
import {
  firstModelService,
  requireModelService,
  resolveModelService,
  resolveRuntimeModelId,
} from "./model-router";
import { buildAgentTools, type ToolContext } from "./tools";
import { openOrCreateSession } from "@/lib/session/personal";
import { openOrCreateScheduleSession } from "@/lib/session/schedule";
import { getExecutionEnv } from "@/lib/session/session-repo";
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
import {
  registerSessionResourceCleanup,
  cleanupSessionResources,
} from "@earendil-works/pi-ai";

// 子代理上下文：普通对话通过 delegate_task 启动的专家子会话。
export interface SubagentContext {
  isSubagent: true;
  parentThreadId: string;
  parentAgentId: string;
  sessionId: string;
  task: string;
  agentName?: string;
  systemPrompt?: string;
}

export interface ScheduleContext {
  isSchedule: true;
  sessionId?: string;
}

export interface RuntimeAgentConfig {
  id: string;
  providerId: string;
  baseURL: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
  enabledSkills: string[];
}

interface CachedHarness {
  promise: Promise<AgentHarness>;
  configSignature: string;
  toolsRuntimeSignature: string;
  workingDirSignature: string;
}

// 缓存的 harness 实例的复合键：threadId::agentId
function harnessKey(sessionId: string, agentId: string): string {
  return `${sessionId}::${agentId}`;
}

function harnessBelongsToThread(key: string, threadId: string): boolean {
  return key.startsWith(`${threadId}::`) || key.startsWith(`${threadId}__`);
}

function normalizeWorkingDir(dir?: string): string {
  return (dir ?? "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
}

// 判断某线程当前是否正在运行（普通会话）。
// 用于配置变更时决定是否 abort 旧 harness：运行中则不 abort，避免打断在途响应。
function isThreadRunning(threadId: string): boolean {
  const chatRunning = useChatStore.getState().runningThreadIds;
  return chatRunning.includes(threadId);
}

function runtimeConfigSignature(agentId: string, subagentContext?: SubagentContext): string {
  const state = useConfigStore.getState();
  const agent = state.agents.find((item) => item.id === agentId);
  const lockedProviderId = agent?.config.provider?.trim() || "";
  const lockedModelId = agent?.config.model?.trim() || "";
  const service = resolveModelService(agentId);

  return JSON.stringify({
    agentId,
    lockedProviderId,
    lockedModelId,
    providerId: service?.provider.id ?? "",
    providerType: service?.provider.type ?? "",
    baseURL: service?.provider.baseURL ?? "",
    apiKey: service?.provider.apiKey ?? "",
    modelId: service?.model.id ?? "",
    systemPrompt: agent?.config.systemPrompt ?? "",
    enabledSkills: agent?.config.enabledSkills ?? [],
    memoryEnabled: state.settings.memory?.enabled ?? false,
    projectMemoryEnabled: state.settings.memory?.projectMemoryEnabled ?? false,
    subagent: Boolean(subagentContext),
    subagentName: subagentContext?.agentName ?? "",
    subagentSystemPrompt: subagentContext?.systemPrompt ?? "",
  });
}

/**
 * Agent 管理器
 */
export class AgentManager {
  // 按 threadId::agentId 缓存 harness（异步创建，先存 Promise 防并发重复构造）
  private harnesses = new Map<string, CachedHarness>();
  // 缓存正在创建中的 harness Promise，防止并发重复创建（竞态保护）
  private pendingCreations = new Map<string, Promise<AgentHarness>>();
  private configs = new Map<string, RuntimeAgentConfig>();
  private registeredCleanupSessions = new Set<string>();

  /** 清空所有缓存的 harness 与配置（重新初始化运行时时调用）。 */
  clear() {
    for (const cached of this.harnesses.values()) {
      void cached.promise.then((harness) => harness.abort()).catch(() => undefined);
    }
    this.harnesses.clear();
    this.pendingCreations.clear(); // 清理正在创建中的Promise，防止泄漏
    this.configs.clear();
    resetModelsCache();
  }

  getRuntimeModelId(agentId: string): string {
    return resolveRuntimeModelId(agentId);
  }

  /**
   * 登记某个 Agent 的运行时配置（不创建 harness，仅记录 provider/model 等）。
   * 在应用初始化时为每个 Agent 调用一次。
   */
  registerAgentConfig(config: AgentConfig): void {
    const service = resolveModelService(config.id);
    if (!service) {
      // 无可用 provider 时不登记；发送时会再行兜底报错
      return;
    }

    this.configs.set(config.id, {
      id: config.id,
      providerId: service.provider.id,
      baseURL: service.provider.baseURL,
      apiKey: service.provider.apiKey,
      model: service.model.id,
      systemPrompt: config.config.systemPrompt,
      enabledSkills: config.config.enabledSkills ?? [],
    });
  }

  /**
   * 获取或创建某线程的 AgentHarness。
   * harness 绑定该线程的 pi Session，会话上下文由 session 原生管理。
   */
  async getOrCreateHarness(
    threadId: string,
    agentId: string,
    options?: {
      workingDir?: string;
      permissionMode?: ToolPermissionMode;
      knowledgeBaseIds?: string[];
      subagentContext?: SubagentContext;
      scheduleContext?: ScheduleContext;
      projectId?: string;
      projectSystemPrompt?: string;
    },
  ): Promise<AgentHarness> {
    const scopedSessionId =
      options?.subagentContext?.sessionId ?? options?.scheduleContext?.sessionId ?? threadId;
    const key = harnessKey(scopedSessionId, agentId);
    const configSignature = runtimeConfigSignature(agentId, options?.subagentContext);
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

      // 模型配置、工具目录或工作目录已经变化。旧 harness 的 model / 工具上下文是创建时固定的；
      // 重新打开同一个 pi Session 可保留历史并装配最新运行时配置。
      // 仅在该会话当前无在途 run 时才 abort 旧 harness：若正在响应中直接 abort 会让
      // 在途请求抛错且无 UI 反馈，这里只移除缓存引用，让在途 run 自然结束后被 GC。
      if (!isThreadRunning(threadId)) {
        void cached.promise.then((harness) => harness.abort()).catch(() => undefined);
      }
      this.harnesses.delete(key);
    }

    // 2. 正在创建中：复用Pending Promise
    const pending = this.pendingCreations.get(key);
    if (pending) {
      return pending;
    }

    // 3. 开始创建：包装Promise并缓存到pendingCreations
    const createPromise = this.createHarness(threadId, agentId, options)
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
        this.pendingCreations.delete(key); // 错误时清理避免死锁
        throw err;
      });

    this.pendingCreations.set(key, createPromise);
    return createPromise;
  }

  private async createHarness(
    threadId: string,
    agentId: string,
    options?: {
      workingDir?: string;
      permissionMode?: ToolPermissionMode;
      knowledgeBaseIds?: string[];
      subagentContext?: SubagentContext;
      scheduleContext?: ScheduleContext;
      projectId?: string;
      projectSystemPrompt?: string;
    },
  ): Promise<AgentHarness> {
    // 解析 Agent 配置（优先用户配置）
    const agentConfig = useConfigStore
      .getState()
      .agents.find((item) => item.id === agentId);

    const service = requireModelService(agentId);
    const model = service.model;

    const subagentContext = options?.subagentContext;
    const scheduleContext = options?.scheduleContext;
    const requesterName = subagentContext?.agentName ?? agentConfig?.name ?? "助手";

    // 渐进式披露：把该 Agent 启用的技能转成 pi 的 Skill，
    // 在系统提示里仅列「清单 + 文件位置」（不塞全文），
    // AI 判断任务匹配某技能时，可用 list_skills/read_skill 读取全文。
    const ownSkillIds = agentConfig?.config.enabledSkills ?? [];
    const rawSkillIds = ownSkillIds;
    const allSkillIds = skillLoader.getEnabledSkills().map((skill) => skill.id);
    const mergedSkillIds = resolveSkillSelection(rawSkillIds, allSkillIds);
    const skills = skillLoader.toPiSkills(mergedSkillIds);

    // 异步检测 Computer Use 与 Browser Use 运行状态，用于按需装配对应工具组
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

    // 装配工具（全局工具，受工具页开关过滤）。
    const toolCtx: ToolContext = {
      threadId,
      projectId: options?.projectId,
      workingDir: options?.workingDir,
      permissionMode: options?.permissionMode ?? DEFAULT_TOOL_PERMISSION_MODE,
      isSubagent: !!subagentContext,
      parentThreadId: subagentContext?.parentThreadId,
      parentAgentId: subagentContext?.parentAgentId,
      isBackground: !!scheduleContext,
      requester: {
        id: agentId,
        name: requesterName,
      },
      skills,
      knowledgeBaseIds: options?.knowledgeBaseIds,
      computerUseAvailable,
      browserExtensionConnected,
    };
    const tools = buildAgentTools(toolCtx);

    const scopedSessionId = subagentContext?.sessionId ?? scheduleContext?.sessionId ?? threadId;
    const [session, env, models] = await Promise.all([
      scheduleContext
          ? openOrCreateScheduleSession(scopedSessionId)
          : openOrCreateSession(scopedSessionId),
      getExecutionEnv(),
      Promise.resolve(
        buildModelsFromConfigs(useConfigStore.getState().providers.providers),
      ),
    ]);

    const basePrompt = subagentContext?.systemPrompt?.trim() || agentConfig?.config.systemPrompt || "";
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
    // 项目提示词：在 basePrompt 之后、技能清单之前注入
    const projectPrompt = options?.projectSystemPrompt?.trim() || "";
    const delegationBlock = subagentContext
      ? [
          `你是由主对话助手临时调用的子代理${subagentContext.agentName ? `「${subagentContext.agentName}」` : ""}。主会话 ID：${subagentContext.parentThreadId}。`,
          `你的任务：${subagentContext.task}`,
          "专注完成该任务，给出可直接交给主助手使用的结论、证据、变更摘要或风险点。不要再次调用 delegate_task。",
        ].join("\n")
      : "当用户任务包含多步骤调研、代码审查、方案对比、实现拆分、测试验证或需要专业视角时，你应主动调用 delegate_task 委派给合适的子代理。未指定目标时 delegate_task 会使用默认助手 default/Cowork；若需要专业助手，先调用 list_agents 查看清单再显式传 agentId/agentName；若清单里没有合适角色，传 temporaryAgentName 与 temporarySystemPrompt 创建临时子代理。主助手保留最终答复权，整合子代理结果后再回复用户；简单闲聊或单步问题不必委派。";
    const promptParts = [delegationBlock, basePrompt, projectPrompt, skillsBlock, memoryBlock];
    const systemPrompt = promptParts
      .map((part) => part?.trim())
      .filter((part): part is string => !!part)
      .join("\n\n");

    const harness = new AgentHarness({
      env,
      session,
      models,
      model: model as Model<any>,
      tools,
      resources: { skills },
      systemPrompt,
    });

    // 启用 Prompt Caching
    harness.setStreamOptions({
      cacheRetention: "short",
      metadata: {
        sessionId: scopedSessionId,
      },
    });

    harness.on("tool_call", async (event) => {
      const decision = await reviewToolPermission({
        agentId,
        requesterName,
        threadId,
        toolName: event.toolName,
        input: event.input,
        permissionMode: toolCtx.permissionMode,
        workingDir: options?.workingDir,
      });
      return decision.allow
        ? undefined
        : {
            block: true,
            reason: decision.reason ?? "工具调用未通过权限审查。",
          };
    });

    // 监听压缩事件：压缩完成时记录日志（0.79.10+ 新增 fromHook 标识）
    harness.on("session_compact", (event) => {
      const entry = event.compactionEntry;
      const source = event.fromHook ? "hook" : "auto";
      console.log(
        `[压缩] 会话 ${scopedSessionId} 压缩完成`,
        {
          source,
          tokensBefore: entry.tokensBefore,
          summaryLength: entry.summary?.length ?? 0,
          firstKeptEntryId: entry.firstKeptEntryId,
          timestamp: new Date(entry.timestamp).toISOString(),
        },
      );
      return undefined;
    });

    // 注册会话级资源清理回调（0.80 新增：session-resources 模块）
    // disposeThread / abortThread 时调 cleanupSessionResources 触发清理
    const sessionId = scopedSessionId;
    if (!this.registeredCleanupSessions.has(sessionId)) {
      this.registeredCleanupSessions.add(sessionId);
      registerSessionResourceCleanup(() => {
        console.log(`[资源清理] 会话 ${sessionId} 资源已释放`);
      });
    }

    return harness;
  }

  /** 销毁某线程的 harness（切换/删除会话时调用）。 */
  disposeThread(threadId: string): void {
    for (const [key, cached] of this.harnesses.entries()) {
      if (harnessBelongsToThread(key, threadId)) {
        void cached.promise.then((harness) => harness.abort()).catch(() => undefined);
        this.harnesses.delete(key);
        // 同时清理可能正在创建中的Promise
        this.pendingCreations.delete(key);
        // 触发会话级资源清理（0.80 session-resources）
        cleanupSessionResources(key.split("::")[0]);
        this.registeredCleanupSessions.delete(key.split("::")[0]);
      }
    }
  }

  /** 中止某个线程当前正在运行的 harness（仅影响该线程，其它并行会话不受影响）。 */
  abortThread(threadId: string): void {
    for (const [key, cached] of this.harnesses.entries()) {
      if (harnessBelongsToThread(key, threadId)) {
        void cached.promise.then((harness) => harness.abort()).catch(() => undefined);
      }
    }
  }

  /**
   * 向指定线程当前正在运行的 harness 插入 steering 消息。
   * 返回实际接收消息的 harness 数量；idle harness 会被跳过。
   */
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
          await harness.steer(text);
          accepted += 1;
        } catch {
          // steer() requires a running harness; idle or already-settled harnesses are ignored.
        }
      },
      { concurrency: LOCAL_IO_CONCURRENCY },
    );
    return accepted;
  }

  /**
   * 向指定线程当前正在运行的 harness 追加后续消息。
   * followUp 会在当前 run 没有更多工具与 steering 消息后执行，适合“做完当前任务后继续处理这句”。
   */
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
          await harness.followUp(text);
          accepted += 1;
        } catch {
          // followUp() requires a running harness; idle or already-settled harnesses are ignored.
        }
      },
      { concurrency: LOCAL_IO_CONCURRENCY },
    );
    return accepted;
  }

  /**
   * 排队下一轮附加用户消息。nextTurn 可在 idle 时调用，下一次 prompt 会先注入队列内容。
   */
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
          await harness.nextTurn(text);
          accepted += 1;
        } catch {
          // Ignore disposed or failed harnesses.
        }
      },
      { concurrency: LOCAL_IO_CONCURRENCY },
    );
    return accepted;
  }

  /** 中止所有线程当前正在运行的 harness。 */
  abortAll(): void {
    for (const cached of this.harnesses.values()) {
      void cached.promise.then((harness) => harness.abort()).catch(() => undefined);
    }
  }

  getAgentConfig(agentId: string): RuntimeAgentConfig | undefined {
    return this.configs.get(agentId);
  }

  getFirstAgentConfig(): RuntimeAgentConfig | undefined {
    const cached = this.configs.values().next().value;
    if (cached) return cached;
    const service = firstModelService();
    if (!service) return undefined;
    return {
      id: "default",
      providerId: service.provider.id,
      baseURL: service.provider.baseURL,
      apiKey: service.provider.apiKey,
      model: service.model.id,
      systemPrompt: "",
      enabledSkills: [],
    };
  }
}

// 导出单例
export const agentManager = new AgentManager();
