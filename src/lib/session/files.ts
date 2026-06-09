import { createDirectory, deleteFile, fileExists } from "@/lib/electron/electron-api";
import { getSessionsRoot, getTeamSessionsRoot } from "./session-repo";

/**
 * 获取会话的文件存储目录路径。
 * 规则：{sessionId}_files
 */
export async function getSessionFilesDir(sessionId: string): Promise<string> {
  const root = await getSessionsRoot();
  return `${root}/${sessionId}_files`;
}

/**
 * 获取团队会话的文件存储目录路径。
 * 规则：{sessionId}_files
 */
export async function getTeamSessionFilesDir(sessionId: string): Promise<string> {
  const root = await getTeamSessionsRoot();
  return `${root}/${sessionId}_files`;
}

/** 创建会话的文件存储目录（如果不存在）。 */
export async function ensureSessionFilesDir(sessionId: string): Promise<void> {
  try {
    const dir = await getSessionFilesDir(sessionId);
    const exists = await fileExists(dir);
    if (!exists) {
      await createDirectory(dir);
      console.log(`创建会话文件目录: ${dir}`);
    }
  } catch (error) {
    console.error(`创建会话文件目录失败 ${sessionId}:`, error);
  }
}

/** 创建团队会话的文件存储目录（如果不存在）。 */
export async function ensureTeamSessionFilesDir(sessionId: string): Promise<void> {
  try {
    const dir = await getTeamSessionFilesDir(sessionId);
    const exists = await fileExists(dir);
    if (!exists) {
      await createDirectory(dir);
      console.log(`创建团队文件目录: ${dir}`);
    }
  } catch (error) {
    console.error(`创建团队文件目录失败 ${sessionId}:`, error);
  }
}

/** 删除会话的文件存储目录（如果存在）。 */
export async function deleteSessionFilesDir(sessionId: string): Promise<void> {
  try {
    const dir = await getSessionFilesDir(sessionId);
    const exists = await fileExists(dir);
    if (exists) {
      await deleteFile(dir);
      console.log(`删除会话文件目录: ${dir}`);
    }
  } catch (error) {
    console.error(`删除会话文件目录失败 ${sessionId}:`, error);
  }
}

/** 删除团队会话的文件存储目录（如果存在）。 */
export async function deleteTeamSessionFilesDir(sessionId: string): Promise<void> {
  try {
    const dir = await getTeamSessionFilesDir(sessionId);
    const exists = await fileExists(dir);
    if (exists) {
      await deleteFile(dir);
      console.log(`删除团队文件目录: ${dir}`);
    }
  } catch (error) {
    console.error(`删除团队文件目录失败 ${sessionId}:`, error);
  }
}
