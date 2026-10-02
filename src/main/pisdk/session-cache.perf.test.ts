import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, type Storage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { describe, expect, it } from "vitest";
import { createSessionStore } from "./session-store";

describe("native session metadata cache", () => {
  it("metadata reads close their connections and history queries bound fetched rows", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "oint-bounded-history-"));
    const seed = createSessionStore(directory);
    const created = await seed.create({ cwd: directory });
    await seed.create({ cwd: directory });
    const initial = await seed.open(created.id);
    if (!initial) throw new Error("Missing session");
    const owner = await initial.session.bindHarness(() =>
      Harness.open(
        initial.storage,
        { models: createModels(), registry: createRegistry() },
        context,
      ),
    );
    await owner.commit(async (tx) => {
      for (let i = 0; i < 140; i++)
        await tx.appendEntry(initial.conversationId, {
          kind: "pi.user",
          model: [{ role: "user", content: `message ${i}`, timestamp: i + 1 }],
        });
    }, context);
    await seed.touch(created.id, { messageCount: 140 });
    await seed.close();
    const active = new Set<Storage>();
    const limits: number[] = [];
    let rows = 0;
    const store = createSessionStore(directory, {
      openStorage: async (file) => {
        const storage = await openNodeSqliteStorage(file);
        active.add(storage);
        const close = storage.close.bind(storage);
        storage.close = async (ctx) => {
          try {
            await close(ctx);
          } finally {
            active.delete(storage);
          }
        };
        const scan = storage.scanEntries.bind(storage);
        storage.scanEntries = async (...args) => {
          limits.push(args[1]);
          const page = await scan(...args);
          rows += page.items.length;
          return page;
        };
        return storage;
      },
    });
    try {
      expect(await store.list()).toHaveLength(2);
      expect(active.size).toBe(0);
      expect(limits).toEqual([]);
      const recent = await store.loadMessages(created.id, { limit: 10 });
      expect(active.size).toBe(1);
      expect(limits).toEqual([11]);
      expect(rows).toBe(11);
      const opened = await store.open(created.id);
      if (!opened || !recent.messages[0]?.entryId) throw new Error("Missing history");
      await opened.session.getEntry(recent.messages[0].entryId, context);
      expect(limits).toEqual([11, 2]);
      expect(rows).toBe(13);
      // Usage queries read the native ledger, never the transcript.
      expect((await store.scanUsageSamples(created.id, 0, 5)).entries).toBe(0);
      expect(rows).toBe(13);
      const first = await opened.session.oldestPage(5, 0, context);
      expect(first.entries).toHaveLength(5);
      expect(rows).toBe(153);
      const cursor = first.entries.at(-1)?.sequence;
      if (cursor === undefined) throw new Error("Expected a complete first history page");
      const second = await opened.session.oldestPage(5, cursor, context);
      expect(second.entries).toHaveLength(5);
      expect(rows).toBe(153);
      await store.loadMessages(created.id, { limit: 2, order: "oldestFirst" });
      expect(rows).toBe(153);
      const writer = await opened.session.bindHarness(() =>
        Harness.open(
          opened.storage,
          { models: createModels(), registry: createRegistry() },
          context,
        ),
      );
      const boundRows = rows;
      await writer.commit(
        (tx) =>
          tx.appendEntry(opened.conversationId, {
            kind: "pi.user",
            model: [{ role: "user", content: "new", timestamp: 1000 }],
          }),
        context,
      );
      expect(await opened.session.allEntries()).toHaveLength(141);
      expect(rows).toBe(boundRows);
    } finally {
      await store.close();
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 20_000);
  it("reuses opened storage across repeated lists", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "oint-cache-perf-"));
    const store = createSessionStore(directory);
    try {
      for (let i = 0; i < 20; i++) await store.create({ title: `会话 ${i}`, cwd: directory });
      const start = performance.now();
      const first = await store.list();
      const initialMs = performance.now() - start;
      const owners = await Promise.all(first.map((session) => store.open(session.id)));
      const repeat = performance.now();
      expect(await store.list()).toEqual(first);
      expect(await Promise.all(first.map((session) => store.open(session.id)))).toEqual(owners);
      expect(first).toHaveLength(20);
      console.log(
        `20 sessions: initial ${initialMs.toFixed(1)} ms; cached ${(performance.now() - repeat).toFixed(1)} ms`,
      );
    } finally {
      await store.close();
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 20_000);
});
