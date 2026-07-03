import { describe, expect, it } from "vitest";

import {
  createScheduleRunId,
  createScheduleThreadId,
  isScheduleThreadId,
  sanitizeScheduleName,
} from "./runtime-ids";

describe("schedule runtime ids", () => {
  it("sanitizes schedule names into lowercase slugs", () => {
    expect(sanitizeScheduleName("  Daily Report / Team A  ")).toBe("daily-report-team-a");
    expect(sanitizeScheduleName("***")).toBe("task");
  });

  it("formats run ids with timestamp precision", () => {
    const runId = createScheduleRunId(new Date(2026, 6, 3, 9, 4, 5));
    expect(runId).toBe("20260703-090405");
  });

  it("marks internal schedule threads with a dedicated prefix", () => {
    const threadId = createScheduleThreadId("task-123", "20260703-090405");
    expect(threadId).toBe(`schedule-run--task-123--20260703-090405`);
    expect(isScheduleThreadId(threadId)).toBe(true);
    expect(isScheduleThreadId("chat::normal-thread")).toBe(false);
  });
});
