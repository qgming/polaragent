/**
 * 流式 Markdown 的分段切分（纯函数，便于单测）。
 *
 * 背景：react-markdown 每次输入变化都**整篇重新解析**。流式输出时文本每帧都在长，
 * 一篇 30KB 的回复到尾部时每帧都要付整个文档的解析成本 —— 越流越卡，最后把主线程
 * 吃满（滚动、点击全部排队）。修法是把文档切成「已完成的块」与「正在增长的尾段」：
 * 完成的块内容不再变化，交给 memo 跳过重解析；只有尾段每次更新才重新解析，而它很短。
 *
 * 切分规则（保守优先，宁可少切不可切错）：
 *   · 只在**空行**处切（围栏代码块内部不切）；围栏闭合行之后也切（围栏后必然是新的块）；
 *   · 空行后面如果跟着「延续行」（列表项 / 引用 / 表格 / 缩进续行），不切 ——
 *     切开会让列表编号重启、引用分家，渲染结果与整篇解析不一致；
 *   · 文本停在**未闭合的围栏**里时，尾段从围栏开始行切出，作为纯代码渲染
 *    （尚在输入中的代码块不该被 markdown 语义解释，也不需要语法高亮）。
 */

/** 尾段：要么是一段普通 markdown，要么是一个还没写完的代码围栏 */
export type StreamingTail =
  | { kind: "markdown"; text: string }
  | { kind: "code"; language: string | undefined; code: string };

export interface StreamingMarkdownSegments {
  /** 已完成的块（文本前缀，append-only）：内容不再变化，可 memo */
  blocks: string[];
  /** 正在增长的尾段；没有内容时为 null */
  tail: StreamingTail | null;
}

/** 围栏开栏行：0-3 空格缩进 + 三个以上反引号/波浪号 + 信息串 */
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
/** 围栏闭合行：同种围栏且不含信息串 */
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

/**
 * 「上一块的延续」行首：空行落在它前面时不切块。
 * 列表项（- * + / 1. 1)）、引用（>）、表格行（|）、缩进行都属于这一类。
 */
const CONTINUATION = /^([ \t]|[-*+][ \t]|\d+[.)][ \t]|>|\|)/;

/** 从围栏信息串里取语言名：`ts title=...` → ts，`{python}` → python */
function parseFenceLanguage(info: string): string | undefined {
  const first = info.trim().split(/[\s{]/)[0];
  return first === "" || first === undefined ? undefined : first;
}

export function splitStreamingMarkdown(text: string): StreamingMarkdownSegments {
  const lines = text.split("\n");
  /** 每行的起始偏移（含换行符累计） */
  const offsets: number[] = [];
  let offset = 0;
  for (const line of lines) {
    offsets.push(offset);
    offset += line.length + 1;
  }

  /** 当前打开的围栏：字符与长度（闭合要求同字符且不短于开栏） */
  let fenceChar = "";
  let fenceLength = 0;
  let fenceOpenIndex = -1;
  /** 块边界：每个元素是一块的结束、下一块的开始 */
  const boundaries: number[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (fenceChar === "") {
      const open = FENCE_OPEN.exec(line);
      if (open !== null && open[1] !== undefined) {
        fenceChar = open[1][0] ?? "";
        fenceLength = open[1].length;
        fenceOpenIndex = i;
        continue;
      }
      if (line.trim() !== "") continue;
      // 空行：跳到最后一个空行之后，看那里有没有可切的内容
      let j = i + 1;
      while (j < lines.length && (lines[j] ?? "").trim() === "") j += 1;
      if (j >= lines.length) break; // 尾部空行：没有可切的后续内容
      if (CONTINUATION.test(lines[j] ?? "")) continue; // 延续行：切了会破坏语义
      boundaries.push(offsets[j] ?? text.length);
      continue;
    }
    // 围栏内：只看闭合
    const close = FENCE_CLOSE.exec(line);
    if (close !== null && close[1] !== undefined) {
      const sameChar = (close[1][0] ?? "") === fenceChar;
      if (sameChar && close[1].length >= fenceLength) {
        fenceChar = "";
        fenceLength = 0;
        boundaries.push((offsets[i] ?? 0) + line.length);
        fenceOpenIndex = -1;
      }
    }
  }

  // 未闭合围栏：尾段从围栏开栏行切出，前面所有内容都算已完成块
  const cutEnd =
    fenceChar !== "" && fenceOpenIndex >= 0
      ? (offsets[fenceOpenIndex] ?? 0)
      : (boundaries.at(-1) ?? 0);

  const blocks: string[] = [];
  let start = 0;
  for (const boundary of boundaries) {
    if (boundary > cutEnd) break;
    if (boundary <= start) continue;
    blocks.push(text.slice(start, boundary));
    start = boundary;
  }

  let tail: StreamingTail | null = null;
  if (fenceChar !== "" && fenceOpenIndex >= 0) {
    const openLine = lines[fenceOpenIndex] ?? "";
    const info = FENCE_OPEN.exec(openLine)?.[2] ?? "";
    const codeStart = Math.min((offsets[fenceOpenIndex] ?? 0) + openLine.length + 1, text.length);
    tail = { kind: "code", language: parseFenceLanguage(info), code: text.slice(codeStart) };
  } else {
    const rest = text.slice(cutEnd);
    if (rest.trim() !== "") tail = { kind: "markdown", text: rest };
  }

  return { blocks, tail };
}
