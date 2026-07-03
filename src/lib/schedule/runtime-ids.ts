export const SCHEDULE_THREAD_PREFIX = "schedule-run--";
const LEGACY_SCHEDULE_THREAD_PREFIX = "schedule-run::";

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function isScheduleThreadId(threadId: string): boolean {
  return (
    threadId.startsWith(SCHEDULE_THREAD_PREFIX) ||
    threadId.startsWith(LEGACY_SCHEDULE_THREAD_PREFIX)
  );
}

export function sanitizeScheduleName(value: string): string {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase() || "task";
}

export function createScheduleRunId(date = new Date()): string {
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("");
}

export function createScheduleThreadId(taskId: string, runId: string): string {
  return `${SCHEDULE_THREAD_PREFIX}${taskId}--${runId}`;
}
