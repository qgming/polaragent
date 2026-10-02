// Pure projection of native usage journal snapshots. No independent disk ledger.
import type { UsageSample } from "@/main/pisdk/session-store";
import { dayKeyOf } from "@/shared/local-day";

export type { UsageSample };
export interface RollupBuckets {
  i: number;
  o: number;
  cr: number;
  cw: number;
}
export interface RollupDay extends RollupBuckets {
  m: Record<string, RollupBuckets>;
}
export interface RollupSession {
  first?: number;
  last?: number;
  seq: number;
  seenUpdatedAt: number;
  days: Record<string, RollupDay>;
  undated?: RollupDay;
}
export interface UsageRollup {
  version: number;
  sessions: Record<string, RollupSession>;
}
export const ROLLUP_VERSION = 1;
export function emptyRollup(): UsageRollup {
  return { version: ROLLUP_VERSION, sessions: {} };
}
export function emptyBuckets(): RollupBuckets {
  return { i: 0, o: 0, cr: 0, cw: 0 };
}
export function bucketTotal(value: RollupBuckets) {
  return value.i + value.o + value.cr + value.cw;
}
export function modelKeyOf(serviceId: string | undefined, modelId: string | undefined): string {
  const service = serviceId?.trim() ?? "";
  const model = modelId?.trim() ?? "";
  return model === "" ? "unknown" : service === "" ? model : `${service}|${model}`;
}
export function splitModelKey(key: string): { serviceId: string; modelId: string } {
  const at = key.indexOf("|");
  return at < 0
    ? { serviceId: "", modelId: key }
    : { serviceId: key.slice(0, at), modelId: key.slice(at + 1) };
}
export function isZeroSample(sample: UsageSample): boolean {
  return (
    sample.inputTokens + sample.outputTokens + sample.cacheReadTokens + sample.cacheWriteTokens ===
    0
  );
}
export function applyUsageSamples(
  session: RollupSession,
  samples: readonly UsageSample[],
  since?: number,
): RollupSession {
  if (samples.length === 0) return session;
  const days = structuredClone(session.days);
  let undated = session.undated ? structuredClone(session.undated) : undefined;
  let first = session.first;
  let last = session.last;
  for (const sample of samples) {
    if (isZeroSample(sample) || (!sample.undated && since !== undefined && sample.at < since))
      continue;
    const modelKey = modelKeyOf(sample.serviceId, sample.modelId);
    const date = sample.undated ? undefined : dayKeyOf(sample.at);
    const day = (date === undefined ? undated : days[date]) ?? { ...emptyBuckets(), m: {} };
    const model = day.m[modelKey] ?? emptyBuckets();
    const value = {
      i: sample.inputTokens,
      o: sample.outputTokens,
      cr: sample.cacheReadTokens,
      cw: sample.cacheWriteTokens,
    };
    for (const key of ["i", "o", "cr", "cw"] as const) {
      day[key] += value[key];
      model[key] += value[key];
    }
    day.m[modelKey] = model;
    if (date === undefined) undated = day;
    else {
      days[date] = day;
      first = Math.min(first ?? sample.at, sample.at);
      last = Math.max(last ?? sample.at, sample.lastAt ?? sample.at);
    }
  }
  return {
    ...session,
    ...(first === undefined ? {} : { first }),
    ...(last === undefined ? {} : { last }),
    days,
    ...(undated ? { undated } : {}),
  };
}
