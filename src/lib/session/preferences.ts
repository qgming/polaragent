import { BACKGROUND_CONTEXT, type Session } from "@earendil-works/pi-agent-core";
import {
  DEFAULT_TOOL_PERMISSION_MODE,
  type ToolPermissionMode,
} from "@/types/permissions";
import {
  TOOL_PERMISSION_MODE_ENTRY,
  WORKING_DIR_ENTRY,
} from "./entries";
import { openOrCreateSession } from "./lifecycle";

export async function getSessionWorkingDir(
  sessionId: string,
): Promise<string | undefined> {
  try {
    const session = await openOrCreateSession(sessionId);
    return readWorkingDirFromEntries(await session.findEntries({ order: "asc" }, BACKGROUND_CONTEXT));
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
    const branch = await session.branch("main", BACKGROUND_CONTEXT);
    if (!branch) return;
    await branch.appendCustomEntry(WORKING_DIR_ENTRY, { dir }, BACKGROUND_CONTEXT);
  } catch (error) {
    console.error(`写入会话工作目录失败 ${sessionId}:`, error);
  }
}

export async function getSessionToolPermissionMode(
  sessionId: string,
): Promise<ToolPermissionMode> {
  try {
    const session = await openOrCreateSession(sessionId);
    return readToolPermissionModeFromEntries(await session.findEntries({ order: "asc" }, BACKGROUND_CONTEXT));
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
    const branch = await session.branch("main", BACKGROUND_CONTEXT);
    if (!branch) return;
    await branch.appendCustomEntry(TOOL_PERMISSION_MODE_ENTRY, { mode }, BACKGROUND_CONTEXT);
  } catch (error) {
    console.error(`写入会话工具权限失败 ${sessionId}:`, error);
  }
}

function readWorkingDirFromEntries(
  entries: Awaited<ReturnType<Session["findEntries"]>>,
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
  entries: Awaited<ReturnType<Session["findEntries"]>>,
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
