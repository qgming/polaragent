// CDP（Chrome DevTools Protocol）会话与白名单。
//
// 为什么要有这一层：
//   1. **通道分工**。页面内的操作与观察一律走 CDP 的**同一个** session，
//      而导航 / `webview` 生命周期 / 弹窗策略 / 权限 / 下载仍走 Electron —— 那些不是页面行为，
//      CDP 要么管不到，要么会绕开已有的安全收敛。
//   2. **白名单是 deny-by-default 的**。旧实现里 `contents.debugger.sendCommand` 是"想发什么发什么"，
//      而 CDP 里 `Cookie.*` / `Storage.*` / `IndexedDB.*` / `DOMStorage.*` 能**直接导出已登录站点的
//      会话数据**，`Network.*` / `Target.*` 则会绕开网络与标签页的产品约束。
//      所以所有发送都必须先过 BROWSER_CDP_ALLOWED 这张表，拒绝的理由也如实回给调用方。
//      这一层不是为了防外部攻击者，而是让「谁开的这个口子」在代码里一眼可查。
//   3. **错误要有码**。CDP 的错误文本各不相同（"-32601"、"Execution context was destroyed"、
//      "No node with given id"），而调用方需要的是统一的那套错误码。映射集中在这里，
//      免得每个通道各写一遍、各漏几种。
//
// 本文件**刻意不 import electron**：白名单、错误映射、协议数据的整形都是纯逻辑，
// 要能在 node 下跑单测（cdp.test.ts）。真正依赖 Electron 的接线在 service.ts。
import type { BrowserConsoleEntry, BrowserErrorCode } from "@/shared/contracts/browser";
import { BrowserToolError } from "./errors";

/** 我们用的协议版本；WebContents.debugger 的 attach 参数 */
export const CDP_PROTOCOL_VERSION = "1.3";

/**
 * 默认开放的方法。
 *
 * 注意这里都是**方法与域**的名字，不是事件：事件订阅走 `on()`，不进白名单
 * （能收到什么由已经启用的域决定，而域的启用本身要过白名单）。
 */
export const BROWSER_CDP_ALLOWED: ReadonlySet<string> = new Set([
  // Page：截图、布局度量、把页面提到前台、应答 JS 弹窗
  "Page.enable",
  "Page.reload",
  "Page.captureScreenshot",
  "Page.getLayoutMetrics",
  "Page.bringToFront",
  "Page.handleJavaScriptDialog",
  // Page 历史：browser_history 的 back / forward 走这里（真机上 Electron 的
  // navigationHistory.goForward() 会报成功但页面不动，见 service.ts 的 history()）
  "Page.getNavigationHistory",
  "Page.navigateToHistoryEntry",
  // DOM：下一阶段的 AX 快照 / 上传要用；本阶段只有 getBoxModel 一类只读调用
  "DOM.enable",
  "DOM.getDocument",
  "DOM.querySelector",
  "DOM.querySelectorAll",
  "DOM.getBoxModel",
  "DOM.describeNode",
  "DOM.scrollIntoViewIfNeeded",
  "DOM.resolveNode",
  // Runtime：求值、属性读取（evaluate 通道）
  "Runtime.enable",
  "Runtime.evaluate",
  "Runtime.callFunctionOn",
  "Runtime.getProperties",
  "Runtime.awaitPromise",
  // Input：鼠标 / 键盘 / 文本（click / hover / type / press 通道）
  "Input.dispatchMouseEvent",
  "Input.dispatchKeyEvent",
  "Input.insertText",
  // Accessibility：AX 快照（阶段 2 的快照迁移）
  "Accessibility.enable",
  "Accessibility.getFullAXTree",
  "Accessibility.getPartialAXTree",
  // Console / Log：控制台（console 通道）
  "Console.enable",
  "Log.enable",
  // Network：**只开放 enable**（网络记录通道）。
  //
  // 记录改走 CDP 而不是 Electron 的 session.webRequest，唯一原因是多标签：
  // webRequest 挂在 session 上，而所有浏览器标签共用 `persist:oint-browser` 分区 ——
  // 它分不清一条请求来自哪个标签。CDP 的 Network 域天然是 per-target 的，
  // 每个标签的缓冲因此互不串味。拦截与 mock（Network.setRequestInterception / Fetch）
  // 仍然关着：这里只订阅事件，不改变任何请求的行为。
  "Network.enable",
]);

/**
 * 开关控制的方法。
 *
 * 本阶段没有任何一处会启用它们，所以它们与"未列入白名单"的处理**完全一致**：
 * 拒绝。分开列出来只有一个目的：下一个阶段要开口子时，改的是这张表而不是白名单，
 * 于是"这次为什么放开"在 review 里看得见。
 */
export const BROWSER_CDP_GATED: ReadonlySet<string> = new Set([
  "Emulation.setDeviceMetricsOverride",
  "DOM.setFileInputFiles",
]);

/** 开关控制的**域**：多标签（Target）、网络拦截与 mock（Network / Fetch） */
export const BROWSER_CDP_GATED_PREFIXES: readonly string[] = ["Network.", "Fetch.", "Target."];

/** 永不开放：它们能直接导出已登录站点的会话数据 */
export const BROWSER_CDP_FORBIDDEN_PREFIXES: readonly string[] = [
  "Cookie.",
  "Storage.",
  "IndexedDB.",
  "DOMStorage.",
];

/** 一个 CDP 方法的判定结果 */
export type CdpMethodDecision = "allow" | "gated" | "forbidden" | "unknown";

/**
 * 判定一个方法能不能发。
 *
 * 顺序刻意是"先永不开放、再默认开放"：万一将来有人把 `Storage.getCookies` 手滑加进白名单，
 * 这里仍然会拒 —— 白名单出错时不能变成"直接漏"。
 */
export function decideCdpMethod(method: string): CdpMethodDecision {
  if (BROWSER_CDP_FORBIDDEN_PREFIXES.some((prefix) => method.startsWith(prefix)))
    return "forbidden";
  if (BROWSER_CDP_ALLOWED.has(method)) return "allow";
  if (BROWSER_CDP_GATED.has(method)) return "gated";
  if (BROWSER_CDP_GATED_PREFIXES.some((prefix) => method.startsWith(prefix))) return "gated";
  // deny-by-default：没列入的白名单就是不许，包括拼错的方法名
  return "unknown";
}

/** 只问"能不能发"（调用方最常用的形态） */
export function isAllowedCdpMethod(method: string): boolean {
  return decideCdpMethod(method) === "allow";
}

/** 拒绝的理由（人可读；写清"为什么拒"与"能做什么"，否则模型只会换个方法名再试一次） */
function denyReason(method: string, decision: CdpMethodDecision): string {
  if (decision === "forbidden") {
    return (
      `CDP 方法 ${method} 属于永不开放的域（Cookie / Storage / IndexedDB / DOMStorage）：` +
      "它们能直接导出已登录站点的会话数据，本工具不允许调用。"
    );
  }
  if (decision === "gated") {
    return (
      `CDP 方法 ${method} 属于开关控制的域（Network / Fetch / Target / Emulation / 文件上传），` +
      "默认关闭且当前版本没有开放入口。请改用已有的工具（browser_logs 的 type: network 读请求记录）。"
    );
  }
  return (
    `CDP 方法 ${method} 不在白名单里（deny-by-default），已拒绝调用。` +
    "如果这是新通道需要的协议方法，请先在 cdp.ts 的白名单里显式登记。"
  );
}

/** 白名单拒绝 → 带码的错误（code 用 INVALID_ARGUMENT，理由写在 message/detail 里） */
export function cdpDeniedError(method: string, decision: CdpMethodDecision): BrowserToolError {
  return new BrowserToolError("INVALID_ARGUMENT", denyReason(method, decision), {
    method,
    decision,
    reason: "PERMISSION_DENIED",
  });
}

/** 从任意错误里抽出可读文本 */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * 从错误对象里抽出协议错误码。
 *
 * 两个来源都要看：Electron 的 `debugger.sendCommand` 拒绝时**不保证**带上结构化的 code
 *（不同版本有的给 `error.code`、有的只把码拼进 message），所以 message 里也要捞一遍。
 * 捞不到就返回 null，由调用方按文本判定。
 */
export function cdpErrorCode(error: unknown): number | null {
  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "number" && Number.isFinite(code)) return code;
    if (typeof code === "string" && /^-?\d+$/.test(code)) return Number(code);
  }
  const matched = /(-3\d{4})\b/.exec(messageOf(error));
  return matched === null ? null : Number(matched[1]);
}

/** 页面 / 目标没了：这类错误重试一次通常就好，且**不是**调用方的错 */
const CDP_CONTEXT_GONE =
  /Execution context was destroyed|Cannot find context|Inspected target navigated|Target closed|target is closed|Session closed|session with given id not found|No target with given id|Debugger is not attached|Debugger is already attached|Page has been closed|Render frame was disposed|frame was disposed/i;

/** 消息里提到的节点 / 帧找不到：是"目标不存在"，不是工具坏了 */
const CDP_TARGET_MISSING =
  /Could not find node|No node with given id|Node with given id does not belong|Node is detached|No such frame|Cannot find frame/i;

/** 方法不存在（协议里没有这个方法，或域没启用） */
const CDP_METHOD_MISSING =
  /wasn't found|was not found|Method not found|Unknown method|is not part of the .* protocol|does not exist in the protocol|is not defined in the protocol/i;

/** 参数不合法 */
const CDP_INVALID_PARAMS =
  /Invalid parameters|Invalid params|Failed to deserialize params|Invalid value|is not a valid/i;

/**
 * 把一次 CDP 失败映射成带错误码的 BrowserToolError。
 *
 * 为什么需要它：调用方（service / 工具层）只能按 code 决定做什么 ——
 * UNAVAILABLE 要提示"面板没布局 / 页面正在导航"、INVALID_ARGUMENT 要提示"方法或参数不对"，
 * 而自由文本会让"页面刚导航走"与"我们发错了方法"看起来一模一样。
 */
export function mapCdpError(error: unknown, method: string): BrowserToolError {
  if (error instanceof BrowserToolError) return error;
  const text = messageOf(error);
  const code = cdpErrorCode(error);
  const detail = { method, cdpCode: code, cdpError: text };

  if (code === -32601 || CDP_METHOD_MISSING.test(text)) {
    return new BrowserToolError(
      "INVALID_ARGUMENT",
      `CDP 方法 ${method} 不存在或未被协议支持：${text}`,
      detail,
    );
  }
  if (code === -32602 || CDP_INVALID_PARAMS.test(text)) {
    return new BrowserToolError(
      "INVALID_ARGUMENT",
      `CDP 方法 ${method} 的参数不合法：${text}`,
      detail,
    );
  }
  if (code === -32001 || CDP_CONTEXT_GONE.test(text)) {
    // 会话 / 上下文没了：页面导航走了、渲染进程重启、调试器被别人抢走。重试即可，别让模型改代码。
    return new BrowserToolError(
      "UNAVAILABLE",
      `CDP 会话已不可用（${method} 失败：页面可能刚导航或渲染进程已重启）：${text}` +
        "。请重新 snapshot 确认页面还在，再重试。",
      detail,
    );
  }
  if (CDP_TARGET_MISSING.test(text)) {
    return new BrowserToolError(
      "NOT_FOUND",
      `CDP 方法 ${method} 找不到目标节点（元素可能已经被移除或重渲染）：${text}。请重新 snapshot。`,
      detail,
    );
  }
  // 其余一律 TOOL_FAILED：说不出具体归属时，宁可说"工具失败"也不要猜一个更具体的码
  //（猜错的码会把模型带向错误的下一步动作）。
  return new BrowserToolError("TOOL_FAILED", `CDP 方法 ${method} 调用失败：${text}`, detail);
}

/**
 * Electron `WebContents.debugger` 的最小接口。
 *
 * 刻意只声明用到的那几个成员（而不是 import electron 的类型）：cdp.test.ts 要能在
 * node 下喂一个假实现进来，而 import electron 会让整个文件在测试里炸掉。
 * 事件用"只声明能收下这些监听器"的宽松签名 —— Electron 那边的重载签名比这里具体得多。
 */
export interface CdpDebugger {
  attach(protocolVersion?: string): void;
  detach(): void;
  isAttached(): boolean;
  sendCommand(method: string, commandParams?: object): Promise<unknown>;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener?(event: string, listener: (...args: unknown[]) => void): unknown;
}

/** 能承载一个 CDP 会话的东西（真实实现是 WebContents） */
export interface CdpTarget {
  readonly debugger: CdpDebugger;
  isDestroyed(): boolean;
}

/**
 * 附着时要预启用的域。
 *
 * 顺序有意义：Page 是弹窗事件与截图的前提，Runtime 是求值的前提 —— 这两个失败等于
 * "附着了但什么也干不了"，所以直接判附着失败（调用方下次会重试）。
 * 其余域（DOM / Accessibility / Console / Log）失败只是让对应通道降级，如实记下来继续。
 */
const CDP_PRE_ENABLE_DOMAINS: readonly string[] = [
  "Page",
  "DOM",
  "Runtime",
  "Accessibility",
  "Console",
  "Log",
  // Network 失败只让「网络记录」这一条通道降级：它是观察用的，不该拖垮整个会话
  "Network",
];

/** 预启用失败就不能算附着成功的域 */
const CDP_REQUIRED_DOMAINS: ReadonlySet<string> = new Set(["Page", "Runtime"]);

/**
 * 一个 CDP 会话。
 *
 * 为什么不每次调用临时 attach：Electron 的 `WebContents.debugger` **同时只允许一个**
 * 调试器，attach/detach 会打断已经订阅的事件流（控制台日志会随机丢几条、弹窗可能没人应答）。
 * 整个进程对每个 guest 只保留一个 CdpSession，由 cdpSessionFor() 缓存。
 */
export class CdpSession {
  /** 当前的调试器（detach 后置空） */
  private debuggerRef: CdpDebugger | null = null;
  /** 当前的附着目标（用来判 isDestroyed） */
  private targetRef: CdpTarget | null = null;
  /** 我们这边认为附着着没有 —— 与 debugger.isAttached() 分开存，见 isAttached() 的说明 */
  private attachedFlag = false;
  /**
   * 按方法名分发的订阅表。
   *
   * 只挂一个 debugger 级 message 监听（见 attach()），订阅在内部按方法名分发 ——
   * 每个订阅各挂一次会踩到 Electron 的 removeAllListeners("message")：
   * 别人清理一下监听，控制台日志就会静默不再更新。
   */
  private readonly messageHandlers = new Map<string, Set<(params: unknown) => void>>();
  /** detach 通知（页面崩溃、开发者工具抢走调试器时调用方要能收尾） */
  private readonly detachHandlers = new Set<() => void>();
  /** 预启用失败的域（诊断用：哪个通道现在是降级的） */
  private readonly degraded = new Set<string>();

  /**
   * 附着到目标并预启用各域。幂等：已经附着时直接返回。
   *
   * 三类失败分得很清楚：
   *   · 目标已销毁 / 调试器已被别人占着 → UNAVAILABLE（"现在不能用"）；
   *   · 必要的域启用失败 → detach 后抛 UNAVAILABLE（下次调用会重试，而不是永久残废）；
   *   · 非必要域失败 → 记下来继续（Console 域在 Chromium 里是废弃域，它失败不能拖垮整个会话）。
   */
  async attach(target: CdpTarget): Promise<void> {
    if (this.isAttached()) return;
    if (target.isDestroyed()) {
      throw new BrowserToolError(
        "UNAVAILABLE",
        "CDP 附着失败：guest 已被销毁（浏览器面板已卸载）。",
        {
          reason: "TARGET_DESTROYED",
        },
      );
    }
    const dbg = target.debugger;
    if (dbg.isAttached()) {
      // 我们已经附着过（attachedFlag 为真）时不会走到这里；所以这个 true 只可能是
      // **别人**占着调试器（开发者工具、或上一次崩溃留下的残留）。
      throw new BrowserToolError(
        "UNAVAILABLE",
        "CDP 附着失败：调试器已被占用（通常是开发者工具开着）。" +
          "请关闭开发者工具后重试 —— 页面操作与观察都走这一个 session。",
        { reason: "DEBUGGER_OCCUPIED" },
      );
    }
    try {
      dbg.attach(CDP_PROTOCOL_VERSION);
    } catch (error) {
      throw new BrowserToolError("UNAVAILABLE", `CDP 附着失败：${messageOf(error)}`, {
        reason: "ATTACH_FAILED",
      });
    }

    this.debuggerRef = dbg;
    this.targetRef = target;
    this.attachedFlag = true;
    // 只挂**一个** debugger 级监听：所有方法订阅在内部按方法名分发。
    // 每个订阅各挂一次监听会踩到 Electron 的 removeAllListeners("message")（弹窗接管那边用过），
    // 于是"某个不相关的功能清理了一下监听"，控制台就静默不再更新。
    dbg.on("message", this.handleMessage);
    dbg.on("detach", this.handleDetach);

    for (const domain of CDP_PRE_ENABLE_DOMAINS) {
      try {
        await dbg.sendCommand(`${domain}.enable`);
      } catch (error) {
        const mapped = mapCdpError(error, `${domain}.enable`);
        if (CDP_REQUIRED_DOMAINS.has(domain)) {
          // 先收尾再抛：留着一个"附着了一半"的会话比不附着更糟（调用方以为能用）
          this.detach();
          throw new BrowserToolError(
            "UNAVAILABLE",
            `CDP 会话不可用：${domain}.enable 失败（${mapped.message}）。请重试一次。`,
            { reason: "PRE_ENABLE_FAILED", domain, code: mapped.code },
          );
        }
        this.degraded.add(domain);
        console.warn(
          `内置浏览器：CDP 预启用 ${domain} 域失败（${mapped.message}），相关通道会降级`,
        );
      }
    }
  }

  /**
   * 会话现在能不能用。
   *
   * 同时看两件事：我们自己的标记，与 `debugger.isAttached()`。只看后者会把
   * "开发者工具占着"也算成我们可用；只看前者则会在页面崩溃、Electron 悄悄 detach 之后
   * 继续往一个死会话里发命令。
   */
  isAttached(): boolean {
    if (!this.attachedFlag || this.debuggerRef === null) return false;
    return this.debuggerRef.isAttached();
  }

  /** 预启用失败的域（诊断 / 测试用） */
  degradedDomains(): readonly string[] {
    return [...this.degraded];
  }

  /**
   * 发一条 CDP 命令。
   *
   * 白名单校验在**发之前**，且不等连接状态 —— 被拒绝的方法连"会话是否可用"都不该暴露。
   */
  async send<T = unknown>(method: string, params?: object): Promise<T> {
    const decision = decideCdpMethod(method);
    if (decision !== "allow") throw cdpDeniedError(method, decision);

    const dbg = this.debuggerRef;
    if (!this.isAttached() || dbg === null) {
      throw new BrowserToolError(
        "UNAVAILABLE",
        `CDP 会话不可用：${method} 无法发送（会话尚未附着或已断开）。请重试一次。`,
        { method, reason: "SESSION_NOT_ATTACHED" },
      );
    }
    if (this.targetRef?.isDestroyed() === true) {
      throw new BrowserToolError("UNAVAILABLE", `CDP 会话不可用：guest 已被销毁（${method}）。`, {
        method,
        reason: "TARGET_DESTROYED",
      });
    }
    try {
      return (await dbg.sendCommand(method, params)) as T;
    } catch (error) {
      throw mapCdpError(error, method);
    }
  }

  /**
   * 订阅一个 CDP 事件。返回退订函数。
   *
   * 同一个方法名 + 同一个函数引用只会注册一次（Set 的语义）：service 在"确保通道已接线"
   * 的地方可以放心地重复调用，而不必自己维护"接过了没有"的状态 —— 正是那种状态在 detach
   * 之后容易失效，于是变成"一个弹窗被应答两次"。
   */
  on<T = unknown>(method: string, handler: (params: T) => void): () => void {
    let set = this.messageHandlers.get(method);
    if (set === undefined) {
      set = new Set();
      this.messageHandlers.set(method, set);
    }
    const fn = handler as (params: unknown) => void;
    set.add(fn);
    return () => {
      set.delete(fn);
    };
  }

  /** 会话断开时的通知（页面崩溃、开发者工具接管）。返回退订函数。 */
  onDetach(handler: () => void): () => void {
    this.detachHandlers.add(handler);
    return () => {
      this.detachHandlers.delete(handler);
    };
  }

  /** 主动断开；已经断开时是 no-op（幂等，收尾路径不必自己判） */
  detach(): void {
    const dbg = this.debuggerRef;
    this.dispose();
    if (dbg?.isAttached() === true) {
      try {
        dbg.detach();
      } catch (error) {
        // 已经断开 / 目标已销毁都会走到这里。我们这边已经清理干净了，
        // 让 Electron 侧的残留错误把调用方吵醒没有任何好处。
        console.warn(`内置浏览器：CDP detach 失败（${messageOf(error)}）`);
      }
    }
  }

  /** 清掉我们这边的所有引用与 debugger 级监听（不再碰 debugger 本身） */
  private dispose(): void {
    const dbg = this.debuggerRef;
    if (dbg !== null) {
      if (typeof dbg.removeListener === "function") {
        dbg.removeListener("message", this.handleMessage);
        dbg.removeListener("detach", this.handleDetach);
      } else {
        // 没有 removeListener 的实现（理论上不会有）只能整体清；至少不会越积越多
        const loose = dbg as { removeAllListeners?: (event?: string) => unknown };
        loose.removeAllListeners?.("message");
        loose.removeAllListeners?.("detach");
      }
    }
    this.debuggerRef = null;
    this.targetRef = null;
    this.attachedFlag = false;
    this.degraded.clear();
  }

  /** debugger 的 message 事件 → 按方法名分发 */
  private readonly handleMessage = (...args: unknown[]): void => {
    const method = typeof args[1] === "string" ? args[1] : "";
    const params = args[2];
    const set = this.messageHandlers.get(method);
    if (set === undefined) return;
    for (const handler of [...set]) {
      try {
        handler(params);
      } catch (error) {
        // 一个订阅者抛错不能带走其它订阅者（控制台日志坏了不该让截图也停）
        console.warn(`内置浏览器：CDP 事件 ${method} 的处理器失败（${messageOf(error)}）`);
      }
    }
  };

  /** debugger 的 detach 事件 → 清状态并通知 */
  private readonly handleDetach = (): void => {
    this.dispose();
    for (const handler of [...this.detachHandlers]) {
      try {
        handler();
      } catch (error) {
        console.warn(`内置浏览器：CDP detach 处理器失败（${messageOf(error)}）`);
      }
    }
  };
}

/**
 * 每个目标一份会话（WeakMap：guest 销毁后不留下悬挂引用）。
 *
 * 用 WeakMap 而不是 Map 是刻意的：面板会被反复挂载 / 卸载，用 Map 会让每次重挂
 * 都多留一个永不过期的 WebContents 引用（内存泄漏，且会拖住渲染进程）。
 */
const sessions = new WeakMap<object, CdpSession>();

/** 取（必要时创建）某个目标上的会话 —— 只创建，不附着 */
export function cdpSessionFor(target: object): CdpSession {
  let session = sessions.get(target);
  if (session === undefined) {
    session = new CdpSession();
    sessions.set(target, session);
  }
  return session;
}

// ---------------------------------------------------------------------------
// 协议数据的整形（纯函数：把 CDP 的结构化事件转成契约里的形状）
// ---------------------------------------------------------------------------

/** 控制台上的一条（`at` 由 service 补，这里只做协议 → 契约的翻译） */
export interface CdpConsoleRecord {
  level: BrowserConsoleEntry["level"];
  text: string;
  source: string;
  line: number;
}

/** Runtime.consoleAPICalled 的 type → 契约里的 level 词表 */
const CONSOLE_CALL_LEVELS: Record<string, BrowserConsoleEntry["level"]> = {
  log: "info",
  info: "info",
  debug: "debug",
  verbose: "debug",
  warning: "warning",
  warn: "warning",
  error: "error",
  assert: "error",
  // 其余（dir / table / trace / count / group…）都是信息级：把它们报成 error 会让模型
  // 以为页面出错了，而它们只是调试输出
  dir: "info",
  dirxml: "info",
  table: "info",
  trace: "info",
  group: "info",
  groupCollapsed: "info",
  groupEnd: "info",
  count: "info",
  timeEnd: "info",
  profile: "info",
  profileEnd: "info",
  clear: "info",
};

/** Log.entryAdded 的 level（verbose 归到 debug） */
const LOG_ENTRY_LEVELS: Record<string, BrowserConsoleEntry["level"]> = {
  verbose: "debug",
  info: "info",
  warning: "warning",
  error: "error",
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

/**
 * 把一个 CDP RemoteObject 描述成人可读的一小段文本。
 *
 * console 通道的意义就是"页面报了什么"，而 `console.log({a:1})` 的参数是个对象：
 * 不给 `description` / `preview` 的话，模型只会看到 `[object Object]` 或者干脆什么都没有。
 * 优先取 `description`（Chromium 已经把它算成人能读的形态："Object"、"Map(2)"、"div#app"），
 * 再退到 `preview.description`，最后退到类型名。
 */
export function describeRemoteObject(value: unknown): string {
  const obj = asRecord(value);
  if (obj === null) return String(value ?? "");
  const primitive = obj.value;
  const type = typeof obj.type === "string" ? obj.type : "";
  if (type === "string") return typeof primitive === "string" ? primitive : "";
  if (type === "number" || type === "boolean") return String(primitive);
  if (type === "undefined") return "undefined";
  if (type === "object" && (primitive === null || obj.subtype === "null")) return "null";
  if (type === "bigint" || type === "symbol") {
    return typeof obj.description === "string" ? obj.description : type;
  }
  if (typeof obj.description === "string" && obj.description !== "") return obj.description;
  const preview = asRecord(obj.preview);
  if (preview !== null && typeof preview.description === "string" && preview.description !== "") {
    return preview.description;
  }
  if (typeof obj.subtype === "string" && obj.subtype !== "") return obj.subtype;
  return type === "" ? "unknown" : type;
}

/** 把 console.* 的多个参数拼成一行（CDP 给的是结构化参数，旧实现只有拼好的字符串） */
export function formatConsoleArgs(args: unknown): string {
  if (!Array.isArray(args)) return "";
  return args.map(describeRemoteObject).join(" ");
}

/** 调用点（source:line）—— 控制台条目里 "谁报的" 那一半 */
function callSite(stackTrace: unknown): { source: string; line: number } {
  const trace = asRecord(stackTrace);
  const frames = trace?.callFrames;
  if (!Array.isArray(frames) || frames.length === 0) return { source: "", line: 0 };
  const frame = asRecord(frames[0]);
  if (frame === null) return { source: "", line: 0 };
  // CDP 的行号是 0 基的，而人/模型看的是 1 基 —— 不换算的话每条日志的行号都差一行
  return {
    source: typeof frame.url === "string" ? frame.url : "",
    line: typeof frame.lineNumber === "number" ? frame.lineNumber + 1 : 0,
  };
}

/** `Runtime.consoleAPICalled` → 控制台条目；结构不对时返回 null（不猜） */
export function consoleCallToRecord(params: unknown): CdpConsoleRecord | null {
  const obj = asRecord(params);
  if (obj === null) return null;
  const type = typeof obj.type === "string" ? obj.type : "log";
  const site = callSite(obj.stackTrace);
  return {
    level: CONSOLE_CALL_LEVELS[type] ?? "info",
    text: formatConsoleArgs(obj.args),
    source: site.source,
    line: site.line,
  };
}

/**
 * `Log.entryAdded` → 控制台条目。
 *
 * 与 consoleAPICalled 的差别：这是**浏览器**产生的条目（网络错误、CSP 拦截、证书问题……），
 * 页面的 console.log 不走这里。两条都要，否则"页面白屏但控制台一片干净"依然看不出原因。
 *
 * `source` 取 `entry.url`：契约里那一栏是与行号一起显示的"谁报的"，
 * 而 CDP 的 `entry.source` 只是分类（javascript / network / security）。
 * 顺带这也让既有噪音过滤生效 —— Electron 自己的日志 url 是 `node:electron/js2c/…`。
 */
export function logEntryToRecord(params: unknown): CdpConsoleRecord | null {
  const obj = asRecord(params);
  const entry = asRecord(obj?.entry);
  if (entry === null) return null;
  const text = typeof entry.text === "string" ? entry.text : "";
  if (text === "") return null;
  const level = typeof entry.level === "string" ? entry.level : "info";
  const url = typeof entry.url === "string" && entry.url !== "" ? entry.url : "";
  return {
    level: LOG_ENTRY_LEVELS[level] ?? "info",
    text,
    source: url === "" ? (typeof entry.source === "string" ? entry.source : "") : url,
    line: typeof entry.lineNumber === "number" ? entry.lineNumber + 1 : 0,
  };
}

/**
 * `Runtime.exceptionThrown` → 控制台条目（页面**未捕获的 JS 异常**）。
 *
 * 为什么必须单独接它：`Runtime.consoleAPICalled` 只覆盖 `console.*` 调用，
 * 页面自己抛出去没人接的异常走的是这个事件。实测：页面里 `addEventListener('error')`
 * 拿得到，而工具侧「无新消息」—— 模型于是完全看不到「页面已经抛异常了」这个最重要的事实。
 *
 * 文本取 `text` 与 `exception.description` 的组合：前者是协议给的类别（"Uncaught"），
 * 后者是人可读的异常内容（"TypeError: x is not a function" 加调用栈），只留一个都会缺一半；
 * 抛的是字符串 / 数字时没有 description，退到 `exception.value`。
 * `url` / `lineNumber` 缺失时退到栈顶帧；行号与 consoleAPICalled 一样从 0 基换算成 1 基。
 */
export function exceptionThrownToRecord(params: unknown): CdpConsoleRecord | null {
  const obj = asRecord(params);
  const details = asRecord(obj?.exceptionDetails);
  if (details === null) return null;
  const exception = asRecord(details.exception);
  const description = typeof exception?.description === "string" ? exception.description : "";
  const thrown =
    exception?.value === undefined || exception?.value === null ? "" : String(exception.value);
  const headline = typeof details.text === "string" ? details.text.trim() : "";
  const body = description !== "" ? description : thrown;
  let text = headline;
  if (body !== "") text = text === "" || body.startsWith(text) ? body : `${text}: ${body}`;
  if (text.trim() === "") return null;

  const frames = asRecord(details.stackTrace)?.callFrames;
  const frame = Array.isArray(frames) && frames.length > 0 ? asRecord(frames[0]) : null;
  const url =
    typeof details.url === "string" && details.url !== ""
      ? details.url
      : typeof frame?.url === "string"
        ? frame.url
        : "";
  const line =
    typeof details.lineNumber === "number"
      ? details.lineNumber
      : typeof frame?.lineNumber === "number"
        ? frame.lineNumber
        : -1;
  return { level: "error", text, source: url, line: line < 0 ? 0 : line + 1 };
}

// ---------------------------------------------------------------------------
// 网络事件的整形（纯函数：把 Network.* 的推送转成「一次请求」的各个阶段）
//
// 为什么不用 Electron 的 webRequest：它挂在 session 上，而所有浏览器标签共用同一个
// persist 分区 —— 分不清一条请求来自哪个标签。Network 域天然是 per-target 的，
// 每个标签各订阅各的，缓冲不会串味。
// ---------------------------------------------------------------------------

/** 一次请求的开始：`Network.requestWillBeSent` 里我们关心的部分 */
export interface CdpNetworkRequestStart {
  requestId: string;
  url: string;
  method: string;
  /** 协议里的资源类型（Document / XHR / Fetch / Script …），已经归一成小写词表 */
  resourceType: string;
  /** 事件时刻（毫秒时间戳），用来算耗时 —— service 侧不再自己记开始时间 */
  at: number;
}

/** CDP 的 type 字段 → 契约里的小写词表（模型看到 "xhr" / "fetch" 比 "XHR" 更一致） */
function normalizeResourceType(value: unknown): string {
  return typeof value === "string" && value !== "" ? value.toLowerCase() : "other";
}

/** `Network.requestWillBeSent` → 请求开始；形状不对返回 null */
export function networkRequestWillBeSent(params: unknown): CdpNetworkRequestStart | null {
  const obj = asRecord(params);
  const request = asRecord(obj?.request);
  const requestId = typeof obj?.requestId === "string" ? obj.requestId : "";
  const url = typeof request?.url === "string" ? request.url : "";
  if (requestId === "" || url === "") return null;
  return {
    requestId,
    url,
    method: typeof request?.method === "string" ? request.method : "GET",
    resourceType: normalizeResourceType(obj?.type),
    at: Date.now(),
  };
}

/** `Network.responseReceived` → 状态码；形状不对返回 null */
export function networkResponseReceived(
  params: unknown,
): { requestId: string; status: number } | null {
  const obj = asRecord(params);
  const response = asRecord(obj?.response);
  const requestId = typeof obj?.requestId === "string" ? obj.requestId : "";
  if (requestId === "") return null;
  const status = typeof response?.status === "number" ? response.status : 0;
  return { requestId, status };
}

/** `Network.loadingFinished` → 请求结束（成功路径）；形状不对返回 null */
export function networkLoadingFinished(params: unknown): { requestId: string; at: number } | null {
  const obj = asRecord(params);
  const requestId = typeof obj?.requestId === "string" ? obj.requestId : "";
  if (requestId === "") return null;
  return { requestId, at: Date.now() };
}

/**
 * `Network.loadingFailed` → 失败原因；形状不对返回 null。
 *
 * `canceled` 要如实带上：用户点了停止、或页面自己 abort 掉一个请求，与
 * DNS 失败 / 连接被拒是两类完全不同的事实，而它们在协议里长得一样。
 */
export function networkLoadingFailed(
  params: unknown,
): { requestId: string; error: string; at: number } | null {
  const obj = asRecord(params);
  const requestId = typeof obj?.requestId === "string" ? obj.requestId : "";
  if (requestId === "") return null;
  const raw = typeof obj?.errorText === "string" && obj.errorText !== "" ? obj.errorText : "failed";
  const canceled = obj?.canceled === true;
  return {
    requestId,
    error: canceled && !/cancel/i.test(raw) ? `canceled (${raw})` : raw,
    at: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// 截图
// ---------------------------------------------------------------------------

/**
 * 截图宽度上限。
 *
 * 为什么要有：截图是要进模型上下文的图片，宽度翻倍 = token 翻几倍。1280 够看清布局与文案，
 * 而超宽页面（或高 DPI 面板）不夹住的话，一张图就能吃掉一次调用的全部预算。
 */
export const SCREENSHOT_MAX_WIDTH = 1280;

/**
 * `Page.captureScreenshot` 的参数。
 *
 * 仍然用 PNG（契约里 `mimeType` 固定是 `image/png`，改格式会连带改工具层与渲染层，
 * 不属于本次迁移）；超宽时用 `clip` + `scale` 缩到上限内，而不是让截图自己变小 ——
 * 后者会连高度一起缩，最终尺寸就说不清了（而我们要如实回报 width/height）。
 *
 * `captureBeyondViewport: false` 是刻意的：本阶段的截图只有**视口**语义（fullPage
 * 明确属于下一步），把整页截下来会给模型一张它没要求、也放不进上下文的长图。
 */
export function buildCaptureScreenshotParams(
  viewport: { width: number; height: number },
  maxWidth = SCREENSHOT_MAX_WIDTH,
): Record<string, unknown> {
  const width = viewport.width > 0 ? viewport.width : 1;
  const height = viewport.height > 0 ? viewport.height : 1;
  const params: Record<string, unknown> = {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
  };
  if (width > maxWidth) {
    params.clip = { x: 0, y: 0, width, height, scale: maxWidth / width };
  }
  return params;
}

/** PNG 里宽高的字节偏移：8 字节签名 + 4 字节块长度 + "IHDR" 之后 */
const PNG_SIZE_OFFSET = 16;

/**
 * 从 base64 PNG 里读出真实像素尺寸。
 *
 * 为什么要自己读：`Page.captureScreenshot` 只回 base64，而契约要求如实回报 width/height。
 * 用"我认为的裁剪尺寸"去算会在高 DPI 面板上直接算错（CSS 像素 ≠ 设备像素），
 * 而错报的尺寸会让模型以为截到了别的内容。IHDR 就在固定偏移上，读它就是权威值。
 * 解析不出来时返回 null —— 调用方那边会退化成"尺寸未知"，而不是编一个数字。
 */
export function readPngSize(base64: string): { width: number; height: number } | null {
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length < PNG_SIZE_OFFSET + 8) return null;
  // PNG 签名，防"这根本不是 PNG"（例如 CDP 在旧版本上回了别的格式）
  if (bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) return null;
  return {
    width: bytes.readUInt32BE(PNG_SIZE_OFFSET),
    height: bytes.readUInt32BE(PNG_SIZE_OFFSET + 4),
  };
}

/**
 * 一张「像全白」的 PNG 的字节/像素比上限。
 *
 * PNG 对纯色区域的压缩率极高：一屏（约 758×1464 ≈ 111 万像素）纯白的 PNG
 * 只有几 KB，而正常页面同样的尺寸通常是几十到几百 KB。取 1/64 是**保守**的：
 * 只有「明显偏小」才算可疑 —— 误报会让一次正常截图被贴上「可能是白的」，
 * 模型会对每次截图都疑神疑鬼，那比漏报更糟。
 */
export const BLANK_PNG_BYTES_PER_PIXEL = 1 / 64;

/** 小于这个像素面积的图不判：PNG 的头部与块结构本身就有一两百字节，阈值在小图上没有分辨力 */
const BLANK_PNG_MIN_PIXELS = 100 * 100;

/**
 * 廉价空白检测（P5）：截图成功但内容可能全白时返回 true。
 *
 * 症状：页面刚挂载 / 刚重挂载时 `Page.captureScreenshot` 立刻返回一张**成功**的图，
 * 内容却全白（实测 758×1464 纯白），而工具什么都不说 —— 模型据此以为页面本来就是白的。
 *
 * 判据是「压缩后字节数 / 像素数」：不解压、不引入图像库，也天然与分辨率无关。
 * 返回 false 只表示「不像全白」，不是「一定不是全白」——它只用来决定要不要重试一次、
 * 要不要在结果里告警（见 service.ts 的 screenshot()）。
 */
export function looksLikeBlankPng(base64: string, width: number, height: number): boolean {
  if (!(width > 0 && height > 0)) return false;
  const pixels = width * height;
  if (pixels < BLANK_PNG_MIN_PIXELS) return false;
  const bytes = Buffer.from(base64, "base64").length;
  return bytes < pixels * BLANK_PNG_BYTES_PER_PIXEL;
}

/** 错误码在报告里的口径 */
export type CdpErrorCode = BrowserErrorCode;
