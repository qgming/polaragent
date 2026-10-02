import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { MemoryStorage, UsageDoc, type UsageState } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyUsage } from "./durable-session";
import { openNativeStateTest } from "./native-state-test";
import { checkpointUsage, observeUsage, UsageJournalDoc, usageSamples } from "./native-usage";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const ledger = (input: number, output = 0): UsageState => ({
  models: { "service/model": { ...emptyUsage(), input, totalTokens: input } },
  tools: { search: { ...emptyUsage(), output, totalTokens: output } },
});
describe("native usage journal", () => {
  it("bounds dated retention without reducing all-time totals", async () => {
    const test = await openNativeStateTest();
    cleanups.push(test.close);
    const id = JSON.stringify(["models", "service/model"]);
    await test.harness.commit(async (tx) => {
      const journal = await tx.doc(UsageJournalDoc, test.root.id);
      journal.seen[id] = {
        inputTokens: 401,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      };
      for (let day = 0; day < 401; day++) {
        const at = new Date(2025, 0, day + 1, 12).getTime();
        journal.days[new Date(at).toISOString().slice(0, 10)] = {
          [id]: {
            inputTokens: 1,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            at,
            lastAt: at,
          },
        };
      }
    }, context);
    await checkpointUsage(test.harness, test.root.id, ledger(401), Date.now());
    const journal = await test.harness.snapshot(UsageJournalDoc, test.root.id, context);
    expect(Object.keys(journal?.days ?? {})).toHaveLength(400);
    const samples = usageSamples(ledger(401), journal);
    expect(samples.reduce((sum, sample) => sum + sample.inputTokens, 0)).toBe(401);
    expect(samples.find((sample) => sample.undated)?.inputTokens).toBe(1);
  });
  it("marks a failed checkpoint's next reconciliation undated instead of shifting spend to the next day", async () => {
    const storage = new MemoryStorage();
    const test = await openNativeStateTest([], storage);
    cleanups.push(test.close);
    let rejectNext = false;
    const facade = new Proxy(test.harness, {
      get(target, key) {
        if (key === "commit")
          return (...args: Parameters<typeof target.commit>) => {
            if (rejectNext) {
              rejectNext = false;
              return Promise.reject(new Error("checkpoint not admitted"));
            }
            return target.commit(...args);
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const observer = await observeUsage(facade, storage);
    const clock = vi.spyOn(Date, "now");
    try {
      clock.mockReturnValue(new Date(2026, 9, 1, 23, 59).getTime());
      rejectNext = true;
      await test.harness.commit(
        async (tx) => Object.assign(await tx.doc(UsageDoc, test.root.id), ledger(5)),
        context,
      );
      await expect(observer.flush()).rejects.toThrow("checkpoint not admitted");
      clock.mockReturnValue(new Date(2026, 9, 2, 0, 1).getTime());
      await test.harness.commit(
        async (tx) => Object.assign(await tx.doc(UsageDoc, test.root.id), ledger(8)),
        context,
      );
      await observer.flush();
      const journal = await test.harness.snapshot(UsageJournalDoc, test.root.id, context);
      expect(Object.keys(journal?.days ?? {})).toEqual([]);
      expect(usageSamples(ledger(8), journal)).toMatchObject([{ inputTokens: 8, undated: true }]);
    } finally {
      clock.mockRestore();
      observer.stop();
    }
  });
  it("captures model and tool ledger increments without transcript entries, once per committed increment", async () => {
    const storage = new MemoryStorage();
    const test = await openNativeStateTest([], storage);
    cleanups.push(test.close);
    const observer = await observeUsage(test.harness, storage);
    cleanups.push(async () => {
      await observer.flush();
      observer.stop();
    });
    await test.harness.commit(
      async (tx) => Object.assign(await tx.doc(UsageDoc, test.root.id), ledger(10, 4)),
      context,
    );
    await observer.flush();
    await checkpointUsage(test.harness, test.root.id, ledger(10, 4), Date.now());
    const journal = await test.harness.snapshot(UsageJournalDoc, test.root.id, context);
    const samples = usageSamples(ledger(10, 4), journal);
    expect(samples.reduce((n, value) => n + value.inputTokens + value.outputTokens, 0)).toBe(14);
    expect(samples.every((sample) => !sample.undated)).toBe(true);
    expect((await test.root.context(context)).entries).toHaveLength(0);
  });
  it("missed crash deltas remain undated and forks reset the journal", async () => {
    const test = await openNativeStateTest();
    cleanups.push(test.close);
    await checkpointUsage(
      test.harness,
      test.root.id,
      ledger(5),
      new Date(2026, 9, 1, 12).getTime(),
    );
    const journal = await test.harness.snapshot(UsageJournalDoc, test.root.id, context);
    const samples = usageSamples(ledger(9), journal);
    expect(samples.find((sample) => sample.undated)?.inputTokens).toBe(4);
    expect(samples.find((sample) => !sample.undated)?.inputTokens).toBe(5);
    const at = await test.harness.commit(
      (tx) => tx.appendEntry(test.root.id, { kind: "test.marker", data: {} }),
      context,
    );
    const fork = await test.root.fork(at.id, { ownership: { kind: "ownerless" } }, context);
    expect(await test.harness.snapshot(UsageJournalDoc, fork.id, context)).toBeUndefined();
  });
});
