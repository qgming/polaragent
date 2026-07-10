import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";

import { text } from "./tool-context";

export type ToolProgressPhase =
  | "validating"
  | "preparing"
  | "fetching"
  | "processing"
  | "executing"
  | "saving"
  | "completed";

export interface ToolProgressDetails {
  phase: ToolProgressPhase | string;
  summary: string;
  progress?: number;
  [key: string]: unknown;
}

export function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

export function elapsedMs(startedAt: number): number {
  return Math.max(0, Math.round(nowMs() - startedAt));
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error("工具执行已取消");
  }
}

export function progressUpdate(
  onUpdate: AgentToolUpdateCallback<ToolProgressDetails> | undefined,
  details: ToolProgressDetails,
): void {
  onUpdate?.({
    content: text(details.summary),
    details,
  } satisfies AgentToolResult<ToolProgressDetails>);
}

export function withDuration<T extends Record<string, unknown>>(
  details: T,
  startedAt: number,
): T & { durationMs: number } {
  return {
    ...details,
    durationMs: elapsedMs(startedAt),
  };
}
