import { createDirectory, deleteFile, fileExists } from "@/lib/electron/electron-api";
import { getScheduleSessionsRoot, getSessionsRoot } from "./session-repo";

/**
 * 获取会话的文件存储目录路径。
 * 规则：{sessionId}_files
 */
export async function getSessionFilesDir(sessionId: string): Promise<string> {
  const root = await getSessionsRoot();
  return `${root}/${sessionId}_files`;
}

/**
 * 获取定时任务后台会话的文件存储目录路径。
 * 规则：{sessionId}_files
 */
export async function getScheduleSessionFilesDir(sessionId: string): Promise<string> {
  const root = await getScheduleSessionsRoot();
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

/** 删除定时任务后台会话的文件存储目录（如果存在）。 */
export async function deleteScheduleSessionFilesDir(sessionId: string): Promise<void> {
  try {
    const dir = await getScheduleSessionFilesDir(sessionId);
    const exists = await fileExists(dir);
    if (exists) {
      await deleteFile(dir);
      console.log(`删除定时任务会话文件目录: ${dir}`);
    }
  } catch (error) {
    console.error(`删除定时任务会话文件目录失败 ${sessionId}:`, error);
  }
}
