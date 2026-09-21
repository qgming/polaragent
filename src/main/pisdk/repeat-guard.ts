// 重复调用守卫：发现「模型在用完全相同的参数反复调用同一个工具」，两级处置。
//
// ## 为什么需要它（以及它取代了什么）
//
// 这里早先是 `maxTurns`：跑到 N 轮就截断。那个机制**定位是错的** ——
// 它被用来发现「子智能体出异常了」（幻觉导致反复做同一件事），
// 但**轮次是资源消耗，不是行为特征**：调低了误伤正当的长任务，调高了发现异常太晚
// （第 80 或第 1000 轮才知道，而那时 token 已经烧掉了）。
//
// 本模块检测的是**行为**，所以第 3 次就能发现。生态里四家独立项目都这么做，
// 且阈值高度一致：
//   · opencode  `DOOM_LOOP_THRESHOLD = 3`（同名 + 同 input，问权限）
//   · Roo Code  `consecutiveIdenticalToolCallLimit = 3`（同名 + 稳定序列化参数，问用户）
//   · Cline     soft 3 / hard 5（**软档注入 in-band 纠正消息，硬档中止**）
//   · OpenHands `action_error = 3`（3 提醒、4 判 stuck）
// **共识是 3，没有人把 5 当第一触发点。**
//
// ## 为什么是两级（3 / 5）
//
// 采用 Cline 的两档设计，理由有两条：
//
// 1. **不中止是四家的共同取向**（Roo 拦截+问人、opencode 走权限请求、OpenHands 只上报）。
//    第 3 次先给模型一次自纠的机会，比直接杀掉好得多 —— 而且这里是**子智能体**，
//    它跑在隐藏会话里，**没有人可以问**，所以唯一可用的第一档就是注入一条纠正消息。
// 2. **第 3 次提醒后仍逐字节重复，就不是瞬时重试了**。第 4–5 次仍然完全一样，
//    说明它卡死了；再给到 8（dsh 的第三档）只是多烧两轮。
//
// ## 与 maxTurns 的关键差别
//
// 提醒**绝不阻断**调用：本模块只产出「该说什么」，拦不拦、停不停由调用方决定
// （见 runtime.ts 的 after_tool 钩子）。这是刻意的 —— 一个会误报的守卫如果同时还会
// 否决调用，就会把正当的幂等轮询（等构建产物、轮询服务是否起来）也一起打死。
//
// ## 已知边界（照抄 dsh 的自我声明，移植时要清楚）
//
// - **只做精确匹配**：`src/a.ts` 与 `./src/a.ts` 算两次不同的调用。
//   近似变体绕过检测是接受的取舍 —— 模糊匹配会带来误报，而误报会让守卫被关掉。
// - **链不跨用户消息**：用户新指令清空计数，全新指令绝不会被当成循环。

import type { JsonValue } from "@earendil-works/pi-agent-core";

/**
 * 软阈值：第几次连续相同的调用开始注入纠正消息。
 *
 * 取 3 是因为生态共识（opencode / Roo / Cline soft / OpenHands 都是 3）。
 * 概率上，一个干正经事的模型连续三次发出**逐字节相同**的调用是很少见的，
 * 而一次提醒只花一个回合；漏掉一个真循环则要烧掉几百个回合。
 */
export const REPEAT_SOFT_THRESHOLD = 3;

/**
 * 硬阈值：第几次连续相同的调用终止这次运行。
 *
 * 取 5（Cline 的 hard）而不是 8（dsh 的第三档）：第 3 次提醒之后还一模一样，
 * 已经不是「瞬时重试」而是明确的卡死，再等三轮只是白烧。
 */
export const REPEAT_HARD_THRESHOLD = 5;

/**
 * 不参与计数的工具：它们的调用**既不递增也不重置**链（对链「透明」）。
 *
 * 为什么 todo 在这里：它是**整表替换**语义 —— 模型每轮重发同一张清单是正常用法，
 * 内容一模一样完全可能（比如「还没开始做」的那几轮）。把它算进链会让守卫
 * 在一个完全正常的会话里报「你在重复」。
 *
 * 透明而不是重置，是为了让「穿插的记录类调用」掩盖不了真循环：
 * `grep X → todo → grep X` 仍然算连续两次 grep X。
 */
export const REPEAT_EXCLUDED_TOOLS: ReadonlySet<string> = new Set(["todo"]);

/** 一条链的状态：只与**上一次**比，所以 O(1) 内存、不扫历史、不调模型 */
export interface RepeatChain {
  /** 上一次参与计数的调用的签名；null = 链还没开始 */
  lastKey: string | null;
  /** 连续相同的次数（含当前这一次） */
  count: number;
  /** 已经就这条链报过软档了吗（避免在第 3 次之后每轮都再说一遍） */
  softReported: boolean;
}

export function createRepeatChain(): RepeatChain {
  return { lastKey: null, count: 0, softReported: false };
}

/** 守卫的判定结果：soft = 注入纠正消息；hard = 终止这次运行 */
export type RepeatVerdict =
  | { level: "soft"; count: number; toolName: string; argsText: string }
  | { level: "hard"; count: number; toolName: string; argsText: string };

/**
 * 递归排序对象的键，再序列化 —— 让**键顺序无关**。
 *
 * 这是本模块唯一一个容易写错、且**错了会静默失效**的地方：
 * 不排序的话 `{a,b}` 与 `{b,a}` 序列化结果不同，于是两次「同一个调用」
 * 被判成不同，计数永远到不了阈值 —— **守卫不报错、也永远不触发**。
 * 三家 JS 实现（Roo 的 safe-stable-stringify、Cline 的 sorted-key canonical JSON、
 * dsh 的深度键排序）都做这一步，理由相同。
 *
 * 数组**保持原顺序**：`edits: [a, b]` 与 `edits: [b, a]` 是两次不同的编辑，
 * 排序它们会把真正的差异抹掉。
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) sorted[key] = canonicalize(source[key]);
  return sorted;
}

/**
 * 一次调用的签名：工具名 + 规范化后的参数。
 *
 * `JSON.stringify` 在规范化之后不会有 undefined / bigint / 循环引用的问题 ——
 * 输入的 `args` 来自模型生成的 JSON，值域就是 JSON 的值域。
 */
export function repeatKey(toolName: string, args: Record<string, JsonValue>): string {
  return `${toolName}\u0000${JSON.stringify(canonicalize(args))}`;
}

/** 参数预览：提醒里带上它，模型才看得出「是哪一次调用」在重复 */
const ARGS_PREVIEW_CHARS = 300;

function previewArgs(args: Record<string, JsonValue>): string {
  const text = JSON.stringify(canonicalize(args)) ?? "";
  if (text.length <= ARGS_PREVIEW_CHARS) return text;
  return `${text.slice(0, ARGS_PREVIEW_CHARS)}… (+${text.length - ARGS_PREVIEW_CHARS} more chars)`;
}

/**
 * 记一次调用，返回该不该说话。
 *
 * 判定是**恰好等于**阈值（不是 >=）：这样每一档只报一次，
 * 不会在第 4、5、6… 次重复时每轮都往上下文里塞一遍同样的提醒。
 * 跨过软档之后继续计数（不归零），否则硬档永远到不了 —— 见文件头关于两级的说明。
 */
export function inspectRepeat(
  chain: RepeatChain,
  toolName: string,
  args: Record<string, JsonValue>,
): RepeatVerdict | null {
  // 排除名单里的调用对链透明：不计也不清，穿插它们掩盖不了真循环
  if (REPEAT_EXCLUDED_TOOLS.has(toolName)) return null;

  const key = repeatKey(toolName, args);
  if (key === chain.lastKey) {
    chain.count += 1;
  } else {
    chain.lastKey = key;
    chain.count = 1;
    chain.softReported = false;
  }

  const tool = { toolName, argsText: previewArgs(args) };
  if (chain.count === REPEAT_HARD_THRESHOLD) return { level: "hard", count: chain.count, ...tool };
  if (chain.count === REPEAT_SOFT_THRESHOLD) {
    chain.softReported = true;
    return { level: "soft", count: chain.count, ...tool };
  }
  return null;
}

/**
 * 软档的纠正消息。
 *
 * 措辞要点（对齐 OpenHands 的 nudge，它是四家里最完整的一版）：
 * **点名工具、点名次数、给出参数**，然后明确说「再这样调一次不会有用」，
 * 并给出两条出路（改参数 / 换做法 / 结束）。
 *
 * 只说「你在重复」是不够的 —— 模型需要知道自己**在重复什么**才能改。
 */
export function softRepeatNotice(toolName: string, count: number, argsText: string): string {
  return [
    `你在用**完全相同的参数**重复调用 \`${toolName}\`（连续第 ${count} 次），这不会带来新信息。`,
    "",
    `参数：${argsText}`,
    "",
    "再这样调用一次不会有任何不同。先看清楚上一次的结果，然后：",
    "- 换一个做法或换一组参数，或者",
    "- 如果已经拿到了足够的信息，就直接结束并把结论写出来；",
    "- 如果卡在缺信息上，明确写出缺什么、你已经查到哪一步。",
  ].join("\n");
}

/**
 * 硬档的终止原因，写进运行记录（`SubagentRun.error`）。
 *
 * 要说清「这是异常」而不是「跑太久了」—— 用户看到这一行时应当立刻明白
 * 是模型卡住了，而不是任务本身大。
 */
export function hardRepeatReason(toolName: string, count: number): string {
  return `检测到重复调用：连续 ${count} 次用完全相同的参数调用 ${toolName}，已终止`;
}
