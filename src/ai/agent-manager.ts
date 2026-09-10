// Agent 管理器 —— 单一全局运行时，基于 pi-agent-core AgentHarness
// src/ai/agent-manager.ts
//
// 生命周期模型：每个对话线程(threadId)对应一个 AgentHarness 实例，绑定该线程的
// pi Session（jsonl 持久化）。切换/删除会话即创建/销毁对应 harness。
// 工具面固定为 pisdk 原生四件套（bash/read/write/edit），执行环境由
// ElectronExecutionEnv（经 IPC 落到主进程安全层）提供。

import {
  AgentHarness,
  BACKGROUND_CONTEXT,
  type AgentHarnessTool,
} from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import {
  requireModelService,
  resolveRuntimeModelId,
} from "./model-router";
import { buildAgentTools, type ToolContext } from "./tools";
import { ElectronExecutionEnv } from "@/lib/electron/electron-fs";
import { openOrCreateSession } from "@/lib/session/personal";
import { useConfigStore } from "@/stores/config-store";
import { useChatStore } from "@/stores/chat-store";
import { reviewToolPermission } from "./tool-permissions";
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
}

/**
 * Agent 管理器（单一全局运行时）
 */
export class AgentManager {
  // 按 threadId 缓存 harness
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
    const key = threadId;
    const configSignature = await runtimeConfigSignature();
    const toolsRuntimeSignature = "native-4";
    const workingDirSignature = JSON.stringify({
      dir: normalizeWorkingDir(options?.workingDir),
      permissionMode: options?.permissionMode ?? DEFAULT_TOOL_PERMISSION_MODE,
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

    const permissionMode = options?.permissionMode ?? DEFAULT_TOOL_PERMISSION_MODE;
    // 工具执行环境：文件与命令都经 ElectronExecutionEnv 走主进程安全层
    const env = new ElectronExecutionEnv(options?.workingDir ?? "");
    const toolCtx: ToolContext = { env };
    const tools = buildAgentTools();

    const [session, models, agentsMd] = await Promise.all([
      openOrCreateSession(threadId),
      Promise.resolve(
        buildModelsFromConfigs(useConfigStore.getState().providers.providers),
      ),
      loadAgentsMdContent(),
    ]);

    const systemPrompt = agentsMd?.trim() || "";

    // pi 0.85: AgentHarness 通过静态 create 创建，tools 为原生 AgentHarnessTool，
    // toolContext 由 harness 在 execute 时注入。
    const { harness } = await AgentHarness.create(
      {
        session,
        models,
        model: model as Model<any>,
        tools: tools as AgentHarnessTool<ToolContext>[],
        toolContext: toolCtx,
        systemPrompt,
      },
      BACKGROUND_CONTEXT,
    );

    await harness.setStreamOptions(
      {
        cacheRetention: "short",
        metadata: {
          sessionId: threadId,
        },
      },
      BACKGROUND_CONTEXT,
    );

    harness.hooks.on("before_tool", async (event) => {
      const decision = await reviewToolPermission({
        requesterName: "助手",
        threadId,
        toolName: event.toolName,
        input: event.args as Record<string, unknown>,
        permissionMode,
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
      console.log(`[压缩] 会话 ${threadId} 即将压缩`, {
        source: event.reason === "manual" ? "manual" : "auto",
        tokensBefore: event.preparation?.tokensBefore,
      });
      return undefined;
    });

    if (!this.registeredCleanupSessions.has(threadId)) {
      this.registeredCleanupSessions.add(threadId);
      registerSessionResourceCleanup(() => {
        console.log(`[资源清理] 会话 ${threadId} 资源已释放`);
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

async function runtimeConfigSignature(): Promise<string> {
  const service = requireModelService();
  const agentsMd = await loadAgentsMdContent();

  return JSON.stringify({
    providerId: service.provider.id,
    providerType: service.provider.type,
    baseURL: service.provider.baseURL,
    apiKey: service.provider.apiKey,
    modelId: service.model.id,
    agentsMd,
  });
}

// 导出单例
export const agentManager = new AgentManager();
