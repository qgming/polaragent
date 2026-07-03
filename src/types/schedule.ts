import type { ToolPermissionMode } from "@/types/permissions";

export type ScheduleKind = "at" | "every" | "cron";

export interface ScheduleAtConfig {
  kind: "at";
  at: string;
}

export interface ScheduleEveryConfig {
  kind: "every";
  everyMs: number;
  startAt?: string;
}

export interface ScheduleCronConfig {
  kind: "cron";
  expr: string;
}

export type ScheduleConfig =
  | ScheduleAtConfig
  | ScheduleEveryConfig
  | ScheduleCronConfig;

export type SchedulePayloadKind = "agentTurn";

export interface AgentTurnPayload {
  kind: "agentTurn";
  message: string;
  contextDirs?: string[];
  agentId?: string;
  workingDir?: string;
  permissionMode?: ToolPermissionMode;
}

export type SchedulePayload = AgentTurnPayload;

export type MissedRunPolicy = "prompt" | "run_all" | "run_latest" | "skip";

export type ScheduleLogStatus = "success" | "failed" | "running" | "skipped";

export interface ScheduledTask {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  schedule: ScheduleConfig;
  payload: AgentTurnPayload;
  missedRunPolicy: MissedRunPolicy;
  lastRunAt?: number;
  nextRunAt?: number;
  lastRunStatus?: Exclude<ScheduleLogStatus, "running">;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ScheduleLogEntry {
  id: string;
  taskId: string;
  runId: string;
  runAt: number;
  status: ScheduleLogStatus;
  output?: string;
  error?: string;
  duration: number;
  threadId?: string;
  workingDir?: string;
  runDir?: string;
  triggeredBy: "schedule" | "manual" | "recovery";
}

export interface ScheduleTaskRuntimeState {
  taskId: string;
  state: "idle" | "running" | "paused";
  lastRunAt?: number;
  nextRunAt?: number;
  currentRunId?: string;
  lastMessage?: string;
}

export interface ScheduleStats {
  totalTasks: number;
  enabledTasks: number;
  runningTasks: number;
  totalRuns: number;
  successRuns: number;
  failedRuns: number;
}

export interface ScheduleFilter {
  status?: "all" | "enabled" | "disabled" | "running";
  searchQuery?: string;
}

export interface CreateScheduledTaskRequest {
  name: string;
  description?: string;
  enabled?: boolean;
  schedule: ScheduleConfig;
  payload: AgentTurnPayload;
  missedRunPolicy?: MissedRunPolicy;
}

export interface UpdateScheduledTaskRequest extends Partial<CreateScheduledTaskRequest> {
  id: string;
}

export interface ScheduleStoreFile {
  version: 1;
  tasks: ScheduledTask[];
}
