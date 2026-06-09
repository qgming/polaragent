import type { Session } from "@earendil-works/pi-agent-core";
import {
  DEFAULT_TOOL_PERMISSION_MODE,
  type ToolPermissionMode,
} from "@/types/permissions";
import { TOOL_PERMISSION_MODE_ENTRY, WORKING_DIR_ENTRY } from "./entries";
import { openOrCreateSession, openOrCreateTeamSession } from "./lifecycle";

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

export async function getTeamSessionWorkingDir(
  sessionId: string,
): Promise<string | undefined> {
  try {
    const session = await openOrCreateTeamSession(sessionId);
    return readWorkingDirFromEntries(await session.getEntries());
  } catch (error) {
    console.error(`读取团队会话工作目录失败 ${sessionId}:`, error);
    return undefined;
  }
}

export async function setTeamSessionWorkingDir(
  sessionId: string,
  dir: string,
): Promise<void> {
  try {
    const session = await openOrCreateTeamSession(sessionId);
    await session.appendCustomEntry(WORKING_DIR_ENTRY, { dir });
  } catch (error) {
    console.error(`写入团队会话工作目录失败 ${sessionId}:`, error);
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

export async function getTeamSessionToolPermissionMode(
  sessionId: string,
): Promise<ToolPermissionMode> {
  try {
    const session = await openOrCreateTeamSession(sessionId);
    return readToolPermissionModeFromEntries(await session.getEntries());
  } catch (error) {
    console.error(`读取团队会话工具权限失败 ${sessionId}:`, error);
    return DEFAULT_TOOL_PERMISSION_MODE;
  }
}

export async function setTeamSessionToolPermissionMode(
  sessionId: string,
  mode: ToolPermissionMode,
): Promise<void> {
  try {
    const session = await openOrCreateTeamSession(sessionId);
    await session.appendCustomEntry(TOOL_PERMISSION_MODE_ENTRY, { mode });
  } catch (error) {
    console.error(`写入团队会话工具权限失败 ${sessionId}:`, error);
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
    if (data?.mode === "readonly" || data?.mode === "full" || data?.mode === "ai_review") {
      return data.mode;
    }
  }
  return DEFAULT_TOOL_PERMISSION_MODE;
}
