// 内置浏览器的自动化服务：主进程这一侧唯一持有 guest WebContents 的地方。
//
// 为什么是主进程而不是渲染层的 webview.executeJavaScript：
//   1. **攻击面**。从渲染层驱动页面 = 在 IPC 上开一个「任意页面代码执行」入口，
//      任何拿到渲染进程执行权的东西都能借它读任意已登录站点。主进程本来就从
//      did-attach-webview 拿到了 guest，不需要再暴露一次。
//   2. **坐标与输入事件**。真实点击要走 webContents.sendInputEvent（合成 click
//      不满足 isTrusted，框架会无视），那只有主进程能做。
//   3. **截图**。capturePage 是 WebContents 的能力，渲染层的 webview 没有等价物。
//
// 与渲染层的关系：**guest 由渲染层的 <webview> 元素创建**（面板挂载才有 guest），
// 主进程通过 did-attach-webview 接管它。为了让模型不必先求用户「请打开面板」，
// 服务在这里做两件事：发出 open-request 让渲染层把面板切出来，然后**等** guest 到位
// （见 awaitGuest）。人只看到面板自己出现了；模型那边什么都不用多做。
//
// 状态刻意**不做持久化**：浏览器会话活在 guest 进程里，应用退出即消失；
// 磁盘上留一份「上次打开的页面」只会制造「重启后它自己回来了」的困惑。

// 阶段 1 的三道「不谎报」关卡（docs/browser-automation-refactor.md §3–§5）：
//   1. **视口守卫**：面板收起时视口是 0×0，坐标输入会被静默丢弃 —— 先查，再动手；
//   2. **ref 校验**：动作前按账本核对 ref 现在的签名，区分「元素被移除」（STALE_REF）、
//      「编号被复用」（REF_DRIFT）与「模型编造的 ref」（UNKNOWN_REF）；
//   3. **后果探针**：动作后在页面里读「谁收到了事件」，空事件报 NO_EFFECT、
//      被别的元素收走报 WRONG_TARGET —— 这两种在旧实现里都会报成「已点击」。
// 三道关各自都可能失败，但失败必须**说得出下一步**（重新 snapshot / 关掉浮层 / 展开面板），
// 所以错误都带错误码（errors.ts），不再是自由文本。
import { BrowserWindow, type Session, type WebContents } from "electron";
import type {
  BrowserConsoleEntry,
  BrowserConsoleReport,
  BrowserDialogPolicy,
  BrowserEvent,
  BrowserNetworkEntry,
  BrowserNetworkReport,
  BrowserPageState,
  BrowserSnapshot,
  BrowserStatus,
  BrowserWaitResult,
} from "@/shared/contracts/browser";
import { IPC } from "@/shared/contracts/ipc";
import {
  buildCaptureScreenshotParams,
  cdpSessionFor,
  type CdpConsoleRecord,
  type CdpSession,
  consoleCallToRecord,
  exceptionThrownToRecord,
  logEntryToRecord,
  looksLikeBlankPng,
  readPngSize,
} from "./cdp";
import { BrowserToolError, toBrowserToolError } from "./errors";
import { type BrowserKeyStroke, KEY_SPEC_EXAMPLES, parseKeySpec, toCdpKeyEvent } from "./keys";
import { elementSignature, RefRegistry } from "./refs";
import {
  buildArmProbeExpression,
  buildEvaluateExpression,
  buildLocateExpression,
  buildReadProbeExpression,
  buildReadValueExpression,
  buildSelectExpression,
  buildSnapshotExpression,
  buildViewportExpression,
  buildWaitExpression,
  normalizeBrowserUrl,
  type ProbeKind,
} from "./script";
import type {
  BrowserActionOutcome,
  BrowserAutomation,
  BrowserDialogOutcome,
  BrowserEvaluateResult,
  BrowserOptionMatch,
  BrowserPressOutcome,
  BrowserScreenshot,
  BrowserSelectOutcome,
} from "./types";
import {
  judgeInput,
  judgeProbe,
  type InputVerdict,
  type ProbeReport,
  type ProbeVerdict,
} from "./verify";
import { waitFor } from "./wait";

/** 控制台日志缓冲上限：只留最近这些条，模型要看的是「刚才报了什么错」 */
const CONSOLE_BUFFER_LIMIT = 500;
/** 单条控制台消息的最大字符数 */
const CONSOLE_MAX_CHARS = 2000;
/** 导航等待上限：超时不报错，只把「还在加载」如实告诉模型 */
const NAVIGATE_TIMEOUT_MS = 20_000;
/**
 * back / forward 落定的上限与轮询间隔。
 *
 * 两个判据都看：地址变了（跨文档导航），或 CDP 的历史下标到了目标条目
 *（单页应用的条目可能同 URL，只是 state 不同）。两者都没动才算没生效 ——
 * 这正是「不许再出现报成功但没动」的判定依据。
 */
const HISTORY_SETTLE_TIMEOUT_MS = 3_000;
const HISTORY_POLL_MS = 50;
/**
 * 等面板把 guest 建出来的上限。
 *
 * 这条路径要走的是：发事件 → 渲染层把右侧栏展开并把视图切到浏览器 → React 渲染
 * BrowserPanel → document.createElement("webview") 插入 → 主进程 did-attach-webview
 * → 我们拿到 WebContents。**首次**调用还要额外等渲染层把面板挂载起来（React 首渲染 +
 * webview 元素的 attach），实测第一次会超过 5 秒（报 UNAVAILABLE，立刻重试就成功），
 * 所以上限取 15 秒 —— 给首次挂载留足余量，同时不让失败调用挂得太久。
 * 超时不静默：报错说清「面板还在打开」，而不是「浏览器不可用」。
 */
const GUEST_READY_TIMEOUT_MS = 15_000;
/** 轮询间隔：按帧级粒度等，避免用户看到「点了半天没反应」 */
const GUEST_POLL_MS = 50;
/**
 * 重发「打开面板」请求的最小间隔。
 *
 * 比轮询慢得多是刻意的：轮询要快（早拿到 guest 早干活），但事件没必要跟着那么密。
 * 面板正常时通常一次就够；异常时这个数字决定了日志里会多出 10 条还是 100 条噪声。
 */
const GUEST_REQUEST_INTERVAL_MS = 500;

/**
 * 动作发出后、读探针前的等待（docs …refactor.md §4 里的 80ms）。
 *
 * 为什么必须等一下再读：`click` 之后浏览器还要把事件派完、框架还要跑完自己的处理
 *（React 的合成事件在微任务里、路由跳转在宏任务里）。立刻读会读到「还没有事件」，
 * 于是每一次正常点击都被判成 NO_EFFECT —— 比不校验更糟：模型会学会忽略这个错误。
 * 80ms 是实测够用的量级（正常页面上事件在 1~2 帧内派完），而它比一次导航的代价小得多。
 */
const PROBE_SETTLE_MS = 80;

/** 文本写入 / 聚焦点击之间的稳定等待（面板未布局时也不能省：事件要来得及派发） */
const INPUT_SETTLE_MS = 30;
/**
 * 网络报告一次最多列出多少条。
 *
 * 缓冲上限是 300，但「列出多少」与「留下多少」是两件事：模型一次读几百条请求
 * 只会把上下文挤满。超出部分如实报在 omitted 里 —— 不能说「就这么多」。
 */
const NETWORK_REPORT_LIMIT = 200;

/** 网络记录缓冲上限：只留最近这些条 */
const NETWORK_BUFFER_LIMIT = 300;
/** 未完成请求的暂存上限（防御性：被取消的长轮询可能永远等不到 completed） */
const NETWORK_PENDING_LIMIT = 500;
/** 坐标复核失败后、重试前的等待：给动画与重渲染一点时间 */
const HIT_RETRY_DELAY_MS = 300;
/** 悬停后等浮层展开的时间：菜单过渡动画基本都在这个量级内结束 */
const HOVER_SETTLE_MS = 250;
/** wait 的默认与最大上限（毫秒） */
const WAIT_DEFAULT_TIMEOUT_MS = 5_000;
const WAIT_MAX_MS = 30_000;
/**
 * 等待的轮询间隔。
 *
 * 比等面板的 50ms 慢得多是刻意的：每次探测都是一次 executeJavaScript（跨进程往返），
 * 200ms 既够在一秒里看几次，又不会把正在渲染的页面拖慢 —— 而「页面渲染得慢」
 * 恰恰是模型会用这个工具的前提。
 */
const WAIT_POLL_MS = 200;

/**
 * 渲染层把 guest 交出来的接入点。
 *
 * 由 app/window.ts 的 did-attach-webview 调用 —— 那是主进程唯一被「递到」guest 的地方。
 * 多个窗口/多个面板时会以最后一次为准：内置浏览器只有一份可见 UI，
 * 真出现两个面板时，让模型操作用户最后打开的那个比操作一个看不见的更合理。
 */
let attached: WebContents | null = null;
/**
 * 模型正在操作页面的工具调用数（不是布尔）。
 *
 * 内核默认 toolExecution 是 "parallel"，模型可以在一轮里同时发多个工具调用
 * （典型：一次要点两处）。用布尔量时先结束的那个会把提示条清掉，界面就变成
 * 「还有工具在跑、但看起来已经停了」—— 与「谁最后结束谁算数」的直觉不符。
 */
let agentActiveCount = 0;
// ref 账本（docs …refactor.md §3）。
//
// 它是**跨快照**的一份记录：每个 ref 在被核对过时的签名、以及它首次出现的代次。
// 页面侧的注册表才是 ref → 元素的权威，但页面会导航、会重渲染、也可能被换掉，
// 而「这个 ref 我到底发过没有」只有主进程知道 —— 这正是 UNKNOWN_REF 与 STALE_REF
// 能分开说的前提（一个要指出模型在编造，一个要指出页面重渲染了）。
const refRegistry = new RefRegistry();
/**
 * 自动化操作的串行化闸门。
 *
 * 并行工具调用必须排队：click / type 是「移动鼠标 → 按下 → 抬起」三步，
 * 两次调用交错会让坐标与按键落到错误的元素上（表现为随机点错东西，最难排查）。
 * 串行化让每一次操作自成一个完整序列，代价只是并行度 —— 浏览器本来就一次只干一件事。
 */
let automationChain: Promise<unknown> = Promise.resolve();
/** 最近一次主框架加载失败原因（成功导航后清空） */
let loadError: string | undefined;
/** 主框架是否在加载 */
let loading = false;
/** 控制台缓冲：读走即清（模型只关心「上次看之后新出现的错误」） */
let consoleBuffer: BrowserConsoleEntry[] = [];

/** 网络记录缓冲：**读走不清**（语义与 console 相反，理由见 types.ts 里 network 的说明） */
let networkBuffer: BrowserNetworkEntry[] = [];
/** 已挂过 webRequest 监听的 session：同一个 session 只允许挂一次，否则每条记录都会变成两条 */
const wiredSessions = new WeakSet<Session>();
/** 当前接管了弹窗拦截的 guest：CDP 同时只允许一个调试器，所以按 webContents 记 */
let dialogTarget: WebContents | null = null;
/** JS 弹窗的当前策略：默认 dismiss —— 页面可以被自己的弹窗挡住，但不该因此僵死 */
let dialogPolicy: BrowserDialogPolicy = { action: "dismiss" };
/** 自动处理掉的弹窗总数，以及上次读走时的计数（dialog 工具回报两者之差） */
let dialogHandledCount = 0;
let dialogHandledAtLastRead = 0;
/** 已经因为「调试器被占用」警告过的 guest：每个工具调用都会走一遍检查，重复警告只会淹掉日志 */
let dialogBlockedWarningFor: WebContents | null = null;
/**
 * 弹窗两条订阅的退订函数。
 *
 * 存在模块级而不是函数局部：ensureDialogHandling 会被反复走（detach 之后重试），
 * 而订阅必须"一次只留一份" —— 靠退订函数而不是 removeAllListeners，
 * 是因为后者会把控制台的订阅一起清掉（那会让日志在接管弹窗之后静默停止更新）。
 */
let stopDialogSubscription: (() => void) | null = null;
let stopDialogDetachSubscription: (() => void) | null = null;

/** 事件出口：由 IPC 层注入（惰性取窗口广播，与 terminal 服务同一套做法） */
type EmitFn = (event: BrowserEvent) => void;

let emitFn: EmitFn | null = null;

function setBrowserEventSink(emit: EmitFn): void {
  emitFn = emit;
}

function emit(event: BrowserEvent): void {
  try {
    emitFn?.(event);
  } catch (error) {
    console.warn(`发送浏览器事件失败：${String(error)}`);
  }
}

/** 页面状态当前值（供 IPC 的 status 通道与事件复用） */
function currentState(): BrowserPageState {
  const contents = attached;
  if (contents === null || contents.isDestroyed()) {
    return {
      url: "",
      title: "",
      loading: false,
      canGoBack: false,
      canGoForward: false,
    };
  }
  const url = contents.getURL();
  const state: BrowserPageState = {
    // about:blank 是「元素刚建出来、还没导航」的表现，当空页面看待
    url: url === "about:blank" ? "" : url,
    title: contents.getTitle(),
    loading,
    canGoBack: contents.navigationHistory.canGoBack(),
    canGoForward: contents.navigationHistory.canGoForward(),
  };
  if (loadError !== undefined) state.error = loadError;
  return state;
}

function publishState(): void {
  emit({ type: "state", state: currentState() });
}

/** 把 WebContents 上的导航/加载/控制台事件接到我们的状态与事件出口上 */
function wireGuest(contents: WebContents): void {
  contents.on("did-start-loading", () => {
    loading = true;
    loadError = undefined;
    publishState();
  });

  contents.on("did-stop-loading", () => {
    loading = false;
    publishState();
  });

  contents.on("did-navigate", () => {
    loading = false;
    loadError = undefined;
    // 换文档 = 页面侧的 __ointEls 已随旧文档一起消失：账本清空并**记下原因**，
    // 之后拿旧 ref 动作时才会说「之前的快照因页面已导航到新文档而失效」，
    // 而不是把两次前的快照编号当成「从未出现过」（真机报告的 P3）。
    refRegistry.markReset("document");
    refRegistry.pruneExcept(new Set());
    publishState();
  });

  contents.on("did-navigate-in-page", () => {
    publishState();
  });

  contents.on("page-title-updated", () => {
    publishState();
  });

  contents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    // 子资源失败（图片、广告）不算「页面加载失败」；
    // -3 是 ERR_ABORTED，即用户/脚本主动中止（点链接后立刻又点了别的）——不是错误
    if (isMainFrame === false || errorCode === -3) return;
    loading = false;
    loadError = `${errorDescription}(${errorCode})${validatedURL === "" ? "" : ` · ${validatedURL}`}`;
    publishState();
  });

  // 控制台**不再**走 Electron 的 console-message：阶段 2 起页面内的观察一律走 CDP
  //（Runtime.consoleAPICalled + Log.entryAdded，见 §9.1/§9.3）。接线在 attachCdpSession 里 ——
  // 它必须在附着成功之后才能订阅，而附着要等 did-attach-webview 之后的第一次 ensureDialogHandling。
  contents.on("render-process-gone", () => {
    loading = false;
    loadError = "页面进程已崩溃";
    // 渲染进程没了，页面侧的注册表随进程一起消失：旧 ref 一律失效，并留下原因
    refRegistry.markReset("guest");
    refRegistry.pruneExcept(new Set());
    publishState();
  });
}

/** 往控制台缓冲里补一条**不是页面产生**的消息（弹窗被自动处理、弹窗被拦下……） */
function pushConsole(level: BrowserConsoleEntry["level"], text: string, source: string): void {
  consoleBuffer.push({ level, text, source, line: 0, at: Date.now() });
  if (consoleBuffer.length > CONSOLE_BUFFER_LIMIT) {
    consoleBuffer.splice(0, consoleBuffer.length - CONSOLE_BUFFER_LIMIT);
  }
}

/**
 * 往控制台缓冲里补一条从 CDP 拿到的消息。
 *
 * 两件事都在这里做，而不是在订阅点各写一遍：
 *   · 截断到单条上限（页面上一条 `console.log(bigString)` 能把整次调用的上下文吃掉）；
 *   · 缓冲与 Electron 旧路径一致地按上限裁掉最旧的（读走即清，见 console()）。
 */
function pushConsoleRecord(record: CdpConsoleRecord): void {
  const text =
    record.text.length > CONSOLE_MAX_CHARS ? `${record.text.slice(0, CONSOLE_MAX_CHARS)}…` : record.text;
  consoleBuffer.push({
    level: record.level,
    text,
    source: record.source,
    line: record.line,
    at: Date.now(),
  });
  if (consoleBuffer.length > CONSOLE_BUFFER_LIMIT) {
    consoleBuffer.splice(0, consoleBuffer.length - CONSOLE_BUFFER_LIMIT);
  }
}

// 订阅用的处理器写成模块级函数：CdpSession.on 按**函数引用**去重，
// 而"确保通道已接线"会被反复调用（每次附着都走一遍），用内联箭头函数会越接越多 ——
// 症状是每条日志在缓冲里出现两三次。
function onConsoleApiCalled(params: unknown): void {
  const record = consoleCallToRecord(params);
  if (record !== null) pushConsoleRecord(record);
}

function onLogEntryAdded(params: unknown): void {
  const record = logEntryToRecord(params);
  if (record !== null) pushConsoleRecord(record);
}

/**
 * 页面**未捕获**的 JS 异常（`Runtime.exceptionThrown`）。
 *
 * 它不是 console.* 调用，走不了 consoleAPICalled；不接这一条，「页面抛异常了」这个
 * 最重要的事实就完全看不到（实测：页面里 addEventListener('error') 拿得到，工具侧无消息）。
 */
function onExceptionThrown(params: unknown): void {
  const record = exceptionThrownToRecord(params);
  if (record !== null) pushConsoleRecord(record);
}

/**
 * 确保 guest 上有一个可用的 CDP 会话，并把**观察类**通道接上（幂等）。
 *
 * 为什么把"附着"与"接线"放在同一个函数里：控制台与弹窗的订阅都只能在附着**成功之后**生效，
 * 而两者都可能被反复触发（每次工具调用都会确认一次会话）。合成一处，两次调用之间的
 * detach/attach 就不会留下"订阅在、会话没了"或"会话在、没人订阅"这类半截状态。
 *
 * 抛错时由调用方决定是降级（弹窗接管失败只警告）还是失败（求值等通道必须报 UNAVAILABLE）。
 */
async function attachCdpSession(contents: WebContents): Promise<CdpSession> {
  const session = cdpSessionFor(contents);
  if (session.isAttached()) return session;
  await session.attach(contents);
  // 控制台三条通道都要：console.log 走 consoleAPICalled，页面未捕获异常走 exceptionThrown，
  // 浏览器自身的报错（资源加载失败、CSP 拦截）走 Log.entryAdded —— 只接一两条的话
  // 「页面白屏但控制台很干净」依然解释不了。
  session.on("Runtime.consoleAPICalled", onConsoleApiCalled);
  session.on("Runtime.exceptionThrown", onExceptionThrown);
  session.on("Log.entryAdded", onLogEntryAdded);
  return session;
}

/**
 * 取一个已附着的 CDP 会话（必要时现场附着）。
 *
 * 求值 / 控制台 / 坐标输入 / 截图现在都只能走 CDP，所以会话起不来时必须**报错**：
 * 悄悄降级回 Electron 那套会让行为在"能用"与"不能用"之间无声地摆动，
 * 而模型看到的只是"点了没反应"。
 */
async function requireCdp(contents: WebContents): Promise<CdpSession> {
  try {
    return await attachCdpSession(contents);
  } catch (error) {
    throw toBrowserToolError(error, "UNAVAILABLE", "CDP 会话不可用");
  }
}

function pushNetworkEntry(entry: BrowserNetworkEntry): void {
  networkBuffer.push(entry);
  if (networkBuffer.length > NETWORK_BUFFER_LIMIT) {
    networkBuffer.splice(0, networkBuffer.length - NETWORK_BUFFER_LIMIT);
  }
}

/**
 * 接管 guest 的网络请求记录。
 *
 * 挂在 **session** 上而不是 webContents 上：webRequest 本来就属于 session，而内置浏览器
 * 用的是固定的 `persist:oint-browser` 分区 —— 于是「同一个 session 只挂一次」必须显式记下来，
 * 重复挂载会让每条请求都变成两条，而两份一模一样的记录会让模型以为请求真的发了两次。
 */
function wireNetwork(contents: WebContents): void {
  const browserSession = contents.session;
  if (wiredSessions.has(browserSession)) return;
  wiredSessions.add(browserSession);
  // 请求开始时间按 id 暂存，用来算耗时
  const starts = new Map<number, { at: number; method: string; resourceType: string }>();

  browserSession.webRequest.onBeforeRequest((details, callback) => {
    // **第一件事就回调**：注册了 onBeforeRequest 却不回调等于把请求挂住，整页都会卡死。
    // 放在最前面，是为了让它不受后面任何一行抛错的影响。
    callback({ cancel: false });
    if (starts.size > NETWORK_PENDING_LIMIT) starts.clear();
    starts.set(details.id, {
      at: Date.now(),
      method: details.method,
      resourceType: details.resourceType,
    });
  });

  browserSession.webRequest.onCompleted((details) => {
    const start = starts.get(details.id);
    starts.delete(details.id);
    pushNetworkEntry({
      url: details.url,
      method: details.method,
      status: details.statusCode,
      resourceType: details.resourceType,
      durationMs: start === undefined ? 0 : Date.now() - start.at,
      at: Date.now(),
    });
  });

  browserSession.webRequest.onErrorOccurred((details) => {
    const start = starts.get(details.id);
    starts.delete(details.id);
    // status 0 = 压根没拿到响应（DNS 失败、连接被拒、CORS 预检失败……），
    // 正是「页面白屏但控制台没有任何报错」时最该看到的那一条
    pushNetworkEntry({
      url: details.url,
      method: details.method,
      status: 0,
      resourceType: details.resourceType,
      error: details.error,
      durationMs: start === undefined ? 0 : Date.now() - start.at,
      at: Date.now(),
    });
  });
}

/**
 * 让 guest 的 JS 弹窗**永远有人应答**。
 *
 * 为什么必须做：实测 `alert()` 会把页面渲染进程永久卡住 —— 之后每一次点击与求值都超时
 *（页面在等一个永远不会有人点的按钮），而界面看起来只是「卡了」。主进程这边没有别的
 * 办法知道弹了窗：Electron 的 API 不暴露「页面上弹了 alert」，只有 CDP 的
 * Page.javascriptDialogOpening 会说。
 *
 * 默认策略是 dismiss：页面可以被自己的弹窗挡住，但不该因为没人应答而僵死。
 */
async function ensureDialogHandling(contents: WebContents): Promise<void> {
  if (contents.isDestroyed()) return;
  if (dialogTarget === contents) return;

  const session = cdpSessionFor(contents);
  if (!session.isAttached() && contents.debugger.isAttached()) {
    // 调试器已经被**别人**占着（开发者工具）。这不是致命错误（弹窗仍会弹给用户看），
    // 但要留下痕迹 —— 否则「模型点了确认没反应」会被归因到工具上，而原因在这里。
    // 判据是「我们自己的会话附着着没有」：只看 debugger.isAttached() 会把
    //「上一轮预启用失败、这一轮要重试」的情况也当成被占用，于是这个 guest 终生不管弹窗。
    // 只警告一次：每个工具调用都会走一遍这个检查，重复警告会把日志淹掉。
    if (dialogBlockedWarningFor !== contents) {
      dialogBlockedWarningFor = contents;
      console.warn(
        "内置浏览器：调试器已被占用，无法接管 JS 弹窗与控制台（弹窗需要人工处理）",
      );
    }
    return;
  }
  try {
    // 附着 + 接线都走同一个入口：控制台也在这里接上（页面在说什么必须尽早开始记，
    // 否则用户自己点的页面报的错就白丢了）。
    await attachCdpSession(contents);
  } catch (error) {
    console.warn(`内置浏览器：接管 JS 弹窗失败（${String(error)}）`);
    return;
  }

  dialogTarget = contents;
  // 这个函数在 detach（渲染进程崩溃重启、用户打开开发者工具）之后会被再走一遍，
  // 所以**先退订上一次**再挂：不退的话同一个弹窗会被应答两次（第二次
  // handleJavaScriptDialog 必然失败），而 dialogHandledCount 也会多计，
  // 回给模型的 handledSinceLastRead 就不准了。
  // 用显式退订而不是 removeAllListeners：后者会把控制台的订阅一起清掉 ——
  // 那正是"弹窗一接管，日志就再也不更新"这类 bug 的来源。
  stopDialogSubscription?.();
  stopDialogDetachSubscription?.();
  stopDialogSubscription = session.on("Page.javascriptDialogOpening", (params) => {
    void answerDialog(contents, params);
  });
  stopDialogDetachSubscription = session.onDetach(() => {
    if (dialogTarget === contents) dialogTarget = null;
  });
}

/** 按当前策略应答一个弹窗，并把它记进控制台缓冲（模型据此才知道「刚才弹了什么」） */
async function answerDialog(contents: WebContents, params: unknown): Promise<void> {
  const info = asRecord(params);
  const kind = typeof info?.type === "string" ? info.type : "alert";
  const message = typeof info?.message === "string" ? info.message : "";
  const accept = dialogPolicy.action === "accept";
  dialogHandledCount += 1;
  pushConsole(
    "warning",
    `[dialog] ${kind}: "${message}" — ${accept ? "accepted" : "dismissed"} automatically ` +
      "(change this with browser_dialog)",
    "oint://browser",
  );
  const command: { accept: boolean; promptText?: string } = { accept };
  // promptText 只在「接受 prompt」时带上：给 confirm 传它会被协议拒绝
  if (accept && typeof dialogPolicy.promptText === "string")
    command.promptText = dialogPolicy.promptText;
  try {
    // 仍走 CDP（应答弹窗本来就是 Page 域的能力，Electron 没有等价 API），
    // 但发命令的路径与其它通道统一到同一个会话上，白名单与错误映射都一致。
    await cdpSessionFor(contents).send("Page.handleJavaScriptDialog", command);
  } catch (error) {
    console.warn(`内置浏览器：应答 JS 弹窗失败（${String(error)}）`);
  }
}

/**
 * 记录一次被拦下的 `window.open` / `target="_blank"`。
 *
 * 由 app/window.ts 的 setWindowOpenHandler 调用（弹窗一律 deny）。为什么要留痕：
 * 页面里「用第三方账号登录」这类按钮走的正是 window.open，被拒绝后页面**什么都不显示** ——
 * 模型只会看到「点了没反应」，然后开始怀疑点击工具本身。把这件事写进控制台缓冲，
 * 读一次 browser_console 就知道是弹窗被拦了，而不是点击失败。
 */
export function recordBrowserPopup(url: string): void {
  pushConsole(
    "warning",
    `[popup] blocked a window.open / target="_blank" navigation to ${url}`,
    "oint://browser",
  );
}

/**
 * 注册 / 注销 guest。
 *
 * 注销（面板切走、元素被卸载）时**保留** attached 的引用不清空 —— 清空会让
 * 「用户切到文件面板」变成「模型所有浏览器调用都失败」，而用户的意图显然不是
 * 「停下正在跑的浏览器任务」。真正的失效由 isDestroyed() 判定：元素卸载会把
 * guest 进程一起销毁，那时 attached 自然读不出东西。
 */
export function attachBrowserGuest(contents: WebContents): void {
  if (attached === contents) {
    // 同一个 guest 重复上报：**不能重复挂监听**，否则每次事件都会发两份，
    // 状态推送与日志缓冲都会翻倍。did-attach-webview 理论上每次挂载只触发一次，
    // 但重复调用在这里是静默无害的，值得花两行买断这个风险。
    return;
  }
  if (attached !== null && !attached.isDestroyed()) {
    console.warn("内置浏览器被重新挂载，改用新的 guest");
  }
  attached = contents;
  loading = false;
  loadError = undefined;
  // 两个缓冲都跟页面走：面板重建后还留着上一个页面的日志与请求记录只会误导
  //（旧记录看起来像是新页面产生的）。webRequest 的监听挂在 session 上，不受重建影响。
  consoleBuffer = [];
  // ref 账本也要跟文档走：换 guest = 换一份文档（面板重挂载 / 元素被销毁重建），
  // 上一份的 ref 永远不会再有效。清掉之外还要**记下重置原因**：之后拿旧 ref 动作时
  // 才能说「之前的快照因页面被重建而失效」，而不是把两次前的快照编号当成编造（P3）。
  refRegistry.markReset("guest");
  refRegistry.pruneExcept(new Set());
  networkBuffer = [];
  wireGuest(contents);
  wireNetwork(contents);
  // 立刻接管弹窗：用户自己点的链接也可能弹出 alert，而一个没人应答的弹窗会把
  // 这个 guest 彻底废掉（后续所有自动化都超时）—— 所以不能等模型第一次调用才做。
  void ensureDialogHandling(contents);
  // 面板刚建好元素时还没有页面：推一次空状态，让面板同步按钮可用性
  publishState();
}

/**
 * 把一次自动化操作排进串行队列。
 *
 * 每个操作都从队尾接上，前一个结束（无论成败）才轮到下一个 —— 于是
 * 「移鼠标 → 按下 → 抬起」这套多步动作不会被另一次调用插进来。
 * 前一个失败不能阻断后续：链上吞掉异常，调用方各自拿到自己的结果 / 错误。
 */
function enqueueAutomation<T>(run: () => Promise<T>): Promise<T> {
  const next = automationChain.then(run, run);
  automationChain = next.catch(() => undefined);
  return next;
}

/** 取当前可用的 guest；没有就返回 null（不报错，交给调用方决定是等还是失败） */
function currentGuest(): WebContents | null {
  const contents = attached;
  if (contents === null || contents.isDestroyed()) return null;
  return contents;
}

/**
 * 取一个能用的 guest；没有就让渲染层把面板打开，并等它到位。
 *
 * 这是「模型能自己叫出浏览器」的实现要点：**光是发事件还不够**。
 * 面板挂载 → 建元素 → did-attach-webview 是一条异步链路，而工具调用是同步进来的，
 * 所以必须在这里等一小段时间，否则模型第一次调用浏览器仍然会撞上「还没有页面」。
 *
 * 等待本身也在解决另一个问题：**面板已经开着、但此刻正在切视图**（比如用户刚切到
 * 文件面板、或上一次调用刚把元素卸载）时，attached 会指向一个已销毁的 guest。
 * 与其让模型看到「请重试」这种无信息量的失败，不如就地等一下 —— 界面通常几十毫秒
 * 就恢复，而模型的耐心比人的短得多。
 *
 * 反复请求是**刻意**的：每次轮询都重发 open-request，这样「用户中途把面板收起来」
 * 也会被再次纠正。渲染层那一侧对同一个请求是幂等的（只是 setState 到同一个视图）。
 */
async function requireGuest(): Promise<WebContents> {
  // 先直接探一次，探不到再开始催 —— 面板本来就在时不该白发一次事件
  const immediate = currentGuest();
  if (immediate !== null) {
    // 每次拿到 guest 都确认一次弹窗拦截还活着：CDP 附加可能因为「开发者工具占用了
    // 调试器」而失败，而那种情况下 alert() 会把页面永久卡住。这里已是 no-op 快路径。
    void ensureDialogHandling(immediate);
    return immediate;
  }

  const found = await waitFor({
    probe: currentGuest,
    // 每一轮都再催一次：等待期间用户可能又把面板收起来，重复请求才能纠正过来
    //（渲染层那一侧对同一请求是幂等的，见 RightSidebar）。
    onRetry: () => emit({ type: "open-request" }),
    timeoutMs: GUEST_READY_TIMEOUT_MS,
    pollMs: GUEST_POLL_MS,
    // 探测要快（早一点拿到 guest 就早一点干活），但没必要每 50ms 都发一次事件：
    // 事件本身无害且幂等，可一旦面板真的起不来，几十上百条重复请求会把日志淹掉，
    // 而那种时刻恰恰最需要看清日志。
    retryEveryMs: GUEST_REQUEST_INTERVAL_MS,
  });
  if (found !== null) {
    void ensureDialogHandling(found);
    return found;
  }

  // 文案只说**试过什么**与**接下来能做什么**，不猜原因：
  // 早期版本在这里写了「请让用户打开右侧边栏」，而实测中面板明明已经挂载了 ——
  // 一句自信但错误的诊断会把排查方向带偏（见 docs 的浏览器操作一节）。
  // UNAVAILABLE = guest 未挂载（§2 的定义正是这一条），工具层据此提示展开面板
  throw new BrowserToolError(
    "UNAVAILABLE",
    `浏览器面板仍在打开，请重试一次（已等待 ${Math.round(GUEST_READY_TIMEOUT_MS / 1000)} 秒）：` +
      "已多次请求展开右侧边栏的「浏览器」视图，但它始终没有交出可操作的页面。" +
      "首次调用时需要等渲染层把 webview 挂载起来，重试一次通常就好；" +
      "若仍然失败，请让用户手动打开右侧边栏（Ctrl+T / 界面右上角的面板开关）。",
    { timeoutMs: GUEST_READY_TIMEOUT_MS },
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * 给一个 Promise 加超时；超时返回 null 而不是抛错。
 *
 * 返回 null 是刻意的：调用方要区分「失败（可重试）」与「超时（也许同样可重试）」，
 * 而两者在这里的处理一致 —— 都由重试逻辑接手。抛错会让上层再套一层 try/catch，
 * 反而更容易漏掉某个分支。
 */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    return await Promise.race([promise.catch(() => null), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** 截图上限：合成器产不出帧时不要让工具调用永远挂着 */
const SCREENSHOT_TIMEOUT_MS = 4_000;

/**
 * 抓一张 PNG，并把真实像素尺寸读回来。
 *
 * 三件事都在这里，缺一不可：
 *   · 视口尺寸优先取 `Page.getLayoutMetrics`（§9.3），读不到就退回视口守卫量到的 innerWidth/Height；
 *   · 宽度上限由 buildCaptureScreenshotParams 处理（clip + scale，超宽时缩到 1280）；
 *   · 尺寸从 PNG 的 IHDR 里读，不用"我以为的裁剪尺寸"去算 —— 高 DPI 面板上那会直接算错，
 *     而错报的尺寸会让模型以为截到了别的内容。拿到的不是 PNG 就返回 null，不编数字。
 */
async function captureScreenshotPng(
  session: CdpSession,
  fallbackViewport: { width: number; height: number },
): Promise<BrowserScreenshot | null> {
  const metrics = await session.send("Page.getLayoutMetrics").catch(() => null);
  const measured = viewportFromLayoutMetrics(metrics);
  const viewport = measured.width > 0 && measured.height > 0 ? measured : fallbackViewport;
  const shot = await session.send<{ data?: unknown }>(
    "Page.captureScreenshot",
    buildCaptureScreenshotParams(viewport),
  );
  const data = typeof shot?.data === "string" ? shot.data : "";
  if (data === "") return null;
  const pixels = readPngSize(data);
  if (pixels === null) return null;
  return { data, mimeType: "image/png", width: pixels.width, height: pixels.height };
}

/**
 * 从 `Page.getLayoutMetrics` 里取视口尺寸。
 *
 * 键名按协议版本有两套写法（`cssVisualViewport` 与旧的 `visualViewport`；布局视口同理），
 * 都收一下 —— 取不到时由调用方退回视口守卫量到的值，而不是把 0×0 拿去裁剪。
 */
function viewportFromLayoutMetrics(metrics: unknown): { width: number; height: number } {
  const record = asRecord(metrics);
  const candidate =
    asRecord(record?.cssVisualViewport) ??
    asRecord(record?.visualViewport) ??
    asRecord(record?.cssLayoutViewport) ??
    asRecord(record?.layoutViewport);
  return {
    width: typeof candidate?.clientWidth === "number" ? candidate.clientWidth : 0,
    height: typeof candidate?.clientHeight === "number" ? candidate.clientHeight : 0,
  };
}

/**
 * 试两次（第二次前稍等）。
 *
 * 「合成器还没产帧」这类失败有个特点：**它自己会好**。多试一次的成本是几百毫秒，
 * 而直接报错的成本是模型放弃截图、改用更差的替代方案。间隔用 150ms 是实测出来的
 * 经验值 —— 太短会撞上同一帧还没合成完，太长会让每次失败都拖住工具调用。
 */
async function retryOnce<T>(run: () => Promise<T | null>): Promise<T | null> {
  const first = await run();
  if (first !== null) return first;
  await delay(150);
  return run();
}

/**
 * 等页面稳定下来：加载结束 + 一小段安静期。
 *
 * 为什么需要「安静期」：did-stop-loading 之后大量 SPA 才开始渲染，
 * 立刻抓快照会拿到一个空壳，模型据此以为「页面上什么都没有」。
 * 这里用固定 200ms 而不是轮询 DOM 稳定性，是因为后者要反复注入脚本，
 * 在重页面上反而更慢，且判定本身也不可靠。
 */
async function waitForIdle(contents: WebContents, timeoutMs = NAVIGATE_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  // 等 isLoading 变 false（或者已经超时）
  while (contents.isLoading() && Date.now() < deadline) {
    await delay(100);
  }
  await delay(200);
}

/**
 * 等 back / forward 真的动起来（最长 HISTORY_SETTLE_TIMEOUT_MS）。
 *
 * 两个判据任一成立即算落定：地址变了（跨文档导航），或 CDP 的历史下标到了目标条目
 *（单页应用的条目可能同 URL，只是 state 不同 —— 只比 URL 会把一次真实的后退误报成没动）。
 * 两者都没动才返回 false，由调用方如实报 NO_EFFECT。这与 navigateAndSettle 是同一个
 * 「以事实为准，不认 API 的回执」的模式。
 */
async function waitForHistoryMove(
  session: CdpSession,
  contents: WebContents,
  before: string,
  targetIndex: number,
): Promise<boolean> {
  const deadline = Date.now() + HISTORY_SETTLE_TIMEOUT_MS;
  for (;;) {
    if (contents.getURL() !== before) return true;
    const navigation = await session
      .send<{ currentIndex?: unknown }>("Page.getNavigationHistory")
      .catch(() => null);
    if (
      navigation !== null &&
      typeof navigation.currentIndex === "number" &&
      navigation.currentIndex === targetIndex
    ) {
      return true;
    }
    if (Date.now() >= deadline) return false;
    await delay(HISTORY_POLL_MS);
  }
}

/**
 * 发起导航并等到它真的落到新地址。
 *
 * **不能只等 `loadURL()` 的 promise**：实测它会在新页面的 did-navigate 之前就 resolve
 *（最典型的形态是 guest 还停在引导用的 about:blank 上，promise 跟着那次加载结束就返回了，
 * 此时 getURL() 仍是 about:blank）。拿这个 promise 当完成信号，open() 会把**旧地址**
 * 报给模型，模型据此以为没打开成功、或者接着去读一个错的页面。
 *
 * 所以以「地址真的变了 / 加载失败」为准。同地址（等价于刷新）不走这里 —— 那种情况
 * 地址不会变，用 URL 变化判定会一直等到超时。
 */
async function navigateAndSettle(contents: WebContents, target: string): Promise<void> {
  const before = contents.getURL();
  loadError = undefined;
  // 不 await 失败：错误已由 did-fail-load 上报，这里再抛一次会变成两份错误
  void contents.loadURL(target).catch(() => undefined);

  const deadline = Date.now() + NAVIGATE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    // 加载失败就直接停手：loadError 会被带进 state，比干等到超时有用
    if (loadError !== undefined) break;
    const now = contents.getURL();
    if (now !== before && now !== "" && now !== "about:blank") break;
    await delay(50);
  }
  await waitForIdle(contents);
}

/** 把注入脚本的返回值收窄成「对象」；非对象一律当失败（页面可能被重定向到空白页） */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

/**
 * 把 CDP 的 exceptionDetails 收成一句人可读的话。
 *
 * 三种形态都要兜住：`exception.description`（异常对象，形如 "TypeError: x is not a function"）、
 * `exception.value`（抛的是个字符串/数字时只有 value）、以及 `text`（异常对象本身拿不到时的
 * 兜底文案）。缺了任何一条，报错就会退化成一句"求值失败"，模型无从下手。
 */
function describeException(details: {
  text?: string;
  exception?: { description?: string; value?: unknown };
}): string {
  const description = details.exception?.description;
  if (typeof description === "string" && description !== "") return description;
  const value = details.exception?.value;
  if (value !== undefined) return String(value);
  return typeof details.text === "string" && details.text !== "" ? details.text : "未知的协议异常";
}

/** browser_wait 的探针目标：脚本侧只认这两种 */
type WaitTarget = { kind: "text"; text: string } | { kind: "selector"; selector: string };

/** 元素在错误文案里的写法：有名字就带上 —— 模型据此才能确认说的是哪个元素 */
function describeElement(ref: string, located: Record<string, unknown>): string {
  const name = typeof located.name === "string" ? located.name.trim() : "";
  return name === "" ? ref : `${ref}（${name}）`;
}

// 页面没回签名时的兜底（脚本版本不一致，或某个分支忘了带上它）。
//
// 口径必须与 script.ts 里的 signatureOf 对齐：role|tag|type|name，其中 input 的 type
// 缺省算 "text"（页面侧就是这么算的）。name 用的是快照里的元素名，对表单字段它可能
// 来自「当前值」而不是页面侧的稳定标签 —— 于是兜底签名可能与页面侧算的略有差异。
// 这只影响一个 ref 的严格程度（多报一次 REF_DRIFT、提示重新 snapshot），不会造成错点，
// 所以在「页面没给签名」这条退化路径上可以接受。
function fallbackSignature(el: Record<string, unknown>): string {
  const tag = typeof el.tag === "string" ? el.tag : "";
  return elementSignature({
    role: typeof el.role === "string" ? el.role : undefined,
    tag,
    type: typeof el.type === "string" ? el.type : tag === "input" ? "text" : "",
    name: typeof el.name === "string" ? el.name : undefined,
  });
}

/** 从定位结果里取整数坐标（locateForAction 已经保证过它们是有限数） */
function coordsOf(located: Record<string, unknown>): { x: number; y: number } {
  return {
    x: Math.round(typeof located.x === "number" ? located.x : 0),
    y: Math.round(typeof located.y === "number" ? located.y : 0),
  };
}

/** 把毫秒参数夹到 [0, max]；非数字、负数都回退到 fallback */
function clampMs(value: number | undefined, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return fallback;
  return Math.min(Math.round(value), max);
}

/** 「请求失败」的口径：压根没拿到响应，或者状态码是 4xx / 5xx */
function isNetworkFailure(entry: BrowserNetworkEntry): boolean {
  return entry.error !== undefined || entry.status === 0 || entry.status >= 400;
}

// 控制台里的「不是页面产生的」噪音：Electron 自己往 console 里灌的消息。
//
// 为什么必须在这里过滤：这些消息**与页面无关**，而模型读 console 是为了找自己的 bug。
// 每条噪音都占一行上下文，还会把「页面到底报没报错」这个判断搅浑（安全警告是 warning，
// 看起来就像页面的告警）。过滤掉的同时如实报 dropped —— 悄悄少几条比多几条更糟。
const ELECTRON_NOISE_SOURCE = "node:electron/js2c";
const ELECTRON_SECURITY_WARNING = /^Electron Security Warning/i;

function isConsoleNoise(entry: BrowserConsoleEntry): boolean {
  if (entry.source.startsWith(ELECTRON_NOISE_SOURCE)) return true;
  return ELECTRON_SECURITY_WARNING.test(entry.text.trim());
}

/**
 * 视口守卫（docs …refactor.md §5）：坐标型动作执行前确认面板真的布局过。
 *
 * 依据是 Electron 探针实测：零尺寸视口下 `sendInputEvent` 与 CDP 的
 * `Input.dispatchMouseEvent` 都会**静默打空**，而 JS 通道（snapshot / evaluate / fill）
 * 照常工作 —— 「读得到、点不到」。面板收起时正是 0×0。
 * 不查这一下会怎样：工具照常派发、页面毫无反应，然后报出「已点击（页面没有跳转）」——
 * 模型据此以为选择器/元素有问题，改用别的 ref 再点一遍，永远点不到。
 *
 * 读不到视口（页面正在导航 / guest 已崩）时同样拦下：这时坐标输入同样不可靠，
 * 而把「读不到」说成「点不到」比让模型空转一次好得多。
 */
async function requireViewport(
  contents: WebContents,
  action: string,
): Promise<{ width: number; height: number }> {
  let probe: Record<string, unknown> | null = null;
  let failure: string | undefined;
  try {
    probe = asRecord(await contents.executeJavaScript(buildViewportExpression(), false));
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  const width = typeof probe?.w === "number" ? probe.w : 0;
  const height = typeof probe?.h === "number" ? probe.h : 0;
  if (failure !== undefined) {
    throw new BrowserToolError(
      "UNAVAILABLE",
      `无法读取页面视口尺寸（${failure}），${action}无法进行：` +
        "页面可能正在导航或渲染进程已崩溃。请稍等片刻、重新 snapshot 确认页面还在，再重试。",
      { viewport: { width, height }, error: failure },
    );
  }
  if (!(width > 0 && height > 0)) {
    throw new BrowserToolError(
      "UNAVAILABLE",
      "浏览器面板未布局（视口 0×0）：坐标输入无法投递。请展开右侧浏览器面板后重试，" +
        "或改用 browser_evaluate。",
      { viewport: { width, height }, viewportGuardedAction: action },
    );
  }
  return { width, height };
}

/** 装探针；装不上（注入失败）返回 false —— 这一轮的效果就只能是 unknown */
async function armProbe(contents: WebContents, kind: ProbeKind, ref: string): Promise<boolean> {
  try {
    const result = await contents.executeJavaScript(buildArmProbeExpression(kind, ref), false);
    return result === "armed";
  } catch (error) {
    console.warn(`浏览器效果探针安装失败（${String(error)}），这一次不做断言`);
    return false;
  }
}

/** 读探针；读不到（页面已经导航走 / 注入失败）返回 null */
async function readProbe(contents: WebContents): Promise<ProbeReport | null> {
  try {
    const raw = asRecord(await contents.executeJavaScript(buildReadProbeExpression(), false));
    if (raw === null || typeof raw.armed !== "boolean") return null;
    return {
      armed: raw.armed,
      kind: typeof raw.kind === "string" ? (raw.kind as ProbeKind) : null,
      ref: typeof raw.ref === "string" ? raw.ref : null,
      events: Array.isArray(raw.events) ? (raw.events as ProbeReport["events"]) : [],
      elementAtPoint: asRecord(raw.elementAtPoint) as ProbeReport["elementAtPoint"],
      activeRef: typeof raw.activeRef === "string" ? raw.activeRef : null,
      activeTag: typeof raw.activeTag === "string" ? raw.activeTag : null,
    };
  } catch (error) {
    console.warn(`浏览器效果探针读取失败（${String(error)}），这一次不做断言`);
    return null;
  }
}

/**
 * 把探针判定落成结局：命中返回告警，没生效 / 打错目标直接抛错。
 *
 * 抛错（而不是把 effect 塞进返回值）是刻意的：工具层要的是「成功就是真成功」——
 * `effect: "no-effect"` 混在正常返回里，模型很容易只读到「点击完成」四个字。
 */
function requireProbeEffect(verdict: ProbeVerdict, action: string, label: string): ProbeOutcome {
  if (verdict.effect === "no-effect") {
    throw new BrowserToolError("NO_EFFECT", `${action}${label}没有生效：${verdict.message}`, verdict.detail);
  }
  if (verdict.effect === "wrong-target") {
    throw new BrowserToolError(
      "WRONG_TARGET",
      `${action}${label}的事件落到了别的元素上：${verdict.message}`,
      verdict.detail,
    );
  }
  // 走到这里只剩 hit / unknown：把结论收窄后交给调用方，
  // 免得「文件里还能出现 no-effect」这件事在类型上被悄悄放过一遍。
  return { effect: verdict.effect, warnings: verdict.warnings };
}

/** 探针判定的收窄结果：抛错的两态已经在 requireProbeEffect 里被排除 */
interface ProbeOutcome {
  effect: "hit" | "unknown";
  warnings: string[];
}

/**
 * 定位一个 ref 并做通用校验：**ref 还是不是快照里那个东西**、未禁用、可见、坐标可算。
 *
 * 这四个检查原先在 click / type 里各写一遍，而它们的文案是模型唯一的线索 ——
 * 合并成一处才能保证「同一种失败在所有工具里说法一致」。坐标复核（hitOk）不在这里：
 * 它需要一个可能的重试，由 requireHit 负责。
 *
 * 第一项（ref 校验）是阶段 1 新增的，也是最能省时间的一处：拿旧 ref 点新页面时，
 * 旧实现会说「找不到元素，请重新 snapshot」，而真相是**元素换了个节点**（REF_DRIFT，
 * 编号被框架复用）或**元素被移除了**（STALE_REF）—— 三者的下一步动作并不相同。
 */
async function locateForAction(
  contents: WebContents,
  ref: string,
  action: string,
): Promise<Record<string, unknown>> {
  const located = asRecord(await contents.executeJavaScript(buildLocateExpression(ref), false));
  if (located === null) {
    throw new BrowserToolError(
      "TOOL_FAILED",
      `定位元素 ${ref} 失败：页面没有返回可解析的结构（可能已被重定向到空白页）。` +
        "请重新 snapshot 确认当前页面。",
      { ref },
    );
  }
  if (located.ok !== true) {
    // 页面侧的注册表里没有这个 ref：账本里有就是「元素被移除」，没有就是「编号是编造的」
    const missing = refRegistry.check(ref, null);
    if (!missing.ok) throw new BrowserToolError(missing.code, missing.message, { ref });
    throw new BrowserToolError(
      "STALE_REF",
      `ref ${ref} 现在指不到任何元素。请重新 browser_snapshot，用新的 ref 再${action}。`,
      { ref, reason: located.reason ?? null },
    );
  }
  const signature = typeof located.signature === "string" ? located.signature : null;
  // 元素已被移除（还在注册表里、但已从 DOM 上摘掉）→ STALE_REF。
  // 刻意**先判它再判签名**：被移除的节点算出来的签名没有意义，报 REF_DRIFT 会把
  // 「页面重渲染了」误导成「编号被复用」。
  if (located.connected !== true) {
    throw new BrowserToolError(
      "STALE_REF",
      `元素 ${describeElement(ref, located)} 已经从页面上被移除了（页面重渲染了）。` +
        "请重新 browser_snapshot，用新的 ref 再操作 —— 旧 ref 不会再恢复。",
      { ref, signature },
    );
  }
  const verdict = refRegistry.check(ref, signature);
  if (!verdict.ok) {
    throw new BrowserToolError(verdict.code, verdict.message, { ref, signature, action });
  }
  // 通过了核对就把当前签名记下来：账本跟着**核对过的事实**走，
  // 免得页面自己改了名字（例如 aria-label 随状态变化）之后一直报假 drift。
  if (signature !== null) refRegistry.note(ref, signature);

  const label = describeElement(ref, located);
  if (located.disabled === true) {
    throw new BrowserToolError(
      "INVALID_ARGUMENT",
      `元素 ${label} 是禁用状态，${action}不会有任何效果。请换一个可操作的元素（重新 snapshot 看当前状态）。`,
      { ref },
    );
  }
  if (located.hidden === true) {
    throw new BrowserToolError(
      "INVALID_ARGUMENT",
      `元素 ${label} 当前不可见，无法${action}。` +
        "常见原因是它被折叠面板收起来了、或者在视口外的容器里 —— 请重新 snapshot 确认。",
      { ref },
    );
  }
  const x = typeof located.x === "number" ? located.x : Number.NaN;
  const y = typeof located.y === "number" ? located.y : Number.NaN;
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new BrowserToolError(
      "INVALID_ARGUMENT",
      `元素 ${label} 的坐标无法确定（可能尺寸为 0），无法${action}。请重新 snapshot 换一个目标。`,
      { ref },
    );
  }
  return located;
}

/**
 * 最后一道校验：**那个坐标上真的是它吗**。
 *
 * 这是最初那批外部报告里最贵的一个坑：站点的 `html { scroll-behavior: smooth }` 让
 * `scrollIntoView` 变成动画滚动，量到的坐标是滚动前的，鼠标事件被发到视口外 ——
 * 点击静默落空，工具却报「已点击（页面没有跳转）」。脚本侧已经用 `behavior:'instant'`
 * 加 `elementFromPoint` 复核堵住了它（见 script.ts），这里负责复核失败时的**补救与说清**：
 * 先重定位一次（重渲染 / 动画刚结束时第二次通常就对），仍不对就如实报错，并指出那个点上
 * 真正是谁 —— 这是模型唯一能据以改动作的信息。
 *
 * 刻意**不在复核失败时硬点**：点错的代价是触发一个用户没要求的动作（下单、删除），
 * 而那不是「重试一次」能挽回的。宁可失败。
 */
async function requireHit(
  contents: WebContents,
  ref: string,
  located: Record<string, unknown>,
  action: string,
): Promise<Record<string, unknown>> {
  if (located.hitOk === true) return located;
  await delay(HIT_RETRY_DELAY_MS);
  const retried = await locateForAction(contents, ref, action);
  if (retried.hitOk === true) return retried;
  const label = describeElement(ref, retried);
  const hitTag =
    typeof retried.hitTag === "string" && retried.hitTag !== ""
      ? `<${retried.hitTag}>`
      : "另一个元素";
  throw new BrowserToolError(
    "WRONG_TARGET",
    `${action}失败：元素 ${label} 的中心坐标上不是它，而是 ${hitTag}。` +
      "常见原因是它被浮层或固定顶栏盖住、或者刚被重新渲染过。" +
      "请重新 snapshot 看当前页面；必要时先按 Escape 关掉浮层（browser_press），或先滚动到别处再定位。",
    { ref, elementAtPoint: { tag: typeof retried.hitTag === "string" ? retried.hitTag : "" } },
  );
}

/**
 * 一次真实鼠标点击（CDP `Input.dispatchMouseEvent`）：移进去 → 按下 → 抬起。
 *
 * 坐标仍然由页面侧的 buildLocateExpression 给出（已实测是视口坐标，与
 * `getBoundingClientRect` 一致），这里只换派发方式 —— 合成 click 事件不满足
 * isTrusted，框架会无视，所以必须走协议层的真实输入。
 *
 * 三件事都是踩出来的：
 *   1. 仍然先发一次 mouseMoved：有些菜单/浮层是先挂 mouseover 才把可点区域渲染出来的，
 *      少了这一下，按下与抬起会落在上一次的坐标上（表现为随机点错东西）。
 *   2. `buttons` 要跟着按键状态走：按下是 1、抬起与移动是 0。给错时页面读到的
 *      `event.buttons` 与实际不符，拖拽类组件会直接不认这次点击。
 *   3. `clickCount: 1` 必须显式给：缺省值在 blob 上不是 1，双击类控件会判错。
 */
async function clickAt(session: CdpSession, x: number, y: number): Promise<void> {
  await session.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y,
    button: "none",
    buttons: 0,
  });
  await delay(INPUT_SETTLE_MS);
  await session.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await session.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
}

/**
 * 发送一次按键（CDP `Input.dispatchKeyEvent`）。
 *
 * 文本不再由这里补：`toCdpKeyEvent` 把"会产生文本的键"标成 `keyDown` + `text`，
 * Chromium 收到 text 后自己插入字符（Enter 的隐式提交也走这条路，不需要再把
 * char 事件摆在别处补）。旧实现要手动补 `char`，是因为 Electron 的 sendInputEvent
 * 拆得比协议细 —— 而那套补法在组合键上很容易多打出一个字符（见 keys.ts 的说明）。
 */
async function sendKeyStroke(session: CdpSession, stroke: BrowserKeyStroke): Promise<void> {
  const events = toCdpKeyEvent(stroke);
  if (events === null) {
    // 只可能来自这里写错的字面量（parseKeySpec 的产物一定能映射）—— 如实报，不要发空按键
    throw new BrowserToolError(
      "INVALID_ARGUMENT",
      `无法把按键 ${stroke.keyCode} 翻译成 CDP 的键位：这是工具的缺陷，请报告。`,
      { keyCode: stroke.keyCode },
    );
  }
  await session.send("Input.dispatchKeyEvent", events.keyDown);
  await session.send("Input.dispatchKeyEvent", events.keyUp);
}

/** 读回值的形状：值本身 + 判定要用的上下文（上限只从 maxlength 属性来，见 script.ts） */
interface FieldRead {
  value: string;
  maxLength: number;
  focused: boolean;
}

/** 读回一个元素当前的值；元素已经不在了 / 已被移除时返回 null（页面重渲染会让 ref 失效） */
async function readFieldValue(contents: WebContents, ref: string): Promise<FieldRead | null> {
  const raw = asRecord(await contents.executeJavaScript(buildReadValueExpression(ref), false));
  if (raw === null || raw.ok !== true || typeof raw.value !== "string") return null;
  return {
    value: raw.value,
    maxLength: typeof raw.maxLength === "number" ? raw.maxLength : 0,
    focused: raw.focused === true,
  };
}

/**
 * 聚焦并填入文本，返回**读回来**的值（含判定需要的字段属性）。
 *
 * 返回 null 表示「读不回来」（元素已经不在了）。这不是失败：页面重渲染掉 ref 往往正是
 * 这次输入产生的结果，把这种情况判成失败会造出一批假警报 —— 而假警报会让模型学会
 * 忽略这个工具的报错，那比不校验更糟。
 */
async function fillField(
  session: CdpSession,
  contents: WebContents,
  ref: string,
  located: Record<string, unknown>,
  text: string,
): Promise<FieldRead | null> {
  const { x, y } = coordsOf(located);
  // 先点一下聚焦：直接 insertText 会打到「当前活动元素」上，那是上一次操作留下的焦点
  await clickAt(session, x, y);
  await delay(INPUT_SETTLE_MS);

  // 清空已有内容：全选后覆盖输入。insertText 是插入而不是替换，
  // 不清空会把新文本追加到旧值后面 —— 搜索框里那是最常见的翻车点。
  await sendKeyStroke(session, { keyCode: "A", modifiers: ["control"], label: "control+a" });
  await delay(INPUT_SETTLE_MS);

  // 文本写入走协议的 Input.insertText：它是"插入一段文本"，语义与旧实现的
  // contents.insertText 一致（不逐字符发 keydown，输入法/补全组件不会把整串当成逐键输入）。
  await session.send("Input.insertText", { text });
  await delay(INPUT_SETTLE_MS);
  return readFieldValue(contents, ref);
}

/**
 * 把「读回来的值」交给判定函数，顺带补上判定需要的上下文。
 *
 * maxLength 优先取**读回那一刻**的属性值（元素可能刚被页面改过），读不回来时退回定位
 * 时读到的那个；两者都取属性（`maxlength`），不是 DOM 属性 `.maxLength` —— 后者在没设
 * 上限时是 524288，拿它当判据会让「被截断」这条口径永远成立（见 script.ts 里的注释）。
 */
function judgeFieldRead(
  read: FieldRead | null,
  previous: FieldRead | null,
  located: Record<string, unknown>,
  text: string,
): InputVerdict {
  const locatedMax = typeof located.maxLength === "number" ? located.maxLength : 0;
  return judgeInput(read?.value ?? "", text, previous?.value ?? null, {
    maxLength: read?.maxLength ?? locatedMax,
    inputType: typeof located.inputType === "string" ? located.inputType : undefined,
  });
}

/** 在页面里跑一次等待探针；null 表示这次没拿到可解析的结果（页面正在导航） */
async function probeWait(
  contents: WebContents,
  target: WaitTarget,
): Promise<Record<string, unknown> | null> {
  return asRecord(await contents.executeJavaScript(buildWaitExpression(target), false));
}

/**
 * 把选择失败翻译成模型能据以行动的一句话。
 *
 * 每种 reason 都对应一个**不同的下一步动作**（重新 snapshot / 改用 click / 换一个值），
 * 所以不能合并成「选择失败」四个字 —— 那等于让模型自己猜。
 */
function describeSelectFailure(
  ref: string,
  match: BrowserOptionMatch,
  raw: Record<string, unknown>,
): string {
  const reason = typeof raw.reason === "string" ? raw.reason : "unknown";
  const options = Array.isArray(raw.options)
    ? raw.options.filter((item): item is string => typeof item === "string")
    : [];
  const total = typeof raw.count === "number" ? raw.count : options.length;
  const list = options.length === 0 ? "" : ` 现有选项（共 ${total} 项）：${options.join(" / ")}`;
  if (reason === "not-found") {
    return `找不到元素 ${ref}。ref 只在最近一次 snapshot 内有效：请重新 snapshot，用新的 ref 再选择。`;
  }
  if (reason === "not-select") {
    const tag = typeof raw.tag === "string" ? raw.tag : "元素";
    return (
      `${ref} 是 <${tag}>，不是 <select> 下拉框，无法用 browser_select 选择。` +
      "自定义下拉组件（一串 div）要先 browser_click 点开它，再 click 弹出的那个选项。"
    );
  }
  if (reason === "disabled") return `${ref} 这个下拉框是禁用状态，选择不会有任何效果。`;
  if (reason === "multiple") {
    return (
      `${ref} 是多选下拉框。browser_select 只支持单选（硬按单选处理会清掉已经选好的其它项），` +
      "请用 browser_click 逐个点选。"
    );
  }
  if (reason === "option-disabled") {
    const label = typeof raw.label === "string" ? raw.label : "";
    return `第 ${String(raw.index ?? "?")} 项（${label}）是禁用选项，无法选中。${list}`;
  }
  const wanted =
    match.kind === "index"
      ? `序号 ${match.index}`
      : match.kind === "value"
        ? `value "${match.value}"`
        : `label "${match.label}"`;
  return `下拉框 ${ref} 里没有匹配 ${wanted} 的选项。${list}`;
}

export function createBrowserAutomation(): BrowserAutomation {
  return {
    setAgentActive: setBrowserAgentActive,

    status(): BrowserStatus {
      return {
        open: attached !== null && !attached.isDestroyed(),
        state: currentState(),
        agentActive: agentActiveCount > 0,
      };
    },

    async open(rawUrl: string): Promise<BrowserPageState> {
      const target = normalizeBrowserUrl(rawUrl);
      if (target === null) {
        throw new BrowserToolError(
          "INVALID_ARGUMENT",
          `无法打开的地址：${rawUrl}。只支持 http / https 的网页地址（例如 https://example.com）。`,
        );
      }
      // 先校验地址再等 guest：一个明显非法的地址不该因为面板还没开而白等 5 秒
      const contents = await requireGuest();
      // 同一地址等于刷新：地址不会变，用 URL 变化判定会等到超时，所以单独走 reload
      if (contents.getURL() === target) {
        loadError = undefined;
        contents.reload();
        await waitForIdle(contents);
        return currentState();
      }
      await navigateAndSettle(contents, target);
      return currentState();
    },

    // history 起的是导航：也要排队，免得与另一次点击的点击序列交错
    history(action): Promise<BrowserPageState> {
      return enqueueAutomation(async () => {
        const contents = await requireGuest();
        // reload 保持 Electron 不变：它没有「目标条目」可言，也就没有可修的真 bug。
        if (action === "reload") {
          contents.reload();
          await waitForIdle(contents, 10_000);
          return currentState();
        }
        // back / forward 刻意**不用** Electron 的 navigationHistory.goForward()：
        // 真机实测它连续 4 次都报成功、地址一动不动，而同页的 history.forward() 正常 ——
        // 那条 API 的回执会撒谎（P1）。改走同页 history 实际用的那条路：
        // Page.getNavigationHistory 拿 currentIndex + entries[{id,url}] 算出目标条目，
        // 再 Page.navigateToHistoryEntry({entryId})，最后按「真的动了没有」如实回报。
        const session = await requireCdp(contents);
        const before = contents.getURL();
        const navigation = await session.send<{ currentIndex?: unknown; entries?: unknown }>(
          "Page.getNavigationHistory",
        );
        const entries = Array.isArray(navigation?.entries) ? navigation.entries : [];
        // 协议没给当前下标时按「在最后一页」处理：那是最保守的假设（不会凭空往前跳）
        const currentIndex =
          typeof navigation?.currentIndex === "number" ? navigation.currentIndex : entries.length - 1;
        const targetIndex = action === "back" ? currentIndex - 1 : currentIndex + 1;
        const target = asRecord(entries[targetIndex]);
        const entryId = typeof target?.id === "number" ? target.id : null;
        if (entryId === null) {
          // 用 NOT_FOUND 而不是自由文本：工具层据此能说「没有上一页可回」，文案与旧实现一致
          throw new BrowserToolError(
            "NOT_FOUND",
            action === "back" ? "已经是第一页，无法后退。" : "已经是最后一页，无法前进。",
          );
        }
        await session.send("Page.navigateToHistoryEntry", { entryId });
        await waitForIdle(contents, 10_000);
        if (await waitForHistoryMove(session, contents, before, targetIndex)) return currentState();
        // 地址与历史下标都没有动：如实报 NO_EFFECT，绝不再出现「报成功但页面没动」
        throw new BrowserToolError(
          "NO_EFFECT",
          `history(${action}) 没有生效：页面地址与历史位置都没有变化` +
            `（${before === "" ? "about:blank" : before}）。` +
            (loadError === undefined ? "" : `最近一次主框架加载失败：${loadError}。`) +
            "请重新 snapshot 确认当前页面；单页应用的前进 / 后退可能不改变地址栏 URL。",
          { action, before, targetEntry: target, loadError: loadError ?? null },
        );
      });
    },

    snapshot(): Promise<BrowserSnapshot> {
      return enqueueAutomation(async () => {
        const contents = await requireGuest();
        await waitForIdle(contents, 10_000).catch(() => undefined);
        // 代次在**注入之前**自增：元素上的 since 就是「它属于哪一代」，
        // 而这一代的编号必须是这一次快照自己，不能是上一次的（差一代会让模型误判新旧）。
        const generation = refRegistry.beginSnapshot();
        const raw = asRecord(await contents.executeJavaScript(buildSnapshotExpression(), false));
        if (raw === null) {
          throw new BrowserToolError(
            "TOOL_FAILED",
            "读取页面失败：页面没有返回可解析的结构（可能已被重定向到空白页）。" +
              (loadError === undefined ? "" : `最近一次主框架加载失败：${loadError}。`),
          );
        }
        const rawElements = Array.isArray(raw.elements) ? raw.elements : [];
        const state = currentState();
        const elements: BrowserSnapshot["elements"] = [];
        for (const item of rawElements) {
          const el = asRecord(item);
          if (el === null) continue;
          const ref = typeof el.ref === "string" ? el.ref : "";
          if (ref === "") continue;
          // 先把签名记进账本，再读 since：第一次见到的元素 since 就是这一代
          const signature =
            typeof el.signature === "string" ? el.signature : fallbackSignature(el);
          refRegistry.note(ref, signature);
          elements.push({
            ref,
            role: typeof el.role === "string" ? el.role : "unknown",
            name: typeof el.name === "string" ? el.name : "",
            tag: typeof el.tag === "string" ? el.tag : "",
            ...(typeof el.type === "string" ? { type: el.type } : {}),
            ...(typeof el.value === "string" ? { value: el.value } : {}),
            ...(typeof el.href === "string" ? { href: el.href } : {}),
            ...(el.disabled === true ? { disabled: true } : {}),
            ...(typeof el.checked === "boolean" ? { checked: el.checked } : {}),
            ...(typeof el.selected === "boolean" ? { selected: el.selected } : {}),
            ...(typeof el.expanded === "boolean" ? { expanded: el.expanded } : {}),
            // since 让模型知道手里的 ref 有多老：刚出现的元素 follow-up 里还指得准，
            // 而来自几代之前的 ref 大概率已经不可用了（配合 STALE_REF/REF_DRIFT 一起看）
            ...(refRegistry.since(ref) === undefined ? {} : { since: refRegistry.since(ref) }),
          });
        }
        const viewport = asRecord(raw.viewport);
        const omitted = asRecord(raw.omitted);
        const rawText = typeof raw.text === "string" ? raw.text : "";
        // P9：导航失败后页面停在错误页（chrome-error://chromewebdata/），它的可见文本往往是空的 ——
        // 只给空文本等于什么都不说，而 browser_open 明明拿到了「加载失败」这个事实。
        // BrowserSnapshot 契约里没有 error 字段（改 shared/contracts 超出本次范围），
        // 所以把原因放在 text 最前面：error: "ERR_CONNECTION_CLOSED(-100)" 加一句人话。
        const failureNote =
          loadError === undefined
            ? ""
            : `error: ${JSON.stringify(loadError)} — 页面没加载成功，下面是错误页（内容可能为空）。`;
        return {
          url: typeof raw.url === "string" ? raw.url : state.url,
          title: typeof raw.title === "string" ? raw.title : state.title,
          generation,
          text: failureNote === "" || rawText === "" ? failureNote + rawText : `${failureNote}\n\n${rawText}`,
          // 截断与否由页面脚本回报的省略量决定 —— 两者同源，不必再单独传一个布尔
          truncated: omitted !== null,
          ...(omitted === null
            ? {}
            : {
                omitted: {
                  elements: typeof omitted.elements === "number" ? omitted.elements : 0,
                  textChars: typeof omitted.textChars === "number" ? omitted.textChars : 0,
                },
              }),
          ...(viewport === null
            ? {}
            : {
                // 视口 0×0 时坐标动作全都会失败（见 requireViewport）—— 让模型在快照里
                // 就看见这个事实，而不是点不动了才发现
                viewport: {
                  width: typeof viewport.width === "number" ? viewport.width : 0,
                  height: typeof viewport.height === "number" ? viewport.height : 0,
                },
              }),
          elements,
        };
      });
    },

    async click(ref): Promise<BrowserActionOutcome> {
      const contents = await requireGuest();
      // 视口守卫在最前面：0×0 时后面所有步骤都注定失败，早点说清楚
      await requireViewport(contents, "点击");
      // 会话也要就位：派发坐标输入的是 CDP（§9.3）。放在守卫之后 ——
      // 「面板没布局」比「调试器被开发者工具占着」更常见，先报更可能的那个。
      const session = await requireCdp(contents);
      const located = await requireHit(
        contents,
        ref,
        await locateForAction(contents, ref, "点击"),
        "点击",
      );
      const name = typeof located.name === "string" ? located.name : "";
      const label = describeElement(ref, located);
      const { x, y } = coordsOf(located);

      const before = contents.getURL();
      // arm → 派发 → 等 80ms → read（docs …refactor.md §4）：
      // 探针必须在**派发之前**装上，否则「事件到底有没有发生」就无从得知了。
      const armed = await armProbe(contents, "click", ref);
      await clickAt(session, x, y);
      await delay(PROBE_SETTLE_MS);
      const probe = armed ? await readProbe(contents) : null;

      await waitForIdle(contents, 5_000).catch(() => undefined);
      const navigated = before !== contents.getURL();
      // 导航过 = 页面确实反应了：这时探针大概率已经被导航带走（读到 armed: false），
      // 但「地址变了」本身就是最硬的证据，不该因为探针不可用而报效果不明。
      if (navigated) return { name, navigated, effect: "hit" };

      const verdict = judgeProbe("click", ref, probe);
      const probeOutcome = requireProbeEffect(verdict, "点击", label);
      const outcome: BrowserActionOutcome = {
        name,
        navigated,
        effect: probeOutcome.effect,
      };
      if (probeOutcome.warnings.length > 0) outcome.warnings = probeOutcome.warnings;
      if (verdict.effect === "unknown") {
        outcome.detail = "页面没有给出可读的事件探针（注入失败或页面正在导航）：这次点击的结果无法断言。";
      }
      return outcome;
    },

    async type(ref, text, submit): Promise<BrowserActionOutcome> {
      const contents = await requireGuest();
      await requireViewport(contents, "输入");
      const session = await requireCdp(contents);
      let located = await requireHit(
        contents,
        ref,
        await locateForAction(contents, ref, "输入"),
        "输入",
      );
      const name = typeof located.name === "string" ? located.name : "";
      // 只对真正可输入的控件下手：点到一个 <button> 上再 insertText 会静默什么都不发生
      //（页面照旧、工具却报成功），模型会以为「填好了」而继续往下走，最后卡在提交那一步。
      if (located.editable !== true) {
        // 每一种「不是可输入字段」都对应一个**不同的下一步动作**，所以分开说。
        // 这里必须在任何点击之前拒绝：聚焦那一下是真实点击，对 file 会弹出原生文件框、
        // 对 submit 会提交表单 —— 那时再报「不是可输入字段」就太晚了，动作已经发生。
        if (located.select === true) {
          throw new BrowserToolError(
            "INVALID_ARGUMENT",
            `元素 ${describeElement(ref, located)} 是下拉框，不接受自由文本。` +
              "请用 browser_select 按 value / label / index 选中一项。",
            { ref },
          );
        }
        const inputType = typeof located.inputType === "string" ? located.inputType : "";
        if (inputType === "file") {
          throw new BrowserToolError(
            "INVALID_ARGUMENT",
            `元素 ${describeElement(ref, located)} 是文件选择框（<input type="file">）。` +
              "浏览器不允许脚本为它指定文件，所以这条路必须由用户手动选文件；" +
              "你可以用 browser_evaluate 看它当前选了没有，或请用户来完成这一步。",
            { ref },
          );
        }
        if (inputType === "checkbox" || inputType === "radio") {
          throw new BrowserToolError(
            "INVALID_ARGUMENT",
            `元素 ${describeElement(ref, located)} 是 <input type="${inputType}">，` +
              "它的状态靠点击切换，不接受文本。请用 browser_click。",
            { ref },
          );
        }
        const tag = typeof located.tag === "string" ? located.tag : "元素";
        const asType = inputType === "" ? "" : ` type="${inputType}"`;
        throw new BrowserToolError(
          "INVALID_ARGUMENT",
          `元素 ${describeElement(ref, located)} 是 <${tag}${asType}>，不是可输入的字段，无法输入文本。` +
            "请先用 browser_snapshot 找到 textbox / textarea 类型的元素。",
          { ref },
        );
      }

      const before = contents.getURL();
      const label = describeElement(ref, located);
      // 探针必须在**输入之前**装上：Ctrl+A 与 insertText 产生的事件都要记下来，
      // 否则「值进去了但框架没收到事件」这种半成功就无从分辨。
      const armed = await armProbe(contents, "input", ref);
      // 输入前先读一次当前值：回读校验要靠它区分「字段自己加了前缀（值变了）」与
      // 「字段里本来就有这段文字（没变，说明这次输入根本没落进去）」。
      let previous = await readFieldValue(contents, ref);
      let read = await fillField(session, contents, ref, located, text);
      let verdict = judgeFieldRead(read, previous, located, text);
      let retried = false;
      if (!verdict.ok && read !== null) {
        // 第一次没落进去：聚焦那一下偶发会落到别处（浮层、动画、元素刚好重渲染 ——
        // 见 script.ts 里 buildReadValueExpression 的说明），重定位再试一次。
        // 「读不回来」不重试：那时元素已经不在，重试只会再打一次空。
        retried = true;
        await delay(HIT_RETRY_DELAY_MS);
        located = await requireHit(
          contents,
          ref,
          await locateForAction(contents, ref, "输入"),
          "输入",
        );
        previous = await readFieldValue(contents, ref);
        read = await fillField(session, contents, ref, located, text);
        verdict = judgeFieldRead(read, previous, located, text);
      }

      // 事件那一半证据（值那一半是 verdict）：两者合起来才敢说「输入成功」
      const probeVerdict = judgeProbe("input", ref, armed ? await readProbe(contents) : null);
      const warnings: string[] = [];
      if (read === null) {
        if (probeVerdict.effect === "wrong-target") {
          throw new BrowserToolError(
            "WRONG_TARGET",
            `输入${label}时事件落到了别的元素上，而且这个字段现在也读不回来了：${probeVerdict.message}`,
            probeVerdict.detail,
          );
        }
        if (probeVerdict.effect !== "hit") {
          throw new BrowserToolError(
            "NO_EFFECT",
            `输入没有落到元素 ${label} 上：事件探针没有看到任何输入事件，而且这个字段现在也读不回来了。` +
              "常见原因是元素在输入过程中被移除 / 重渲染，或者它并不是真正接收输入的那个元素。",
            { ref, wanted: text, probe: probeVerdict.effect },
          );
        }
        // 事件到了、值读不回来：页面在输入后立刻重渲染了这个元素 —— 那往往正是
        // 这次输入的结果，所以不当失败，但要如实说明「没有复核过」。
        warnings.push(
          "输入事件已到达目标，但元素随即被页面重渲染，无法回读校验：请重新 snapshot 确认字段里现在是什么。",
        );
      } else if (!verdict.ok) {
        if (probeVerdict.effect === "wrong-target") {
          throw new BrowserToolError(
            "WRONG_TARGET",
            `输入${label}的事件落到了别的元素上：${probeVerdict.message}`,
            probeVerdict.detail,
          );
        }
        // 唯一能戳破「假成功」的地方：回读到的值不对就如实报错，不再报「已输入」。
        // 值本身要带上 —— 模型据此能立刻分清是「被截断」「被掩码」还是「打错了元素」。
        throw new BrowserToolError(
          "NO_EFFECT",
          `输入没有落到元素 ${label} 上${retried ? "（已重试一次）" : ""}：${verdict.detail ?? ""}`,
          { ref, wanted: text, value: read.value, previous: previous?.value ?? null },
        );
      } else {
        if (verdict.warning !== undefined) warnings.push(verdict.warning);
        if (probeVerdict.effect === "unknown") warnings.push(...probeVerdict.warnings);
        else if (probeVerdict.effect === "wrong-target") {
          // 值确实落进了这个字段，但事件被别处收走：以值为准（它才是模型关心的东西），
          // 但要把这件事说出来 —— 框架可能没收到 change，接着提交会出问题。
          warnings.push(`字段的值已经变了，但输入事件落到了别的元素上：${probeVerdict.message}`);
        }
      }

      // submit 是 type 的收尾动作：它也走 CDP 的按键通道（Enter 的隐式提交靠 keyDown 里的
      // text="\r"，见 toCdpKeyEvent）
      if (submit) await sendKeyStroke(session, { keyCode: "Enter", modifiers: [], label: "enter" });

      // 给页面一点时间回应这次输入（表单校验、联动下拉、submit 的隐式提交都在这个窗口里），
      // 再等加载落定 —— 只等 waitForIdle 是不够的：它盯的是加载状态，而输入后的反应
      // 往往根本不经过加载状态。
      await delay(300);
      await waitForIdle(contents, 5_000).catch(() => undefined);
      const navigated = before !== contents.getURL();
      const outcome: BrowserActionOutcome = { name, navigated, effect: "hit" };
      if (warnings.length > 0) outcome.warnings = warnings;
      if (navigated) outcome.detail = "输入后页面发生了导航 / 提交。";
      return outcome;
    },

    async press(key, ref): Promise<BrowserPressOutcome> {
      const contents = await requireGuest();
      await requireViewport(contents, "按键");
      const session = await requireCdp(contents);
      const stroke = parseKeySpec(key);
      if (stroke === null) {
        throw new BrowserToolError(
          "INVALID_ARGUMENT",
          `无法识别的按键：${key}。支持的名字有 ${KEY_SPEC_EXAMPLES.join(" / ")}，组合键用 + 连接（如 Control+A）。`,
        );
      }
      // 地址必须在**聚焦点击之前**取：给了 ref 时那一次点击本身就可能导航或提交表单，
      // 在那之后取 before 会把它自己的结果算成「本来就在那儿」，于是工具回报
      // 「按了键、页面没动」—— 而模型会据此在**另一个页面**上继续操作。
      const before = contents.getURL();
      let name = "";
      const targetRef = typeof ref === "string" && ref !== "" ? ref : null;
      if (targetRef !== null) {
        // 给了元素就先用真实点击把焦点放上去：页面的键盘处理几乎都挂在焦点上，
        // 而「现在谁有焦点」是上一次操作留下的 —— 不点它一下，键就发给了别的元素。
        const located = await requireHit(
          contents,
          targetRef,
          await locateForAction(contents, targetRef, "按键"),
          "按键",
        );
        name = typeof located.name === "string" ? located.name : "";
        const { x, y } = coordsOf(located);
        // 探针必须在点击**之前**装上：聚焦那一次点击本身也会产生事件，
        // 而按键的效果判定要看 keydown 落到了谁身上（焦点错误是「按键没反应」的头号原因）。
        await armProbe(contents, "key", targetRef);
        await clickAt(session, x, y);
        await delay(INPUT_SETTLE_MS);
      } else {
        await armProbe(contents, "key", "");
      }
      await sendKeyStroke(session, stroke);
      await delay(PROBE_SETTLE_MS);
      const probeVerdict = judgeProbe("key", targetRef, await readProbe(contents));
      await waitForIdle(contents, 5_000).catch(() => undefined);
      const navigated = before !== contents.getURL();
      // 导航过就是确实生效了（Enter 提交表单正是这条路径）
      if (navigated) return { name, navigated, effect: "hit", keys: stroke.label };
      const label = targetRef === null ? "" : `（${name === "" ? targetRef : name}）`;
      const probeOutcome = requireProbeEffect(probeVerdict, "按键", label);
      const outcome: BrowserPressOutcome = {
        name,
        navigated,
        effect: probeOutcome.effect,
        keys: stroke.label,
      };
      if (probeOutcome.warnings.length > 0) outcome.warnings = probeOutcome.warnings;
      if (probeVerdict.effect === "unknown") {
        outcome.detail = "页面没有给出可读的按键探针（注入失败或页面正在导航）：这次按键的结果无法断言。";
      }
      return outcome;
    },

    async hover(ref): Promise<BrowserActionOutcome> {
      const contents = await requireGuest();
      await requireViewport(contents, "悬停");
      const session = await requireCdp(contents);
      const located = await requireHit(
        contents,
        ref,
        await locateForAction(contents, ref, "悬停"),
        "悬停",
      );
      const { x, y } = coordsOf(located);
      const name = typeof located.name === "string" ? located.name : "";
      const label = describeElement(ref, located);
      const before = contents.getURL();
      await armProbe(contents, "hover", ref);
      // 先移到元素附近、再压到中心：一次性「瞬移」也能触发 mouseenter，但有些菜单挂在
      // mousemove 上，得让鼠标走一段路才会展开。坐标仍由页面侧给出，只是改用 CDP 派发。
      await session.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: Math.max(0, x - 2),
        y: Math.max(0, y - 2),
        button: "none",
        buttons: 0,
      });
      await delay(INPUT_SETTLE_MS);
      await session.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x,
        y,
        button: "none",
        buttons: 0,
      });
      // 悬停要等浮层展开再读探针（见 HOVER_SETTLE_MS 的说明），否则会把
      // 「菜单还没弹出来」判成「页面毫无反应」
      await delay(HOVER_SETTLE_MS);
      const probeVerdict = judgeProbe("hover", ref, await readProbe(contents));
      await waitForIdle(contents, 5_000).catch(() => undefined);
      const navigated = before !== contents.getURL();
      if (navigated) return { name, navigated, effect: "hit" };
      const probeOutcome = requireProbeEffect(probeVerdict, "悬停", label);
      const outcome: BrowserActionOutcome = { name, navigated, effect: probeOutcome.effect };
      if (probeOutcome.warnings.length > 0) outcome.warnings = probeOutcome.warnings;
      if (probeVerdict.effect === "unknown") {
        outcome.detail = "页面没有给出可读的悬停探针（注入失败或页面正在导航）：这次悬停的结果无法断言。";
      }
      return outcome;
    },

    async select(ref, match): Promise<BrowserSelectOutcome> {
      const contents = await requireGuest();
      await requireViewport(contents, "选择");
      // 定位这一步不能省：ref 校验（STALE_REF / REF_DRIFT / UNKNOWN_REF）、视口、禁用、
      // 可见、坐标复核全在它里面。省掉它，下拉框就成了唯一绕过所有关卡的动作。
      const located = await requireHit(
        contents,
        ref,
        await locateForAction(contents, ref, "选择"),
        "选择",
      );
      const name = typeof located.name === "string" ? located.name : "";
      const label = describeElement(ref, located);
      const before = contents.getURL();
      // 探针先装上：受控组件的 input / change 事件是「页面真的认账了」的唯一证据，
      // 而 set selectedIndex 本身在没有事件时什么都不会传到框架里（典型假成功）。
      const armed = await armProbe(contents, "input", ref);
      const raw = asRecord(
        await contents.executeJavaScript(buildSelectExpression(ref, match), false),
      );
      if (raw === null) {
        throw new BrowserToolError(
          "TOOL_FAILED",
          `选择失败：元素 ${ref} 没有返回可解析的结果（页面可能已被重定向到空白页）。`,
          { ref },
        );
      }
      if (raw.ok !== true) {
        // 元素在两次注入之间被移除：这种情况该由账本来定性（元素曾经有效 = STALE_REF）
        if (raw.reason === "not-found" || raw.reason === "stale") {
          const gone = refRegistry.check(ref, null);
          if (!gone.ok) throw new BrowserToolError(gone.code, gone.message, { ref });
        }
        const code =
          raw.reason === "not-select" || raw.reason === "disabled" || raw.reason === "multiple"
            ? "INVALID_ARGUMENT"
            : "NOT_FOUND";
        throw new BrowserToolError(code, describeSelectFailure(ref, match, raw), {
          ref,
          reason: typeof raw.reason === "string" ? raw.reason : null,
        });
      }
      const chosenValue = typeof raw.value === "string" ? raw.value : "";
      const chosenLabel = typeof raw.label === "string" ? raw.label : "";
      // 选中会触发页面的 onChange，它常常要发一个请求再重新渲染，给它一点时间
      await delay(300);
      await waitForIdle(contents, 5_000).catch(() => undefined);
      // **再读一次**：脚本里那次读发生在派发事件的同一个 tick，而受控组件会在事件处理
      // 完成之后（React 的 restoreControlledState、Vue 的 nextTick）把 DOM 值写回去。
      // 不复读就会回给模型一句自相矛盾的话 —— `Selected "Germany" (value="us")`，
      // 而模型看到 "Selected" 就接着去提交，提交上去的仍是旧值。
      const settled = await readFieldValue(contents, ref);
      const probeVerdict = judgeProbe("input", ref, armed ? await readProbe(contents) : null);
      const warnings: string[] = [];
      if (settled !== null && settled.value !== chosenValue) {
        throw new BrowserToolError(
          "NO_EFFECT",
          `选择没有生效：元素 ${label} 现在是 ${JSON.stringify(settled.value)}，` +
            `而不是要求选中的 ${JSON.stringify(chosenValue)}（${chosenLabel}）。` +
            "页面在收到 change 事件之后把值改了回去 —— 常见于该选项被业务规则拒绝，" +
            "或者这个下拉框由页面状态单向控制。请重新 snapshot 看它当前显示什么。",
          { ref, wanted: chosenValue, value: settled.value },
        );
      }
      if (settled === null) {
        // 读不回来（元素被重渲染）：这时只剩事件这一半证据
        if (probeVerdict.effect !== "hit") {
          throw new BrowserToolError(
            "NO_EFFECT",
            `选择没有生效：元素 ${label} 在选中后就从页面上消失了，而且探针没有看到任何 input / change 事件。` +
              "这次选择很可能根本没有到达页面。请重新 snapshot 确认这个下拉框还在不在。",
            { ref, probe: probeVerdict.effect },
          );
        }
        warnings.push(
          "input / change 事件已到达页面，但元素随即被重渲染，无法复核选中值：请重新 snapshot 确认下拉框现在显示什么。",
        );
      } else if (probeVerdict.effect === "wrong-target") {
        // 值确实变了，但事件被别处收走：以值为准，同时把这件事说出来
        warnings.push(`下拉框的值确实变成了 ${JSON.stringify(chosenValue)}，但事件落到了别的元素上：${probeVerdict.message}`);
      } else if (probeVerdict.effect === "unknown") {
        warnings.push(...probeVerdict.warnings);
      }
      const outcome: BrowserSelectOutcome = {
        name,
        navigated: before !== contents.getURL(),
        effect: "hit",
        value: chosenValue,
        label: chosenLabel,
      };
      if (warnings.length > 0) outcome.warnings = warnings;
      return outcome;
    },

    async wait(options): Promise<BrowserWaitResult> {
      const contents = await requireGuest();
      const started = Date.now();
      // 固定等待：页面在做没有可观察信号的动画或重试时，只有「等一会儿」是可行的
      if (typeof options.ms === "number") {
        const ms = clampMs(options.ms, WAIT_DEFAULT_TIMEOUT_MS, WAIT_MAX_MS);
        await delay(ms);
        return { matched: true, waitedMs: Date.now() - started, detail: `waited ${ms}ms` };
      }
      const target: WaitTarget =
        typeof options.text === "string"
          ? { kind: "text", text: options.text }
          : {
              kind: "selector",
              selector: typeof options.selector === "string" ? options.selector : "",
            };
      const timeoutMs = clampMs(options.timeoutMs, WAIT_DEFAULT_TIMEOUT_MS, WAIT_MAX_MS);
      // 第一次探测单独做：非法选择器必须**立刻**失败。放进轮询里只会白等满一个超时，
      // 然后拿回「没等到」这种毫无信息量的结论，而模型会据此以为是页面慢。
      const first = await probeWait(contents, target);
      if (first !== null && first.invalid === true) {
        throw new BrowserToolError(
          "INVALID_ARGUMENT",
          `等待条件不合法：${String(first.detail ?? "无法使用的选择器")}`,
        );
      }
      if (first !== null && first.found === true) {
        return {
          matched: true,
          waitedMs: Date.now() - started,
          detail: String(first.detail ?? ""),
        };
      }
      // 超时时要把**最后一次探测**看到的情况报出去，所以在闭包里接住它
      let lastDetail = first === null ? "" : String(first.detail ?? "");
      const result = await waitFor({
        probe: async () => {
          const probed = await probeWait(contents, target);
          if (probed === null) return null;
          lastDetail = String(probed.detail ?? "");
          return probed.found === true ? probed : null;
        },
        timeoutMs,
        pollMs: WAIT_POLL_MS,
      });
      const waitedMs = Date.now() - started;
      if (result === null) {
        return {
          matched: false,
          waitedMs,
          detail: lastDetail === "" ? `nothing matched within ${timeoutMs}ms` : lastDetail,
        };
      }
      return { matched: true, waitedMs, detail: String(result.detail ?? "") };
    },

    async network(query): Promise<BrowserNetworkReport> {
      // 先等 guest 在位：webRequest 的监听是挂载 guest 时注册的，guest 不在就没有记录可言
      await requireGuest();
      if (query?.clear === true) networkBuffer = [];
      const all = networkBuffer.slice();
      const selected = query?.failuresOnly === true ? all.filter(isNetworkFailure) : all;
      // 交出去的是**副本**：调用方（工具层）不该拿到这个会继续增长的数组本身
      const entries =
        selected.length > NETWORK_REPORT_LIMIT ? selected.slice(-NETWORK_REPORT_LIMIT) : selected;
      return {
        entries,
        // total 是**过滤前**的条数：工具层要说清「共 N 条、里面 M 条失败」都得靠它。
        // 只回过滤后的数组时，模型看到空数组就没法区分「一条都没发」与「都不失败」。
        total: all.length,
        omitted: selected.length - entries.length,
        bufferEmpty: all.length === 0,
        // noFailures 是旧实现最误导人的地方：它把「有记录但没有失败」报成了
        // 「还没有记录」，而模型正是靠这句话决定要不要继续等接口 —— 于是白等或误判。
        noFailures: all.length > 0 && all.every((entry) => !isNetworkFailure(entry)),
      };
    },

    async dialog(policy): Promise<BrowserDialogOutcome> {
      const contents = await requireGuest();
      // 每次设策略都确认一次拦截是活的：它因为「调试器被占用」失败过时，改策略也没意义
      await ensureDialogHandling(contents);
      // 只留下已知字段：把 undefined 带进状态会让后续判断多一层特例
      dialogPolicy =
        typeof policy.promptText === "string"
          ? { action: policy.action, promptText: policy.promptText }
          : { action: policy.action };
      const handled = Math.max(0, dialogHandledCount - dialogHandledAtLastRead);
      dialogHandledAtLastRead = dialogHandledCount;
      return { policy: { ...dialogPolicy }, handledSinceLastRead: handled };
    },

    async screenshot(): Promise<BrowserScreenshot> {
      const contents = await requireGuest();
      // 视口守卫：0×0 时合成器根本没有可截的画面（截图会超时或交出一张空图），
      // 早点说清是「面板没布局」而不是让模型反复重试截图。
      const viewport = await requireViewport(contents, "截图");
      const session = await requireCdp(contents);
      /**
       * 截图必须带超时。
       *
       * 合成器还没产出过帧时 `Page.captureScreenshot` 同样会一直不 resolve（旧实现用
       * capturePage 时实测报 `Current display surface not available for capture` /
       * `UnknownVizError`，其中一次调用干脆不返回）—— 不返回比报错更糟：工具调用永不结束、
       * `withAgentActivity` 的 finally 永不执行，界面就永久停在「正在截图」，
       * 用户只能重启应用。所以这里既限时也重试，两者缺一不可。
       */
      const attempt = async (): Promise<BrowserScreenshot | null> => {
        // 先等一帧真的被画出来：截图要的是「有帧被合成」，
        // 而 waitForIdle 保证的是「加载结束 + 短暂安静」—— 那是两件事。
        // 用双 rAF：第一个回调排在当前帧的绘制之后，第二个确保合成器又转过一轮。
        await session
          .send("Runtime.evaluate", {
            expression:
              "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))",
            awaitPromise: true,
            returnByValue: true,
          })
          .catch(() => undefined);
        return withTimeout(captureScreenshotPng(session, viewport), SCREENSHOT_TIMEOUT_MS);
      };

      let shot = await retryOnce(attempt);
      if (shot === null) {
        throw new BrowserToolError(
          "TOOL_FAILED",
          `截图失败：页面没有交出可截取的内容（已重试一次）。` +
            "这通常发生在页面刚加载、还没绘制出第一帧的时候 —— " +
            "请先 snapshot 确认页面已有内容，或者稍等片刻再截图。",
        );
      }
      // P5：页面刚挂载 / 刚重挂载时合成器交出的第一张图可能全是白的（实测 758×1464 纯白），
      // 而它「成功」得毫无破绽。廉价判据见 cdp.ts 的 looksLikeBlankPng（压缩字节数明显偏小）。
      // 先给一次机会（可能正好在画第一帧），仍然可疑就如实告警 —— 不说的话，
      // 模型会把一张白图当成页面本来的样子。
      if (looksLikeBlankPng(shot.data, shot.width, shot.height)) {
        await delay(300);
        const again = await withTimeout(
          captureScreenshotPng(session, viewport),
          SCREENSHOT_TIMEOUT_MS,
        );
        if (again !== null) shot = again;
        if (looksLikeBlankPng(shot.data, shot.width, shot.height)) {
          shot = {
            ...shot,
            warning: "截图像素全白：页面可能尚未渲染完成，请稍后重试或先 snapshot 确认。",
          };
        }
      }
      return shot;
    },

    async console(): Promise<BrowserConsoleReport> {
      // 先确认 guest 在**再**清缓冲：反过来（先清后取）会在 guest 已销毁时
      // 把消息白白吃掉 —— 抛错的同时还丢了数据，用户重新打开面板后什么都看不到。
      const contents = await requireGuest();
      // 控制台现在只能从 CDP 拿（Runtime.consoleAPICalled + Log.entryAdded）。会话起不来时
      // 如实报 UNAVAILABLE，而不是回一个空列表 —— 后者会让模型以为「页面很干净」。
      await requireCdp(contents);
      const buffered = consoleBuffer;
      consoleBuffer = [];
      const entries = buffered.filter((entry) => !isConsoleNoise(entry));
      // dropped 如实报出来：被滤掉的是 Electron 自己的噪音（安全警告、js2c 内部日志），
      // 不属于页面。但「少了几条」本身就是信息 —— 悄悄丢消息会让模型以为页面很干净。
      return { entries, dropped: buffered.length - entries.length };
    },

    async evaluate(code): Promise<BrowserEvaluateResult> {
      const contents = await requireGuest();
      const session = await requireCdp(contents);
      /**
       * 求值走 `Runtime.evaluate`（§9.3），但页面侧的脚本一个字都不改。
       *
       * 阶段 1 的序列化降级（DOM 节点 / Function / 循环引用不再静默变成 `{}`，而是
       * `{__kind:…}`）就在 buildEvaluateExpression 里 —— 它是这次迁移要**保住**的契约，
       * 换的只是通道。返回值形状仍是 BrowserEvaluateResult，工具层与渲染层不用改。
       */
      const response = await session.send<{
        result?: { value?: unknown };
        exceptionDetails?: {
          text?: string;
          exception?: { description?: string; value?: unknown };
        };
      }>("Runtime.evaluate", {
        expression: buildEvaluateExpression(code),
        returnByValue: true,
        awaitPromise: true,
      });
      if (response.exceptionDetails !== undefined) {
        // 走到这里的**不是**模型写的代码出错：那些异常已经被页面侧的 try/catch 收成
        // `{ ok:false, error }`。exceptionDetails 只可能来自包装层（注入失败、求值中途导航），
        // 所以按 TOOL_FAILED 抛 —— 报成 ok:false 会让模型去改一段根本没问题的代码。
        throw new BrowserToolError("TOOL_FAILED", `求值失败：${describeException(response.exceptionDetails)}`, {
          code: response.exceptionDetails.exception?.description ?? null,
        });
      }
      const result = asRecord(response.result?.value);
      if (result === null) return { ok: false, error: "页面没有返回可解析的结果。" };
      if (result.ok === true) {
        return { ok: true, value: typeof result.value === "string" ? result.value : "null" };
      }
      return { ok: false, error: typeof result.error === "string" ? result.error : "未知错误" };
    },
  };
}

/**
 * 模型开始 / 结束操作页面：面板据此显示提示条。
 *
 * **由工具层按计数驱动**（见 pisdk/tools/browser.ts 的 withAgentActivity）：
 * 内核并行执行工具调用，所以这里收到的是「还有几个操作在跑」的增减，
 * 计数归零才算真的停了。服务侧只负责把这个事实转成事件。
 */
export function setBrowserAgentActive(active: boolean, note?: string): void {
  agentActiveCount = active ? agentActiveCount + 1 : Math.max(0, agentActiveCount - 1);
  emit(note === undefined ? { type: "agent", active } : { type: "agent", active, note });
}

/** 广播出口绑定；在 IPC 注册时调用一次 */
export function initBrowserEvents(): void {
  setBrowserEventSink((event) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC.browser.event, event);
    }
  });
}

let sharedAutomation: BrowserAutomation | null = null;

/** 进程内单例：工具层与 IPC 层共用同一份状态（不能各建一份，否则状态会对不上） */
export function getBrowserAutomation(): BrowserAutomation {
  sharedAutomation ??= createBrowserAutomation();
  return sharedAutomation;
}

/** 应用退出时清掉引用（guest 由窗口销毁负责，这里只是不留悬挂引用） */
export function disposeBrowser(): void {
  attached = null;
  agentActiveCount = 0;
  loading = false;
  loadError = undefined;
  consoleBuffer = [];
  networkBuffer = [];
  // 弹窗策略与计数一起归零：下次启动是一次全新的会话，没有「上次的策略」可言
  dialogTarget = null;
  dialogPolicy = { action: "dismiss" };
  dialogHandledCount = 0;
  dialogHandledAtLastRead = 0;
  dialogBlockedWarningFor = null;
  sharedAutomation = null;
}
