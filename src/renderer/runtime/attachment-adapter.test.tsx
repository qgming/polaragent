/**
 * 附件适配器的单测（ui project / jsdom）。
 *
 * 这里钉住两个**只有时序上才暴露**的缺陷，它们在界面上都表现为「附件静默消失」：
 *
 * 1. **探测还没完就按发送**：库的 `canSend` 只看「有没有附件」，不看它是否就绪。
 *    没有 `pending` 表兜住的话，`send()` 拿到的附件没有 `content`，附件就被丢掉了 ——
 *    用户以为发出去了，模型什么都没收到。
 * 2. **探测失败**：`ComposerAddAttachment` 把 `addAttachment` 的异常 `catch {}` 吞了，
 *    所以失败必须靠 `add()` 抛出、由库把卡片标成 error 才看得见。
 */

import type { PendingAttachment } from "@assistant-ui/react";
import { describe, expect, it } from "vitest";
import { OintAttachmentAdapter } from "./attachment-adapter";
import { ATTACHMENT_DATA_PART, payloadFromAttachment } from "./attachment-payload";

describe("OintAttachmentAdapter", () => {
  it("先给「处理中」的占位，再给就绪态（用户始终看得见自己的文件）", async () => {
    const adapter = new OintAttachmentAdapter();
    const file = new File(["hello"], "notes.md", { type: "text/markdown" });
    const iterator = adapter.add({ file })[Symbol.asyncIterator]();

    const placeholder = await iterator.next();
    expect(placeholder.done).toBe(false);
    expect(placeholder.value?.status).toEqual({
      type: "running",
      reason: "uploading",
      progress: 0,
    });
    expect(placeholder.value?.content).toBeUndefined();

    const ready = await iterator.next();
    expect(ready.done).toBe(false);
    expect(ready.value?.status).toEqual({ type: "requires-action", reason: "composer-send" });
    expect(ready.value?.type).toBe("document");
    const payload = payloadFromAttachment(ready.value as PendingAttachment);
    expect(payload).toMatchObject({ kind: "text", name: "notes.md" });
    expect(payload?.text).toBe("hello");
  });

  it("接受任意文件类型（不再是 image/*）", () => {
    expect(new OintAttachmentAdapter().accept).toBe("*");
  });

  it("探测没完就发送：send() 等同一个探测任务，附件不会被丢掉", async () => {
    const adapter = new OintAttachmentAdapter();
    const file = new File(["# 标题"], "notes.md", { type: "text/markdown" });
    const iterator = adapter.add({ file })[Symbol.asyncIterator]();
    const placeholder = (await iterator.next()).value as PendingAttachment;
    // 此刻探测一定还没结束：占位附件没有 content
    expect(placeholder.content).toBeUndefined();

    // 用户抢在探测完成前按了发送
    const complete = await adapter.send(placeholder);
    expect(complete.status).toEqual({ type: "complete" });
    const payload = payloadFromAttachment(complete);
    expect(payload).toMatchObject({ kind: "text", name: "notes.md" });
    expect(payload?.text).toBe("# 标题");
    expect(complete.content?.[0]).toMatchObject({ type: "data", name: ATTACHMENT_DATA_PART });
  });

  it("探测失败时 add() 抛出（库据此把卡片标成 error，而不是静默无事发生）", async () => {
    const adapter = new OintAttachmentAdapter();
    const file = new File([new Uint8Array([1, 2, 3])], "huge.bin", {
      type: "application/octet-stream",
    });
    // 拿不到磁盘路径（jsdom 里 pathForFile 不存在）又超过上限 → 必须拒绝
    Object.defineProperty(file, "size", { value: 65 * 1024 * 1024 });

    const iterator = adapter.add({ file })[Symbol.asyncIterator]();
    await iterator.next(); // 占位照常给出
    await expect(iterator.next()).rejects.toThrow(/上限/);
  });

  it("remove() 清掉挂着的探测任务", async () => {
    const adapter = new OintAttachmentAdapter();
    const file = new File(["x"], "a.txt", { type: "text/plain" });
    const iterator = adapter.add({ file })[Symbol.asyncIterator]();
    const placeholder = (await iterator.next()).value as PendingAttachment;

    await adapter.remove(placeholder);
    // 清掉之后 send 拿不到负载，但也不该崩：返回一个空的 complete 附件
    const complete = await adapter.send(placeholder);
    expect(complete.status).toEqual({ type: "complete" });
  });
});
