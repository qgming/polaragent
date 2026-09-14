// 内置浏览器工具：让模型自己操作右侧面板那个浏览器。
//
// 与其它自建工具的差异：它们操作的是**主进程持有的 guest WebContents**
//（见 main/browser/service.ts），而不是会话的工作目录。所以：
//   · 不进 exec-env 的路径守卫 —— 浏览器读的是网页，不是工作区文件；
//   · 状态是**全局单例**而不是会话级的 —— 内置浏览器只有一份（详见 browser/types.ts），
//     工具因此不需要 sessionId 之外的依赖注入，直接取单例即可。
//
// 依赖经参数注入（BrowserAutomation）而不是 import 具体实现：service.ts 依赖 electron，
// 而这个文件要能在 node 环境的单测里跑（假实现即可，见 browser.test.ts）。
//
// 权限分级（见 permissions.ts，名单常量在 shared/contracts/browser.ts）：
//   · snapshot / console / network / screenshot / wait 是只读的 → LOW_RISK_TOOLS，模型可以自由地「先看一眼」；
//   · open / history / click / type / press / hover / select / dialog / evaluate 会改变页面状态或执行代码
//     → high，逐次审批。这几条正是「模型能不能替我在某个网站上点确认」的分界线，不该默认放行。
//
// 工具文案用英文，与内核四件套、todo、jobs 一致；面向维护者的注释是中文。

import type { AgentHarnessTool, ExecutionToolContext } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import {
  BROWSER_TOOL_NAMES,
  type BrowserConsoleReport,
  type BrowserDialogPolicy,
  type BrowserErrorCode,
  type BrowserNetworkReport,
  type BrowserPageState,
  type BrowserSnapshot,
  type BrowserWaitResult,
} from "@/shared/contracts/browser";
import type {
  BrowserActionOutcome,
  BrowserAutomation,
  BrowserNetworkQuery,
  BrowserOptionMatch,
  BrowserWaitOptions,
} from "../../browser/types";

/** 快照文本回填给模型的上限：与页面侧脚本的上限一致，这里只做二次兜底 */
const SNAPSHOT_TEXT_LIMIT = 6000;
/** 控制台回填条数上限 */
const CONSOLE_LIMIT = 100;

/** 网络记录回填条数上限：取最近 N 条（网络是「回头看」的读取，不增量） */
const NETWORK_LIMIT = 80;

/**
 * 已知错误码的运行时副本（§2 冻结）。
 *
 * 类型只在编译期存在，工具层要在运行时判断「这个错误是不是带码的浏览器失败」，
 * 所以必须有一份值。这里刻意不 import 具体类（src/main/browser/errors.ts）：
 *   1. 工具层与主进程实现分属两次改动，按**结构**识别（有 code 且在名单内）能让
 *      两侧各自独立落地，也把 electron 侧的依赖挡在 node 单测之外；
 *   2. detail 的键是开放集合（命中者 / 视口 / ref…），字段名不该固化进工具层。
 */
const BROWSER_ERROR_CODES: readonly BrowserErrorCode[] = [
  "UNKNOWN_REF",
  "STALE_REF",
  "REF_DRIFT",
  "NO_EFFECT",
  "WRONG_TARGET",
  "BLOCKED",
  "NOT_FOUND",
  "UNAVAILABLE",
  "INVALID_ARGUMENT",
  "TOOL_FAILED",
];

/** 主进程抛出的浏览器失败：code 决定「下一步怎么办」，detail 决定诊断信息 */
interface BrowserFailure {
  code: BrowserErrorCode;
  message: string;
  detail?: Record<string, unknown>;
}

/** 把任意错误识别成 BrowserFailure；不是就返回 undefined（原样上抛，行为不变） */
function asBrowserFailure(error: unknown): BrowserFailure | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const candidate = error as { code?: unknown; message?: unknown; detail?: unknown };
  if (typeof candidate.code !== "string") return undefined;
  if (!(BROWSER_ERROR_CODES as readonly string[]).includes(candidate.code)) return undefined;
  const detail =
    typeof candidate.detail === "object" && candidate.detail !== null
      ? (candidate.detail as Record<string, unknown>)
      : undefined;
  return {
    code: candidate.code as BrowserErrorCode,
    message: typeof candidate.message === "string" ? candidate.message : String(error),
    ...(detail === undefined ? {} : { detail }),
  };
}

/**
 * detail 的一个值 → 一行可读文本。
 *
 * 命中者与视口是诊断遮挡 / 零尺寸这两类故障的关键字段，给它们专有写法，
 * 比丢一段 JSON 更容易被模型读对（`div#modal.overlay` / `0×0`）。
 */
function formatDetailValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null) return "null";
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.tag === "string") {
      const id = typeof record.id === "string" && record.id !== "" ? `#${record.id}` : "";
      const cls = record.cls ?? record.class;
      const classes =
        typeof cls === "string" && cls.trim() !== "" ? `.${cls.trim().split(/\s+/).join(".")}` : "";
      return `${record.tag}${id}${classes}`;
    }
    const width = record.w ?? record.width;
    const height = record.h ?? record.height;
    if (typeof width === "number" && typeof height === "number") return `${width}×${height}`;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

/** 每种错误码的「下一步怎么办」：模型靠这一句决定是重试、重新快照还是换一条路 */
const FAILURE_NEXT_STEP: Record<BrowserErrorCode, string> = {
  UNKNOWN_REF: "这个 ref 不在任何快照里 —— 重新 browser_snapshot，用新清单里的 ref。",
  STALE_REF: "元素已被移除（页面重渲染过）—— 重新 browser_snapshot，再对新的 ref 操作。",
  REF_DRIFT: "节点还在但语义变了（框架复用了节点）—— 重新 browser_snapshot 核对目标后再操作。",
  NO_EFFECT:
    "动作发出但页面没有任何反应 —— 重新 browser_snapshot 看现状，并用 browser_console / browser_network 查原因。",
  WRONG_TARGET:
    "该位置被别的元素占据（浮层遮挡或坐标偏移）—— 先 browser_press Escape 关掉浮层，或改用 browser_evaluate 直接操作目标。",
  BLOCKED: "被浏览器策略拦下（弹窗 / 权限 / 导航白名单）—— 换个入口或先处理权限，别重试同一个动作。",
  NOT_FOUND: "目标不存在 —— 重新 browser_snapshot 确认页面上还有什么。",
  UNAVAILABLE:
    "浏览器面板未布局或未挂载（视口 0×0 时坐标输入无法投递）—— 请用户在右侧展开浏览器面板后重试，或改用 browser_evaluate。",
  INVALID_ARGUMENT: "参数不合法 —— 按工具的 schema 修正参数后重试。",
  TOOL_FAILED: "操作失败但原因不明 —— 可原样重试一次；仍失败就重新 browser_snapshot 后换一种做法。",
};

/** 失败 → 给模型看的完整文本：错误码 / 详情 / 下一步 */
function formatBrowserFailure(tool: string, failure: BrowserFailure): string {
  const lines = [`${tool} 失败（${failure.code}）：${failure.message}`];
  if (failure.detail !== undefined && Object.keys(failure.detail).length > 0) {
    lines.push("详情：");
    for (const [key, value] of Object.entries(failure.detail)) {
      lines.push(`- ${key}: ${formatDetailValue(value)}`);
    }
  }
  lines.push(`下一步：${FAILURE_NEXT_STEP[failure.code]}`);
  return lines.join("\n");
}

/**
 * 失败渲染的唯一出口（在 withAgentActivity 里统一调用）。
 *
 * 带 code 的失败换成可读文本再抛 —— 内核把抛出的文案作为工具结果回给模型；
 * 没有 code 的错误原样上抛，保持「参数校验错误 / 非浏览器错误」的既有形态。
 */
function decorateBrowserFailure(tool: string, error: unknown): unknown {
  const failure = asBrowserFailure(error);
  return failure === undefined ? error : new Error(formatBrowserFailure(tool, failure));
}

const openSchema = Type.Object({
  url: Type.String({
    minLength: 1,
    description:
      'The web address to open, e.g. "example.com" or "https://example.com/path?q=1". ' +
      "A missing scheme is completed to https. Only http and https are accepted.",
  }),
});

const historySchema = Type.Object({
  action: Type.Union([Type.Literal("back"), Type.Literal("forward"), Type.Literal("reload")], {
    description: '"back" / "forward" move through this page\'s own history; "reload" refetches it.',
  }),
});

const snapshotSchema = Type.Object({});

const clickSchema = Type.Object({
  ref: Type.String({
    minLength: 1,
    description:
      'Element ref from the most recent browser_snapshot, e.g. "e12". ' +
      "Refs are only valid for the snapshot that produced them: if the page changed, snapshot again.",
  }),
});

const typeSchema = Type.Object({
  ref: Type.String({
    minLength: 1,
    description: 'Element ref from the most recent browser_snapshot, e.g. "e12".',
  }),
  text: Type.String({
    description: "Text to put into the field. Any existing content in it is replaced.",
  }),
  submit: Type.Optional(
    Type.Boolean({
      description:
        "true to press Enter after typing (search boxes, login forms). Default false: only fill the field.",
    }),
  ),
});

const screenshotSchema = Type.Object({});

const consoleSchema = Type.Object({});

const evaluateSchema = Type.Object({
  code: Type.String({
    minLength: 1,
    description:
      "JavaScript to run in the page. The last expression's value is returned as JSON. " +
      "Use it only when the snapshot cannot answer the question (e.g. a page variable or a computed style).",
  }),
});

const pressSchema = Type.Object({
  key: Type.String({
    minLength: 1,
    description:
      'The key to press, e.g. "Enter", "Escape", "Tab", "ArrowDown", "PageDown", "Control+A", "Shift+Tab". ' +
      'Names follow KeyboardEvent.key; a modifier combination is written with "+".',
  }),
  ref: Type.Optional(
    Type.String({
      minLength: 1,
      description:
        "Element ref from the most recent browser_snapshot. When given, the element is clicked first to move " +
        'focus onto it, e.g. "e12". Omit it to send the key to whatever the page currently has focused.',
    }),
  ),
});

const hoverSchema = Type.Object({
  ref: Type.String({
    minLength: 1,
    description: 'Element ref from the most recent browser_snapshot, e.g. "e12".',
  }),
});

const selectSchema = Type.Object({
  ref: Type.String({
    minLength: 1,
    description: 'Element ref of the dropdown from the most recent browser_snapshot, e.g. "e12".',
  }),
  value: Type.Optional(
    Type.String({
      description: 'Program value of the option, e.g. "us" — usually what the form submits.',
    }),
  ),
  label: Type.Optional(
    Type.String({
      description: 'Text of the option as the user sees it, e.g. "United States".',
    }),
  ),
  index: Type.Optional(
    Type.Number({
      minimum: 1,
      description: "1-based position of the option in the list (1 = the first option).",
    }),
  ),
});

const waitSchema = Type.Object({
  text: Type.Optional(
    Type.String({
      description:
        "Wait until this text appears on the page (case-insensitive substring match). Use it when the page " +
        "has no stable selector to wait for.",
    }),
  ),
  selector: Type.Optional(
    Type.String({
      description: 'Wait until this CSS selector matches a visible element, e.g. "#results .row".',
    }),
  ),
  ms: Type.Optional(
    Type.Number({
      minimum: 0,
      description:
        "Wait this many milliseconds instead of waiting for something to appear (max 30000).",
    }),
  ),
  timeoutMs: Type.Optional(
    Type.Number({
      minimum: 0,
      description:
        "How long to wait for text / selector before giving up, in milliseconds. Default 5000, max 30000. " +
        "Ignored when ms is given.",
    }),
  ),
});

const networkSchema = Type.Object({
  failuresOnly: Type.Optional(
    Type.Boolean({
      description: "true to return only failed requests and 4xx/5xx responses. Default false.",
    }),
  ),
  clear: Type.Optional(
    Type.Boolean({
      description:
        "true to empty the buffer before returning, so the log measures only what happens from now on. " +
        "Default false.",
    }),
  ),
});

const dialogSchema = Type.Object({
  action: Type.Union([Type.Literal("accept"), Type.Literal("dismiss")], {
    description:
      '"accept" clicks OK, "dismiss" clicks Cancel / closes. Stays in effect for every later dialog until changed.',
  }),
  promptText: Type.Optional(
    Type.String({
      description:
        "Text to type into a prompt() dialog before it is accepted. Only used for prompt dialogs, and only " +
        "when action is accept.",
    }),
  ),
});

const OPEN_DESCRIPTION =
  "Open a web address in the built-in browser in the right sidebar, and wait for the page to finish loading.\n\n" +
  "When to use it: to reach a page before reading or interacting with it (sites the user asked about, docs, dashboards).\n" +
  "When NOT to use it: when a page is already open and you only need its content (use browser_snapshot); " +
  "to fetch a URL whose text you just need as data — this drives a real browser window the user is watching.\n\n" +
  "Notes: only http/https addresses work; file:, javascript: and data: are rejected. " +
  "The built-in browser must be open in the right sidebar (Ctrl+T); if it is not, this reports how to open it.\n" +
  "Output: the resulting page url and title. A load error may be reported for the url while the page still shows content.";

const HISTORY_DESCRIPTION =
  "Move the built-in browser through its own history: back, forward, or reload.\n\n" +
  "When to use it: after following a link you want to come back from; to retry a page that failed to load; " +
  "to refresh data after the user changed something outside the page.\n" +
  "When NOT to use it: to reach a known url (use browser_open); to change what the page shows " +
  "(use browser_click / browser_type).\n\n" +
  "Output: the resulting page url and title; a failure message when there is nothing to go back or forward to.";

const SNAPSHOT_DESCRIPTION =
  "Read the open page: its visible text plus the list of interactive elements (buttons, links, inputs) with a `ref` for each.\n\n" +
  "When to use it: first thing after browser_open, and again after every action that can change the page — " +
  "it is the only reliable way to know what is currently on screen.\n" +
  "When NOT to use it: when you only need to know whether the page finished loading " +
  "(browser_open already reports that).\n\n" +
  `Output: url, title, the visible text (truncated at ${SNAPSHOT_TEXT_LIMIT} characters), and elements as ` +
  'lines of `ref role "name"` in document order. Refs are valid only for this snapshot.\n' +
  "The text is what the user sees: it does not include hidden menus, collapsed sections, or content behind a click.";

const CLICK_DESCRIPTION =
  "Click an element of the open page, identified by the `ref` from a recent browser_snapshot.\n\n" +
  "When to use it: to follow a link, press a button, tick a box, open a menu, submit a filled-in form.\n" +
  "When NOT to use it: on an element you have not just seen in a snapshot (the page may have re-rendered " +
  "and the ref gone stale); to type into a field (use browser_type).\n\n" +
  "Notes: the click is a real mouse event sent to the page, so hover-menus and framework handlers behave " +
  "as they do for the user; the element is scrolled into view first. A disabled or hidden element is reported " +
  "as an error instead of being clicked blindly.\n" +
  "Output: the element's name and whether the click caused a navigation. Always snapshot again afterwards.";

const TYPE_DESCRIPTION =
  "Type text into an input, textarea or other editable element of the open page, identified by a `ref`.\n\n" +
  "When to use it: filling a search box or a form field before clicking its submit button, " +
  "or passing submit: true.\n" +
  "When NOT to use it: to read what a field currently contains (browser_snapshot reports each field's value).\n\n" +
  "Notes: any existing content in the field is replaced, not appended to. The field is focused and scrolled " +
  "into view first. With submit: true an Enter key is sent after typing, which is how search and login forms " +
  "are normally submitted.\n" +
  "Output: the element's name and whether the interaction caused a navigation.";

const SCREENSHOT_DESCRIPTION =
  "Take a picture of the visible part of the built-in browser and look at it.\n\n" +
  "When to use it: when the answer depends on how the page looks rather than on its text — a chart, a captcha, " +
  "a layout problem, whether something is visually hidden or overlapped.\n" +
  "When NOT to use it: as a substitute for browser_snapshot — the screenshot shows only the visible viewport, " +
  "contains no element refs, and costs far more tokens than the text.\n\n" +
  "Output: a PNG image of the current viewport.";

const CONSOLE_DESCRIPTION =
  "Read the console messages (including uncaught errors) the open page has produced since the last read.\n\n" +
  "When to use it: a page is blank or an action had no visible effect and you suspect a script error; " +
  "after browser_evaluate to see whether the code you ran logged anything.\n" +
  "When NOT to use it: to read the page content (use browser_snapshot).\n\n" +
  'Output: one line per message as "[level] text (source:line)", oldest first. ' +
  "Reading drains the buffer: each call returns only the messages added since the previous call, " +
  "and a call with no new messages says so.";

const EVALUATE_DESCRIPTION =
  "Run a piece of JavaScript in the open page and get its value back as JSON.\n\n" +
  "When to use it: the escape hatch for questions the snapshot cannot answer — reading a page variable, " +
  "a computed style, a data attribute, or a small calculation over the DOM.\n" +
  "When NOT to use it: for anything browser_snapshot already reports (text, links, form values) — " +
  "those are cheaper and cannot break the page. Do not use it to fetch other URLs.\n\n" +
  "Notes: the code runs in the page's own context, so it can see the page's globals and the DOM; " +
  "it cannot reach Node or this app. Promise results are awaited. The value must be JSON-serialisable.\n" +
  "Output: the JSON value, or the error message if the code threw.";

const PRESS_DESCRIPTION =
  "Press a key or a key combination on the open page, optionally aimed at one element.\n\n" +
  "When to use it: to submit a search box or form with Enter (finer than browser_type submit: true, which " +
  "always presses it right after typing); to walk a menu that has no refs with Tab or ArrowDown; to scroll a " +
  "long page with PageDown; to close an overlay with Escape; to select the whole field with Control+A and then " +
  "replace it with browser_type.\n" +
  "When NOT to use it: to put text into a field — use browser_type, which replaces the existing content; this " +
  "tool sends the key whether or not it lands anywhere, so a key that hits nothing changes nothing.\n\n" +
  'Notes: keys are named as in KeyboardEvent.key ("Enter", "Escape", "Tab", "ArrowDown", "PageDown") and a ' +
  'combination is written with "+" ("Control+A", "Shift+Tab"). With a ref the element is clicked first to put ' +
  "focus on it — that is also how you focus an element the page does not focus itself; without a ref the key " +
  "goes to the element the page currently has focused (often <body>, where most keys do nothing).\n" +
  "Output: the normalized keys that were sent, the target element when a ref was given, and whether pressing " +
  "caused a navigation.";

const HOVER_DESCRIPTION =
  "Move the mouse over an element of the open page, identified by the ref from a recent browser_snapshot.\n\n" +
  "When to use it: to open a hover menu or submenu, show a tooltip, or make a :hover rule take effect, then " +
  "snapshot again to see the elements it revealed.\n" +
  "When NOT to use it: to activate something — that is browser_click. Many menus open on hover as well, so try " +
  "click first; use hover when a click would navigate away or select something you do not want.\n\n" +
  "Notes: the pointer really moves, so CSS and JS hover handlers behave as they do for the user; nothing is " +
  "clicked, and nothing changes except the hover itself. The only way to see what appeared is to snapshot " +
  "again.\n" +
  "Output: the element's name and whether hovering caused a navigation (it almost never does).";

const SELECT_DESCRIPTION =
  "Choose an option in a dropdown of the open page, identified by the ref from a recent browser_snapshot.\n\n" +
  "When to use it: a form control is a real <select> and the snapshot lists options you can pick.\n" +
  "When NOT to use it: on dropdowns built from divs (they are not <select> — click the control, then click the " +
  "option); to fill a free-text field (use browser_type).\n\n" +
  'Notes: value is the program value of the option ("us", usually what the form submits), label is the text the ' +
  'user sees ("United States"), and index is the 1-based position in the list, for options whose value and ' +
  "label are both empty or duplicated. Give exactly one of value / label / index — zero or several is rejected, " +
  "because silently selecting the wrong option would corrupt the form. The element is scrolled into view first.\n" +
  "Output: the label and value that were actually selected, and whether selecting caused a navigation.";

const WAIT_DESCRIPTION =
  "Wait until the page shows a piece of text or an element, or for a fixed number of milliseconds.\n\n" +
  "When to use it: the number one problem with single-page apps is that an action returns before its content is " +
  "rendered, so a snapshot taken right after it shows an empty shell. Wait for the outcome instead — a text that " +
  "only appears once data arrives, or a container selector. text matches case-insensitively as a substring, " +
  "which is what you need when the page has no stable selector (class names are build hashes).\n" +
  "When NOT to use it: as a substitute for looking — snapshot first to see whether the page is loading at all, " +
  "and re-check with browser_network when you want to know whether a request finished.\n\n" +
  "Notes: give exactly one of text / selector / ms. timeoutMs (default 5000) applies only to text and selector; " +
  "both it and ms are capped at 30000 by the browser.\n" +
  "Output: whether the condition was met and how long it took. On timeout the message also says what the page " +
  "looked like at that moment — read it before retrying.";

const NETWORK_DESCRIPTION =
  "Read the network requests the open page has made.\n\n" +
  "When to use it: a page is blank or a button did nothing and you need to tell an API returning 500 apart from " +
  "a request blocked by CORS and from a request that was never sent at all; a page is slower than expected and " +
  "you want to see which request is taking the time.\n" +
  "When NOT to use it: to read script errors and page messages (use browser_console).\n\n" +
  "Notes: unlike browser_console this is NOT an incremental read — every call returns the whole record that is " +
  "currently buffered, so calling it twice shows the same requests twice. Pass clear: true to empty the buffer " +
  "first when you want to measure only what happens from now on; failuresOnly: true narrows the answer to failed " +
  "requests and 4xx/5xx responses.\n" +
  'Output: one line per request as "METHOD status url (type, Nms)". A status of failed means no response was ' +
  `received, with the reason appended when known. At most the last ${NETWORK_LIMIT} requests are shown.`;

const DIALOG_DESCRIPTION =
  "Set how the built-in browser answers JavaScript dialogs (alert / confirm / prompt).\n\n" +
  "When to use it: a flow shows a confirmation dialog you need to accept; a prompt() needs text typed into it " +
  "(promptText).\n" +
  'When NOT to use it: as a way to answer "the dialog that is about to appear" — this sets a policy, not a ' +
  "one-off answer, and it stays in effect until you change it again. The content of each dialog is logged to " +
  "the console (level=warning); read it with browser_console.\n\n" +
  "Notes: a JS dialog blocks the page's renderer — while nobody answers it the page is completely stuck and " +
  "every later operation times out (measured behaviour, not theory). The built-in browser therefore dismisses " +
  'dialogs automatically by default, so a page is never stuck; use accept for the flows that need "OK" ' +
  "(confirmation dialogs, beforeunload save prompts). promptText is only used on prompt dialogs and only when " +
  "action is accept.\n" +
  "Output: the policy now in effect, and how many dialogs have been answered automatically since this tool was " +
  "last called.";

/** 快照 → 给模型看的文本：文本在前、元素清单在后（元素才是下一步要用的） */
function formatSnapshot(snapshot: BrowserSnapshot): string {
  const lines: string[] = [`Page: ${snapshot.title === "" ? "(untitled)" : snapshot.title}`];
  lines.push(`URL: ${snapshot.url === "" ? "(none)" : snapshot.url}`);
  if (typeof snapshot.generation === "number") {
    lines.push(`Snapshot generation: ${snapshot.generation} — refs are only valid for this one.`);
  }
  if (
    snapshot.viewport !== undefined &&
    (snapshot.viewport.width === 0 || snapshot.viewport.height === 0)
  ) {
    lines.push(
      `Viewport: ${snapshot.viewport.width}×${snapshot.viewport.height} — the panel is not laid out, ` +
        "so coordinate input (click / type / press / hover / select) cannot be delivered. " +
        "Ask the user to expand the browser panel, or use browser_evaluate.",
    );
  }

  const text =
    snapshot.text.length > SNAPSHOT_TEXT_LIMIT
      ? `${snapshot.text.slice(0, SNAPSHOT_TEXT_LIMIT)}…`
      : snapshot.text;
  lines.push("", "Visible text:", text === "" ? "(the page shows no text)" : text);

  lines.push("", `Interactive elements (${snapshot.elements.length}):`);
  if (snapshot.elements.length === 0) {
    lines.push("(none — the page may still be loading, or everything on it is plain text)");
  } else {
    for (const element of snapshot.elements) {
      const parts = [`- ${element.ref}`, element.role, `"${element.name}"`];
      if (element.type !== undefined) parts.push(`type=${element.type}`);
      if (element.value !== undefined) parts.push(`value="${element.value}"`);
      if (element.checked !== undefined) parts.push(element.checked ? "checked" : "unchecked");
      if (element.disabled === true) parts.push("disabled");
      if (element.href !== undefined) parts.push(`-> ${element.href}`);
      lines.push(parts.join(" "));
    }
  }

  if (
    snapshot.omitted !== undefined &&
    (snapshot.omitted.elements > 0 || snapshot.omitted.textChars > 0)
  ) {
    const omitted: string[] = [];
    if (snapshot.omitted.elements > 0) omitted.push(`${snapshot.omitted.elements} element(s)`);
    if (snapshot.omitted.textChars > 0) {
      omitted.push(`${snapshot.omitted.textChars} text character(s)`);
    }
    lines.push(
      "",
      `(Omitted by the page limits: ${omitted.join(" and ")} — there is more on the page than listed above.)`,
    );
  }
  if (snapshot.truncated) {
    lines.push("", "(The page was longer than the limits above; this is a partial view.)");
  }
  return lines.join("\n");
}

/**
 * 控制台消息 → 给模型看的文本。
 *
 * dropped 是被过滤掉的来源（Electron 自身的安全警告等，见 §6）：过滤该做，
 * 但必须让模型知道「少了的那几条不是页面没产生」。读取语义仍是增量 ——
 * 只报上次读取之后的新消息。
 */
function formatConsole(report: BrowserConsoleReport): string {
  const notes =
    report.dropped > 0
      ? [
          `(${report.dropped} message(s) were filtered out as noise from Electron itself, not the page.)`,
        ]
      : [];
  if (report.entries.length === 0) {
    return ["No new console messages since the last read.", ...notes].join("\n");
  }
  const shown = report.entries.slice(-CONSOLE_LIMIT);
  const lines = shown.map((entry) => {
    const where = entry.source === "" ? "" : ` (${entry.source}:${entry.line})`;
    return `[${entry.level}] ${entry.text}${where}`;
  });
  const header =
    report.entries.length > shown.length
      ? `Console messages (showing the last ${shown.length} of ${report.entries.length}):`
      : `Console messages (${report.entries.length}):`;
  return [header, ...notes, ...lines].join("\n");
}

/** 导航结果文案：open 与 history 都只回「到哪了」 */
function formatPageState(action: string, state: BrowserPageState): string {
  const notes = [`${action}: now at ${state.url === "" ? "(no page)" : state.url}`];
  if (state.title !== "") notes.push(`Title: ${state.title}`);
  if (state.loading) {
    notes.push("The page is still loading; snapshot again if it looks incomplete.");
  }
  if (state.error !== undefined) notes.push(`Load problem: ${state.error}`);
  return notes.join("\n");
}

/**
 * 网络记录 → 给模型看的文本。
 *
 * 三种事实必须分开说（§6），否则模型没法据此决策：
 *   1. bufferEmpty —— 缓冲里一条记录都没有；
 *   2. noFailures —— 有记录但全都成功了。旧实现在这里回「还没有记录」，与事实相反，
 *      而模型正是靠这句话决定要不要继续等接口；
 *   3. omitted —— 有记录没列出来（展示上限），不给出数字会让模型以为「页面就发了这么多」。
 */
function formatNetwork(report: BrowserNetworkReport): string {
  if (report.bufferEmpty) return "No network requests have been recorded yet.";

  const shown = report.entries.slice(-Math.min(report.entries.length, NETWORK_LIMIT));
  const omitted = Math.max(0, report.omitted) + (report.entries.length - shown.length);
  const lines: string[] = [];

  if (report.noFailures) {
    lines.push(
      `Network requests: ${report.total} record(s), none failed — no request errored and none returned a 4xx/5xx status.`,
    );
  }

  if (shown.length === 0) {
    lines.push("Nothing to list for this read.");
  } else {
    lines.push(
      omitted > 0
        ? `Network requests (showing the last ${shown.length} of ${report.total}):`
        : `Network requests (${report.total}):`,
      'Each line is "METHOD status url (type, Nms)"; a failed line is a request that got no response.',
    );
    for (const entry of shown) {
      const status = entry.status === 0 ? "failed" : String(entry.status);
      const reason = entry.error === undefined || entry.error === "" ? "" : ` - ${entry.error}`;
      lines.push(
        `${entry.method} ${status} ${entry.url} (${entry.resourceType}, ${entry.durationMs}ms)${reason}`,
      );
    }
  }

  if (omitted > 0) {
    lines.push(
      `${omitted} record(s) are not listed here (only the most recent ${NETWORK_LIMIT} are shown).`,
    );
  }
  return lines.join("\n");
}

/**
 * 等待结果 → 给模型看的文本。
 *
 * 超时分支是重点：这是模型唯一能拿到「等的是什么、等了多久、现在页面什么样」的地方，
 * 少了它模型只会拿着同一个条件盲目重试。
 */
function formatWait(result: BrowserWaitResult): string {
  if (result.matched) return `Waited ${result.waitedMs}ms: ${result.detail}`;
  return (
    `Timed out after ${result.waitedMs}ms: ${result.detail}\n` +
    "The page may be slower than the timeout, or the text you are waiting for never renders. " +
    "Snapshot to see what is on the page now."
  );
}

/** 「三选一」参数个数不对时的统一错误：说清要求与实际给了哪几个，模型才知道怎么改 */
function exclusiveParamError(tool: string, names: readonly string[], given: string[]): Error {
  const actual = given.length === 0 ? "0 个" : `${given.length} 个（${given.join("、")}）`;
  return new Error(`${tool} 需要恰好给出 ${names.join(" / ")} 中的一个，实际给了 ${actual}。`);
}

/** browser_select 的 value / label / index → BrowserOptionMatch（个数不对直接抛错） */
function pickOptionMatch(input: {
  value?: string;
  label?: string;
  index?: number;
}): BrowserOptionMatch {
  const given: string[] = [];
  if (input.value !== undefined) given.push("value");
  if (input.label !== undefined) given.push("label");
  if (input.index !== undefined) given.push("index");
  const names = ["value", "label", "index"];
  if (given.length !== 1) throw exclusiveParamError("browser_select", names, given);

  if (input.value !== undefined) return { kind: "value", value: input.value };
  if (input.label !== undefined) return { kind: "label", label: input.label };
  if (input.index !== undefined) return { kind: "index", index: input.index };
  // 上面的计数已经保证三者恰有一个；这一行只是让类型收敛（TS 无法从计数推断解构结果）
  throw exclusiveParamError("browser_select", names, given);
}

/** browser_wait 的 text / selector / ms → BrowserWaitOptions（个数不对直接抛错） */
function pickWaitOptions(input: {
  text?: string;
  selector?: string;
  ms?: number;
  timeoutMs?: number;
}): BrowserWaitOptions {
  const given: string[] = [];
  if (input.text !== undefined) given.push("text");
  if (input.selector !== undefined) given.push("selector");
  if (input.ms !== undefined) given.push("ms");
  if (given.length !== 1)
    throw exclusiveParamError("browser_wait", ["text", "selector", "ms"], given);

  const options: BrowserWaitOptions = {};
  if (input.text !== undefined) options.text = input.text;
  else if (input.selector !== undefined) options.selector = input.selector;
  else if (input.ms !== undefined) options.ms = input.ms;
  if (input.timeoutMs !== undefined) options.timeoutMs = input.timeoutMs;
  return options;
}

/** 面板提示条文案：wait 的三类目标互斥，说清这次在等什么 */
function waitNote(options: BrowserWaitOptions): string {
  if (options.text !== undefined) return "正在等待文字出现";
  if (options.selector !== undefined) return "正在等待元素出现";
  return "正在等待页面";
}

/**
 * 动作成功 → outcome 里必须交代的两件事（§4 / §6）。
 *
 * effect 三态要区别对待：
 *   hit —— 探针确认事件落到了目标上，这是常态，不再多说（默认形态不变，不啰嗦）；
 *   unknown —— 探针不可用（注入失败等），**没有做任何断言**，绝不能读成「已验证命中」；
 *   no-effect —— 服务侧通常已把它转成 NO_EFFECT 抛错，真走到这里也要说清。
 * warnings 非空必须逐条列出（例如输入被 maxlength 截断），否则模型会把「部分生效」当成完全生效。
 */
function withActionNotes(text: string, outcome: BrowserActionOutcome): string {
  const notes: string[] = [];
  if (outcome.effect === "unknown") {
    notes.push(
      "Effect: unknown — the page-side check was not available, so this only says the action was dispatched; it is NOT asserted to have landed.",
    );
  } else if (outcome.effect === "no-effect") {
    notes.push("Effect: the page showed no reaction to this action.");
  }
  if (outcome.detail !== undefined && outcome.detail !== "") notes.push(outcome.detail);
  for (const warning of outcome.warnings ?? []) notes.push(`Warning: ${warning}`);
  return notes.length === 0 ? text : [text, ...notes].join("\n");
}

/**
 * 统一把「模型正在操作页面」推给面板，并把这次调用排进串行队列。
 *
 * **串行是必需的**：内核默认 toolExecution 是 parallel，模型可以在一轮里同时发多个
 * 工具调用（一次点两处、或边点边截图）。click / type 是「移鼠标 → 按下 → 抬起」三步，
 * 两次调用交错会把坐标与按键落到错误的元素上 —— 表现为随机点错东西，最难排查。
 * 排队后每次操作自成一个完整序列，代价只是并行度，而浏览器本来就一次只干一件事。
 *
 * 用计数而不是布尔记录「有几个操作在跑」：先结束的那个不该把提示条清掉，
 * 否则还有工具在动的时候界面看起来已经停了 —— 并行执行下那会真的发生。
 *
 * 失败也在这里收口：主进程抛的 BrowserToolError 带 code/detail，统一渲染成
 * 「错误码 + 详情 + 下一步」；tool 参数就是首行要写的工具名（browser_click 等）。
 */
let activityCount = 0;
let activityChain: Promise<unknown> = Promise.resolve();

function withAgentActivity<T>(
  automation: BrowserAutomation,
  note: string,
  run: () => Promise<T>,
  tool: string,
): Promise<T> {
  // activityChain 永远以「已完成」的状态接上（错误在下面被吞掉），所以只需一个回调；
  // 上一次调用失败也不该阻断这一次 —— 每次调用各自拿到自己的结果或错误。
  const queued = activityChain.then(() => {
    activityCount += 1;
    automation.setAgentActive(true, note);
    return run()
      .catch((error: unknown) => {
        throw decorateBrowserFailure(tool, error);
      })
      .finally(() => {
        activityCount = Math.max(0, activityCount - 1);
        // 只有最后一个结束的才清提示条：计数归零才代表真的没有操作在跑
        if (activityCount === 0) automation.setAgentActive(false);
      });
  });
  activityChain = queued.then(
    () => undefined,
    () => undefined,
  );
  return queued;
}

/**
 * 构造整套浏览器工具。
 *
 * automation 由调用方注入：生产是 getBrowserAutomation() 单例（工具与 IPC 共用一份状态），
 * 测试传假实现 —— 与 jobs / ask 的注入方式一致，工具自己不认识 Electron。
 */
export function createBrowserTools(
  automation: BrowserAutomation,
): AgentHarnessTool<ExecutionToolContext>[] {
  const open: AgentHarnessTool<ExecutionToolContext, typeof openSchema> = {
    name: BROWSER_TOOL_NAMES.open,
    label: BROWSER_TOOL_NAMES.open,
    description: OPEN_DESCRIPTION,
    parameters: openSchema,
    async execute(_toolCallId, params: Static<typeof openSchema>) {
      const state = await withAgentActivity(
        automation,
        `正在打开 ${params.url}`,
        () => automation.open(params.url),
        BROWSER_TOOL_NAMES.open,
      );
      return {
        content: [{ type: "text", text: formatPageState("Opened", state) }],
        details: { state },
      };
    },
  };

  const history: AgentHarnessTool<ExecutionToolContext, typeof historySchema> = {
    name: BROWSER_TOOL_NAMES.history,
    label: BROWSER_TOOL_NAMES.history,
    description: HISTORY_DESCRIPTION,
    parameters: historySchema,
    async execute(_toolCallId, params: Static<typeof historySchema>) {
      const label =
        params.action === "back" ? "后退" : params.action === "forward" ? "前进" : "刷新";
      const state = await withAgentActivity(
        automation,
        `正在${label}`,
        () => automation.history(params.action),
        BROWSER_TOOL_NAMES.history,
      );
      return {
        content: [{ type: "text", text: formatPageState(params.action, state) }],
        details: { state },
      };
    },
  };

  const snapshot: AgentHarnessTool<ExecutionToolContext, typeof snapshotSchema> = {
    name: BROWSER_TOOL_NAMES.snapshot,
    label: BROWSER_TOOL_NAMES.snapshot,
    description: SNAPSHOT_DESCRIPTION,
    parameters: snapshotSchema,
    async execute() {
      const result = await withAgentActivity(
        automation,
        "正在读取页面",
        () => automation.snapshot(),
        BROWSER_TOOL_NAMES.snapshot,
      );
      return { content: [{ type: "text", text: formatSnapshot(result) }], details: result };
    },
  };

  const click: AgentHarnessTool<ExecutionToolContext, typeof clickSchema> = {
    name: BROWSER_TOOL_NAMES.click,
    label: BROWSER_TOOL_NAMES.click,
    description: CLICK_DESCRIPTION,
    parameters: clickSchema,
    async execute(_toolCallId, params: Static<typeof clickSchema>) {
      const outcome = await withAgentActivity(
        automation,
        `正在点击 ${params.ref}`,
        () => automation.click(params.ref),
        BROWSER_TOOL_NAMES.click,
      );
      const target = outcome.name === "" ? params.ref : `${params.ref} ("${outcome.name}")`;
      const text = withActionNotes(
        outcome.navigated
          ? `Clicked ${target}. The page navigated; snapshot again to see the new content.`
          : `Clicked ${target}. The page did not navigate; snapshot again to see what changed.`,
        outcome,
      );
      return { content: [{ type: "text", text }], details: outcome };
    },
  };

  const typeTool: AgentHarnessTool<ExecutionToolContext, typeof typeSchema> = {
    name: BROWSER_TOOL_NAMES.type,
    label: BROWSER_TOOL_NAMES.type,
    description: TYPE_DESCRIPTION,
    parameters: typeSchema,
    async execute(_toolCallId, params: Static<typeof typeSchema>) {
      const outcome = await withAgentActivity(
        automation,
        `正在输入到 ${params.ref}`,
        () => automation.type(params.ref, params.text, params.submit === true),
        BROWSER_TOOL_NAMES.type,
      );
      const target = outcome.name === "" ? params.ref : `${params.ref} ("${outcome.name}")`;
      const suffix = params.submit === true ? " and pressed Enter" : "";
      const text = withActionNotes(
        outcome.navigated
          ? `Typed into ${target}${suffix}. The page navigated; snapshot again to see the result.`
          : `Typed into ${target}${suffix}. The page did not navigate; snapshot again to confirm the field now holds the text.`,
        outcome,
      );
      return { content: [{ type: "text", text }], details: outcome };
    },
  };

  const press: AgentHarnessTool<ExecutionToolContext, typeof pressSchema> = {
    name: BROWSER_TOOL_NAMES.press,
    label: BROWSER_TOOL_NAMES.press,
    description: PRESS_DESCRIPTION,
    parameters: pressSchema,
    async execute(_toolCallId, params: Static<typeof pressSchema>) {
      const outcome = await withAgentActivity(
        automation,
        `正在按键 ${params.key}`,
        () => automation.press(params.key, params.ref),
        BROWSER_TOOL_NAMES.press,
      );
      const where =
        outcome.name === ""
          ? ""
          : ` on ${params.ref ?? "(the focused element)"} ("${outcome.name}")`;
      const text = withActionNotes(
        outcome.navigated
          ? `Pressed ${outcome.keys}${where}. The page navigated; snapshot again to see the new content.`
          : `Pressed ${outcome.keys}${where}. The page did not navigate; snapshot again to see what changed.`,
        outcome,
      );
      return { content: [{ type: "text", text }], details: outcome };
    },
  };

  const hover: AgentHarnessTool<ExecutionToolContext, typeof hoverSchema> = {
    name: BROWSER_TOOL_NAMES.hover,
    label: BROWSER_TOOL_NAMES.hover,
    description: HOVER_DESCRIPTION,
    parameters: hoverSchema,
    async execute(_toolCallId, params: Static<typeof hoverSchema>) {
      const outcome = await withAgentActivity(
        automation,
        `正在悬停到 ${params.ref}`,
        () => automation.hover(params.ref),
        BROWSER_TOOL_NAMES.hover,
      );
      const target = outcome.name === "" ? params.ref : `${params.ref} ("${outcome.name}")`;
      const text = withActionNotes(
        outcome.navigated
          ? `Hovered ${target}. The page navigated; snapshot again to see the new content.`
          : `Hovered ${target}. The page did not navigate; snapshot again to see what appeared.`,
        outcome,
      );
      return { content: [{ type: "text", text }], details: outcome };
    },
  };

  const select: AgentHarnessTool<ExecutionToolContext, typeof selectSchema> = {
    name: BROWSER_TOOL_NAMES.select,
    label: BROWSER_TOOL_NAMES.select,
    description: SELECT_DESCRIPTION,
    parameters: selectSchema,
    async execute(_toolCallId, params: Static<typeof selectSchema>) {
      // 参数校验放在这里而不是交给 schema：typebox 表达不了「恰好一个」，而服务侧抛出的
      // 中文错误会原样回给模型，模型据此就能改对参数。
      const match = pickOptionMatch(params);
      const outcome = await withAgentActivity(
        automation,
        "正在选择下拉项",
        () => automation.select(params.ref, match),
        BROWSER_TOOL_NAMES.select,
      );
      const target = outcome.name === "" ? params.ref : `${params.ref} ("${outcome.name}")`;
      const suffix = outcome.navigated
        ? "The page navigated; snapshot again to see the new content."
        : "The page did not navigate; snapshot again to confirm the field now holds the selection.";
      const text = withActionNotes(
        `Selected "${outcome.label}" (value="${outcome.value}") in ${target}. ${suffix}`,
        outcome,
      );
      return { content: [{ type: "text", text }], details: outcome };
    },
  };

  const wait: AgentHarnessTool<ExecutionToolContext, typeof waitSchema> = {
    name: BROWSER_TOOL_NAMES.wait,
    label: BROWSER_TOOL_NAMES.wait,
    description: WAIT_DESCRIPTION,
    parameters: waitSchema,
    async execute(_toolCallId, params: Static<typeof waitSchema>) {
      const options = pickWaitOptions(params);
      const result = await withAgentActivity(
        automation,
        waitNote(options),
        () => automation.wait(options),
        BROWSER_TOOL_NAMES.wait,
      );
      return { content: [{ type: "text", text: formatWait(result) }], details: result };
    },
  };

  const screenshot: AgentHarnessTool<ExecutionToolContext, typeof screenshotSchema> = {
    name: BROWSER_TOOL_NAMES.screenshot,
    label: BROWSER_TOOL_NAMES.screenshot,
    description: SCREENSHOT_DESCRIPTION,
    parameters: screenshotSchema,
    async execute() {
      const shot = await withAgentActivity(
        automation,
        "正在截图",
        () => automation.screenshot(),
        BROWSER_TOOL_NAMES.screenshot,
      );
      return {
        content: [
          {
            type: "text",
            text: `Screenshot of the visible viewport (${shot.width}×${shot.height}).`,
          },
          { type: "image", data: shot.data, mimeType: shot.mimeType },
        ],
        details: { width: shot.width, height: shot.height },
      };
    },
  };

  const consoleTool: AgentHarnessTool<ExecutionToolContext, typeof consoleSchema> = {
    name: BROWSER_TOOL_NAMES.console,
    label: BROWSER_TOOL_NAMES.console,
    description: CONSOLE_DESCRIPTION,
    parameters: consoleSchema,
    async execute() {
      // 读缓冲本身不碰页面，但它也要走这条链：**「每个工具都在同一条串行链上」是
      // 一条不该有例外的规则** —— 一旦有一个例外，下一个人加工具时就不知道要不要包，
      // 而漏包的代价（两次点击序列交错）极难归因。代价只是提示条多闪一下。
      const report = await withAgentActivity(
        automation,
        "正在读取页面控制台",
        () => automation.console(),
        BROWSER_TOOL_NAMES.console,
      );
      return {
        content: [{ type: "text", text: formatConsole(report) }],
        details: report,
      };
    },
  };

  const network: AgentHarnessTool<ExecutionToolContext, typeof networkSchema> = {
    name: BROWSER_TOOL_NAMES.network,
    label: BROWSER_TOOL_NAMES.network,
    description: NETWORK_DESCRIPTION,
    parameters: networkSchema,
    async execute(_toolCallId, params: Static<typeof networkSchema>) {
      const query: BrowserNetworkQuery = {
        failuresOnly: params.failuresOnly === true,
        clear: params.clear === true,
      };
      // 返回值从「裸数组」换成了 BrowserNetworkReport（§6）：bufferEmpty / noFailures / omitted
      // 是三种不同的事实，工具层必须分开说，否则模型会把「全都成功了」读成「还没发请求」。
      const report = await withAgentActivity(
        automation,
        "正在读取网络请求",
        () => automation.network(query),
        BROWSER_TOOL_NAMES.network,
      );
      const parts: string[] = [];
      // 清空是「从现在开始量」的动作：先说明缓冲已经空了，再看记录，顺序不能反
      if (params.clear === true) parts.push("Network log cleared before this read.");
      parts.push(formatNetwork(report));
      return { content: [{ type: "text", text: parts.join("\n") }], details: report };
    },
  };

  const dialog: AgentHarnessTool<ExecutionToolContext, typeof dialogSchema> = {
    name: BROWSER_TOOL_NAMES.dialog,
    label: BROWSER_TOOL_NAMES.dialog,
    description: DIALOG_DESCRIPTION,
    parameters: dialogSchema,
    async execute(_toolCallId, params: Static<typeof dialogSchema>) {
      const promptText = params.promptText ?? "";
      // 空串等同于没给：prompt 弹窗的默认文字是页面自己写的，不该被空串盖掉
      const policy: BrowserDialogPolicy =
        promptText === "" ? { action: params.action } : { action: params.action, promptText };
      const outcome = await withAgentActivity(
        automation,
        "正在设置弹窗策略",
        () => automation.dialog(policy),
        BROWSER_TOOL_NAMES.dialog,
      );
      const lines = [
        `JavaScript dialogs will now be ${policy.action === "accept" ? "accepted" : "dismissed"}.`,
      ];
      if (promptText !== "") lines.push(`Prompt text: "${promptText}"`);
      lines.push(
        outcome.handledSinceLastRead === 0
          ? "No dialogs have popped up since the last call to this tool."
          : `${outcome.handledSinceLastRead} dialog(s) have been handled automatically since the last call to this tool.`,
      );
      lines.push("Details of each dialog are logged to the console (browser_console).");
      return { content: [{ type: "text", text: lines.join("\n") }], details: outcome };
    },
  };

  const evaluate: AgentHarnessTool<ExecutionToolContext, typeof evaluateSchema> = {
    name: BROWSER_TOOL_NAMES.evaluate,
    label: BROWSER_TOOL_NAMES.evaluate,
    description: EVALUATE_DESCRIPTION,
    parameters: evaluateSchema,
    async execute(_toolCallId, params: Static<typeof evaluateSchema>) {
      const result = await withAgentActivity(
        automation,
        "正在页面中执行脚本",
        () => automation.evaluate(params.code),
        BROWSER_TOOL_NAMES.evaluate,
      );
      const text = result.ok ? `Result: ${result.value}` : `The code threw: ${result.error}`;
      return { content: [{ type: "text", text }], details: result };
    },
  };

  return [
    open,
    history,
    snapshot,
    click,
    typeTool,
    press,
    hover,
    select,
    wait,
    screenshot,
    consoleTool,
    network,
    dialog,
    evaluate,
  ];
}
