import { describe, expect, it, vi } from "vitest";
import type { SessionStore, UsageSample } from "@/main/pisdk/session-store";
import type { SessionSummary } from "@/shared/contracts/session";
import { createUsageStatsService } from "./usage-stats";

function summary(id: string, kind: "chat" | "subagent" = "chat"): SessionSummary {
  return {
    id,
    kind,
    title: id,
    createdAt: 0,
    updatedAt: 1,
    cwd: "",
    archived: false,
    pinned: false,
    messageCount: 0,
    model: null,
  };
}
const sample = (tokens: number, extra: Partial<UsageSample> = {}): UsageSample => ({
  at: new Date(2026, 9, 2, 12).getTime(),
  inputTokens: tokens,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  modelId: "model",
  ...extra,
});
describe("native usage snapshot reports", () => {
  it("refreshes native spend even when no assistant entry or updatedAt changed", async () => {
    let count = 2;
    const store = {
      list: async () => [summary("root")],
      scanUsageSamples: vi.fn(async () => ({
        samples: [sample(count)],
        nextSeq: 1,
        entries: 1,
        done: true,
      })),
    } as unknown as SessionStore;
    const service = createUsageStatsService({ store });
    expect((await service.report()).totalTokens).toBe(2);
    count = 7;
    expect((await service.report()).totalTokens).toBe(7);
    expect(store.scanUsageSamples).toHaveBeenCalledTimes(2);
  });
  it("counts undated spend in totals/model/kind while excluding it from heatmap and streak", async () => {
    const store = {
      list: async () => [summary("root"), summary("child", "subagent")],
      scanUsageSamples: async (id: string) => ({
        samples: [id === "root" ? sample(10) : sample(4, { at: 0, undated: true })],
        nextSeq: 1,
        entries: 1,
        done: true,
      }),
    } as unknown as SessionStore;
    const report = await createUsageStatsService({ store }).report();
    expect(report.totalTokens).toBe(14);
    expect(report.undatedTokens).toBe(4);
    expect(report.days).toHaveLength(1);
    expect(report.days[0]?.tokens).toBe(10);
    expect(report.sessions.chat.tokens).toBe(10);
    expect(report.sessions.subagent.tokens).toBe(4);
    expect(report.models[0]?.tokens).toBe(14);
  });
  it("propagates read failures instead of publishing false zero totals", async () => {
    const store = {
      list: async () => {
        throw new Error("storage unavailable");
      },
    } as unknown as SessionStore;
    await expect(createUsageStatsService({ store }).report()).rejects.toThrow(
      "storage unavailable",
    );
  });
});
