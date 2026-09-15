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
import type { SubagentRun } from "@/shared/contracts/subagent";
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
  baseDir = await mkdtemp(path.join(os.tmpdir(), "oint-sessions-"));
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

  it("readTitle 区分「还没命名」与已有标题", async () => {
    const summary = await store.create();
    await expect(store.readTitle(summary.id)).resolves.toBeNull();

    await store.rename(summary.id, "自动命名结果");
    await expect(store.readTitle(summary.id)).resolves.toBe("自动命名结果");

    // 空白的标题视为未命名，自动命名仍可补上
    await store.rename(summary.id, "   ");
    await expect(store.readTitle(summary.id)).resolves.toBeNull();
  });

  it("oldestFirst 从会话开头取，newestFirst 取尾部（自动命名需要前者）", async () => {
    const summary = await store.create();
    const opened = await store.open(summary.id);
    if (!opened) throw new Error("会话应能打开");

    for (const text of ["第一问", "第一答", "第二问", "第二答"]) {
      await opened.branch.appendMessage(userMessage(text), BACKGROUND_CONTEXT);
    }
    const head = await store.loadMessages(summary.id, { limit: 2, order: "oldestFirst" });
    expect(head.messages.map(textOf)).toEqual(["第一问", "第一答"]);
    // 取满即给游标，供继续向下翻
    expect(head.nextCursor).toBeTypeOf("number");

    const tail = await store.loadMessages(summary.id, { limit: 2 });
    expect(tail.messages.map(textOf)).toEqual(["第二问", "第二答"]);
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

  it("setPinned 写索引并能从 list 读回", async () => {
    const target = await store.create({ title: "置顶目标" });
    const other = await store.create({ title: "不受影响" });
    expect(target.pinned).toBe(false);
    expect((await store.list()).find((item) => item.id === target.id)?.pinned).toBe(false);

    await store.setPinned(target.id, true);
    const pinned = await store.list();
    expect(pinned.find((item) => item.id === target.id)?.pinned).toBe(true);
    expect(pinned.find((item) => item.id === other.id)?.pinned).toBe(false);

    await store.setPinned(target.id, false);
    expect((await store.list()).find((item) => item.id === target.id)?.pinned).toBe(false);
  });

  it("readCwd 区分未绑定与已绑定", async () => {
    const unbound = await store.create();
    await expect(store.readCwd(unbound.id)).resolves.toBeNull();

    const bound = await store.create({ cwd: "D:\\work\\demo" });
    await expect(store.readCwd(bound.id)).resolves.toBe("D:\\work\\demo");

    // 纯空白视为未绑定，避免把空格当工作目录用
    const blank = await store.create({ cwd: "   " });
    await expect(store.readCwd(blank.id)).resolves.toBeNull();
  });

  it("readModel / setModel：会话级模型绑定能存能读，写 null 即清除", async () => {
    const session = await store.create();
    // 新建会话不绑定模型（跟随默认）
    await expect(store.readModel(session.id)).resolves.toBeNull();
    await expect(store.list()).resolves.toContainEqual(
      expect.objectContaining({ id: session.id, model: null }),
    );

    const ref = { serviceId: "svc-a", modelId: "m1" };
    await store.setModel(session.id, ref);
    await expect(store.readModel(session.id)).resolves.toEqual(ref);
    // summary 也要带上（渲染层靠它渲染 chip 与思考档位）
    const bound = (await store.list()).find((item) => item.id === session.id);
    expect(bound?.model).toEqual(ref);

    // 清除绑定：必须能落盘成 null，否则重启后旧绑定又回来了
    await store.setModel(session.id, null);
    await expect(store.readModel(session.id)).resolves.toBeNull();
    const cleared = (await store.list()).find((item) => item.id === session.id);
    expect(cleared?.model).toBeNull();
  });

  it("索引里被手改坏的 model 视为未绑定（不抛错、也不返回半个引用）", async () => {
    const session = await store.create();
    const index = createSessionsIndex(baseDir);
    // 缺 modelId / 类型不对 / 全是空白：都应该回落到 null
    for (const broken of [{ serviceId: "svc-a" }, "svc-a/m1", { serviceId: " ", modelId: "m1" }]) {
      await index.update(session.id, { model: broken as never });
      await expect(store.readModel(session.id)).resolves.toBeNull();
    }
  });

  /**
   * 子智能体运行记录的**真实**落盘往返。
   *
   * 为什么必须有这一条（而不是只靠 subagent-runner 里那份 mock 过的 store）：
   * 「进程在上一次运行期间退出」这件事只能靠索引里那条记录认出来，
   * 而 runner 的测试把 store 整个换成了 stub —— 那只证明「它调了 saveSubagentRun」，
   * 证明不了「写进去的东西真的能被下一个进程按父会话读回来」。这里用真索引走一遍。
   */
  describe("子智能体运行记录", () => {
    function makeRun(patch: Partial<SubagentRun> = {}): SubagentRun {
      return {
        delegationId: "d-1",
        sessionId: "s-parent",
        parentToolCallId: "d-1",
        childSessionId: "child-1",
        agentName: "scout",
        agentSource: "builtin",
        description: "调研重试逻辑",
        task: "看 src/retry.ts",
        status: "running",
        startedAt: 1_000,
        model: null,
        modelId: "svc/model-x",
        thinkingLevel: "medium",
        maxTurns: 30,
        tools: ["read", "grep"],
        turns: 2,
        toolCalls: 3,
        updatedAt: 2_000,
        ...patch,
      };
    }

    /** 建一个子智能体子会话：kind 与 parentSessionId 决定了它会不会被 listSubagentRunsFor 认领 */
    async function makeChild(delegationId: string, parentSessionId: string) {
      return store.create({
        title: `scout · ${delegationId}`,
        kind: "subagent",
        parentSessionId,
        parentToolCallId: delegationId,
        agentName: "scout",
        delegationId,
      });
    }

    it("写进子会话条目后能按父会话读回来，且字段完整", async () => {
      const parent = await store.create({ title: "父会话" });
      const child = await makeChild("d-1", parent.id);
      const run = makeRun({ sessionId: parent.id, childSessionId: child.id });

      await store.saveSubagentRun(child.id, run);
      const runs = await store.listSubagentRunsFor(parent.id);

      expect(runs).toHaveLength(1);
      // 全字段往返，不只是 id：面板与 TaskList 都直接读这份记录
      expect(runs[0]).toEqual(run);
    });

    it("只认自己的父会话，别的会话与 kind 不匹配的条目都不出现", async () => {
      const mine = await store.create({ title: "我的会话" });
      const other = await store.create({ title: "别人的会话" });
      const mineChild = await makeChild("d-mine", mine.id);
      const otherChild = await makeChild("d-other", other.id);
      // 普通会话（kind 缺省 = chat）即使被塞了运行记录也不该被认领
      const plain = await store.create({ title: "普通会话" });

      await store.saveSubagentRun(
        mineChild.id,
        makeRun({ sessionId: mine.id, childSessionId: mineChild.id, delegationId: "d-mine" }),
      );
      await store.saveSubagentRun(
        otherChild.id,
        makeRun({ sessionId: other.id, childSessionId: otherChild.id, delegationId: "d-other" }),
      );
      await store.saveSubagentRun(
        plain.id,
        makeRun({ sessionId: plain.id, childSessionId: plain.id }),
      );

      const runs = await store.listSubagentRunsFor(mine.id);
      expect(runs.map((run) => run.delegationId)).toEqual(["d-mine"]);
    });

    it("重写同一条子会话即覆盖：终点那份记录盖掉起点那份", async () => {
      const parent = await store.create({ title: "父会话" });
      const child = await makeChild("d-1", parent.id);
      await store.saveSubagentRun(
        child.id,
        makeRun({ sessionId: parent.id, childSessionId: child.id }),
      );
      await store.saveSubagentRun(
        child.id,
        makeRun({
          sessionId: parent.id,
          childSessionId: child.id,
          status: "interrupted",
          endedAt: 5_000,
          updatedAt: 5_000,
        }),
      );

      const runs = await store.listSubagentRunsFor(parent.id);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ status: "interrupted", endedAt: 5_000 });
    });

    it("多条运行按 startedAt 升序（面板与 TaskList 直接沿用这个顺序）", async () => {
      const parent = await store.create({ title: "父会话" });
      const late = await makeChild("d-late", parent.id);
      const early = await makeChild("d-early", parent.id);
      await store.saveSubagentRun(
        late.id,
        makeRun({
          sessionId: parent.id,
          childSessionId: late.id,
          delegationId: "d-late",
          startedAt: 9_000,
        }),
      );
      await store.saveSubagentRun(
        early.id,
        makeRun({
          sessionId: parent.id,
          childSessionId: early.id,
          delegationId: "d-early",
          startedAt: 1_000,
        }),
      );

      const runs = await store.listSubagentRunsFor(parent.id);
      expect(runs.map((run) => run.delegationId)).toEqual(["d-early", "d-late"]);
    });

    it("索引里的坏记录被跳过，不让整份列表消失", async () => {
      const parent = await store.create({ title: "父会话" });
      const good = await makeChild("d-good", parent.id);
      const bad = await makeChild("d-bad", parent.id);
      await store.saveSubagentRun(
        good.id,
        makeRun({ sessionId: parent.id, childSessionId: good.id, delegationId: "d-good" }),
      );
      // 越过类型把坏数据直接写进索引：缺 delegationId 的运行记录必须被解析层拒掉。
      // 索引是外部 JSON，手改坏是真会发生的（见实现里那条跳过注释）。
      await createSessionsIndex(baseDir).update(bad.id, {
        subagentRun: { status: "running" },
      } as never);

      const runs = await store.listSubagentRunsFor(parent.id);
      expect(runs.map((run) => run.delegationId)).toEqual(["d-good"]);
    });
  });
});
