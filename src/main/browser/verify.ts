// 「这一次动作到底有没有生效」的判定：**纯函数，不依赖 electron**，因此可以直接测。
//
// 两种判定放在同一个文件里，是因为它们是同一件事的两半：动作发出后页面有没有反应。
//   · judgeInput / textLanded —— 输入类动作（type / select）的**读回值**判定；
//   · judgeProbe             —— 鼠标 / 键盘动作的**事件探针**判定。
// 两者都必须能在 node 下单测：它们是「工具报成功、页面其实没动」这条假成功路径上
// 唯一能被自动验证的关卡，而真机复现一次要开应用、开面板、点一遍。
//
// 为什么输入判定不能直接比字符串相等：输入框常常会自己改写内容 ——
// 电话 / 金额 / 日期字段会被掩码和格式化重写（输入 "1234567890" 得到 "(123) 456-7890"），
// contenteditable 会把换行归一。直接比相等就会把「成功」判成「失败」，并触发一次
// 没有意义的重复输入（第二次输入插到格式化后的文本里，把值搞得更乱）。
//
// 反过来也不能太松：只判断「非空」的话，「打到了别的元素上」这类真实故障都会被当成成功 ——
// 而那正是最初那批报告的根因（工具报成功、字段其实是空的）。所以口径的放宽都必须
// 有明确的理由（格式化成另一种写法、被 maxlength 截断），并且**给得出告警**；
// 讲不出理由的不一致仍然判失败。

import type { ProbeKind } from "./script";

/**
 * 判断 `text` 是否真的落进了当前值为 `value` 的字段。
 *
 * 依次尝试三种口径，命中任意一种即算成功：
 *   1. 去掉首尾空白后完全相等 —— 绝大多数字段的真实情况；
 *   2. 只比较字母数字（去掉一切空白与标点、统一小写）—— 掩码 / 千分位 / 分组格式，
 *      以及「字段自己在值前面加了国家码、货币符号」这类前缀；
 *   3. 「包含」——**仅当 `previous` 给出了输入前的值、且当前值与它不同**时才成立。
 *
 * 第 3 条那个前提是整个函数里最容易被漏掉的一处：没有它就有一个很隐蔽的假成功 ——
 * 字段预填着 "latest test"，模型输入 "test"，而聚焦那一下没落到元素上（`insertText`
 * 打到了 BODY），字段原样不动，可「`latest test` 包含 `test`」成立了，于是工具报
 * 「已输入」。带上「值确实变了」这个前提，既保住上面第 2 条覆盖不到的真实前缀场景，
 * 又堵住「字段本来就有这段文字」这条假成功路径。
 *
 * `previous` 缺省（读不到输入前的值）时第 3 条直接不成立 —— 宁可多报一次失败，
 * 也不要多报一次成功：前者模型重看一眼页面就能发现，后者会一路做到提交。
 *
 * 本函数是 `judgeInput` 的布尔包装；后者在同样这三条之外还放宽了 maxlength / 日期 /
 * 数值三种「写法不同但其实是成功」的情况，并把这些情况做成**告警**而不是失败。
 */
export function textLanded(value: string, text: string, previous?: string | null): boolean {
  return judgeInput(value, text, previous).ok;
}

/** 输入判定的结论：落地（可选告警）或没落地（带可读原因） */
export interface InputVerdict {
  /** 值确实落进了这个字段（含被页面改写成另一种等价写法的情况） */
  ok: boolean;
  /** 落地了、但被页面改写（截断 / 掩码 / 格式化）—— 非致命，进 outcome.warnings */
  warning?: string;
  /** 没落地时的人可读原因，调用方据此拼错误文案 */
  detail?: string;
}

/** 判定的额外上下文：DOM 上读到的字段属性，能让口径更准 */
export interface InputContext {
  /** 输入前的值；缺省时「包含」口径不成立 */
  previous?: string | null;
  /** 字段的 maxlength **属性**值（不是 DOM 属性 `.maxLength`：它缺省时是 524288，会骗人） */
  maxLength?: number;
  /** input 的类型（date / number / …），决定要不要走日期 / 数值口径 */
  inputType?: string;
}

/**
 * 带上下文的输入落地判定：在 `textLanded` 的口径上再加两条「其实是成功」的放宽。
 *
 * 为什么需要放宽：
 *   · **maxlength**：模型输入 20 个字、字段只收 5 个，值确实是这次输入的结果，
 *     只是被字段的上限切短了。判失败会让模型以为没填、再填一次（第二次会更短），
 *     而真相是「页面已经收到了、只是拒绝多余部分」—— 正确做法是落地 + 告警，
 *     让模型知道字段里现在只有前 5 个字符。
 *   · **date / number**：`<input type="date">` 会把 "2024/1/5"、"01/05/2024" 一律
 *     归一成 "2024-01-05"，`type="number"` 会把 "$1,234.00" 存成 1234。
 *     这些都不是失败，是浏览器在替我们规范化。
 * 但放宽必须有边界：说不出理由的不一致（值完全对不上、或字段是空的）仍然判失败 ——
 * 「工具报成功、字段其实是空的」是这一整套判定存在的理由，不能被放宽掉。
 */
export function judgeInput(
  value: string,
  text: string,
  previous?: string | null,
  context: InputContext = {},
): InputVerdict {
  // 输入空串就是「清空这个字段」，没有可校验的内容，一律算成功
  const wanted = text.trim();
  if (wanted === "") return { ok: true };

  const actual = value.trim();
  if (actual === wanted) return { ok: true };

  const strippedActual = alphanumericOnly(actual);
  const strippedWanted = alphanumericOnly(wanted);
  if (strippedWanted !== "" && strippedActual === strippedWanted) {
    // 值被掩码 / 分组格式改写了 —— 落地了，但把「字段里实际是什么」一并说清
    return { ok: true, warning: rewritten(actual, wanted) };
  }

  if (sameNumber(actual, wanted)) {
    return { ok: true, warning: rewritten(actual, wanted) };
  }

  if (isDateLikeType(context.inputType) || (looksLikeDate(actual) && looksLikeDate(wanted))) {
    if (sameDateParts(actual, wanted)) return { ok: true, warning: rewritten(actual, wanted) };
  }

  const changed = typeof previous === "string" && previous.trim() !== actual;
  if (changed && strippedWanted !== "" && strippedActual.includes(strippedWanted))
    return { ok: true };

  const truncated = truncatedByMaxLength(actual, wanted, context.maxLength);
  if (truncated !== null) return { ok: true, warning: truncated };

  return {
    ok: false,
    detail:
      `读回来的值是「${clip(actual)}」，而要求输入的是「${clip(wanted)}」。` +
      "常见原因是这个字段会被页面改写（掩码 / 长度限制 / 格式化），" +
      "或者它并不是真正接收输入的那个元素。请重新 snapshot 确认。",
  };
}

/** 只保留字母与数字、统一小写：用于跨过掩码与分组格式的比较 */
function alphanumericOnly(value: string): string {
  return value.replace(/[^\p{L}\p{N}]+/gu, "").toLowerCase();
}

/** 把值收窄成有限数：允许货币符号 / 千分位 / 百分号 / 单位尾巴，其余一律放弃 */
function asNumber(value: string): number | null {
  const cleaned = value
    .replace(/[\s,，]/g, "")
    .replace(/^[^\d+-.]*/, "")
    .replace(/[^\d.]+$/, "");
  if (!/^[+-]?\d*\.?\d+$/.test(cleaned)) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

/** 数值口径：`$1,234.00` 与 `1234` 是同一个值，不该因为写法不同判失败 */
function sameNumber(actual: string, wanted: string): boolean {
  const left = asNumber(actual);
  const right = asNumber(wanted);
  return left !== null && right !== null && left === right;
}

/** 粗判「像日期/时间」：有分隔符的三段数字，或带时间的形态 */
const DATE_LIKE = /^\s*[+-]?\d{1,4}\s*[-/.]\s*\d{1,2}(\s*[-/.]\s*\d{1,4})?/;

function looksLikeDate(value: string): boolean {
  return DATE_LIKE.test(value);
}

/** date / time / month / week 这几类 input 的值由浏览器归一，写法差异几乎必然 */
function isDateLikeType(inputType: string | undefined): boolean {
  return (
    inputType === "date" ||
    inputType === "time" ||
    inputType === "datetime-local" ||
    inputType === "month" ||
    inputType === "week"
  );
}

/**
 * 日期口径：把两边的数字分组各自取出、去前导零、排序后比较。
 *
 * 为什么排序：`<input type="date">` 的显示格式随 locale 变（MM/DD/YYYY 与
 * YYYY-MM-DD 都能出现），而值本身是同一个日子 —— 模型按屏幕上看到的顺序输入，
 * 字段按自己的顺序存，逐位比较必然失败。分组数不同（或一边没有数字）就不认，
 * 免得把 "123 456" 与 "456123" 这种无关内容判成相等。
 */
function sameDateParts(actual: string, wanted: string): boolean {
  const left = digitGroups(actual);
  const right = digitGroups(wanted);
  if (left.length === 0 || left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((group, index) => group === sortedRight[index]);
}

/** 取出所有数字分组并去掉前导零（"01" → "1"，"2024" → "2024"） */
function digitGroups(value: string): string[] {
  return (value.match(/\d+/g) ?? []).map((group) => group.replace(/^0+(?=\d)/, ""));
}

/**
 * 被 maxlength 截断：值就是想要的文本的前缀，且字段确实设了上限。
 *
 * 判据必须包含「字段设了 maxlength」这一条 —— 没有它，「少几个字符」就变成成功了，
 * 而少字母的场景里更常见的真相是「输入打到了别的元素上/被打断」，
 * 那种情况必须判失败（见 verify.test.ts 里钉住的那条反向断言）。
 */
function truncatedByMaxLength(actual: string, wanted: string, maxLength?: number): string | null {
  if (typeof maxLength !== "number" || !Number.isFinite(maxLength) || maxLength <= 0) return null;
  if (wanted.length <= maxLength) return null;
  const head = wanted.slice(0, maxLength);
  if (actual !== head && actual !== head.trim()) return null;
  return (
    `输入被字段的 maxlength=${maxLength} 截断：只落进了前 ${maxLength} 个字符，` +
    `字段里现在是「${clip(actual)}」。剩下的部分需要换一个更短的值，或者由页面自己补全。`
  );
}

/** 值被页面改写时的告警文案：把「要求什么」和「现在是什么」都摆出来 */
function rewritten(actual: string, wanted: string): string {
  return `输入被页面格式化了：要求「${clip(wanted)}」，字段里现在是「${clip(actual)}」`;
}

/** 文案里截断长值，避免一条告警把上下文挤满 */
function clip(value: string): string {
  return value.length > 80 ? `${value.slice(0, 80)}…` : value;
}

/** 页面探针记下的一条事件：谁收到了它 */
export interface ProbeEventRecord {
  /** 事件类型（click / input / keydown / mouseover …） */
  type: string;
  /** 事件目标所属的 ref：从 target 往上找到第一个有 ref 的祖先（点在内层 span 上也算命中按钮） */
  targetRef: string | null;
  /** 事件目标的标签名（小写），用于「是谁收走了」的文案 */
  targetTag?: string;
  /** 事件目标的 role（有的话） */
  targetRole?: string;
  /** 是否由真实输入产生（sendInputEvent 是 true；页面自己 dispatch 的是 false） */
  trusted?: boolean;
  at?: number;
}

/** 探针读到的「坐标上是谁」：判断遮挡的关键信息 */
export interface ProbePointElement {
  tag: string;
  id?: string;
  cls?: string;
}

/** 一次探针读取的原始结果（页面侧返回什么，这里就是什么） */
export interface ProbeReport {
  /** 探针真的装上了没有；false 表示这一轮无法断言 */
  armed: boolean;
  kind: ProbeKind | null;
  ref: string | null;
  events: ProbeEventRecord[];
  elementAtPoint: ProbePointElement | null;
  /** 读探针那一刻 document.activeElement 的 ref（press 的焦点校验用） */
  activeRef?: string | null;
  activeTag?: string | null;
}

/** 探针判定：命中 / 断言不了 / 页面毫无反应 / 事件被别的元素收走 */
export type ProbeVerdict =
  | { effect: "hit"; warnings: string[] }
  | { effect: "unknown"; warnings: string[] }
  | { effect: "no-effect"; message: string; detail: Record<string, unknown> }
  | { effect: "wrong-target"; message: string; detail: Record<string, unknown> };

/**
 * 判定一次动作的后果。
 *
 * 为什么必须有这一层：`sendInputEvent` 是**没有回执**的 —— 视口没布局、元素被浮层盖住、
 * 元素在按下与抬起之间被重渲染，这三种情况它都同样静默地什么都不做，而工具在旧实现里
 * 会报「已点击（页面没有跳转）」。探针把「谁收到了事件」记录下来，于是这三种情况
 * 都能被分开说出来（NO_EFFECT / WRONG_TARGET），并给出下一步动作。
 *
 * `input` 类（type / select）刻意不在这里判「值」：事件只是其中一半证据，
 * 另一半是读回值（judgeInput）。这里只回答「事件到了谁那儿」，
 * 没收到事件时返回 unknown 让调用方用读回值兜底 —— 值确实落进去了就说明动作走通了，
 * 而值也没落进去时调用方本来就会报 NO_EFFECT。
 */
export function judgeProbe(
  kind: ProbeKind,
  ref: string | null,
  report: ProbeReport | null,
): ProbeVerdict {
  if (report === null || report.armed !== true) {
    return {
      effect: "unknown",
      warnings: ["动作后的效果探针不可用（注入失败或页面正在导航）：这一次的结果无法断言。"],
    };
  }
  const events = Array.isArray(report.events) ? report.events : [];
  switch (kind) {
    case "click":
      return judgePointer(ref, events, report);
    case "hover": {
      const entered = events.filter(
        (event) =>
          event.type === "mouseover" || event.type === "mouseenter" || event.type === "pointerover",
      );
      if (entered.length === 0) {
        return {
          effect: "no-effect",
          message:
            "鼠标移上去了，但页面没有收到任何 mouseover / mouseenter 事件 —— " +
            "悬停菜单、tooltip 都不会展开。",
          detail: probeDetail(ref, report),
        };
      }
      return hitOrWrong(ref, entered, report);
    }
    case "key": {
      const downs = events.filter((event) => event.type === "keydown");
      if (downs.length === 0) {
        return {
          effect: "no-effect",
          message:
            "按键没有到达页面：没有收到任何 keydown 事件。" +
            "常见原因是视口未布局，或焦点不在页面里（先点一下页面再按键）。",
          detail: probeDetail(ref, report),
        };
      }
      const verdict = hitOrWrong(ref, downs, report);
      if (verdict.effect !== "hit") return verdict;
      // ref 场景额外校验焦点：键发出去了，但收下它的不是目标元素
      if (
        ref !== null &&
        report.activeRef !== undefined &&
        report.activeRef !== null &&
        report.activeRef !== ref
      ) {
        verdict.warnings.push(
          `按键到达的是 ${describeEventTarget(downs.find((event) => event.targetRef === ref) ?? downs[0])}，` +
            `但焦点在 ${report.activeRef} 上：页面若按 activeElement 分发按键，这次按键会落到别处。`,
        );
      }
      return verdict;
    }
    case "input": {
      const typed = events.filter(
        (event) =>
          event.type === "input" ||
          event.type === "beforeinput" ||
          event.type === "change" ||
          event.type === "paste" ||
          event.type === "compositionend",
      );
      if (typed.length === 0) {
        // 事件只是证据的一半：读回值那一半由调用方判定（见本函数上方说明）
        return {
          effect: "unknown",
          warnings: ["输入事件没有被页面收到：值可能落进去了，但框架的 onInput/onChange 没触发。"],
        };
      }
      return hitOrWrong(ref, typed, report);
    }
  }
}

/** 点击判定：完全没有事件 = 没生效；有事件但都不是目标收下的 = 打到了别的元素 */
function judgePointer(
  ref: string | null,
  events: ProbeEventRecord[],
  report: ProbeReport,
): ProbeVerdict {
  if (events.length === 0) {
    return {
      effect: "no-effect",
      message:
        "点击没有任何反应：页面在点击后没有收到任何鼠标事件（mousedown / mouseup / click 一个都没有）。" +
        "常见原因是视口未布局、元素在点击前被移走，或者坐标落在了可点区域之外。",
      detail: probeDetail(ref, report),
    };
  }
  return hitOrWrong(ref, events, report);
}

/** 共同的那一步：事件里有目标收下的就算命中，一个都没有就是被别的元素收走了 */
function hitOrWrong(
  ref: string | null,
  events: ProbeEventRecord[],
  report: ProbeReport,
): ProbeVerdict {
  if (ref === null) return { effect: "hit", warnings: [] };
  const hits = events.filter((event) => event.targetRef === ref);
  if (hits.length === 0) {
    const receiver = events[0];
    return {
      effect: "wrong-target",
      message:
        `事件没有落到目标 ${ref} 上，而是被 ${describeEventTarget(receiver)} 收走了` +
        `${report.elementAtPoint === null ? "" : `（那个坐标上现在是 ${describePoint(report.elementAtPoint)}）`}。` +
        "常见原因是目标被浮层 / 固定顶栏盖住，或者页面在点击前重新渲染过。",
      detail: { ref, receiver: receiver ?? null, ...probeDetail(ref, report) },
    };
  }
  return { effect: "hit", warnings: [] };
}

/** 错误 detail 里统一带上「谁收到了」与「坐标上是谁」，排查时不必再复现一次 */
function probeDetail(ref: string | null, report: ProbeReport): Record<string, unknown> {
  return {
    ref,
    elementAtPoint: report.elementAtPoint,
    events: Array.isArray(report.events) ? report.events : [],
  };
}

function describeEventTarget(event: ProbeEventRecord | undefined): string {
  if (event === undefined) return "另一个元素";
  const tag =
    event.targetTag === undefined || event.targetTag === "" ? "另一个元素" : `<${event.targetTag}>`;
  const byRef = event.targetRef === null ? "" : `（${event.targetRef}）`;
  const role =
    event.targetRole === undefined || event.targetRole === "" ? "" : ` role=${event.targetRole}`;
  return `${tag}${byRef}${role}`;
}

function describePoint(point: ProbePointElement): string {
  const id = point.id === undefined || point.id === "" ? "" : `#${point.id}`;
  const firstClass = (point.cls ?? "").trim().split(/\s+/)[0] ?? "";
  const cls = firstClass === "" ? "" : `.${firstClass}`;
  return `<${point.tag}${id}${cls}>`;
}
