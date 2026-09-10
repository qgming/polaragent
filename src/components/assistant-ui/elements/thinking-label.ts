// 运行态标签推导（纯函数，便于单测）
// src/components/assistant-ui/elements/thinking-label.ts
//
// 与 MessagePrimitive.GroupedParts 的 indicator 判定保持一致：indicator 是
// GroupedParts 合成的渲染槽，不在 message.parts 中，因此「是否该显示运行态提示」
// 必须自己按等价谓词推导，不能靠扫描 parts 判断。

/** 推导所需的最小消息形状，避免把 runtime 类型拖进单测 */
export interface ThinkingLabelInput {
  /** 消息是否仍在产出（status.type === "running"） */
  running: boolean;
  parts: ReadonlyArray<{
    type: string;
    /** tool-call 专用：undefined 表示该调用尚未返回 */
    result?: unknown;
    /** tool-call 专用：工具名 */
    toolName?: string;
  }>;
}

/**
 * 推导运行态标签。
 *
 * 三档：
 *  1. 仍有未返回的工具调用 → `正在运行 <工具名>`
 *  2. 结尾不是 text/reasoning（含尚无任何 part）→ `思考中`
 *  3. 结尾已是正文或思考内容 → `undefined`，让位给真实内容
 *
 * 第 2 档与 GroupedParts 默认的 `no-text` indicator 模式等价，覆盖「刚跑完工具、
 * 模型正在组织正文」这类中间态；漏掉会让运行态提示出现空窗。
 */
export function deriveThinkingLabel({
  running,
  parts,
}: ThinkingLabelInput): string | undefined {
  if (!running) return undefined;

  const pending = parts.find(
    (part) => part.type === "tool-call" && part.result === undefined,
  );
  if (pending) {
    return pending.toolName ? `正在运行 ${pending.toolName}` : "正在运行工具";
  }

  const last = parts[parts.length - 1];
  const endsWithContent = last?.type === "text" || last?.type === "reasoning";
  return parts.length === 0 || !endsWithContent ? "思考中" : undefined;
}
