import {
  createDirectory,
  deleteFile,
  fileExists,
  getDataDir,
  readFile,
  writeFile,
} from "@/lib/electron/electron-api";
import type {
  ScheduleLogEntry,
  ScheduleStoreFile,
  ScheduledTask,
} from "@/types/schedule";

const SCHEDULE_ROOT = "schedule";
const TASKS_FILE = "tasks.json";
const LOG_RETENTION = 50;

function normalize(base: string): string {
  return base.replace(/\\/g, "/").replace(/\/+$/, "");
}

async function scheduleRoot(): Promise<string> {
  return `${normalize(await getDataDir())}/${SCHEDULE_ROOT}`;
}

async function ensureScheduleRoot(): Promise<string> {
  const root = await scheduleRoot();
  await createDirectory(root, { securityMode: "full" });
  await createDirectory(`${root}/logs`, { securityMode: "full" });
  return root;
}

async function tasksFilePath(): Promise<string> {
  return `${await ensureScheduleRoot()}/${TASKS_FILE}`;
}

async function logFilePath(taskId: string): Promise<string> {
  return `${await ensureScheduleRoot()}/logs/${taskId}.json`;
}

async function taskConfigDir(taskId: string): Promise<string> {
  return `${await ensureScheduleRoot()}/tasks/${taskId}`;
}

async function taskConfigPath(taskId: string): Promise<string> {
  return `${await taskConfigDir(taskId)}/task.json`;
}

function sortTasks(tasks: ScheduledTask[]): ScheduledTask[] {
  return [...tasks].sort((a, b) => b.updatedAt - a.updatedAt);
}

function normalizeStoreFile(raw: unknown): ScheduleStoreFile {
  if (!raw || typeof raw !== "object") {
    return { version: 1, tasks: [] };
  }
  const record = raw as { version?: unknown; tasks?: unknown };
  const tasks = Array.isArray(record.tasks) ? record.tasks : [];
  return {
    version: record.version === 1 ? 1 : 1,
    tasks: sortTasks(tasks.filter((item): item is ScheduledTask => Boolean(item && typeof item === "object"))),
  };
}

function normalizeTaskRecord(raw: unknown): ScheduledTask | null {
  if (!raw || typeof raw !== "object") return null;
  return raw as ScheduledTask;
}

async function loadScheduledTaskConfig(taskId: string): Promise<ScheduledTask | null> {
  const path = await taskConfigPath(taskId);
  if (!(await fileExists(path, { securityMode: "full" }))) {
    return null;
  }
  try {
    const content = await readFile(path, { securityMode: "full" });
    return normalizeTaskRecord(JSON.parse(content) as unknown);
  } catch (error) {
    console.error(`读取定时任务配置失败 ${taskId}:`, error);
    return null;
  }
}

export async function loadScheduledTasks(): Promise<ScheduledTask[]> {
  const path = await tasksFilePath();
  if (!(await fileExists(path, { securityMode: "full" }))) {
    return [];
  }
  try {
    const content = await readFile(path, { securityMode: "full" });
    const parsed = JSON.parse(content) as unknown;
    const tasks = normalizeStoreFile(parsed).tasks;
    const merged = await Promise.all(
      tasks.map(async (task) => (await loadScheduledTaskConfig(task.id)) ?? task),
    );
    return sortTasks(merged);
  } catch (error) {
    console.error("读取定时任务失败:", error);
    return [];
  }
}

export async function saveScheduledTasks(tasks: ScheduledTask[]): Promise<void> {
  const payload: ScheduleStoreFile = {
    version: 1,
    tasks: sortTasks(tasks),
  };
  await writeFile(await tasksFilePath(), JSON.stringify(payload, null, 2), { securityMode: "full" });
  await Promise.all(tasks.map((task) => saveScheduledTaskConfig(task)));
}

export async function saveScheduledTaskConfig(task: ScheduledTask): Promise<void> {
  const dir = await taskConfigDir(task.id);
  await createDirectory(dir, { securityMode: "full" });
  await writeFile(await taskConfigPath(task.id), JSON.stringify(task, null, 2), { securityMode: "full" });
}

export async function deleteScheduledTaskConfig(taskId: string): Promise<void> {
  const path = await taskConfigPath(taskId);
  if (!(await fileExists(path, { securityMode: "full" }))) {
    return;
  }
  await deleteFile(path, { securityMode: "full" });
}

export async function loadScheduleLogs(taskId: string): Promise<ScheduleLogEntry[]> {
  const path = await logFilePath(taskId);
  if (!(await fileExists(path, { securityMode: "full" }))) {
    return [];
  }
  try {
    const content = await readFile(path, { securityMode: "full" });
    const parsed = JSON.parse(content) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is ScheduleLogEntry => Boolean(item && typeof item === "object"))
      .sort((a, b) => b.runAt - a.runAt);
  } catch (error) {
    console.error(`读取定时任务日志失败 ${taskId}:`, error);
    return [];
  }
}

export async function appendScheduleLog(log: ScheduleLogEntry): Promise<ScheduleLogEntry[]> {
  const current = await loadScheduleLogs(log.taskId);
  const next = [log, ...current].sort((a, b) => b.runAt - a.runAt).slice(0, LOG_RETENTION);
  await writeFile(await logFilePath(log.taskId), JSON.stringify(next, null, 2), { securityMode: "full" });
  return next;
}

export async function scheduleRunRoot(taskId: string): Promise<string> {
  const root = `${await ensureScheduleRoot()}/runs/${taskId}`;
  await createDirectory(root, { securityMode: "full" });
  return root;
}

export async function createScheduleRunDir(taskId: string, runId: string): Promise<string> {
  const root = await scheduleRunRoot(taskId);
  const dir = `${root}/${runId}`;
  await createDirectory(dir, { securityMode: "full" });
  return dir;
}
