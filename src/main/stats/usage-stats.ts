// Reports are fresh projections of bounded native journals, not a second accounting database.
import { getSessionStore, type SessionStore } from "@/main/pisdk/session-store";
import type { UsageStatsReport } from "@/shared/contracts/stats";
import { dayKeyOf } from "@/shared/local-day";
import { aggregateUsageReport, type SessionMeta } from "./usage-aggregate";
import { applyUsageSamples, emptyRollup } from "./usage-rollup";
export interface UsageStatsService {
  report(): Promise<UsageStatsReport>;
}
export interface UsageStatsDeps {
  store: SessionStore;
  now?: () => number;
}
export function createUsageStatsService(deps: UsageStatsDeps): UsageStatsService {
  const now = deps.now ?? Date.now;
  let inFlight: Promise<UsageStatsReport> | undefined;
  async function scan(): Promise<UsageStatsReport> {
    const summaries = await deps.store.list();
    const rollup = emptyRollup();
    const meta = new Map<string, SessionMeta>();
    for (const summary of summaries) {
      meta.set(summary.id, { title: summary.title, kind: summary.kind ?? "chat" });
      // A query reads a complete bounded snapshot. There is no persisted entry cursor to drift.
      const result = await deps.store.scanUsageSamples(summary.id, 0, Number.MAX_SAFE_INTEGER);
      rollup.sessions[summary.id] = applyUsageSamples(
        { seq: result.nextSeq, seenUpdatedAt: summary.updatedAt, days: {} },
        result.samples,
      );
    }
    return aggregateUsageReport({
      rollup,
      sessions: meta,
      today: dayKeyOf(now()),
      scanning: { active: false, scanned: summaries.length, total: summaries.length },
      now: now(),
    });
  }
  return {
    report() {
      inFlight ??= scan().finally(() => {
        inFlight = undefined;
      });
      return inFlight;
    },
  };
}
let defaultService: UsageStatsService | undefined;
export function getUsageStatsService(): UsageStatsService {
  defaultService ??= createUsageStatsService({ store: getSessionStore() });
  return defaultService;
}
