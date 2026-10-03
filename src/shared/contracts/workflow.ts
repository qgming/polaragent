export interface GoalState {
  id: string;
  workId: string;
  revision: number;
  objective: string;
  scope: "research" | "implementation";
  criteria: string[];
  status: "active" | "paused" | "blocked" | "completed" | "ended";
  progress: string;
  reason?: string;
  continuationCount: number;
  continuationLimit: number;
}

export interface PlanRef {
  planId: string;
  revision: number;
}

export type PlanExecutionRequest = PlanRef & {
  requestId: string;
  workId: string;
  workRevision: number;
};

export interface PlanState {
  id: string;
  workId: string;
  revision: number;
  requirementsRevision: number;
  goalId?: string;
  status: "draft" | "ready" | "archived";
  title: string;
  markdown: string;
}

/** Current work constraints. Only a host user-control action can broaden them. */
export interface WorkContract {
  workId: string;
  revision: number;
  requirementsRevision: number;
  effects: "read-only" | "unrestricted";
  requiresReview: boolean;
  pendingInputIds: string[];
  approvedPlanRef: PlanRef | null;
}

export interface PlanExecutionReceipt {
  requestId: string;
  workId: string;
  workRevision: number;
  planRef: PlanRef;
  plan: PlanState;
  contract: WorkContract;
  status: "reserved" | "admitted" | "released";
  inputId?: string;
}

/** UI projection; each concern is persisted in its own native document. */
export interface WorkflowState {
  revision: number;
  goal: GoalState | null;
  plan: PlanState | null;
  work: WorkContract | null;
  execution: PlanExecutionReceipt | null;
}

export type GoalControl = "pause" | "resume" | "end";
export type WorkflowResult =
  | { ok: true }
  | { ok: false; code: "busy" | "stale" | "missing" | "invalid" | "failed"; message?: string };
