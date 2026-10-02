import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionWorkspaceDir } from "@/main/app/paths";
import type { TextPart } from "@/shared/contracts/session";
import { SessionMetadataDoc } from "./durable-session";
import { createSessionStore, type OpenedSession, type SessionStore } from "./session-store";
import { createSessionsIndex } from "./sessions-index";

let baseDir: string;
let store: SessionStore;
let clock: number;

function userMessage(text: string): Message {
  return { role: "user", content: text, timestamp: Date.now() };
}

function textOf(message: { parts: unknown[] } | undefined): string {
  const part = message?.parts[0] as TextPart | undefined;
  return part?.text ?? "";
}

async function appendMessage(
  opened: OpenedSession,
  message: Message,
  _context = BACKGROUND_CONTEXT,
) {
  const owner = await opened.session.bindHarness(() =>
    Harness.open(
      opened.storage,
      { models: createModels(), registry: createRegistry() },
      BACKGROUND_CONTEXT,
    ),
  );
  const record = await owner.commit(
    (tx) =>
      tx.appendEntry(opened.session.activeConversationId, {
        kind: message.role === "toolResult" ? "pi.tool-result" : `pi.${message.role}`,
        model: [message],
      }),
    BACKGROUND_CONTEXT,
  );
  return opened.session.projectEntry(record).entryId;
}

beforeEach(async () => {
  baseDir = await mkdtemp(path.join(os.tmpdir(), "oint-sessions-"));
  clock = 1_700_000_000_000;
  store = createSessionStore(baseDir, { now: () => (clock += 1000) });
});

afterEach(async () => {
  await store.close();
  await rm(baseDir, { recursive: true, force: true });
});

describe("session-store", () => {
  /**
   * 元数据缓存（P2-1）。
   *
   * `repo.list()` 对每个会话文件做 readdir → realpath → open → query → close，
   * 底层是同步 sqlite —— 本机 50 个会话实测每次约 220 ms 的主进程阻塞。
   * 缓存之后「重复 list」不该再触发它。
   */
  describe("会话元数据缓存", () => {
    it("连续两次 list 只扫盘一次", async () => {
      const created = await store.create({ title: "会话一" });
      await store.list();
      const opened = await store.open(created.id);

      await store.list();
      await store.list();

      expect(await store.open(created.id)).toBe(opened);
    });

    it("create 之后缓存失效：新建的会话立刻出现在列表里", async () => {
      await store.list();
      const created = await store.create({ title: "新的" });

      const list = await store.list();
      expect(list.map((item) => item.id)).toContain(created.id);
    });

    it("remove 之后缓存失效：被删的会话不再出现", async () => {
      const created = await store.create({ title: "待删" });
      await store.list();

      await store.remove(created.id);

      const list = await store.list();
      expect(list.map((item) => item.id)).not.toContain(created.id);
    });

    it("fork 之后缓存失效：分支会话出现在列表里", async () => {
      const source = await store.create({ title: "源" });
      const opened = await store.open(source.id);
      if (!opened) throw new Error("源会话应能打开");
      const entry = await appendMessage(opened, userMessage("一"), BACKGROUND_CONTEXT);
      await store.list();

      const forked = await store.fork(source.id, entry);

      const list = await store.list();
      expect(list.map((item) => item.id)).toContain(forked.id);
    });
  });

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
      // 没给工作目录的会话拿的是自己的临时工作区（不是空串，也不是进程当前目录）
      cwd: sessionWorkspaceDir(second.id, baseDir),
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
    await expect(store.readTitle(summary.id)).resolves.toBe("新标题");
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
      await appendMessage(opened, userMessage(text), BACKGROUND_CONTEXT);
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
    await appendMessage(opened, userMessage("一"), BACKGROUND_CONTEXT);
    const secondEntry = await appendMessage(opened, userMessage("二"), BACKGROUND_CONTEXT);
    await appendMessage(opened, userMessage("三"), BACKGROUND_CONTEXT);

    const forked = await store.fork(source.id, secondEntry);
    expect(forked.parentSessionId).toBe(source.id);
    expect(forked.title).toBe("源会话 · 分支");
    expect(forked.messageCount).toBe(2);

    const forkedMessages = await store.loadMessages(forked.id);
    expect(forkedMessages.messages.every((message) => message.entryId?.startsWith("entry:"))).toBe(
      true,
    );
    expect(forkedMessages.messages.map((message) => textOf(message))).toEqual(["一", "二"]);

    // 源会话不受影响，原生分支副本没有修改源记录
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
    for (let i = 1; i <= 60; i += 1) {
      await appendMessage(opened, userMessage(`消息${i}`), BACKGROUND_CONTEXT);
    }

    const entries = await opened.session.allEntries();
    const seqs = entries.map((entry) => entry.sequence);
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
    expect(index[summary.id]?.messageCount).toBe(0);
    expect((await store.list()).find((entry) => entry.id === summary.id)?.messageCount).toBe(60);
  });

  it("loadMessages 对不存在的会话返回空结果且不抛错", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(store.loadMessages("not-exists")).resolves.toEqual({
      messages: [],
      compactionSummaries: [],
    });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  describe("用量快照持久化", () => {
    const RECORD = {
      stats: {
        turns: 3,
        steps: 25,
        llmMs: 351_000,
        toolMs: 12_500,
        ttftMs: 13_700,
        ttftSteps: 1,
        decodeMs: 8_000,
        decodeTokens: 13_184,
      },
      tokenUsage: {
        uncachedInputTokens: 72_388,
        outputTokens: 14_153,
        cacheReadTokens: 1_054_208,
        cacheWriteTokens: 0,
      },
      breakdown: { systemTokens: 1_800, toolsTokens: 7_100, messageTokens: 63_800 },
    };

    it("写入后能原样读回", async () => {
      const session = await store.create({ title: "有用量" });
      await store.writeUsage(session.id, RECORD);
      await expect(store.readUsage(session.id)).resolves.toEqual({
        ...RECORD,
        tokenUsage: {
          uncachedInputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      });
    });

    it("没有记录时返回 undefined（新会话不编造全 0 数据）", async () => {
      const session = await store.create();
      await expect(store.readUsage(session.id)).resolves.toBeUndefined();
    });

    it("写用量不刷新 updatedAt（不该把会话顶到侧栏最前）", async () => {
      const session = await store.create({ title: "排序不受影响" });
      const before = (await store.list()).find((item) => item.id === session.id)?.updatedAt;
      await store.writeUsage(session.id, RECORD);
      const after = (await store.list()).find((item) => item.id === session.id)?.updatedAt;
      expect(after).toBe(before);
    });

    it("后写入整体替换前一次（不是字段合并）", async () => {
      const session = await store.create();
      await store.writeUsage(session.id, RECORD);
      const second = {
        ...RECORD,
        stats: { ...RECORD.stats, steps: 40 },
        breakdown: { systemTokens: 2_000, toolsTokens: 7_000, messageTokens: 90_000 },
      };
      await store.writeUsage(session.id, second);
      const read = await store.readUsage(session.id);
      expect(read?.stats.steps).toBe(40);
      expect(read?.breakdown).toEqual(second.breakdown);
    });

    it("坏数据整条作废（缺一段 / 负数 / 非数）", async () => {
      const session = await store.create();
      const cases: unknown[] = [
        { stats: RECORD.stats, tokenUsage: RECORD.tokenUsage }, // 缺 breakdown
        { ...RECORD, breakdown: { systemTokens: -1, toolsTokens: 0, messageTokens: 0 } },
        { ...RECORD, tokenUsage: { ...RECORD.tokenUsage, outputTokens: "很多" } },
        { ...RECORD, stats: { ...RECORD.stats, steps: null } },
        "不是对象",
        null,
      ];
      for (const bad of cases) {
        await writeFile(
          path.join(baseDir, "sessions-index.json"),
          JSON.stringify({ [session.id]: { usage: bad } }),
        );
        await expect(store.readUsage(session.id)).resolves.toBeUndefined();
      }
    });

    it("会话删除后用量随之消失", async () => {
      const session = await store.create();
      await store.writeUsage(session.id, RECORD);
      await store.remove(session.id);
      await expect(store.readUsage(session.id)).resolves.toBeUndefined();
    });
  });

  /**
   * 级联删除：删父会话时，它名下的子智能体会话必须一起删掉。
   *
   * 为什么这条重要：子会话是**真实落盘**的会话，但 `list` 时按 hidden kind 过滤掉，
   * 所以它们在左侧栏里看不见。父会话一删，这些子会话就成了永远看不见、也删不掉的
   * 磁盘垃圾 —— 每派一次子智能体就留一份。这里钉住级联行为。
   */
  describe("删除父会话时级联删除子会话", () => {
    it("普通会话（kind=chat）不作为子会话被误删", async () => {
      const parent = await store.create({ title: "父" });
      // 一个 parentSessionId 恰好指向父、但 kind 是 chat 的会话（例如旧版 fork 的遗留）：
      // 只认 kind === "subagent"，不能因为 parentSessionId 相同就删掉别人的数据
      const forked = await store.create({ title: "普通会话", parentSessionId: parent.id });

      await store.remove(parent.id);

      const after = await store.list();
      expect(after.find((item) => item.id === forked.id)).toBeDefined();
    });
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

  /**
   * 会话的临时工作区（`<数据根>/workspaces/<会话 id>`）。
   *
   * 它存在的理由：会话原先可以「没有工作目录」，而文件面板 / 终端 / 执行环境都拿它当根 ——
   * 结果是模型写过的文件在右侧一律打不开。现在**每个会话都有根**：调用方给了就用它
   *（在项目里新建的会话、子会话），没给就建一个本会话的临时目录。
   *
   * 三组不变量：
   *   1. 建会话时就把目录建出来（执行环境要拿它当 cwd，不存在会直接跑不起来）；
   *   2. 缺失目录绑定的会话（索引里没有 cwd）由 ensureCwd / list 补上，且补出来的值会落盘；
   *   3. 删会话只清这一份目录，用户显式保存到别处（含子会话共享的父工作区）的文件不受影响。
   */
  describe("会话临时工作区", () => {
    it("create 没给工作目录时绑定本会话的临时工作区，且目录真的建出来", async () => {
      const created = await store.create();
      const expected = sessionWorkspaceDir(created.id, baseDir);

      expect(created.cwd).toBe(expected);
      await expect(store.readCwd(created.id)).resolves.toBe(expected);
      // 目录必须存在：执行环境拿它当 cwd，终端拿它当启动目录，缺了会直接失败
      await expect(stat(expected)).resolves.toBeDefined();

      const bound = await store.create({ cwd: "D:\\work\\demo" });
      await expect(store.readCwd(bound.id)).resolves.toBe("D:\\work\\demo");
      // 显式绑定的会话不该多出一个没人用的临时目录
      await expect(stat(sessionWorkspaceDir(bound.id, baseDir))).rejects.toThrow();

      // 纯空白视为「没给」：它会拼出含糊的相对路径，下游很容易变成进程当前目录
      const blank = await store.create({ cwd: "   " });
      await expect(store.readCwd(blank.id)).resolves.toBe(sessionWorkspaceDir(blank.id, baseDir));
    });

    it("ensureCwd：缺失目录绑定的会话现补一个临时工作区并落盘，重复调用是同一个目录", async () => {
      const legacy = await store.create({ cwd: "D:\\legacy" });
      // 模拟损坏的写下的索引条目：把 cwd 抹掉（JSON 里没有这个键）
      const opened = await store.open(legacy.id);
      if (!opened) throw new Error("Missing session");
      await opened.session.withSession((owner) =>
        owner.commit(async (tx) => {
          delete (await tx.doc(SessionMetadataDoc)).attributes.cwd;
        }, BACKGROUND_CONTEXT),
      );
      await expect(store.readCwd(legacy.id)).resolves.toBeNull();

      const dir = await store.ensureCwd(legacy.id);
      expect(dir).toBe(sessionWorkspaceDir(legacy.id, baseDir));
      // 落盘：下一个进程读到的就是它，不必再补一次
      await expect(store.readCwd(legacy.id)).resolves.toBe(dir);
      // 幂等：不会每问一次就换一个目录
      await expect(store.ensureCwd(legacy.id)).resolves.toBe(dir);
    });

    it("list 给缺失目录绑定的会话补上临时工作区（界面看到的 cwd 与主进程用的是同一个）", async () => {
      const legacy = await store.create({ cwd: "D:\\legacy" });
      const opened = await store.open(legacy.id);
      if (!opened) throw new Error("Missing session");
      await opened.session.withSession((owner) =>
        owner.commit(async (tx) => {
          delete (await tx.doc(SessionMetadataDoc)).attributes.cwd;
        }, BACKGROUND_CONTEXT),
      );

      const row = (await store.list()).find((item) => item.id === legacy.id);
      expect(row?.cwd).toBe(sessionWorkspaceDir(legacy.id, baseDir));
      // 目录真的建出来了：终端会拿这个值当启动目录
      await expect(stat(row?.cwd ?? "")).resolves.toBeDefined();
      // 已经写进索引，不是每次列表都现算
      const index = await createSessionsIndex(baseDir).read();
      expect(index[legacy.id]?.cwd).toBe(sessionWorkspaceDir(legacy.id, baseDir));
    });

    it("ensureCwd 对不存在的会话抛错（不为拼错的 id 留下没人认领的目录）", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      await expect(store.ensureCwd("not-exists")).rejects.toThrow(/会话不存在/);
      await expect(stat(sessionWorkspaceDir("not-exists", baseDir))).rejects.toThrow();
      warn.mockRestore();
    });

    it("删会话时清掉它的临时工作区，但不碰显式绑定的目录", async () => {
      const scratch = await store.create();
      const scratchDir = sessionWorkspaceDir(scratch.id, baseDir);
      await writeFile(path.join(scratchDir, "note.md"), "临时文件\n", "utf8");

      // 显式绑定的目录：用户让模型「保存到别处」的那一类
      const realDir = path.join(baseDir, "user-project");
      await mkdir(realDir, { recursive: true });
      await writeFile(path.join(realDir, "keep.md"), "用户文件\n", "utf8");
      const bound = await store.create({ cwd: realDir });

      await store.remove(scratch.id);
      await expect(stat(scratchDir)).rejects.toThrow();

      await store.remove(bound.id);
      await expect(stat(path.join(realDir, "keep.md"))).resolves.toBeDefined();
    });

    it("分支会话继承源会话的工作目录，最后一个使用者被删时才清目录", async () => {
      const source = await store.create({ title: "源" });
      const sourceDir = sessionWorkspaceDir(source.id, baseDir);
      await writeFile(path.join(sourceDir, "shared.md"), "x\n", "utf8");
      const opened = await store.open(source.id);
      if (!opened) throw new Error("源会话应能打开");
      const entry = await appendMessage(opened, userMessage("一"), BACKGROUND_CONTEXT);

      const forked = await store.fork(source.id, entry);
      // 分支接着同一段对话，文件也在同一个目录里
      expect(forked.cwd).toBe(sourceDir);

      // 删源会话：目录还被分支用着，不能清（否则分支的根变成一个不存在的目录）
      await store.remove(source.id);
      await expect(stat(path.join(sourceDir, "shared.md"))).resolves.toBeDefined();

      // 分支也没了，这时才真正清掉
      await store.remove(forked.id);
      await expect(stat(sourceDir)).rejects.toThrow();
    });
  });

  /**
   * 新会话页「选择项目」的落点。
   *
   * 会话在创建时就有一个根（显式给的目录，或本会话的临时工作区），所以「先选项目再开聊」
   * 只能是**改绑定**。这里验的是那条通道的三条拒绝理由与一次清理 —— 它们都属于
   * 「改了就说不清」或「改了会留垃圾」的那一类，出了错在界面上看不出来。
   */
  describe("setCwd（改绑工作目录）", () => {
    it("把空会话改绑到项目目录，并把原来的临时工作区清掉", async () => {
      const created = await store.create({ title: "新会话" });
      const tempDir = sessionWorkspaceDir(created.id, baseDir);
      await writeFile(path.join(tempDir, "scratch.md"), "临时\n", "utf8");

      const projectDir = path.join(baseDir, "user-project");
      await mkdir(projectDir, { recursive: true });

      await store.setCwd(created.id, projectDir);

      await expect(store.readCwd(created.id)).resolves.toBe(projectDir);
      // 列表里也变了：侧栏靠它分组（项目 / 最近）
      const row = (await store.list()).find((item) => item.id === created.id);
      expect(row?.cwd).toBe(projectDir);
      // 原来那个临时工作区只跟着这个会话存在，换根之后它没有主人了
      await expect(stat(tempDir)).rejects.toThrow();
    });

    it("显式绑定的目录不会被当成临时工作区清掉", async () => {
      const realDir = path.join(baseDir, "user-project");
      await mkdir(realDir, { recursive: true });
      await writeFile(path.join(realDir, "keep.md"), "用户文件\n", "utf8");
      const bound = await store.create({ cwd: realDir });

      const otherDir = path.join(baseDir, "another");
      await mkdir(otherDir, { recursive: true });
      await store.setCwd(bound.id, otherDir);

      // 判据是「cwd 是不是 workspaces 根的直接子目录」：用户目录不在其中，必须原样留着
      await expect(stat(path.join(realDir, "keep.md"))).resolves.toBeDefined();
    });

    it("已有消息的会话拒绝改（相对路径是按当时的根解析的）", async () => {
      const used = await store.create({ title: "聊过了" });
      const opened = await store.open(used.id);
      if (!opened) throw new Error("Missing session");
      await appendMessage(opened, userMessage("已有内容"));

      const projectDir = path.join(baseDir, "user-project");
      await mkdir(projectDir, { recursive: true });

      await expect(store.setCwd(used.id, projectDir)).rejects.toThrow(/已有消息/);
      await expect(store.readCwd(used.id)).resolves.toBe(sessionWorkspaceDir(used.id, baseDir));
    });

    it("目标不是已存在的目录时拒绝（不留一个下次发送必然失败的根）", async () => {
      const created = await store.create();
      const missing = path.join(baseDir, "nope");

      await expect(store.setCwd(created.id, missing)).rejects.toThrow(/目录不存在/);
      await expect(store.setCwd(created.id, "   ")).rejects.toThrow(/不能为空/);
      await expect(store.readCwd(created.id)).resolves.toBe(
        sessionWorkspaceDir(created.id, baseDir),
      );
    });

    it("会话不存在时拒绝（不为拼错的 id 写出一条指向任意目录的索引项）", async () => {
      const projectDir = path.join(baseDir, "user-project");
      await mkdir(projectDir, { recursive: true });

      await expect(store.setCwd("not-exists", projectDir)).rejects.toThrow(/会话不存在/);
    });
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
});
