import type { Session } from "@earendil-works/pi-agent-core";
import {
  DEFAULT_TOOL_PERMISSION_MODE,
  type ToolPermissionMode,
} from "@/types/permissions";
import {
  TOOL_PERMISSION_MODE_ENTRY,
  WORKING_DIR_ENTRY,
  KNOWLEDGE_BASE_IDS_ENTRY,
  PROJECT_REF_ENTRY,
  AGENT_ID_ENTRY,
} from "./entries";
import { openOrCreateSession } from "./lifecycle";

export async function getSessionWorkingDir(
  sessionId: string,
): Promise<string | undefined> {
  try {
    const session = await openOrCreateSession(sessionId);
    return readWorkingDirFromEntries(await session.getEntries());
  } catch (error) {
    console.error(`读取会话工作目录失败 ${sessionId}:`, error);
    return undefined;
  }
}

export async function setSessionWorkingDir(
  sessionId: string,
  dir: string,
): Promise<void> {
  try {
    const session = await openOrCreateSession(sessionId);
    await session.appendCustomEntry(WORKING_DIR_ENTRY, { dir });
  } catch (error) {
    console.error(`写入会话工作目录失败 ${sessionId}:`, error);
  }
}

export async function getSessionToolPermissionMode(
  sessionId: string,
): Promise<ToolPermissionMode> {
  try {
    const session = await openOrCreateSession(sessionId);
    return readToolPermissionModeFromEntries(await session.getEntries());
  } catch (error) {
    console.error(`读取会话工具权限失败 ${sessionId}:`, error);
    return DEFAULT_TOOL_PERMISSION_MODE;
  }
}

export async function setSessionToolPermissionMode(
  sessionId: string,
  mode: ToolPermissionMode,
): Promise<void> {
  try {
    const session = await openOrCreateSession(sessionId);
    await session.appendCustomEntry(TOOL_PERMISSION_MODE_ENTRY, { mode });
  } catch (error) {
    console.error(`写入会话工具权限失败 ${sessionId}:`, error);
  }
}

function readWorkingDirFromEntries(
  entries: Awaited<ReturnType<Session["getEntries"]>>,
): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type === "custom" && entry.customType === WORKING_DIR_ENTRY) {
      const data = entry.data as { dir?: unknown } | undefined;
      if (data && typeof data.dir === "string" && data.dir.trim()) {
        return data.dir;
      }
      return undefined;
    }
  }
  return undefined;
}

function readToolPermissionModeFromEntries(
  entries: Awaited<ReturnType<Session["getEntries"]>>,
): ToolPermissionMode {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "custom" || entry.customType !== TOOL_PERMISSION_MODE_ENTRY) {
      continue;
    }
    const data = entry.data as { mode?: unknown } | undefined;
    if (data?.mode === "readonly" || data?.mode === "safe" || data?.mode === "ai_review" || data?.mode === "full") {
      return data.mode;
    }
  }
  return DEFAULT_TOOL_PERMISSION_MODE;
}

export async function getSessionKnowledgeBaseIds(
  sessionId: string,
): Promise<string[]> {
  try {
    const session = await openOrCreateSession(sessionId);
    return readKnowledgeBaseIdsFromEntries(await session.getEntries());
  } catch (error) {
    console.error(`读取会话知识库失败 ${sessionId}:`, error);
    return [];
  }
}

export async function setSessionKnowledgeBaseIds(
  sessionId: string,
  ids: string[],
): Promise<void> {
  try {
    const session = await openOrCreateSession(sessionId);
    await session.appendCustomEntry(KNOWLEDGE_BASE_IDS_ENTRY, { ids });
  } catch (error) {
    console.error(`写入会话知识库失败 ${sessionId}:`, error);
  }
}

// --- 会话级助手 ID 持久化 ---

function readAgentIdFromEntries(
  entries: Awaited<ReturnType<Session["getEntries"]>>,
): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type === "custom" && entry.customType === AGENT_ID_ENTRY) {
      const data = entry.data as { agentId?: unknown } | undefined;
      if (data && typeof data.agentId === "string" && data.agentId.trim()) {
        return data.agentId;
      }
      // 当前条目数据无效，继续向前查找更早的有效条目
      continue;
    }
  }
  return undefined;
}

export async function getSessionAgentId(
  sessionId: string,
): Promise<string | undefined> {
  try {
    const session = await openOrCreateSession(sessionId);
    return readAgentIdFromEntries(await session.getEntries());
  } catch (error) {
    console.error(`读取会话助手 ID 失败 ${sessionId}:`, error);
    return undefined;
  }
}

export async function setSessionAgentId(
  sessionId: string,
  agentId: string,
): Promise<void> {
  try {
    const session = await openOrCreateSession(sessionId);
    await session.appendCustomEntry(AGENT_ID_ENTRY, { agentId });
  } catch (error) {
    console.error(`写入会话助手 ID 失败 ${sessionId}:`, error);
  }
}

function readKnowledgeBaseIdsFromEntries(
  entries: Awaited<ReturnType<Session["getEntries"]>>,
): string[] {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "custom" || entry.customType !== KNOWLEDGE_BASE_IDS_ENTRY) {
      continue;
    }
    const data = entry.data as { ids?: unknown } | undefined;
    if (data && Array.isArray(data.ids)) {
      return data.ids.filter((id): id is string => typeof id === "string");
    }
  }
  return [];
}

export async function getSessionProjectId(
  sessionId: string,
): Promise<string | undefined> {
  try {
    const session = await openOrCreateSession(sessionId);
    return readProjectIdFromEntries(await session.getEntries());
  } catch (error) {
    console.error(`读取会话项目归属失败 ${sessionId}:`, error);
    return undefined;
  }
}

export async function setSessionProjectId(
  sessionId: string,
  projectId: string,
): Promise<void> {
  try {
    const session = await openOrCreateSession(sessionId);
    await session.appendCustomEntry(PROJECT_REF_ENTRY, { projectId });
  } catch (error) {
    console.error(`写入会话项目归属失败 ${sessionId}:`, error);
  }
}

function readProjectIdFromEntries(
  entries: Awaited<ReturnType<Session["getEntries"]>>,
): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "custom" || entry.customType !== PROJECT_REF_ENTRY) {
      continue;
    }
    const data = entry.data as { projectId?: unknown } | undefined;
    if (data && typeof data.projectId === "string" && data.projectId.trim()) {
      return data.projectId;
    }
    // 当前条目数据无效，继续向前查找更早的有效条目
    continue;
  }
  return undefined;
}
