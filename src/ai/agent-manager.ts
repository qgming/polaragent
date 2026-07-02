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
import type { AgentConfig, TeamConfig } from "@/types/config";
import {
  firstModelService,
  requireModelService,
  resolveModelService,
  resolveRuntimeModelId,
} from "./model-router";
import { buildAgentTools, type ToolContext } from "./tools";
import { openOrCreateSession } from "@/lib/session/personal";
import { openOrCreateTeamSession } from "@/lib/session/team";
import { getExecutionEnv } from "@/lib/session/session-repo";
import { useConfigStore } from "@/stores/config-store";
import { useToolsStore } from "@/stores/tools-store";
import { useChatStore } from "@/stores/chat-store";
import { useTeamChatStore } from "@/stores/team/team-chat-store";
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

// 团队上下文：成员发言时叠加到该成员自身配置之上。
export interface TeamContext {
  // 用团队会话仓库打开 session（teams/conversations），而非普通对话仓库
  isTeam: true;
  // 团队级技能：并入该成员启用的技能（即使成员自身未启用）
  extraSkillIds: string[];
  // 团队整体系统提示词（叠加到成员 systemPrompt 之后）
  teamSystemPrompt: string;
  // 身份前缀（「你是 X，团队成员有 …，发言请用第一人称」），置于系统提示词最前
  identityPrefix: string;
  // 该成员在团队会话里的独立 session id（每成员一个文件，互不污染历史）。
  // 缺省时回退到 threadId（旧行为）。
  sessionId?: string;
  // 团队投票工具上下文。存在时会把 request_team_vote 注入给当前成员。
  teamConfig?: TeamConfig;
  currentAgentId?: string;
  members?: AgentConfig[];
  // 团队投票收集阶段：后台要求当前成员必须调用 cast_team_vote 落票。
  voteCasting?: {
    voteId: string;
    voterId: string;
    options: Array<{ id: string; label: string }>;
    onCast: (optionId: string) => void;
  };
  // 团队会话选中的知识库 ID 列表
  knowledgeBaseIds?: string[];
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

// 判断某线程当前是否正在运行（普通会话或团队会话）。
// 用于配置变更时决定是否 abort 旧 harness：运行中则不 abort，避免打断在途响应。
function isThreadRunning(threadId: string, sessionId?: string): boolean {
  const chatRunning = useChatStore.getState().runningThreadIds;
  const teamRunning = useTeamChatStore.getState().runningThreadIds;
  return (
    chatRunning.includes(threadId) ||
    teamRunning.includes(threadId) ||
    (sessionId ? teamRunning.includes(sessionId) : false)
  );
}

function runtimeConfigSignature(agentId: string, teamContext?: TeamContext): string {
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
    teamSystemPrompt: teamContext?.teamSystemPrompt ?? "",
    teamExtraSkills: teamContext?.extraSkillIds ?? [],
    teamVoteCasting: Boolean(teamContext?.voteCasting),
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
      teamContext?: TeamContext;
      projectSystemPrompt?: string;
    },
  ): Promise<AgentHarness> {
    const key = harnessKey(options?.teamContext?.sessionId ?? threadId, agentId);
    const configSignature = runtimeConfigSignature(agentId, options?.teamContext);
    const toolsRuntimeSignature = useToolsStore.getState().runtimeSignature;
    const workingDirSignature = JSON.stringify({
      dir: normalizeWorkingDir(options?.workingDir),
      permissionMode: options?.permissionMode ?? DEFAULT_TOOL_PERMISSION_MODE,
      knowledgeBaseIds: [...(options?.knowledgeBaseIds ?? [])].sort(),
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
      if (!isThreadRunning(threadId, options?.teamContext?.sessionId)) {
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
      teamContext?: TeamContext;
      projectSystemPrompt?: string;
    },
  ): Promise<AgentHarness> {
    // 解析 Agent 配置（优先用户配置）
    const agentConfig = useConfigStore
      .getState()
      .agents.find((item) => item.id === agentId);

    const service = requireModelService(agentId);
    const model = service.model;

    const teamContext = options?.teamContext;
    const requesterName = teamContext
      ? (agentConfig?.name ?? "团队成员")
      : (agentConfig?.name ?? "助手");

    // 渐进式披露：把该 Agent 启用的技能转成 pi 的 Skill，
    // 在系统提示里仅列「清单 + 文件位置」（不塞全文），
    // AI 判断任务匹配某技能时，可用 list_skills/read_skill 读取全文。
    // 团队模式下并入团队级技能（对全员可用），去重。
    const ownSkillIds = agentConfig?.config.enabledSkills ?? [];
    const rawSkillIds = teamContext
      ? Array.from(new Set([...ownSkillIds, ...teamContext.extraSkillIds]))
      : ownSkillIds;
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

    // 装配工具（全局工具，受工具页开关过滤;团队投票工具仅团队上下文可见）。
    const toolCtx: ToolContext = {
      threadId,
      workingDir: options?.workingDir,
      permissionMode: options?.permissionMode ?? DEFAULT_TOOL_PERMISSION_MODE,
      isTeam: !!teamContext,
      requester: {
        id: agentId,
        name: requesterName,
      },
      skills,
      knowledgeBaseIds: options?.knowledgeBaseIds,
      teamVote:
        !teamContext?.voteCasting &&
        teamContext?.teamConfig &&
        teamContext.currentAgentId
          ? {
              team: teamContext.teamConfig,
              initiatorId: teamContext.currentAgentId,
            }
          : undefined,
      teamFlow:
        !teamContext?.voteCasting &&
        teamContext?.teamConfig &&
        teamContext.currentAgentId &&
        teamContext.members
          ? {
              threadId,
              team: teamContext.teamConfig,
              currentAgentId: teamContext.currentAgentId,
              members: teamContext.members,
            }
          : undefined,
      teamCastVote: teamContext?.voteCasting,
      computerUseAvailable,
      browserExtensionConnected,
    };
    const tools = buildAgentTools(toolCtx);

    const teamSessionId = teamContext?.sessionId ?? threadId;
    const [session, env, models] = await Promise.all([
      teamContext
        ? openOrCreateTeamSession(teamSessionId)
        : openOrCreateSession(threadId),
      getExecutionEnv(),
      Promise.resolve(
        buildModelsFromConfigs(useConfigStore.getState().providers.providers),
      ),
    ]);

    const basePrompt = agentConfig?.config.systemPrompt ?? "";
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
    // 团队模式：身份前缀 + 成员自身提示词 + 团队整体提示词 + 技能清单，依次拼接。
    // 项目提示词：在 basePrompt 之后、技能清单之前注入
    const projectPrompt = options?.projectSystemPrompt?.trim() || "";
    const promptParts = teamContext
      ? [
          teamContext.identityPrefix,
          basePrompt,
          projectPrompt,
          teamContext.teamSystemPrompt,
          skillsBlock,
          memoryBlock,
        ]
      : [basePrompt, projectPrompt, skillsBlock, memoryBlock];
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
        sessionId: teamContext?.sessionId || threadId,
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
        isTeam: !!teamContext,
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
      const tokensBefore = event.compactionEntry.tokensBefore;
      const source = event.fromHook ? "hook" : "auto";
      console.log(
        `[压缩] 会话 ${teamSessionId} 压缩完成: ${tokensBefore} tokens → summary (来源: ${source})`,
      );
      return undefined;
    });

    // 注册会话级资源清理回调（0.80 新增：session-resources 模块）
    // disposeThread / abortThread 时调 cleanupSessionResources 触发清理
    const sessionId = teamSessionId;
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
