import type { JsonValue } from "@earendil-works/chord";
import type { Message } from "@earendil-works/pi-ai";
import type { JobInfo } from "@/shared/contracts/job";
import type { ChatMessage } from "@/shared/contracts/session";
import type { SubagentRun } from "@/shared/contracts/subagent";
import { buildSubagentResult } from "./report-delivery";

export interface NativeReport {
  text: string;
  isError: boolean;
  details: JsonValue;
}
export interface JobReportRecord {
  job: JobInfo;
  toolCallId?: string;
  result?: { text: string; isError: boolean };
}

/** One presentation adapter for committed reports, shared by history, live views and model requests. */
export function nativeReports(
  runs: readonly SubagentRun[],
  jobs: readonly JobReportRecord[],
): Map<string, NativeReport> {
  const reports = new Map<string, NativeReport>();
  for (const run of runs) {
    const result = buildSubagentResult(run);
    if (result)
      reports.set(run.parentToolCallId, { ...result, details: run as unknown as JsonValue });
  }
  for (const record of jobs) {
    if (record.toolCallId && record.result)
      reports.set(record.toolCallId, {
        ...record.result,
        details: { job: record.job } as unknown as JsonValue,
      });
  }
  return reports;
}

export function projectReportMessages(
  messages: ChatMessage[],
  reports: ReadonlyMap<string, NativeReport>,
): ChatMessage[] {
  return messages.map((message) => ({
    ...message,
    parts: message.parts.map((part) => {
      if (part.type !== "tool-call") return part;
      const report = reports.get(part.toolCallId);
      return report
        ? {
            ...part,
            result: report.text,
            details: report.details,
            isError: report.isError,
            status: report.isError ? ("error" as const) : ("done" as const),
          }
        : part;
    }),
  }));
}

export function projectReportContext(
  messages: readonly Message[],
  reports: ReadonlyMap<string, NativeReport>,
): Message[] {
  return messages.map((message) => {
    if (message.role !== "toolResult") return message;
    const report = reports.get(message.toolCallId);
    return report
      ? { ...message, content: [{ type: "text", text: report.text }], isError: report.isError }
      : message;
  });
}
