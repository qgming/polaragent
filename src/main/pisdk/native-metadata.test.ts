import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  AgentDoc,
  createRegistry,
  defineTask,
  Harness,
  UsageDoc,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createUsageStatsService } from "@/main/stats/usage-stats";
import { emptyUsage, SessionHandleReleased, SessionPerformanceDoc } from "./durable-session";
import { createSessionStore, type SessionStore } from "./session-store";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function setup() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oint-native-meta-"));
  cleanups.push(() =>
    rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  );
  const store = createSessionStore(directory);
  cleanups.push(() => store.close());
  return { directory, store };
}
describe("native session metadata authority", () => {
  it("uses the selected retry's ledger, performance and native working directory", async () => {
    const test = await setup();
    const summary = await test.store.create();
    const opened = await test.store.open(summary.id);
    if (!opened) throw new Error("Missing session");
    const owner = await opened.session.bindHarness(() =>
      Harness.open(opened.storage, { models: createModels(), registry: createRegistry() }, context),
    );
    const original = opened.conversationId;
    const performance = {
      stats: {
        turns: 1,
        steps: 1,
        llmMs: 0,
        toolMs: 0,
        ttftMs: 0,
        ttftSteps: 0,
        decodeMs: 0,
        decodeTokens: 0,
      },
      breakdown: { systemTokens: 1, toolsTokens: 0, messageTokens: 0 },
      tokenUsage: {
        uncachedInputTokens: 999,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    };
    await owner.commit(async (tx) => {
      (await tx.doc(UsageDoc, original)).models["p/m"] = {
        ...emptyUsage(),
        input: 11,
        totalTokens: 11,
      };
    }, context);
    await test.store.writeUsage(summary.id, performance);
    const retry = await opened.session.forkAndSelect(null, context);
    expect(opened.conversationId).toBe(retry.id);
    await owner.commit(async (tx) => {
      (await tx.doc(UsageDoc, retry.id)).models["p/m"] = {
        ...emptyUsage(),
        input: 3,
        totalTokens: 3,
      };
    }, context);
    expect(await test.store.readUsage(summary.id)).toMatchObject({
      tokenUsage: { uncachedInputTokens: 3 },
      stats: { steps: 0 },
    });
    await test.store.writeUsage(summary.id, {
      ...performance,
      stats: { ...performance.stats, steps: 2 },
    });
    await test.store.setCwd(summary.id, test.directory);
    expect(
      (await owner.snapshot(SessionPerformanceDoc, original, context))?.performance?.stats.steps,
    ).toBe(1);
    expect(
      (await owner.snapshot(SessionPerformanceDoc, retry.id, context))?.performance?.stats.steps,
    ).toBe(2);
    expect((await owner.snapshot(AgentDoc, original, context))?.cwd).toBe(summary.cwd);
    expect((await owner.snapshot(AgentDoc, retry.id, context))?.cwd).toBe(test.directory);
    expect(await test.store.readUsage(summary.id)).toMatchObject({
      tokenUsage: { uncachedInputTokens: 3 },
      stats: { steps: 2 },
    });
  });
  it("keeps metadata and native totals readable after a journal failure with no later usage", async () => {
    const test = await setup();
    const summary = await test.store.create({ title: "Still readable" });
    const opened = await test.store.open(summary.id);
    if (!opened) throw new Error("Missing session");
    const owner = await opened.session.bindHarness(() =>
      Harness.open(opened.storage, { models: createModels(), registry: createRegistry() }, context),
    );
    const commit = owner.commit.bind(owner);
    const failure = new Error("journal checkpoint failed");
    const checkpoint = vi.spyOn(owner, "commit").mockRejectedValueOnce(failure);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await commit(async (tx) => {
        (await tx.doc(UsageDoc, opened.conversationId)).models["p/m"] = {
          ...emptyUsage(),
          input: 9,
          totalTokens: 9,
        };
      }, context);
      await expect(opened.session.flushUsage()).rejects.toThrow("journal checkpoint failed");
      // The normal close path still reports the undrained journal failure and releases storage.
      cleanups.pop();
      cleanups.push(async () => {
        await expect(test.store.close()).rejects.toThrow("journal checkpoint failed");
      });
      expect(await test.store.readTitle(summary.id)).toBe("Still readable");
      expect((await test.store.list())[0]?.title).toBe("Still readable");
      expect((await test.store.readUsage(summary.id))?.tokenUsage.uncachedInputTokens).toBe(9);
      const report = await createUsageStatsService({ store: test.store }).report();
      expect(report.totalTokens).toBe(9);
      expect(report.undatedTokens).toBe(9);
      expect(report.days).toEqual([]);
    } finally {
      checkpoint.mockRestore();
      warning.mockRestore();
    }
  });
  it("separates root retry spend from owned child spend without family double counting", async () => {
    const test = await setup();
    const summary = await test.store.create();
    const opened = await test.store.open(summary.id);
    if (!opened) throw new Error("Missing session");
    const owner = await opened.session.bindHarness(() =>
      Harness.open(opened.storage, { models: createModels(), registry: createRegistry() }, context),
    );
    const task = defineTask<null, { phase: "run" }, null>({
      name: "test.owner",
      version: 1,
      initial: () => ({ phase: "run" }),
      phases: {
        async run(_task, runtime, context) {
          await runtime.commit(
            () => ({ status: "terminal", outcome: { status: "completed", result: null } }),
            context,
          );
        },
      },
      async abort(_task, runtime, context) {
        await runtime.commit(
          () => ({ status: "terminal", outcome: { status: "aborted" } }),
          context,
        );
      },
    });
    const child = await owner.commit(async (tx) => {
      const parent = await tx.createTask(task, null, {
        conversationId: opened.conversationId,
        ownership: { kind: "conversation" },
      });
      const child = await tx.createConversation({ ownership: { kind: "task", taskId: parent } });
      const retry = await tx.createConversation({ ownership: { kind: "ownerless" } });
      for (const [id, input] of [
        [opened.conversationId, 10],
        [child.id, 7],
        [retry.id, 3],
      ] as const)
        (await tx.doc(UsageDoc, id)).models["p/m"] = { ...emptyUsage(), input, totalTokens: input };
      return child.id;
    }, context);
    const rootSamples = await test.store.scanUsageSamples(summary.id, 0, 100);
    const childSamples = await test.store.scanUsageSamples(`${summary.id}~${child}`, 0, 100);
    expect(rootSamples.samples.reduce((sum, sample) => sum + sample.inputTokens, 0)).toBe(13);
    expect(childSamples.samples.reduce((sum, sample) => sum + sample.inputTokens, 0)).toBe(7);
    expect((await opened.session.getStats(context)).usage.input).toBe(10);
  });
  it("serializes concurrent offline metadata writes and survives catalogue deletion", async () => {
    const test = await setup();
    const summary = await test.store.create();
    await Promise.all([
      test.store.rename(summary.id, "Native title"),
      test.store.setPinned(summary.id, true),
      test.store.setArchived(summary.id, true),
      test.store.setAgentMode(summary.id, "orchestrate"),
      test.store.setModel(summary.id, { serviceId: "provider", modelId: "model" }),
    ]);
    await test.store.close();
    await rm(path.join(test.directory, "sessions-index.json"), { force: true });
    const reopened = createSessionStore(test.directory);
    cleanups.push(() => reopened.close());
    expect((await reopened.list())[0]).toMatchObject({
      title: "Native title",
      pinned: true,
      archived: true,
      agentMode: "orchestrate",
      model: { serviceId: "provider", modelId: "model" },
    });
  });
  it("an offline metadata Session never becomes the later runtime Harness", async () => {
    const test = await setup();
    const summary = await test.store.create();
    const stale = await test.store.open(summary.id);
    if (!stale) throw new Error("Missing session");
    await test.store.rename(summary.id, "Renamed");
    const unused = vi.fn();
    await expect(stale.session.bindHarness(unused)).rejects.toBeInstanceOf(SessionHandleReleased);
    expect(unused).not.toHaveBeenCalled();
    const opened = await test.store.open(summary.id);
    if (!opened) throw new Error("Missing reopened session");
    const task = defineTask<null, { phase: "run" }, string>({
      name: "test.metadata-runtime",
      version: 1,
      initial: () => ({ phase: "run" }),
      phases: {
        async run(_task, runtime, context) {
          await runtime.commit(
            () => ({
              status: "terminal",
              outcome: { status: "completed", result: "real registry" },
            }),
            context,
          );
        },
      },
      async abort(_task, runtime, context) {
        await runtime.commit(
          () => ({ status: "terminal", outcome: { status: "aborted" } }),
          context,
        );
      },
    });
    const registry = createRegistry();
    registry.install({ name: "test", tasks: [task] });
    const factory = vi.fn(() =>
      Harness.open(opened.storage, { models: createModels(), registry }, context),
    );
    const owner = await opened.session.bindHarness(factory);
    const id = await owner.commit(
      (tx) =>
        tx.createTask(task, null, {
          conversationId: opened.conversationId,
          ownership: { kind: "conversation" },
        }),
      context,
    );
    expect((await owner.waitForTask(id, context)).state.outcome).toMatchObject({
      status: "completed",
      result: "real registry",
    });
    expect(factory).toHaveBeenCalledOnce();
  });
  it("Stats queries close unopened storage connections and reopen native dated usage after shutdown", async () => {
    const test = await setup();
    const summary = await test.store.create();
    const opened = await test.store.open(summary.id);
    if (!opened) throw new Error("Missing session");
    const owner = await opened.session.bindHarness(() =>
      Harness.open(opened.storage, { models: createModels(), registry: createRegistry() }, context),
    );
    await owner.commit(async (tx) => {
      (await tx.doc(UsageDoc, opened.conversationId)).models["provider/model"] = {
        ...emptyUsage(),
        input: 7,
        totalTokens: 7,
      };
    }, context);
    await test.store.close();
    let openedCount = 0;
    let closedCount = 0;
    const reader: SessionStore = createSessionStore(test.directory, {
      openStorage: async (file) => {
        openedCount++;
        const storage = await openNodeSqliteStorage(file);
        const close = storage.close.bind(storage);
        storage.close = async (ctx) => {
          closedCount++;
          await close(ctx);
        };
        return storage;
      },
    });
    cleanups.push(() => reader.close());
    const report = await createUsageStatsService({ store: reader }).report();
    expect(report.totalTokens).toBe(7);
    expect(report.undatedTokens).toBeUndefined();
    expect(report.days).toHaveLength(1);
    expect(openedCount).toBeGreaterThan(0);
    expect(closedCount).toBe(openedCount);
    expect((await reader.readUsage(summary.id))?.tokenUsage.uncachedInputTokens).toBe(7);
  });
});
