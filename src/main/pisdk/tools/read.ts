// read 工具包装：内核的 read 直接回文件原文，而本应用给模型的描述承诺「返回带行号的内容」
// （见 tools.ts 的 READ_DESCRIPTION）。
//
// 这个包装不是锦上添花：子智能体要在报告里引用「哪个文件哪一行」，grep 的输出也是
// `path:line:text` —— 唯独 read 拿不到行号时，两者对不上，模型只能用摘录的文本描述位置
// （已有子智能体因为「描述说带行号、实际没带」而被误导）。行号是**阅读辅助**：
// 它不属于文件内容，edit / write 的描述里必须提醒模型不要把它写回去。
//
// 只动纯文本结果：
// - 图片读取返回「说明文本 + image 块」，不按行编号；
// - 内核追加的截断 / 分页尾注（[Showing lines …] / [N more lines in file. …]）不是文件内容，
//   编号时要原样留在末尾 —— 它们承担分页语义（用 offset= 继续读），改一个字都会误导模型。

import {
  type AgentHarnessTool,
  createReadTool,
  type ExecutionToolContext,
} from "@earendil-works/pi-agent-core";

/** 内核 read 结果尾注（见内核 harness/tools/read.js 的两处拼接）：编号时原样保留 */
const FOOTER_PATTERN = /^\[(?:Showing lines \d+-\d+ of \d+|\d+ more lines in file\.)/;

/** 单行就超过字节上限时内核整段只回一句提示：没有内容行可编号，原样返回 */
const OVERSIZED_LINE_PATTERN = /^\[Line \d+ is .*, exceeds /;

/** cat -n 风格：右对齐的绝对行号 + 制表符 + 该行原文 */
export function numberLines(content: string, firstLine: number): string {
  if (content === "") return "";
  const lines = content.split("\n");
  // 末尾换行不产生一个不存在的空行号（cat -n 对 "a\n" 也只显示第 1 行）
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  const width = String(firstLine + lines.length - 1).length;
  return lines
    .map((line, index) => `${String(firstLine + index).padStart(width)}\t${line}`)
    .join("\n");
}

/**
 * 给内核的文本结果加行号。
 *
 * firstLine 必须是**文件里的真实行号**（offset=4 时首行是 4）：否则模型引用的行号会整体偏移，
 * 比没有行号更糟。尾注从最后一个 "\n\n[" 处切开 —— 内核只在这里追加尾注，
 * 而文件正文里出现一模一样尾注的概率可以忽略。
 */
function withLineNumbers(text: string, firstLine: number): string {
  if (OVERSIZED_LINE_PATTERN.test(text)) return text;
  const index = text.lastIndexOf("\n\n[");
  if (index === -1) return numberLines(text, firstLine);
  const footer = text.slice(index + 2);
  if (!FOOTER_PATTERN.test(footer)) return numberLines(text, firstLine);
  const body = text.slice(0, index);
  return body === "" ? footer : `${numberLines(body, firstLine)}\n\n${footer}`;
}

/**
 * 构造带行号的 read 工具：除输出格式外与内核 read 完全一致（offset / limit / 图片 / 截断都沿用）。
 */
export function createReadToolWithLineNumbers<
  TContext extends ExecutionToolContext = ExecutionToolContext,
>(): AgentHarnessTool<TContext> {
  const inner = createReadTool<TContext>();
  const execute: typeof inner.execute = async (
    toolCallId,
    params,
    onUpdate,
    toolContext,
    invocation,
    context,
  ) => {
    const result = await inner.execute(
      toolCallId,
      params,
      onUpdate,
      toolContext,
      invocation,
      context,
    );
    // 只有「单块纯文本」才是按行组织的文件内容：图片附件与多块结果原样返回
    const only = result.content.length === 1 ? result.content[0] : undefined;
    if (only === undefined || only.type !== "text") return result;
    const firstLine = Math.max(1, Math.floor(params.offset ?? 1));
    return { ...result, content: [{ ...only, text: withLineNumbers(only.text, firstLine) }] };
  };
  return { ...inner, execute };
}
