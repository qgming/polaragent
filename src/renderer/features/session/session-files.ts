/**
 * 会话面板里「产物 / 参考」两块的纯逻辑：从消息 parts 汇总本次会话的文件足迹。
 *
 * 做成纯函数（不碰 React、不碰 store）是为了能在 node project 下直接喂普通对象断言 ——
 * 与 ToolParts 的 ToolPartLike、TodoPanel 的 latestTodo 同一个口径。
 *
 * 路径取的是**工具参数里的 path**：write / edit / read 的参数结构本来就是 `{ path }`
 * （见 main/pisdk/permissions.ts 的 assessToolRisk、main/pisdk/message-mapper.test.ts），
 * 结果文本里反而不再保证带一遍路径；args 在流式期就已经解析好了。
 *
 * 去重保留**首次出现**的顺序（会话里先动过哪个文件就先列哪个），次数与最后活动时间累加；
 * 「最后活动时间」用消息的 createdAt —— part 自己没有时间戳，消息是它唯一的归属。
 */

import type { ChatMessage, ChatPart } from "@/shared/contracts/session";

/**
 * 一次工具调用是否真的落到文件上了：否认 / 报错 / 还在等审批的都不算。
 *
 * **导出**供 turn-files.ts 复用：那条路径要判断的是同一件事（「这轮到底改没改」），
 * 各写一份迟早会在「running 算不算」这类边界上漂移。
 */
export function applied(part: Extract<ChatPart, { type: "tool-call" }>): boolean {
  if (part.isError === true) return false;
  // pending-approval 与 denied 都还没执行；error 是执行了但没成功。running 已经发出去了，算。
  return part.status !== "pending-approval" && part.status !== "denied" && part.status !== "error";
}

/** 工具参数里的路径：与 tool-presentation 的 toolChip 同一个取键顺序（path 优先，其次 file） */
export function callPath(part: ChatPart): string | null {
  if (part.type !== "tool-call") return null;
  const args = part.args;
  if (typeof args !== "object" || args === null) return null;
  const record = args as Record<string, unknown>;
  for (const key of ["path", "file"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return null;
}

/** 一个文件在本次会话里留下的足迹 */
export interface FileActivity {
  path: string;
  /** 出现次数（写/改过几次，或读过几次） */
  count: number;
  /** 最后一次活动的消息时间（毫秒） */
  lastAt: number;
}

/** 用户附件的聚合：消息里只留了图片的 mimeType 与数据，没有文件名（见 contracts/session.ts） */
export interface AttachmentActivity {
  mimeType: string;
  count: number;
}

const WRITE_TOOLS: ReadonlySet<string> = new Set(["write", "edit"]);
const READ_TOOLS: ReadonlySet<string> = new Set(["read"]);

function collect(messages: readonly ChatMessage[], tools: ReadonlySet<string>): FileActivity[] {
  const found = new Map<string, FileActivity>();

  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "tool-call") continue;
      if (!tools.has(part.toolName)) continue;
      if (!applied(part)) continue;
      const path = callPath(part);
      if (path === null) continue;

      const existing = found.get(path);
      if (existing === undefined) {
        found.set(path, { path, count: 1, lastAt: message.createdAt });
      } else {
        existing.count += 1;
        existing.lastAt = message.createdAt;
      }
    }
  }

  return [...found.values()];
}

/** 本次会话被写 / 改过的文件（write + edit 合并计数，同一路径只占一行） */
export function writtenFiles(messages: readonly ChatMessage[]): FileActivity[] {
  return collect(messages, WRITE_TOOLS);
}

/** 本次会话读过的文件（read 的 path，去重保序） */
export function readFiles(messages: readonly ChatMessage[]): FileActivity[] {
  return collect(messages, READ_TOOLS);
}

/**
 * 用户发的图片附件，按 mimeType 聚合。
 *
 * 只做到这个粒度是因为消息里确实只有 mimeType 与 dataUrl：文件名活在 Composer 的附件状态里，
 * 发送后不再落盘（见 runtime 的 SimpleImageAttachmentAdapter 与 message-mapper 的 image 分支）。
 */
export function imageAttachments(messages: readonly ChatMessage[]): AttachmentActivity[] {
  const found = new Map<string, AttachmentActivity>();

  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "image") continue;
      const existing = found.get(part.mimeType);
      if (existing === undefined) {
        found.set(part.mimeType, { mimeType: part.mimeType, count: 1 });
      } else {
        existing.count += 1;
      }
    }
  }

  return [...found.values()];
}
