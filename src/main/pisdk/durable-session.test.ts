import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  AgentDoc,
  createRegistry,
  type EntryDraft,
  Harness,
  UsageDoc,
} from "@earendil-works/pi-durable";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildAttachmentEnvelope,
  parseAttachmentEnvelope,
  sessionAttachmentsDir,
  storeAttachmentBytes,
} from "./attachments";
import { emptyUsage } from "./durable-session";
import { createExecEnv } from "./exec-env";
import { createSessionStore, type SessionStore } from "./session-store";

let directory: string;
let store: SessionStore;
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "oint-durable-"));
  store = createSessionStore(directory);
});
afterEach(async () => {
  await store.close();
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
async function open(id: string) {
  const opened = await store.open(id);
  if (!opened) throw new Error("Missing session");
  const harness = await opened.session.bindHarness(() =>
    Harness.open(opened.storage, { models: createModels(), registry: createRegistry() }, context),
  );
  const conversation = await harness.conversation(opened.session.activeConversationId, context);
  if (!conversation) throw new Error("Missing conversation");
  const append = async (entry: EntryDraft) => {
    const record = await harness.commit(
      (tx) => tx.appendEntry(opened.session.activeConversationId, entry),
      context,
    );
    return opened.session.projectEntry(record);
  };
  return { ...opened, harness, conversation, append };
}
const user = (text: string): EntryDraft => ({
  kind: "pi.user",
  model: [{ role: "user", content: text, timestamp: 1000 }],
});

describe("Pi 1.0 native storage", () => {
  it("fork copies only referenced attachments and can read them after the source is deleted", async () => {
    const project = path.join(directory, "project");
    await mkdir(project);
    const source = await store.create({ cwd: project });
    const attachment = {
      kind: "file" as const,
      name: "document.pdf",
      mimeType: "application/pdf",
      size: 7,
    };
    const bytes = Buffer.from("pdfdata");
    const saved = await storeAttachmentBytes(source.id, attachment, bytes, directory);
    await storeAttachmentBytes(
      source.id,
      { ...attachment, name: "unreferenced.pdf" },
      Buffer.from("not copied"),
      directory,
    );
    const opened = await open(source.id);
    const cutoff = await opened.append({
      kind: "pi.user",
      model: [
        {
          role: "user",
          timestamp: 1,
          content: [{ type: "text", text: buildAttachmentEnvelope(1, saved, attachment) }],
        },
      ],
    });
    const forked = await store.fork(source.id, cutoff.entryId);
    const copy = await open(forked.id);
    const model = (await copy.session.allEntries())[0]?.record.model?.[0];
    if (model?.role !== "user" || typeof model.content === "string")
      throw new Error("Missing attachment message");
    const block = model.content[0];
    if (block?.type !== "text") throw new Error("Missing envelope");
    const envelope = parseAttachmentEnvelope(block.text);
    if (!envelope) throw new Error("Missing parsed envelope");
    expect(path.dirname(envelope.path)).toBe(sessionAttachmentsDir(forked.id, directory));
    expect(await readdir(sessionAttachmentsDir(forked.id, directory))).toHaveLength(1);
    const env = await createExecEnv({
      cwd: project,
      allowedRoots: [sessionAttachmentsDir(forked.id, directory)],
    });
    try {
      expect(await env.readBinaryFile(envelope.path, context)).toMatchObject({
        ok: true,
        value: bytes,
      });
      await store.remove(source.id);
      expect(await env.readBinaryFile(envelope.path, context)).toMatchObject({
        ok: true,
        value: bytes,
      });
      expect(await readFile(envelope.path)).toEqual(bytes);
    } finally {
      await env.cleanup(context);
    }
  });
  it("rejects attachment envelopes pointing outside the source attachment directory", async () => {
    const source = await store.create();
    const external = path.join(directory, "private.txt");
    await writeFile(external, "do not copy");
    const attachment = {
      kind: "text" as const,
      name: "private.txt",
      mimeType: "text/plain",
      size: 11,
    };
    const opened = await open(source.id);
    const entry = await opened.append({
      kind: "pi.user",
      model: [
        {
          role: "user",
          timestamp: 1,
          content: buildAttachmentEnvelope(1, { path: external, bytes: 11 }, attachment),
        },
      ],
    });
    await expect(store.fork(source.id, entry.entryId)).rejects.toThrow("附件不属于源会话");
    expect((await store.list()).map((session) => session.id)).toEqual([source.id]);
    expect(await readFile(external, "utf8")).toBe("do not copy");
  });
  it("reopens, appends and preserves stable IPC entry identities and tool/image data", async () => {
    const created = await store.create({ title: "native", cwd: directory });
    const opened = await open(created.id);
    const first = await opened.append(user("hello"));
    await opened.append({
      kind: "pi.tool-result",
      model: [
        {
          role: "toolResult",
          toolName: "read_image",
          toolCallId: "call",
          content: [{ type: "image", mimeType: "image/png", data: "AAAA" }],
          details: { retained: true },
          isError: false,
          timestamp: 1001,
        },
      ],
    });
    await opened.harness.close(context);
    await opened.session.unbindHarness(opened.harness);
    const reopened = await open(created.id);
    expect(reopened.session).not.toBe(opened.session);
    expect((await reopened.session.getEntry(first.entryId, context))?.entryId).toBe(first.entryId);
    expect((await reopened.session.allEntries())[1]?.record.model?.[0]).toMatchObject({
      details: { retained: true },
      content: [{ type: "image", data: "AAAA" }],
    });
    const third = await reopened.append(user("again"));
    expect(third.parentId).not.toBeNull();
    expect(
      (await store.loadMessages(created.id)).messages.map((message) => message.entryId),
    ).toEqual([first.entryId, third.entryId]);
  });
  it("serializes concurrent harness acquisition and includes hidden records in parent links", async () => {
    const created = await store.create();
    const opened = await store.open(created.id);
    if (!opened) throw new Error("Missing session");
    let factories = 0;
    const factory = async () => {
      factories++;
      return Harness.open(
        opened.storage,
        { models: createModels(), registry: createRegistry() },
        context,
      );
    };
    const owners = await Promise.all(
      Array.from({ length: 8 }, () => opened.session.bindHarness(factory)),
    );
    expect(factories).toBe(1);
    expect(owners.every((owner) => owner === owners[0])).toBe(true);
    const owner = owners[0];
    if (!owner) throw new Error("Missing owner");
    const hidden = await owner.commit(
      (tx) =>
        tx.appendEntry(opened.conversationId, { kind: "todo", data: { revision: 1, todos: [] } }),
      context,
    );
    const visible = await owner.commit(
      (tx) => tx.appendEntry(opened.conversationId, user("hello")),
      context,
    );
    expect(opened.session.projectEntry(visible).parentId).toBe(
      opened.session.externalEntryId(hidden.id),
    );
  });
  it("retry forks and selects atomically, restores configuration and excludes abandoned siblings", async () => {
    const created = await store.create();
    const opened = await open(created.id);
    await opened.conversation.configure({ instructions: "retained config" }, context);
    const first = await opened.append(user("first"));
    await opened.append(user("abandoned"));
    const retry = await opened.session.forkAndSelect(first.entryId, context);
    await opened.harness.commit((tx) => tx.appendEntry(retry.id, user("replacement")), context);
    expect(
      (await store.loadMessages(created.id)).messages.map((message) => message.parts[0]),
    ).toEqual([
      { type: "text", text: "first" },
      { type: "text", text: "replacement" },
    ]);
    await opened.session.close();
    const reopened = await open(created.id);
    expect(reopened.session.activeConversationId).toBe(retry.id);
    expect((await reopened.harness.snapshot(AgentDoc, retry.id, context))?.instructions).toBe(
      "retained config",
    );
    const fresh = await reopened.session.forkAndSelect(null, context);
    expect((await reopened.harness.snapshot(AgentDoc, fresh.id, context))?.instructions).toBe(
      "retained config",
    );
    expect((await store.loadMessages(created.id)).messages).toEqual([]);
  });
  it("app fork copies cutoff history and compaction without tasks or inherited usage", async () => {
    const created = await store.create({ title: "source", cwd: directory });
    const opened = await open(created.id);
    await opened.conversation.configure({ instructions: "at cutoff" }, context);
    await opened.append(user("before"));
    const retained = await opened.append(user("retained"));
    await opened.append({
      kind: "todo",
      data: { revision: 1, todos: [{ content: "keep", status: "pending" }] },
    });
    const compact = await opened.append({
      kind: "pi.compaction",
      head: retained.record.id,
      model: [{ role: "user", content: "summary", timestamp: 1002 }],
      data: { reason: "manual" },
    });
    await opened.append(user("too late"));
    const forked = await store.fork(created.id, compact.entryId);
    const copy = await open(forked.id);
    const view = await copy.conversation.context(context);
    expect(
      view.messages.map((message) => (message.role === "user" ? message.content : "")),
    ).toEqual(["summary", "retained"]);
    expect(
      (await copy.session.allEntries()).find((entry) => entry.record.kind === "todo")?.record.data,
    ).toMatchObject({ revision: 1 });
    expect((await copy.harness.inspect(context)).tasks).toEqual([]);
    expect(await copy.harness.usage(context)).toEqual({ models: {}, tools: {} });
    expect(
      (await copy.harness.snapshot(AgentDoc, copy.session.activeConversationId, context))
        ?.instructions,
    ).toBe("at cutoff");
  });
  it("sums usage-ledger-only spend without inventing assistant messages", async () => {
    const created = await store.create();
    const opened = await open(created.id);
    const usage = { ...emptyUsage(), input: 7, totalTokens: 7 };
    await opened.harness.commit(async (tx) => {
      const ledger = await tx.doc(UsageDoc, opened.conversation.id);
      ledger.models["test/model"] = usage;
    }, context);
    expect(await opened.session.getStats(context)).toMatchObject({
      messageCount: 0,
      usage: { input: 7, totalTokens: 7 },
    });
  });
  it("open waits for a concurrent close and returns a fresh usable owner", async () => {
    const created = await store.create();
    const first = await open(created.id);
    await first.append(user("before close"));
    const closing = first.session.close();
    const next = await store.open(created.id);
    await closing;
    expect(next?.session).not.toBe(first.session);
    const reopened = await open(created.id);
    await reopened.append(user("after close"));
    expect((await store.loadMessages(created.id)).messages).toHaveLength(2);
  });
  it("does not discover, modify or import previous databases", async () => {
    await mkdir(path.join(directory, "sessions"));
    const old = path.join(directory, "sessions", "old.sqlite");
    await writeFile(old, "untouched");
    expect(await store.list()).toEqual([]);
    const created = await store.create();
    await store.remove(created.id);
    expect(await store.list()).toEqual([]);
    expect(await readFile(old, "utf8")).toBe("untouched");
  });
});
