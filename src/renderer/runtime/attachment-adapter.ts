// 附件适配器：接住用户拖进来 / 选进来的**任意**文件，并在加入时就把它探好。
//
// ## 为什么不用官方的 SimpleImageAttachmentAdapter
//
// 它的 `accept` 是 `image/*`：非图片文件直接被拒，而拒绝发生在库内部
// （`ComposerAddAttachment` 的 `input.onchange` 里那个 `try { await addAttachment(file) } catch {}`），
// 用户看到的是「选了文件，什么都没发生」—— 连一句错误都没有。
//
// ## 为什么探测放在 add() 而不是 send()
//
// `send()` 一被调用，库立刻清空输入框与附件列表，然后才 await 适配器。视频抽帧要几秒，
// 放在 send() 里那几秒界面是空的。放在 `add()` 里，附件缩略图先出现（状态是
// `uploading`），处理完再换成就绪态 —— 用户始终看得见自己的文件。
//
// 这里用 `add()` 的**异步生成器**形态：库的 `drainAttachmentAdd` 会逐个消费 yield 出来的
// 附件并按 id 就地替换。先 yield 一个 uploading 态占位，再 yield 探好的结果。
// 探测抛错时库会把最后那个附件标成 `incomplete/error` 并把 message 显示在卡片上 ——
// 这正是「选文件没反应」要变成「选文件看到为什么不行」的地方。

import type {
  Attachment,
  AttachmentAdapter,
  CompleteAttachment,
  PendingAttachment,
} from "@assistant-ui/react";
import {
  ATTACHMENT_DATA_PART,
  payloadFromAttachment,
  probeAttachment,
} from "@/renderer/runtime/attachment-payload";
import type { ChatAttachment, ChatAttachmentKind } from "@/shared/contracts/attachment";

/** 附件类别 → assistant-ui 的附件类型（只影响它自带的图标/文案分支） */
function attachmentTypeFor(kind: ChatAttachmentKind): string {
  switch (kind) {
    case "image":
      return "image";
    case "video":
      return "video";
    case "text":
      return "document";
    case "file":
      return "file";
  }
}

let sequence = 0;

/** 稳定的附件 id：库按 id 就地替换，重试/更新都靠它认人 */
function nextId(): string {
  sequence += 1;
  return `oint-attachment-${Date.now().toString(36)}-${sequence}`;
}

export class OintAttachmentAdapter implements AttachmentAdapter {
  /**
   * 什么都收。
   *
   * `"*"` 会让库的 `ComposerAddAttachment` 不给 `<input type="file">` 设 accept ——
   * 文件选择器因此能看到全部文件（这正是「选文件等」该有的样子）。
   * 代价是用户可能选到一个我们最终只能给路径的文件（PDF / 压缩包），
   * 那是**明确支持**的一类（见 shared/contracts/attachment 的 kind: "file"），不是错误。
   */
  accept = "*";

  /**
   * 还在探测中的附件（id → 探测任务）。
   *
   * 为什么必须有这张表：探测（视频抽帧）要几秒，而库的 `canSend` 只看「有没有附件」——
   * 用户在探测完成前就能按发送。那条路上库会把附件交给 `send()`，而此刻它还没有
   * `content`，于是附件会被**静默丢掉**（用户以为发出去了，模型什么也没收到）。
   * 这里让 `send()` 等同一个探测任务，把那个窗口关掉。
   */
  private pending = new Map<string, Promise<ChatAttachment>>();

  async *add(state: { file: File }): AsyncGenerator<PendingAttachment, void> {
    const { file } = state;
    const id = nextId();
    const name = file.name === "" ? "attachment" : file.name;
    const task = probeAttachment(file);
    this.pending.set(id, task);

    // 先占位：探测期间用户看到的是一个带「处理中」的卡片，而不是什么都没有
    yield {
      id,
      type: "file",
      name,
      ...(file.type === "" ? {} : { contentType: file.type }),
      file,
      status: { type: "running", reason: "uploading", progress: 0 },
    };

    // 探测失败时抛给库：它会把卡片标成 incomplete/error 并把 message 显示出来
    //（`ComposerAddAttachment` 自己把异常吞了，所以那条路必须靠库的错误态）
    const payload = await task;
    yield {
      id,
      type: attachmentTypeFor(payload.kind),
      name,
      ...(file.type === "" ? {} : { contentType: file.type }),
      file,
      status: { type: "requires-action", reason: "composer-send" },
      // 负载放在库声明的 `data` part 槽位里：挂自造字段会在库内部的对象拷贝里丢掉
      content: [{ type: "data", name: ATTACHMENT_DATA_PART, data: payload }],
    };
  }

  /**
   * 发送：正常情况下探测已经在 add() 做完了，这里只把状态推成 complete。
   *
   * `content` 原样带过去 —— 它就是 `onNew` 里读出来的那份附件描述。
   * 只有「用户在探测完成前就按了发送」这一种情况下才会走到 `pending` 那一支。
   */
  async send(attachment: PendingAttachment): Promise<CompleteAttachment> {
    const ready = payloadFromAttachment(attachment) ?? (await this.pending.get(attachment.id));
    this.pending.delete(attachment.id);
    return {
      ...attachment,
      status: { type: "complete" },
      content:
        ready === undefined
          ? (attachment.content ?? [])
          : [{ type: "data", name: ATTACHMENT_DATA_PART, data: ready }],
    };
  }

  async remove(attachment: Attachment): Promise<void> {
    // 没有服务端要清理的东西：附件字节在发送时才由主进程落盘
    this.pending.delete(attachment.id);
  }
}
