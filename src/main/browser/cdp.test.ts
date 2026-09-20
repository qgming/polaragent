// CDP 层（白名单、错误映射、事件分发、协议数据整形）的单测。
//
// 这些测试全部**不依赖 electron**：cdp.ts 里凡是需要 WebContents 的部分都在 CdpSession 内部，
// 而它只跟一个最小接口打交道，所以这里可以喂一个假 debugger 进来。
// 为什么值得测：白名单与错误码是「错了也不会响」的两件事 ——
//   · 白名单漏一条 → 某个通道在真机上静默失效（发送被 CPU 拒绝，而调用方只看到一句空）；
//   · 白名单多一条 → 把 Cookie / Storage 这类能导出登录会话的域打开，代码里看不出问题；
//   · 错误码映射错了 → 模型拿到的「下一步该做什么」是错的（页面刚导航 vs 我们发错方法）。
// 所以下面每条断言都对着 cdp.ts 里的一个具体决定，改坏一格就会变红。

import { describe, expect, it } from "vitest";
import {
  BROWSER_CDP_ALLOWED,
  BROWSER_CDP_FORBIDDEN_PREFIXES,
  BROWSER_CDP_GATED,
  buildCaptureScreenshotParams,
  type CdpDebugger,
  CdpSession,
  cdpDeniedError,
  cdpErrorCode,
  consoleCallToRecord,
  decideCdpMethod,
  describeRemoteObject,
  isAllowedCdpMethod,
  logEntryToRecord,
  mapCdpError,
  networkLoadingFailed,
  networkLoadingFinished,
  networkRequestWillBeSent,
  networkResponseReceived,
  readPngSize,
  SCREENSHOT_MAX_WIDTH,
} from "./cdp";
import { BrowserToolError, isBrowserToolError } from "./errors";

/** 假 debugger：只实现 CdpDebugger 那几个成员，并记录收到过什么 */
class FakeDebugger implements CdpDebugger {
  attached = false;
  protocolVersion: string | undefined;
  readonly sent: Array<{ method: string; params: Record<string, unknown> | undefined }> = [];
  /** 方法名 → 响应；值是 Error 时按「发送失败」处理 */
  readonly plan = new Map<string, unknown>();
  private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  attach(protocolVersion?: string): void {
    if (this.attached) throw new Error("Debugger is already attached");
    this.attached = true;
    this.protocolVersion = protocolVersion;
  }

  detach(): void {
    this.attached = false;
    this.emit("detach");
  }

  isAttached(): boolean {
    return this.attached;
  }

  async sendCommand(method: string, commandParams?: Record<string, unknown>): Promise<unknown> {
    this.sent.push({ method, params: commandParams });
    const planned = this.plan.get(method);
    if (planned instanceof Error) throw planned;
    return planned;
  }

  on(event: string, listener: (...args: unknown[]) => void): void {
    let set = this.listeners.get(event);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
  }

  removeListener(event: string, listener: (...args: unknown[]) => void): void {
    this.listeners.get(event)?.delete(listener);
  }

  /** 模拟 Electron 推来一条 message 事件 */
  emit(method: string, params?: unknown): void {
    for (const listener of this.listeners.get("message") ?? []) listener({}, method, params);
  }

  emitEvent(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener({}, ...args);
  }

  methodsSent(): string[] {
    return this.sent.map((item) => item.method);
  }
}

/** 目标替身：CdpSession 只需要 debugger 与 isDestroyed */
function fakeTarget(debuggerRef: FakeDebugger, destroyed = false) {
  return { debugger: debuggerRef, isDestroyed: () => destroyed };
}

describe("CDP 白名单", () => {
  it("默认开放的集合逐条放行（少一条就是某个通道在真机上静默失效）", () => {
    // 迁移到的每一个方法都必须在表里，否则对应通道发不出去
    for (const method of [
      "Page.enable",
      "Page.captureScreenshot",
      "Page.getLayoutMetrics",
      "Page.handleJavaScriptDialog",
      "Runtime.enable",
      "Runtime.evaluate",
      "Input.dispatchMouseEvent",
      "Input.dispatchKeyEvent",
      "Input.insertText",
      "Log.enable",
      "Page.reload",
      "Page.bringToFront",
      "Page.getNavigationHistory",
      "Page.navigateToHistoryEntry",
      "DOM.getBoxModel",
      "DOM.scrollIntoViewIfNeeded",
      "DOM.describeNode",
      "Runtime.getProperties",
      "Accessibility.getFullAXTree",
      "Console.enable",
    ]) {
      expect(isAllowedCdpMethod(method), method).toBe(true);
    }
  });

  it("永不开放的域一律拒绝，且判定先于白名单（白名单被改错也不能变成直接漏）", () => {
    for (const prefix of BROWSER_CDP_FORBIDDEN_PREFIXES) {
      expect(decideCdpMethod(`${prefix}getCookies`), prefix).toBe("forbidden");
    }
    expect(decideCdpMethod("Cookie.getCookies")).toBe("forbidden");
    expect(decideCdpMethod("Storage.getStorageKeyForFrame")).toBe("forbidden");
    expect(decideCdpMethod("IndexedDB.clearObjectStore")).toBe("forbidden");
    expect(decideCdpMethod("DOMStorage.setDOMStorageItem")).toBe("forbidden");
    // 即使有人把某个永不开放的方法手滑加进白名单，判定仍然是 forbidden
    // （这里不真的改白名单，只断言判定顺序：前缀优先）
    expect(isAllowedCdpMethod("Storage.getCookies")).toBe(false);
  });

  it("开关控制的域与方法是 gated（默认关），未登记的域是 unknown", () => {
    // Network 只放开了 enable（记录用）；拦截 / mock 与多目标（Fetch / Target）仍然关着。
    // 其余 Network.* 方法（setRequestInterception 之类）必须还是 gated —— 它们会改变请求行为。
    for (const method of [
      "Network.setRequestInterception",
      "Fetch.enable",
      "Target.createTarget",
    ]) {
      expect(decideCdpMethod(method), method).toBe("gated");
    }
    expect(isAllowedCdpMethod("Network.enable")).toBe(true);
    for (const method of ["Emulation.setDeviceMetricsOverride", "DOM.setFileInputFiles"]) {
      expect(decideCdpMethod(method), method).toBe("gated");
    }
    expect(BROWSER_CDP_GATED.has("DOM.setFileInputFiles")).toBe(true);
    // 没登记过的方法（含拼错的）一律 unknown → 拒绝
    expect(decideCdpMethod("Runtime.compileScript")).toBe("unknown");
    expect(decideCdpMethod("Page.Enable")).toBe("unknown");
    expect(isAllowedCdpMethod("Runtime.compileScript")).toBe(false);
  });

  it("白名单表里只有协议的「默认开放」集合（不多不少）", () => {
    // 表被无意扩大时这条会红 —— 白名单的每一次扩大都应该是显式决定
    expect([...BROWSER_CDP_ALLOWED].every((method) => method.includes("."))).toBe(true);
    // 30 = 原来的 29 + Network.enable（网络记录从 session.webRequest 迁到 CDP，理由见 cdp.ts）
    expect(BROWSER_CDP_ALLOWED.size).toBe(30);
    expect([...BROWSER_CDP_ALLOWED].some((method) => method.startsWith("Cookie."))).toBe(false);
  });

  it("拒绝的理由带 PERMISSION_DENIED 与 INVALID_ARGUMENT 码（工具层据此渲染下一步）", () => {
    const denied = cdpDeniedError("Storage.getCookies", "forbidden");
    expect(isBrowserToolError(denied)).toBe(true);
    expect(denied.code).toBe("INVALID_ARGUMENT");
    expect(denied.detail?.reason).toBe("PERMISSION_DENIED");
    expect(denied.message).toContain("Storage.getCookies");
  });
});

describe("CdpSession.send", () => {
  it("被拒绝的方法**不会**真的发出去（拒绝发生在白名单那一层）", async () => {
    const dbg = new FakeDebugger();
    const session = new CdpSession();
    await session.attach(fakeTarget(dbg));
    dbg.sent.length = 0; // 只看这一条；忽略 attach 时的预启用

    await expect(session.send("Storage.getCookies")).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    await expect(session.send("Network.setRequestInterception")).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    expect(dbg.methodsSent()).toEqual([]);
  });

  it("未附着时发送 → UNAVAILABLE（而不是把命令丢进空气里）", async () => {
    const session = new CdpSession();
    await expect(session.send("Runtime.evaluate", { expression: "1" })).rejects.toMatchObject({
      code: "UNAVAILABLE",
    });
  });

  it("白名单内的方法原样透传参数与响应", async () => {
    const dbg = new FakeDebugger();
    dbg.plan.set("Runtime.evaluate", { result: { type: "string", value: "ok" } });
    const session = new CdpSession();
    await session.attach(fakeTarget(dbg));

    const result = await session.send<{ result: { value: string } }>("Runtime.evaluate", {
      expression: "1+1",
      returnByValue: true,
    });
    expect(result.result.value).toBe("ok");
    expect(dbg.sent.at(-1)).toEqual({
      method: "Runtime.evaluate",
      params: { expression: "1+1", returnByValue: true },
    });
  });

  it("附着之后 guest 被销毁 → UNAVAILABLE（不再往死的目标发命令）", async () => {
    const dbg = new FakeDebugger();
    let destroyed = false;
    const target = { debugger: dbg, isDestroyed: () => destroyed };
    const session = new CdpSession();
    await session.attach(target);

    destroyed = true;
    const before = dbg.sent.length;
    await expect(session.send("Runtime.evaluate", { expression: "1" })).rejects.toMatchObject({
      code: "UNAVAILABLE",
    });
    expect(dbg.sent.length).toBe(before);
  });
});

describe("CdpSession 附着", () => {
  it("attach 用 1.3 协议，并预启用 Page/DOM/Runtime/Accessibility/Console/Log", async () => {
    const dbg = new FakeDebugger();
    const session = new CdpSession();
    await session.attach(fakeTarget(dbg));

    expect(dbg.protocolVersion).toBe("1.3");
    for (const domain of ["Page", "DOM", "Runtime", "Accessibility", "Console", "Log"]) {
      expect(dbg.methodsSent(), domain).toContain(`${domain}.enable`);
    }
    expect(session.isAttached()).toBe(true);
  });

  it("重复 attach 是幂等的（Electron 同时只允许一个调试器，重复附着必然失败）", async () => {
    const dbg = new FakeDebugger();
    const session = new CdpSession();
    await session.attach(fakeTarget(dbg));
    const before = dbg.sent.length;
    await session.attach(fakeTarget(dbg));
    expect(dbg.sent.length).toBe(before);
  });

  it("调试器已被别人占着（开发者工具）→ UNAVAILABLE，理由是 DEBUGGER_OCCUPIED", async () => {
    const dbg = new FakeDebugger();
    dbg.attached = true; // 别人先占了
    const session = new CdpSession();
    const error = await session.attach(fakeTarget(dbg)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BrowserToolError);
    expect((error as BrowserToolError).code).toBe("UNAVAILABLE");
    expect((error as BrowserToolError).detail?.reason).toBe("DEBUGGER_OCCUPIED");
  });

  it("必要域（Page / Runtime）启用失败 → 判附着失败并**断开**，好让下次重试", async () => {
    const dbg = new FakeDebugger();
    dbg.plan.set("Page.enable", new Error("Execution context was destroyed."));
    const session = new CdpSession();
    const error = await session.attach(fakeTarget(dbg)).catch((e: unknown) => e);
    expect((error as BrowserToolError).code).toBe("UNAVAILABLE");
    expect(session.isAttached()).toBe(false);
    expect(dbg.isAttached()).toBe(false);
  });

  it("非必要域（Console 是废弃域）失败只降级，不拖垮会话", async () => {
    const dbg = new FakeDebugger();
    dbg.plan.set("Console.enable", new Error("'Console.enable' wasn't found"));
    const session = new CdpSession();
    await session.attach(fakeTarget(dbg));
    expect(session.isAttached()).toBe(true);
    expect(session.degradedDomains()).toEqual(["Console"]);
  });

  it("guest 已销毁 → 不附着", async () => {
    const dbg = new FakeDebugger();
    const session = new CdpSession();
    await expect(session.attach(fakeTarget(dbg, true))).rejects.toMatchObject({
      code: "UNAVAILABLE",
    });
    expect(dbg.isAttached()).toBe(false);
  });
});

describe("CdpSession 事件", () => {
  it("on(method) 只收到自己订阅的方法，退订后不再收到", async () => {
    const dbg = new FakeDebugger();
    const session = new CdpSession();
    await session.attach(fakeTarget(dbg));

    const seen: unknown[] = [];
    const off = session.on("Runtime.consoleAPICalled", (params) => seen.push(params));
    dbg.emit("Runtime.consoleAPICalled", { type: "log" });
    dbg.emit("Log.entryAdded", { entry: {} });
    expect(seen).toEqual([{ type: "log" }]);

    off();
    dbg.emit("Runtime.consoleAPICalled", { type: "error" });
    expect(seen.length).toBe(1);
  });

  it("同一个函数重复订阅只算一次（重复接线不会让每条日志变成两条）", async () => {
    const dbg = new FakeDebugger();
    const session = new CdpSession();
    await session.attach(fakeTarget(dbg));

    let count = 0;
    const handler = (): void => {
      count += 1;
    };
    session.on("Log.entryAdded", handler);
    session.on("Log.entryAdded", handler);
    dbg.emit("Log.entryAdded", {});
    expect(count).toBe(1);
  });

  it("一个处理器抛错不影响其它处理器", async () => {
    const dbg = new FakeDebugger();
    const session = new CdpSession();
    await session.attach(fakeTarget(dbg));

    let reached = false;
    session.on("Log.entryAdded", () => {
      throw new Error("boom");
    });
    session.on("Log.entryAdded", () => {
      reached = true;
    });
    expect(() => dbg.emit("Log.entryAdded", {})).not.toThrow();
    expect(reached).toBe(true);
  });

  it("debugger detach 时通知订阅者并把自己标成未附着（否则会继续往死会话发命令）", async () => {
    const dbg = new FakeDebugger();
    const session = new CdpSession();
    await session.attach(fakeTarget(dbg));

    let notified = 0;
    session.onDetach(() => {
      notified += 1;
    });
    dbg.emitEvent("detach");
    expect(notified).toBe(1);
    expect(session.isAttached()).toBe(false);
  });

  it("detach() 是幂等的，且会真的调用 debugger.detach", async () => {
    const dbg = new FakeDebugger();
    const session = new CdpSession();
    await session.attach(fakeTarget(dbg));
    session.detach();
    expect(dbg.isAttached()).toBe(false);
    expect(() => session.detach()).not.toThrow();
  });
});

describe("CDP 错误 → 错误码映射", () => {
  const cases: ReadonlyArray<readonly [label: string, error: unknown, code: string]> = [
    ["方法不存在（协议码）", new Error("'-32601' (0xffff)"), "INVALID_ARGUMENT"],
    ["方法不存在（Electron 的文案）", new Error("'Runtime.nope' wasn't found"), "INVALID_ARGUMENT"],
    ["参数不合法", new Error("Invalid parameters"), "INVALID_ARGUMENT"],
    ["上下文被销毁（页面导航走了）", new Error("Execution context was destroyed."), "UNAVAILABLE"],
    ["调试器已被别人抢走", new Error("Debugger is already attached"), "UNAVAILABLE"],
    ["找不到节点", new Error("No node with given id 42"), "NOT_FOUND"],
    ["帧已不存在", new Error("No such frame"), "NOT_FOUND"],
    ["其它一律 TOOL_FAILED", new Error("browser process crashed"), "TOOL_FAILED"],
  ];

  it.each(cases)("%s → %s", (_label, error, code) => {
    expect(mapCdpError(error, "Runtime.evaluate").code).toBe(code);
  });

  it("结构化 code 优先于文案（Electron 不同版本给的东西不一样）", () => {
    const withCode = Object.assign(new Error("boom"), { code: -32000 });
    expect(cdpErrorCode(withCode)).toBe(-32000);
    // 只认 -32xxx 这个形态：其它数字（超时毫秒、进程号）不该被当成协议码
    expect(cdpErrorCode(new Error("error (code: -32601)"))).toBe(-32601);
    expect(cdpErrorCode(new Error("waited 32000 ms without a frame"))).toBeNull();
    expect(cdpErrorCode(new Error("Method not found (-32601)"))).toBe(-32601);
    expect(cdpErrorCode(new Error("no code here"))).toBeNull();
  });

  it("已经是 BrowserToolError 的原样返回（不重复包一层，免得码被改写）", () => {
    const original = new BrowserToolError("NO_EFFECT", "点击没有生效");
    expect(mapCdpError(original, "Input.dispatchMouseEvent")).toBe(original);
  });

  it("映射结果一定带码与现场信息（工具层只能按 code 决策）", () => {
    const mapped = mapCdpError(new Error("Execution context was destroyed."), "Runtime.evaluate");
    expect(isBrowserToolError(mapped)).toBe(true);
    expect(mapped.detail?.method).toBe("Runtime.evaluate");
    expect(mapped.message).toContain("Runtime.evaluate");
  });
});

describe("控制台事件整形（Runtime.consoleAPICalled / Log.entryAdded）", () => {
  it("console.* 按 type 映射到我们的 level 词表", () => {
    const levels: ReadonlyArray<readonly [string, string]> = [
      ["log", "info"],
      ["info", "info"],
      ["debug", "debug"],
      ["verbose", "debug"],
      ["warning", "warning"],
      ["error", "error"],
      ["assert", "error"],
    ];
    for (const [type, level] of levels) {
      expect(consoleCallToRecord({ type })?.level, type).toBe(level);
    }
  });

  it("结构化参数被拼成人能读的一行（对象不再变成空字符串）", () => {
    expect(describeRemoteObject({ type: "string", value: "hello" })).toBe("hello");
    expect(describeRemoteObject({ type: "number", value: 42 })).toBe("42");
    expect(describeRemoteObject({ type: "boolean", value: false })).toBe("false");
    expect(describeRemoteObject({ type: "undefined" })).toBe("undefined");
    expect(describeRemoteObject({ type: "object", subtype: "null", value: null })).toBe("null");
    expect(describeRemoteObject({ type: "object", description: "Object" })).toBe("Object");
    expect(describeRemoteObject({ type: "object", preview: { description: "div#app" } })).toBe(
      "div#app",
    );
    expect(describeRemoteObject({ type: "function", description: "function f()" })).toBe(
      "function f()",
    );

    const record = consoleCallToRecord({
      type: "log",
      args: [
        { type: "string", value: "count:" },
        { type: "number", value: 3 },
        { type: "object", description: "{a: 1}" },
      ],
    });
    expect(record?.text).toBe("count: 3 {a: 1}");
  });

  it("调用点取 stackTrace 的第一帧，行号从 0 基换算成 1 基", () => {
    const record = consoleCallToRecord({
      type: "error",
      stackTrace: { callFrames: [{ url: "https://example.com/app.js", lineNumber: 6 }] },
    });
    expect(record?.source).toBe("https://example.com/app.js");
    expect(record?.line).toBe(7);
  });

  it("Log.entryAdded 带上 url 与 level（浏览器自身的错误走这条通道）", () => {
    const record = logEntryToRecord({
      entry: {
        source: "network",
        level: "error",
        text: "Failed to load resource: net::ERR_NAME_NOT_RESOLVED",
        url: "https://api.example.com/x",
        lineNumber: 0,
      },
    });
    expect(record).toEqual({
      level: "error",
      text: "Failed to load resource: net::ERR_NAME_NOT_RESOLVED",
      source: "https://api.example.com/x",
      line: 1,
    });
    // url 为空时退回 entry.source（分类），不至于让 source 一栏空掉
    expect(
      logEntryToRecord({ entry: { source: "security", level: "warning", text: "x" } })?.source,
    ).toBe("security");
  });

  it("结构不对（空文本 / 没有 entry）时返回 null，不编一条假日志", () => {
    expect(logEntryToRecord(undefined)).toBeNull();
    expect(logEntryToRecord({ entry: { level: "error" } })).toBeNull();
    expect(consoleCallToRecord(null)).toBeNull();
  });

  it("Electron 自己的日志 source 形如 node:electron/js2c，能被既有的噪音过滤认出", () => {
    // service 侧的 isConsoleNoise 按 source 前缀过滤；这里钉住「协议字段映射到那一栏」这件事
    const record = logEntryToRecord({
      entry: {
        source: "javascript",
        level: "warning",
        text: "Electron Security Warning",
        url: "node:electron/js2c/renderer_init.js",
      },
    });
    expect(record?.source.startsWith("node:electron/js2c")).toBe(true);
  });
});

describe("截图参数与 PNG 尺寸", () => {
  it("宽度不超过上限时直接抓视口（不加 clip）", () => {
    const params = buildCaptureScreenshotParams({ width: 1000, height: 700 });
    expect(params.format).toBe("png");
    expect(params.clip).toBeUndefined();
    expect(params.captureBeyondViewport).toBe(false);
  });

  it("超宽时用 clip + scale 缩到 1280 以内（PNG 契约不变）", () => {
    const params = buildCaptureScreenshotParams({ width: 2560, height: 1400 });
    expect(params.clip).toEqual({ x: 0, y: 0, width: 2560, height: 1400, scale: 0.5 });
    expect(params.format).toBe("png");
    expect(SCREENSHOT_MAX_WIDTH).toBe(1280);
  });

  it("从 base64 PNG 的 IHDR 里如实读出像素尺寸（高 DPI 下算出来的会错）", () => {
    const base64 = fakePng(1280, 720);
    expect(readPngSize(base64)).toEqual({ width: 1280, height: 720 });
    // 不是 PNG 就返回 null：调用方那边退化成「尺寸未知」，而不是编一个数字
    expect(
      readPngSize(Buffer.from("not a png at all, but long enough").toString("base64")),
    ).toBeNull();
    expect(readPngSize("")).toBeNull();
  });
});

describe("网络事件整形（Network.* → 契约记录）", () => {
  it("requestWillBeSent：取出 url / method / 归一后的资源类型", () => {
    const start = networkRequestWillBeSent({
      requestId: "r1",
      request: { url: "https://example.com/api/items", method: "POST" },
      type: "XHR",
    });
    expect(start).not.toBeNull();
    expect(start?.requestId).toBe("r1");
    expect(start?.url).toBe("https://example.com/api/items");
    expect(start?.method).toBe("POST");
    // 词表统一成小写：模型看到 "xhr" 比 "XHR" 更容易与其它输出对齐
    expect(start?.resourceType).toBe("xhr");
  });

  it("requestWillBeSent：缺 requestId 或 url 时返回 null（不编造记录）", () => {
    expect(networkRequestWillBeSent({ request: { url: "https://x/" } })).toBeNull();
    expect(networkRequestWillBeSent({ requestId: "r1", request: {} })).toBeNull();
    expect(networkRequestWillBeSent(null)).toBeNull();
  });

  it("responseReceived → 状态码", () => {
    expect(networkResponseReceived({ requestId: "r1", response: { status: 500 } })).toEqual({
      requestId: "r1",
      status: 500,
    });
    expect(networkResponseReceived({ requestId: "r1", response: {} })).toEqual({
      requestId: "r1",
      status: 0,
    });
    expect(networkResponseReceived({})).toBeNull();
  });

  it("loadingFinished → 结束时刻", () => {
    const finished = networkLoadingFinished({ requestId: "r1" });
    expect(finished?.requestId).toBe("r1");
    expect(typeof finished?.at).toBe("number");
    expect(networkLoadingFinished({})).toBeNull();
  });

  it("loadingFailed：如实带上 canceled（与 DNS/连接失败是两类事实）", () => {
    const canceled = networkLoadingFailed({
      requestId: "r1",
      errorText: "net::ERR_ABORTED",
      canceled: true,
    });
    expect(canceled?.error).toBe("canceled (net::ERR_ABORTED)");

    const failed = networkLoadingFailed({
      requestId: "r2",
      errorText: "net::ERR_CONNECTION_REFUSED",
    });
    expect(failed?.error).toBe("net::ERR_CONNECTION_REFUSED");

    // 没有 errorText 时也要有一条可读的失败原因，不能空着
    expect(networkLoadingFailed({ requestId: "r3" })?.error).toBe("failed");
  });
});

/** 造一个只带 IHDR 的假 PNG（字节偏移与真 PNG 一致，够 readPngSize 读） */
function fakePng(width: number, height: number): string {
  const bytes = Buffer.alloc(32);
  bytes.writeUInt8(0x89, 0);
  bytes.write("PNG", 1, "ascii");
  bytes.writeUInt8(0x0d, 4);
  bytes.writeUInt8(0x0a, 5);
  bytes.writeUInt8(0x1a, 6);
  bytes.writeUInt8(0x0a, 7);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes.toString("base64");
}
