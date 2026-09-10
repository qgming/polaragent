import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type AgentMessage, BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import {
  createNodeSqliteFactory,
  SqliteSessionRepo,
} from "@earendil-works/pi-session-backend-sqlite-node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TextPart } from "@/shared/contracts/session";
import { createSessionStore, type SessionStore } from "./session-store";
import { createSessionsIndex } from "./sessions-index";

let baseDir: string;
let repo: SqliteSessionRepo;
let store: SessionStore;
let clock: number;

function userMessage(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: Date.now() };
}

function textOf(message: { parts: unknown[] } | undefined): string {
  const part = message?.parts[0] as TextPart | undefined;
  return part?.text ?? "";
}

beforeEach(async () => {
  baseDir = await mkdtemp(path.join(os.tmpdir(), "polaragent-sessions-"));
  clock = 1_700_000_000_000;
  // 注入递增时钟，保证 list 排序断言稳定
  repo = new SqliteSessionRepo({
    directory: path.join(baseDir, "sessions"),
    databaseFactory: createNodeSqliteFactory(),
    now: () => (clock += 1_000),
  });
  store = createSessionStore(baseDir, repo);
});

afterEach(async () => {
  await repo.close(BACKGROUND_CONTEXT);
  await rm(baseDir, { recursive: true, force: true });
});

describe("session-store", () => {
  it("create 两个会话后 list 按 updatedAt 降序并补齐字段", async () => {
    const first = await store.create({ title: "会话一", cwd: "D:\\workspace" });
    const second = await store.create({ title: "会话二" });

    const list = await store.list();
    expect(list.map((item) => item.id)).toEqual([second.id, first.id]);
    expect(list[0]).toMatchObject({
      id: second.id,
      title: "会话二",
      archived: false,
      messageCount: 0,
      cwd: "",
      updatedAt: second.createdAt,
    });
    expect(list[1]).toMatchObject({
      id: first.id,
      title: "会话一",
      cwd: "D:\\workspace",
      createdAt: first.createdAt,
      updatedAt: first.createdAt,
    });
  });

  it("rename 同时写会话名与索引", async () => {
    const summary = await store.create({ title: "旧标题" });
    await store.rename(summary.id, "新标题");

    const row = (await store.list()).find((item) => item.id === summary.id);
    expect(row?.title).toBe("新标题");

    const opened = await store.open(summary.id);
    expect(opened).toBeDefined();
    if (!opened) throw new Error("会话应能打开");
    await expect(opened.session.getName(BACKGROUND_CONTEXT)).resolves.toBe("新标题");
  });

  it("setArchived 生效", async () => {
    const summary = await store.create();
    await store.setArchived(summary.id, true);
    expect((await store.list())[0]?.archived).toBe(true);
  });

  it("fork 到第 2 条：记录 parentSessionId 且消息前缀一致", async () => {
    const source = await store.create({ title: "源会话" });
    const opened = await store.open(source.id);
    expect(opened).toBeDefined();
    if (!opened) throw new Error("源会话应能打开");
    const branch = opened.branch;
    const firstEntry = await branch.appendMessage(userMessage("一"), BACKGROUND_CONTEXT);
    const secondEntry = await branch.appendMessage(userMessage("二"), BACKGROUND_CONTEXT);
    await branch.appendMessage(userMessage("三"), BACKGROUND_CONTEXT);

    const forked = await store.fork(source.id, secondEntry);
    expect(forked.parentSessionId).toBe(source.id);
    expect(forked.title).toBe("源会话 · 分支");
    expect(forked.messageCount).toBe(2);

    const forkedMessages = await store.loadMessages(forked.id);
    expect(forkedMessages.messages.map((message) => message.id)).toEqual([firstEntry, secondEntry]);
    expect(forkedMessages.messages.map((message) => textOf(message))).toEqual(["一", "二"]);

    // 源会话不受影响，占位 lane 元数据已清理
    const sourceMessages = await store.loadMessages(source.id);
    expect(sourceMessages.messages).toHaveLength(3);

    const listed = (await store.list()).find((item) => item.id === forked.id);
    expect(listed?.parentSessionId).toBe(source.id);
  });

  it("remove 物理删除并清索引", async () => {
    const summary = await store.create({ title: "删除我" });
    await store.open(summary.id);

    await store.remove(summary.id);
    expect((await store.list()).some((item) => item.id === summary.id)).toBe(false);
    expect((await store.loadMessages(summary.id)).messages).toEqual([]);

    const index = await createSessionsIndex(baseDir).read();
    expect(index[summary.id]).toBeUndefined();
  });

  it("loadMessages 分页：先取 40 条再按 nextCursor 取上一页", async () => {
    const summary = await store.create({ title: "分页" });
    const opened = await store.open(summary.id);
    expect(opened).toBeDefined();
    if (!opened) throw new Error("分页会话应能打开");
    const branch = opened.branch;
    for (let i = 1; i <= 60; i += 1) {
      await branch.appendMessage(userMessage(`消息${i}`), BACKGROUND_CONTEXT);
    }

    const entries = await branch.findEntries({ order: "oldestFirst" }, BACKGROUND_CONTEXT);
    const seqs = entries.map((entry) => entry.seq);
    expect(seqs).toHaveLength(60);

    const firstPage = await store.loadMessages(summary.id, { limit: 40 });
    expect(firstPage.messages).toHaveLength(40);
    expect(firstPage.nextCursor).toBe(seqs[20]);
    expect(textOf(firstPage.messages[0])).toBe("消息21");
    expect(textOf(firstPage.messages[39])).toBe("消息60");

    const cursor = firstPage.nextCursor;
    if (cursor === undefined) throw new Error("首页应返回分页游标");
    const secondPage = await store.loadMessages(summary.id, {
      limit: 40,
      beforeSeq: cursor,
    });
    expect(secondPage.messages).toHaveLength(20);
    expect(secondPage.nextCursor).toBeUndefined();
    expect(textOf(secondPage.messages[0])).toBe("消息1");
    expect(textOf(secondPage.messages[19])).toBe("消息20");

    // 索引里的 messageCount 按需补齐为总消息数
    const index = await createSessionsIndex(baseDir).read();
    expect(index[summary.id]?.messageCount).toBe(60);
  });

  it("loadMessages 对不存在的会话返回空结果且不抛错", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(store.loadMessages("not-exists")).resolves.toEqual({
      messages: [],
      compactionSummaries: [],
    });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
