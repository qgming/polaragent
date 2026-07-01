import { firstModelService, resolveModelService } from "./model-router";
import { callLlm } from "./llm-call";
import {
  createMemory,
  hasSensitiveMemoryContent,
  memoryApiConfigFromSettings,
  normalizeMemoryJsonText,
  projectKeyFromWorkingDir,
} from "@/lib/memory";
import type { MemoryScope, MemoryType } from "@/lib/memory";
import { useConfigStore } from "@/stores/config-store";
import { useMemoryStore } from "@/stores/memory-store";

const MIN_CONFIDENCE = 0.6;
const MAX_CAPTURE_TEXT = 1800;

interface CaptureParams {
  threadId: string;
  agentId: string;
  threadTitle?: string;
  workingDir?: string;
  userText: string;
  assistantText: string;
}

interface RawMemoryCandidate {
  scope?: unknown;
  type?: unknown;
  content?: unknown;
  confidence?: unknown;
  tags?: unknown;
}

export interface NormalizedMemoryCandidate {
  scope: MemoryScope;
  type: MemoryType;
  content: string;
  confidence: number;
  tags: string[];
}

const VALID_TYPES = new Set<MemoryType>([
  "preference",
  "profile",
  "project",
  "instruction",
  "correction",
  "communication",
  "workflow",
  "tool",
  "goal",
  "constraint",
]);

export async function captureMemoriesFromExchange(
  params: CaptureParams,
): Promise<void> {
  const settings = useConfigStore.getState().settings;
  const memorySettings = settings.memory;
  if (!memorySettings?.enabled || !memorySettings.autoWrite) return;

  const config = memoryApiConfigFromSettings(settings);
  if (!config) return;

  const service = resolveModelService(params.agentId) ?? firstModelService();
  if (!service) return;

  const projectKey = projectKeyFromWorkingDir(params.workingDir);

  try {
    const result = await callLlm(service, {
      systemPrompt: buildCaptureSystemPrompt(Boolean(projectKey && memorySettings.projectMemoryEnabled)),
      userPrompt: buildCaptureUserPrompt(params),
      temperature: 0.1,
      maxTokens: 700,
    });

    const candidates = parseMemoryCandidates(result)
      .map((candidate) =>
        normalizeCandidate(candidate, {
          allowProject: Boolean(projectKey && memorySettings.projectMemoryEnabled),
        }),
      )
      .filter((candidate): candidate is NormalizedMemoryCandidate => Boolean(candidate))
      .filter((candidate) => candidate.confidence >= MIN_CONFIDENCE)
      .filter((candidate) =>
        memorySettings.sensitiveFilter
          ? !hasSensitiveMemoryContent(candidate.content)
          : true,
      );

    for (const candidate of candidates) {
      await createMemory({
        memory: {
          ...candidate,
          sourceThreadId: params.threadId,
          projectKey: candidate.scope === "project" ? projectKey : undefined,
        },
        config,
        dedupeThreshold: 0.92,
        sensitiveFilter: memorySettings.sensitiveFilter,
      }).catch((error) => {
        console.warn("自动写入记忆失败，已跳过单条候选:", error);
      });
    }

    useMemoryStore.getState().setLastAutoWriteError(null);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("自动记忆捕获失败:", error);
    useMemoryStore.getState().setLastAutoWriteError(message);
  }
}

function buildCaptureSystemPrompt(allowProject: boolean): string {
  const scopes = allowProject
    ? '"global" 或 "project"'
    : '"global"。当前没有可用项目上下文，不要输出 project 记忆';
  return [
    "你是 PolarAgent 的长期记忆提取器。你的任务是从一轮用户与助手对话中提取值得长期保存的记忆。",
    "只保存将来明显有用、稳定、可复用的信息。不要保存普通闲聊、一次性任务步骤、临时问题、工具输出细节或助手自己的推测。",
    "不要保存密码、API Key、token、验证码、银行卡、身份证号等敏感信息。",
    `scope 只能是 ${scopes}。`,
    'type 只能是 "preference"、"profile"、"project"、"instruction"、"correction"、"communication"、"workflow"、"tool"、"goal"、"constraint"。',
    '只输出 JSON 数组，不要解释。每项格式为 {"scope":"global","type":"preference","content":"...","confidence":0.8,"tags":["..."]}。没有可记忆内容时输出 []。',
  ].join("\n");
}

function buildCaptureUserPrompt(params: CaptureParams): string {
  const title = params.threadTitle?.trim() || "未命名对话";
  const workingDir = params.workingDir?.trim() || "无";
  return [
    `对话标题：${title}`,
    `工作目录：${workingDir}`,
    "",
    "用户消息：",
    trimForCapture(params.userText),
    "",
    "助手回复：",
    trimForCapture(params.assistantText),
  ].join("\n");
}

function trimForCapture(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, MAX_CAPTURE_TEXT);
}

export function parseMemoryCandidates(raw: string): RawMemoryCandidate[] {
  try {
    const parsed = JSON.parse(normalizeMemoryJsonText(raw)) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter(isObjectRecord);
    }
    if (isObjectRecord(parsed) && Array.isArray(parsed.memories)) {
      return parsed.memories.filter(isObjectRecord);
    }
  } catch {
    return [];
  }
  return [];
}

function isObjectRecord(value: unknown): value is RawMemoryCandidate & Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function normalizeCandidate(
  candidate: RawMemoryCandidate,
  options: { allowProject: boolean },
): NormalizedMemoryCandidate | null {
  const content =
    typeof candidate.content === "string"
      ? candidate.content.replace(/\s+/g, " ").trim()
      : "";
  if (content.length < 6) return null;

  const requestedScope = candidate.scope === "project" ? "project" : "global";
  const scope: MemoryScope =
    requestedScope === "project" && options.allowProject ? "project" : "global";

  const rawType = typeof candidate.type === "string" ? candidate.type : "";
  const type: MemoryType = VALID_TYPES.has(rawType as MemoryType)
    ? (rawType as MemoryType)
    : scope === "project"
      ? "project"
      : "preference";

  const confidence = Number(candidate.confidence);
  const tags = Array.isArray(candidate.tags)
    ? candidate.tags
        .filter((tag): tag is string => typeof tag === "string")
        .map((tag) => tag.trim())
        .filter(Boolean)
        .slice(0, 8)
    : [];

  return {
    scope,
    type,
    content,
    confidence: Number.isFinite(confidence)
      ? Math.max(0, Math.min(1, confidence))
      : 0.7,
    tags,
  };
}
