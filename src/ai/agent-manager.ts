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
import { providerManager } from "./providers";
import { buildAgentTools, type ToolContext } from "./tools";
import {
  openOrCreateSession,
  openOrCreateTeamSession,
} from "@/lib/session/session-operations";
import { getExecutionEnv } from "@/lib/session/session-repo";
import { useConfigStore } from "@/stores/config-store";
import { useToolsStore } from "@/stores/tools-store";
import { skillLoader } from "@/lib/skill/skill-loader";
import { resolveSkillSelection } from "@/lib/skill/skill-selection";

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

/**
 * Agent 管理器
 */
export class AgentManager {
  // 按 threadId::agentId 缓存 harness（异步创建，先存 Promise 防并发重复构造）
  private harnesses = new Map<string, CachedHarness>();
  private configs = new Map<string, RuntimeAgentConfig>();

  /** 清空所有缓存的 harness 与配置（重新初始化运行时时调用）。 */
  clear() {
    for (const cached of this.harnesses.values()) {
      void cached.promise.then((harness) => harness.abort()).catch(() => undefined);
    }
    this.harnesses.clear();
    this.configs.clear();
  }

  /**
   * 登记某个 Agent 的运行时配置（不创建 harness，仅记录 provider/model 等）。
   * 在应用初始化时为每个 Agent 调用一次。
   */
  registerAgentConfig(config: AgentConfig): void {
    let provider = providerManager.getProvider(config.config.provider);
    let usingDefaultProvider = false;
    if (!provider) {
      provider = providerManager.getDefaultProvider() ?? undefined;
      usingDefaultProvider = true;
    }
    if (!provider) {
      // 无可用 provider 时不登记；发送时会再行兜底报错
      return;
    }

    // agent 未指定模型时：回退到全局默认模型（仅当落在默认 provider 上）
    const wantedModel =
      config.config.model?.trim() ||
      (usingDefaultProvider ? providerManager.getDefaultModelId() : undefined);
    const model = provider.getModel(wantedModel);
    if (!model) {
      return;
    }

    this.configs.set(config.id, {
      id: config.id,
      providerId: provider.id,
      baseURL: provider.baseURL,
      apiKey: provider.apiKey,
      model: model.id,
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
    options?: { workingDir?: string; teamContext?: TeamContext },
  ): Promise<AgentHarness> {
    const key = harnessKey(options?.teamContext?.sessionId ?? threadId, agentId);
    const toolsRuntimeSignature = useToolsStore.getState().runtimeSignature;
    const workingDirSignature = normalizeWorkingDir(options?.workingDir);
    const cached = this.harnesses.get(key);
    if (cached) {
      if (
        cached.toolsRuntimeSignature === toolsRuntimeSignature &&
        cached.workingDirSignature === workingDirSignature
      ) {
        return cached.promise;
      }

      // 工具目录或工作目录已经变化。旧 harness 的工具列表/工具上下文是创建时固定的；
      // 重新打开同一个 pi Session 可保留历史并装配最新工具上下文。
      this.harnesses.delete(key);
    }

    const promise = this.createHarness(threadId, agentId, options);
    this.harnesses.set(key, {
      promise,
      toolsRuntimeSignature,
      workingDirSignature,
    });
    // 创建失败则移除缓存，避免后续一直拿到 rejected Promise
    promise.catch(() => this.harnesses.delete(key));
    return promise;
  }

  private async createHarness(
    threadId: string,
    agentId: string,
    options?: { workingDir?: string; teamContext?: TeamContext },
  ): Promise<AgentHarness> {
    // 解析 Agent 配置（优先用户配置）
    const agentConfig = useConfigStore
      .getState()
      .agents.find((item) => item.id === agentId);

    let provider = providerManager.getProvider(
      agentConfig?.config.provider ?? "",
    );
    let usingDefaultProvider = false;
    if (!provider) {
      provider = providerManager.getDefaultProvider() ?? undefined;
      usingDefaultProvider = true;
    }
    if (!provider) {
      throw new Error(
        "没有可用助手。请先在设置中保存 Base URL、API Key 和模型名称后再发送。",
      );
    }

    // agent 未指定模型时：回退到全局默认模型（仅当落在默认 provider 上）
    const wantedModel =
      agentConfig?.config.model?.trim() ||
      (usingDefaultProvider ? providerManager.getDefaultModelId() : undefined);
    const model = provider.getModel(wantedModel);
    if (!model) {
      throw new Error("请先在设置中配置模型名称");
    }

    const teamContext = options?.teamContext;
    const requesterName = teamContext
      ? (agentConfig?.name ?? "团队成员")
      : (agentConfig?.name ?? "助手");
    // 装配工具（全局工具，受工具页开关过滤；团队投票工具仅团队上下文可见）。
    const toolCtx: ToolContext = {
      threadId,
      workingDir: options?.workingDir,
      isTeam: !!teamContext,
      requester: {
        id: agentId,
        name: requesterName,
      },
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
    };
    const tools = buildAgentTools(toolCtx);

    const teamSessionId = teamContext?.sessionId ?? threadId;
    const [session, env] = await Promise.all([
      teamContext
        ? openOrCreateTeamSession(teamSessionId)
        : openOrCreateSession(threadId),
      getExecutionEnv(),
    ]);

    const apiKey = provider.apiKey;

    // 渐进式披露：把该 Agent 启用的技能转成 pi 的 Skill，
    // 在系统提示里仅列「清单 + 文件位置」（不塞全文），
    // AI 判断任务匹配某技能时，自行用 read_file 按 location 读取 SKILL.md 及其 references。
    // 团队模式下并入团队级技能（对全员可用），去重。
    const ownSkillIds = agentConfig?.config.enabledSkills ?? [];
    const rawSkillIds = teamContext
      ? Array.from(new Set([...ownSkillIds, ...teamContext.extraSkillIds]))
      : ownSkillIds;
    const allSkillIds = skillLoader.getEnabledSkills().map((skill) => skill.id);
    const mergedSkillIds = resolveSkillSelection(rawSkillIds, allSkillIds);
    const skills = skillLoader.toPiSkills(mergedSkillIds);
    const basePrompt = agentConfig?.config.systemPrompt ?? "";
    const skillsBlock = formatSkillsForSystemPrompt(skills);
    // 团队模式：身份前缀 + 成员自身提示词 + 团队整体提示词 + 技能清单，依次拼接。
    const promptParts = teamContext
      ? [
          teamContext.identityPrefix,
          basePrompt,
          teamContext.teamSystemPrompt,
          skillsBlock,
        ]
      : [basePrompt, skillsBlock];
    const systemPrompt = promptParts
      .map((part) => part?.trim())
      .filter((part): part is string => !!part)
      .join("\n\n");

    const harness = new AgentHarness({
      env,
      session,
      model: model as Model<any>,
      tools,
      resources: { skills },
      systemPrompt,
      getApiKeyAndHeaders: async (m) => ({
        apiKey,
        headers: m.headers,
      }),
    });

    return harness;
  }

  /** 销毁某线程的 harness（切换/删除会话时调用）。 */
  disposeThread(threadId: string): void {
    for (const [key, cached] of this.harnesses.entries()) {
      if (harnessBelongsToThread(key, threadId)) {
        void cached.promise.then((harness) => harness.abort()).catch(() => undefined);
        this.harnesses.delete(key);
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
    return this.configs.values().next().value;
  }
}

// 导出单例
export const agentManager = new AgentManager();
