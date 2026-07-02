// IPC: Browser Use - Chrome extension bridge.
const WebSocket = require("ws");
const http = require("http");
const { app, dialog } = require("electron");
const fs = require("fs");
const path = require("path");
const { clampNumber } = require("../lib/utils.cjs");

// 共享的浏览器端 DOM 辅助函数（注入到 CDP Runtime.evaluate 中执行）
const BROWSER_RUNTIME_HELPERS = `
  function interactiveSelector() {
    return [
      "a[href]", "button", "input", "textarea", "select", "summary",
      "[contenteditable='true']", "[role='button']", "[role='link']",
      "[role='textbox']", "[role='checkbox']", "[role='radio']",
      "[role='combobox']", "[role='menuitem']", "[onclick]",
      "[tabindex]:not([tabindex='-1'])",
    ].join(",");
  }
  function queryAll(root, selector) {
    try { return Array.from(root.querySelectorAll(selector)); } catch (_) { return []; }
  }
  function queryOne(root, selector) {
    try { return root.querySelector(selector); } catch (_) { return null; }
  }
  function queryPiercePath(root, path) {
    if (!Array.isArray(path) || path.length === 0) return null;
    let currentRoot = root;
    let current = null;
    for (let i = 0; i < path.length; i++) {
      current = queryOne(currentRoot, path[i]);
      if (!current) return null;
      if (i < path.length - 1) {
        currentRoot = current.shadowRoot;
        if (!currentRoot) return null;
      }
    }
    return current;
  }
  function walkRoots(root, visitor) {
    if (!root) return;
    visitor(root);
    for (const host of queryAll(root, "*")) {
      if (host.shadowRoot) walkRoots(host.shadowRoot, visitor);
    }
  }
  function deepQuerySelector(root, selector) {
    let found = null;
    walkRoots(root, (nextRoot) => {
      if (found) return;
      found = queryOne(nextRoot, selector);
    });
    if (found) return found;
    for (const frame of queryAll(root, "iframe,frame")) {
      try {
        const child = frame.contentDocument && deepQuerySelector(frame.contentDocument, selector);
        if (child) return child;
      } catch (_) {}
    }
    return null;
  }
  function deepQuerySelectorAll(root, selector) {
    const results = [];
    walkRoots(root, (nextRoot) => results.push(...queryAll(nextRoot, selector)));
    for (const frame of queryAll(root, "iframe,frame")) {
      try {
        if (frame.contentDocument) results.push(...deepQuerySelectorAll(frame.contentDocument, selector));
      } catch (_) {}
    }
    return results;
  }
  function resolveFrameDocument(framePath) {
    let doc = document;
    for (const step of Array.isArray(framePath) ? framePath : []) {
      let frame = queryPiercePath(doc, step?.piercePath);
      if (!frame && Number.isInteger(Number(step?.index))) {
        frame = queryAll(doc, "iframe,frame")[Number(step.index)];
      }
      if (!frame) return null;
      try { doc = frame.contentDocument; } catch (_) { return null; }
      if (!doc) return null;
    }
    return doc;
  }
  function textFor(el) {
    return (
      el.getAttribute("aria-label") ||
      el.getAttribute("title") ||
      el.getAttribute("placeholder") ||
      el.getAttribute("alt") ||
      el.innerText ||
      el.textContent ||
      el.value ||
      ""
    ).trim().replace(/\\s+/g, " ").toLowerCase();
  }
  function deepElementFromPoint(x, y, rootDoc) {
    let doc = rootDoc || document;
    let px = x;
    let py = y;
    let el = null;
    for (let guard = 0; guard < 8; guard++) {
      try { el = doc.elementFromPoint(px, py); } catch (_) { return null; }
      if (!el) return null;
      if (el.shadowRoot) {
        const inner = el.shadowRoot.elementFromPoint(px, py);
        if (inner && inner !== el) { el = inner; continue; }
      }
      if ((el.tagName === "IFRAME" || el.tagName === "FRAME") && el.contentDocument) {
        const rect = el.getBoundingClientRect();
        px -= rect.x; py -= rect.y;
        doc = el.contentDocument;
        continue;
      }
      return el;
    }
    return el;
  }
  function findActionElement(target, element) {
    const doc = resolveFrameDocument(element?.framePath) || document;
    if (Array.isArray(element?.piercePath)) {
      const exact = queryPiercePath(doc, element.piercePath);
      if (exact) return { el: exact, selector: "piercePath" };
    }
    const selectors = [];
    if (Array.isArray(element?.selectors)) selectors.push(...element.selectors);
    if (target && !String(target).startsWith("@e")) selectors.unshift(target);
    for (const selector of selectors.filter(Boolean)) {
      const el = deepQuerySelector(doc, selector);
      if (el) return { el, selector };
    }
    const needle = String(element?.text || "").trim().replace(/\\s+/g, " ").toLowerCase();
    if (needle) {
      const byText = deepQuerySelectorAll(doc, interactiveSelector()).find((el) => {
        const t = textFor(el);
        return t === needle || (needle.length > 4 && t.includes(needle));
      });
      if (byText) return { el: byText, selector: "text" };
    }
    if (element?.bbox) {
      const x = Number(element.bbox.centerX);
      const y = Number(element.bbox.centerY);
      if (Number.isFinite(x) && Number.isFinite(y)) {
        let el = deepElementFromPoint(x, y);
        if (el && !el.matches(interactiveSelector())) el = el.closest(interactiveSelector());
        if (el) return { el, selector: "bbox" };
      }
    }
    return null;
  }
  function nextFrame() {
    return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }
  function waitForDomSettled(waitMs, rootDoc) {
    const quietMs = Math.max(80, Number(waitMs || 0));
    const maxMs = Math.max(quietMs + 50, Math.min(3000, quietMs + 1200));
    return new Promise((resolve) => {
      let done = false;
      let quietTimer = null;
      let observer = null;
      const finish = () => {
        if (done) return;
        done = true;
        try { observer && observer.disconnect(); } catch (_) {}
        clearTimeout(quietTimer);
        resolve();
      };
      const bump = () => {
        clearTimeout(quietTimer);
        quietTimer = setTimeout(finish, quietMs);
      };
      observer = new MutationObserver(bump);
      try {
        observer.observe((rootDoc || document).documentElement, { childList: true, subtree: true, attributes: true });
      } catch (_) {
        return setTimeout(resolve, quietMs);
      }
      bump();
      setTimeout(finish, maxMs);
    });
  }
`;

const DEFAULT_CONFIG = {
  wsPort: 18765,
  apiPort: 18767,
  enableHttpApi: false,
  actionTimeoutMs: 30000,
  waitAfterActionMs: 300,
  verboseLogs: false,
};

let config = { ...DEFAULT_CONFIG };
let wss = null;
let apiServer = null;
let extensionWs = null;
let requestId = 0;
let pendingRequests = new Map();
let snapshotCache = new Map();
let extensionInfo = null;
let lastError = null;
let lastCommandAt = 0;
let lastTabs = [];

function normalizePort(value, fallback) {
  const port = Number(value ?? fallback);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("端口必须是 1-65535");
  }
  return port;
}

function normalizeConfig(input = {}) {
  return {
    wsPort: normalizePort(input.wsPort, config.wsPort),
    apiPort: normalizePort(input.apiPort, config.apiPort),
    enableHttpApi: Boolean(input.enableHttpApi ?? config.enableHttpApi),
    actionTimeoutMs: clampNumber(input.actionTimeoutMs, config.actionTimeoutMs, 1000, 180000),
    waitAfterActionMs: clampNumber(input.waitAfterActionMs, config.waitAfterActionMs, 0, 10000),
    verboseLogs: Boolean(input.verboseLogs ?? config.verboseLogs),
  };
}

function log(...args) {
  if (config.verboseLogs) console.log("[BrowserUse]", ...args);
}

function markError(error) {
  lastError = error instanceof Error ? error.message : String(error);
  console.error("[BrowserUse]", lastError);
}

function rejectAllPending(message) {
  const error = new Error(message);
  for (const { reject, timer } of pendingRequests.values()) {
    clearTimeout(timer);
    reject(error);
  }
  pendingRequests.clear();
}

function closeListeningServer(server) {
  return new Promise((resolve) => {
    if (!server) {
      resolve();
      return;
    }
    try {
      server.close(() => resolve());
    } catch (_) {
      resolve();
    }
  });
}

function startServices() {
  if (wss) return;

  try {
    wss = new WebSocket.Server({ host: "127.0.0.1", port: config.wsPort });
  } catch (error) {
    wss = null;
    markError(error);
    return;
  }

  wss.on("connection", (ws) => {
    log("Extension connected");
    extensionWs = ws;
    lastError = null;

    ws.on("message", (data) => {
      try {
        const raw = data.toString();
        const msg = JSON.parse(raw);

        if (msg.type === "ping") return;

        if (msg.type === "ext_ready") {
          extensionInfo = {
            browserId: msg.browser_id,
            profileId: msg.profile_id,
            profileLabel: msg.profile_label,
            connectedAt: Date.now(),
          };
          lastTabs = Array.isArray(msg.tabs) ? msg.tabs : [];
          return;
        }

        if (msg.type === "tabs_update") {
          lastTabs = Array.isArray(msg.tabs) ? msg.tabs : [];
          extensionInfo = {
            ...(extensionInfo || {}),
            browserId: msg.browser_id ?? extensionInfo?.browserId,
            profileId: msg.profile_id ?? extensionInfo?.profileId,
            profileLabel: msg.profile_label ?? extensionInfo?.profileLabel,
          };
          return;
        }

        const id = Number(msg.id);
        if (id && pendingRequests.has(id)) {
          const request = pendingRequests.get(id);
          pendingRequests.delete(id);
          clearTimeout(request.timer);
          if (msg.type === "error") {
            request.reject(normalizeExtensionError(msg.error));
          } else {
            request.resolve(msg.result ?? msg);
          }
        }
      } catch (error) {
        markError(new Error(`WebSocket 消息解析失败: ${error.message}`));
      }
    });

    ws.on("close", () => {
      log("Extension disconnected");
      if (extensionWs === ws) {
        extensionWs = null;
        extensionInfo = null;
        lastTabs = [];
        rejectAllPending("Chrome 扩展连接已断开");
      }
    });

    ws.on("error", (error) => markError(error));
  });

  wss.on("error", (error) => {
    markError(error);
    if (error.code === "EADDRINUSE") {
      void stopServices();
    }
  });

  if (config.enableHttpApi) startApiServer();
}

function startApiServer() {
  if (apiServer) return;
  apiServer = http.createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(404);
      res.end();
      return;
    }

    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 2 * 1024 * 1024) req.destroy();
    });
    req.on("end", async () => {
      try {
        const params = JSON.parse(body || "{}");
        const result = await handleCommand(params);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, result }));
      } catch (error) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: error.message }));
      }
    });
  });

  apiServer.on("error", markError);
  apiServer.listen(config.apiPort, "127.0.0.1");
}

async function stopServices() {
  const oldWss = wss;
  const oldApiServer = apiServer;
  wss = null;
  apiServer = null;

  if (extensionWs) {
    try { extensionWs.close(); } catch (_) {}
    extensionWs = null;
  }
  extensionInfo = null;
  lastTabs = [];
  rejectAllPending("Browser Use 服务已停止");
  snapshotCache.clear();
  await Promise.all([closeListeningServer(oldWss), closeListeningServer(oldApiServer)]);
}

async function restartServices(nextConfig) {
  if (nextConfig) config = normalizeConfig(nextConfig);
  await stopServices();
  startServices();
  return getStatus();
}

function normalizeExtensionError(error) {
  if (error instanceof Error) return error;
  if (error && typeof error === "object") {
    return new Error(error.message || JSON.stringify(error));
  }
  return new Error(String(error || "未知错误"));
}

async function sendToExtension(action, params = {}, timeout = config.actionTimeoutMs) {
  if (!extensionWs || extensionWs.readyState !== WebSocket.OPEN) {
    throw new Error("Chrome 扩展未连接，请确保已加载扩展并打开网页");
  }

  return new Promise((resolve, reject) => {
    const id = ++requestId;
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`操作超时 (${timeout}ms): ${action}`));
    }, timeout);

    pendingRequests.set(id, { resolve, reject, timer, action, startedAt: Date.now() });
    lastCommandAt = Date.now();

    try {
      extensionWs.send(JSON.stringify({ id: String(id), code: { cmd: action, ...params } }));
    } catch (error) {
      pendingRequests.delete(id);
      clearTimeout(timer);
      reject(error);
    }
  });
}

async function getActiveTabId(tabId) {
  if (Number.isInteger(Number(tabId)) && Number(tabId) > 0) return Number(tabId);
  const tabs = await getTabs({});
  const active = tabs.find((tab) => tab.active) ?? tabs[0];
  if (!active?.id) throw new Error("未找到可操作的浏览器标签页");
  return active.id;
}

async function handleCommand(params) {
  const { command, ...args } = params || {};

  switch (command) {
    case "tabs":
      return await getTabs(args);
    case "open":
      return await openTab(args);
    case "close":
      return await closeTab(args);
    case "scan":
      return await scanPage(args);
    case "snapshot":
      return await snapshot(args);
    case "click":
      return await click(args);
    case "fill":
      return await fill(args);
    case "drag":
      return await drag(args);
    case "upload":
      return await upload(args);
    case "exec":
      return await executeScript(args);
    case "screenshot":
      return await screenshot(args);
    case "network":
      return await networkMonitor(args);
    case "console":
      return await consoleMonitor(args);
    default:
      throw new Error(`未知命令: ${command}`);
  }
}

async function getTabs(args) {
  const resp = await sendToExtension("tabs", args);
  const tabs = Array.isArray(resp) ? resp : (resp.data || resp.result?.data || resp.tabs || []);
  lastTabs = tabs;
  return tabs;
}

async function openTab(args) {
  const { url, profile, active, window, allowFocus, groupTitle } = args;
  const resp = await sendToExtension("openTab", { url, profile, active, window, allowFocus, groupTitle });
  const tabId = resp.id || resp.data?.id || resp.result?.data?.id;
  if (tabId) {
    // #3 页面就绪检测：新标签页打开后等待页面加载完成
    await waitForPageReady(tabId).catch(() => {});
  }
  return { tabId, ...resp };
}

async function closeTab(args) {
  const { tabId } = args;
  const resp = await sendToExtension("closeTab", { tabId });
  clearSnapshotsForTab(tabId);
  return resp.data || resp.result?.data || { closed: true, tabId };
}

async function cdp(tabId, method, params = {}, timeout) {
  return await sendToExtension("cdp", { tabId: await getActiveTabId(tabId), method, params }, timeout);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isNavigationTransientError(error) {
  const message = String(error?.message || error || "").toLowerCase();
  return (
    message.includes("execution context was destroyed") ||
    message.includes("cannot find context") ||
    message.includes("inspected target navigated") ||
    message.includes("target closed") ||
    message.includes("frame was detached")
  );
}

// #3 页面就绪检测：获取当前 URL 与 readyState
async function getPageState(tabId) {
  try {
    const resp = await cdp(tabId, "Runtime.evaluate", {
      expression: `(function(){ return { url: location.href, readyState: document.readyState }; })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    return resp.result?.value || resp.value || {};
  } catch (error) {
    return {};
  }
}

// #3 页面就绪检测：等待 document.readyState === 'complete' 且无 pending 资源
async function waitForPageReady(tabId, timeoutMs = 5000) {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    try {
      const resp = await cdp(tabId, "Runtime.evaluate", {
        expression: `
          (function() {
            if (document.readyState !== 'complete') return { ready: false, reason: 'readyState=' + document.readyState };
            const entries = performance.getEntriesByType('resource');
            const pending = entries.filter(r => r.responseEnd === 0);
            if (pending.length > 0) return { ready: false, reason: pending.length + ' pending resources' };
            return { ready: true };
          })()
        `,
        returnByValue: true,
        awaitPromise: true,
      });
      const value = resp.result?.value || resp.value;
      if (value?.ready) return true;
    } catch (error) {
      // 页面可能正在导航，忽略错误继续等待
    }
    await sleep(200);
  }
  log("页面就绪检测超时，降级继续执行");
  return false;
}

// #5 页面导航检测：对比操作前后的 URL/readyState，若发生导航则等待新页面就绪
async function detectAndWaitForNavigation(tabId, preState, timeoutMs = 5000) {
  try {
    const postState = await getPageState(tabId);
    const urlChanged = preState?.url && postState?.url && preState.url !== postState.url;
    const readyStateRegressed = preState?.readyState === 'complete' && postState?.readyState && postState.readyState !== 'complete';
    if (!urlChanged && !readyStateRegressed) return false;
    log("检测到页面导航，等待新页面就绪");
    await waitForPageReady(tabId, timeoutMs);
    return true;
  } catch (error) {
    return false;
  }
}

// 复用 snapshot 逻辑：为指定 tab 生成快照并写入 snapshotCache
async function buildAndCacheSnapshot(tabId, limit = 200, offset = 0) {
  const expression = `(${buildSnapshotScript.toString()})(${JSON.stringify({ limit, offset })})`;
  const resp = await cdp(tabId, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  const elements = resp.result?.value || resp.value || [];
  const snapshotId = `${tabId}:${Date.now()}`;
  snapshotCache.set(snapshotId, { tabId, elements, createdAt: Date.now() });
  pruneSnapshotCache();
  return { snapshotId, tabId, elements, count: elements.length };
}

async function performClick(tabId, args, resolved) {
  const expression = buildClickScript({
    target: resolved.target,
    element: resolved.element,
    action: args.action,
    waitMs: config.waitAfterActionMs,
  });
  try {
    const resp = await cdp(tabId, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    return { result: resp.result?.value || resp.value || {}, resolved };
  } catch (error) {
    if (!isNavigationTransientError(error)) throw error;
    await sleep(Math.max(100, config.waitAfterActionMs));
    return { result: { ok: true, selector: resolved.target }, resolved, navigationLikely: true };
  }
}

async function performFill(tabId, args, resolved) {
  const expression = buildFillScript({
    target: resolved.target,
    element: resolved.element,
    value: String(args.value ?? ""),
    clear: Boolean(args.clear),
    append: Boolean(args.append),
    selectBy: args.selectBy,
    waitMs: config.waitAfterActionMs,
  });
  try {
    const resp = await cdp(tabId, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    return { result: resp.result?.value || resp.value || {}, resolved };
  } catch (error) {
    if (!isNavigationTransientError(error)) throw error;
    await sleep(Math.max(100, config.waitAfterActionMs));
    return { result: { ok: true, selector: resolved.target }, resolved, navigationLikely: true };
  }
}

// #4 @e 引用容错：元素未找到时自动重新快照，按 selector/text 重新匹配后重试一次
async function retryActionAfterResnapshot(tabId, args, originalResolved, actionName) {
  try {
    log("元素定位失败，尝试重新快照后重试:", args.target);
    const newSnapshot = await buildAndCacheSnapshot(tabId);
    const originalElement = originalResolved.element;
    if (!originalElement) return null;

    const rematched = newSnapshot.elements.find((el) => {
      if (!el) return false;
      if (originalElement.selector && el.selector === originalElement.selector) return true;
      if (originalElement.text && el.text && el.text === originalElement.text) return true;
      if (Array.isArray(originalElement.selectors) && Array.isArray(el.selectors)) {
        return originalElement.selectors.some((s) => el.selectors.includes(s));
      }
      return false;
    });

    if (!rematched) {
      log("重新快照后未找到匹配元素:", args.target);
      return null;
    }

    log("重新快照后找到匹配元素，重试操作:", rematched.ref || rematched.selector);
    const newResolved = { target: rematched.selector || rematched.ref, element: rematched };

    if (actionName === "click") {
      const perf = await performClick(tabId, args, newResolved);
      return { ...perf, snapshotId: newSnapshot.snapshotId };
    }
    if (actionName === "fill") {
      const perf = await performFill(tabId, args, newResolved);
      return { ...perf, snapshotId: newSnapshot.snapshotId };
    }
  } catch (error) {
    log("重新快照重试失败:", error.message);
  }
  return null;
}

async function scanPage(args) {
  const tabId = await getActiveTabId(args.tabId);
  // #3 页面就绪检测：扫描前等待页面加载完成
  await waitForPageReady(tabId);
  const expression = args.textOnly === false
    ? "document.documentElement.outerHTML"
    : `(${buildScanTextScript.toString()})()`;
  const resp = await cdp(tabId, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  return resp.result?.value ?? resp.value ?? "";
}

function buildScanTextScript() {
  const seen = new WeakSet();
  const parts = [];

  function pushText(root) {
    if (!root) return;
    const text = root.body?.innerText || root.textContent || "";
    if (text.trim()) parts.push(text.trim());
  }

  function walk(root) {
    if (!root || seen.has(root)) return;
    seen.add(root);
    pushText(root);
    let all = [];
    try { all = Array.from(root.querySelectorAll("*")); } catch (_) {}
    for (const el of all) {
      if (el.shadowRoot) walk(el.shadowRoot);
      if ((el.tagName === "IFRAME" || el.tagName === "FRAME") && el.contentDocument) {
        try { walk(el.contentDocument); } catch (_) {}
      }
    }
  }

  walk(document);
  return parts.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
}

async function snapshot(args) {
  const tabId = await getActiveTabId(args.tabId);
  // #3 页面就绪检测：快照前等待页面加载完成
  await waitForPageReady(tabId);
  const limit = clampNumber(args.limit, 200, 1, 1000);
  const offset = clampNumber(args.offset, 0, 0, 100000);
  const result = await buildAndCacheSnapshot(tabId, limit, offset);
  return { ...result, sessionKey: result.snapshotId };
}

function buildSnapshotScript({ limit, offset }) {
  const selector = [
    "a[href]",
    "button",
    "input",
    "textarea",
    "select",
    "summary",
    "[contenteditable='true']",
    "[role='button']",
    "[role='link']",
    "[role='textbox']",
    "[role='checkbox']",
    "[role='radio']",
    "[role='combobox']",
    "[role='menuitem']",
    "[onclick]",
    "[tabindex]:not([tabindex='-1'])",
  ].join(",");

  const results = [];
  const seenElements = new WeakSet();
  const wanted = offset + limit;

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }

  function queryAll(root, css) {
    try { return Array.from(root.querySelectorAll(css)); } catch (_) { return []; }
  }

  function selectorInRoot(el, root) {
    const parts = [];
    let node = el;
    while (node && node.nodeType === Node.ELEMENT_NODE && node !== root && parts.length < 6) {
      let part = node.tagName.toLowerCase();
      if (node.id) {
        part += `#${cssEscape(node.id)}`;
        parts.unshift(part);
        break;
      }
      const parent = node.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((child) => child.tagName === node.tagName);
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(" > ");
  }

  function piercePathFor(el) {
    const chain = [];
    let node = el;
    while (node && node.nodeType === Node.ELEMENT_NODE) {
      const root = node.getRootNode();
      const selector = selectorInRoot(node, root);
      if (selector) chain.unshift(selector);
      if (root && root.host) {
        node = root.host;
      } else {
        break;
      }
    }
    return chain;
  }

  function absoluteRect(el) {
    const rect = el.getBoundingClientRect();
    let x = rect.x;
    let y = rect.y;
    let win = el.ownerDocument.defaultView;
    while (win && win !== window) {
      const frame = win.frameElement;
      if (!frame) break;
      const frameRect = frame.getBoundingClientRect();
      x += frameRect.x;
      y += frameRect.y;
      win = win.parent;
    }
    return {
      x,
      y,
      width: rect.width,
      height: rect.height,
      centerX: x + rect.width / 2,
      centerY: y + rect.height / 2,
    };
  }

  function isVisible(el) {
    const rect = absoluteRect(el);
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = el.ownerDocument.defaultView.getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) return false;
    return true;
  }

  function textFor(el) {
    return (
      el.getAttribute("aria-label") ||
      el.getAttribute("title") ||
      el.getAttribute("placeholder") ||
      el.getAttribute("alt") ||
      el.innerText ||
      el.textContent ||
      el.value ||
      ""
    ).trim().replace(/\s+/g, " ").slice(0, 120);
  }

  function frameIndex(frame) {
    try {
      return Array.from(frame.ownerDocument.querySelectorAll("iframe,frame")).indexOf(frame);
    } catch (_) {
      return -1;
    }
  }

  function addElement(el, context) {
    if (!el || seenElements.has(el) || !isVisible(el)) return;
    seenElements.add(el);
    const ordinal = results.length;
    if (ordinal < offset) {
      results.push(null);
      return;
    }
    if (results.length >= wanted) return;
    const rect = absoluteRect(el);
    const text = textFor(el);
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute("role") || "";
    const selectors = [];
    if (el.id) selectors.push(`#${cssEscape(el.id)}`);
    if (el.getAttribute("data-testid")) selectors.push(`[data-testid="${cssEscape(el.getAttribute("data-testid"))}"]`);
    if (el.getAttribute("aria-label")) selectors.push(`${tag}[aria-label="${cssEscape(el.getAttribute("aria-label"))}"]`);
    if (el.name) selectors.push(`${tag}[name="${cssEscape(el.name)}"]`);
    selectors.push(selectorInRoot(el, el.getRootNode()));
    results.push({
      ref: `@e${ordinal - offset + 1}`,
      type: tag,
      role,
      text,
      selector: selectors.find(Boolean),
      selectors: selectors.filter(Boolean),
      framePath: context.framePath,
      piercePath: piercePathFor(el),
      disabled: Boolean(el.disabled || el.getAttribute("aria-disabled") === "true"),
      href: el.href || "",
      inputType: el.type || "",
      bbox: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        centerX: Math.round(rect.x + rect.width / 2),
        centerY: Math.round(rect.y + rect.height / 2),
      },
    });
  }

  function collect(root, context) {
    if (!root || results.length >= wanted) return;
    for (const el of queryAll(root, selector)) {
      if (results.length >= wanted) break;
      addElement(el, context);
    }

    for (const frame of queryAll(root, "iframe,frame")) {
      if (results.length >= wanted) break;
      let childDoc = null;
      try { childDoc = frame.contentDocument; } catch (_) {}
      if (!childDoc) continue;
      collect(childDoc, {
        framePath: [
          ...(context.framePath || []),
          { index: frameIndex(frame), piercePath: piercePathFor(frame) },
        ],
      });
    }

    for (const host of queryAll(root, "*")) {
      if (results.length >= wanted) break;
      if (host.shadowRoot) collect(host.shadowRoot, context);
    }
  }

  collect(document, { framePath: [] });
  return results.slice(offset, wanted).filter(Boolean);
}

function pruneSnapshotCache() {
  const now = Date.now();
  for (const [key, entry] of snapshotCache.entries()) {
    if (now - entry.createdAt > 5 * 60 * 1000) snapshotCache.delete(key);
  }
  while (snapshotCache.size > 20) {
    const oldest = [...snapshotCache.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
    if (!oldest) break;
    snapshotCache.delete(oldest[0]);
  }
}

function clearSnapshotsForTab(tabId) {
  for (const [key, entry] of snapshotCache.entries()) {
    if (Number(entry.tabId) === Number(tabId)) snapshotCache.delete(key);
  }
}

function resolveCachedTarget(tabId, target, snapshotId) {
  if (!target || !String(target).startsWith("@e")) return { target };
  const index = Number(String(target).slice(2)) - 1;
  if (!Number.isInteger(index) || index < 0) return { target };

  const candidates = snapshotId
    ? [snapshotCache.get(snapshotId)].filter(Boolean)
    : [...snapshotCache.values()].filter((entry) => Number(entry.tabId) === Number(tabId)).sort((a, b) => b.createdAt - a.createdAt);

  for (const entry of candidates) {
    const element = entry.elements[index];
    if (element) return { target: element.selector, element };
  }
  return { target };
}

async function click(args) {
  const tabId = await getActiveTabId(args.tabId);
  const resolved = resolveCachedTarget(tabId, args.target, args.snapshotId || args.sessionKey);

  // #3 页面就绪检测：操作前等待页面 readyState 与资源加载完成
  await waitForPageReady(tabId);

  // #5 导航检测：记录操作前页面状态
  const preState = await getPageState(tabId);

  let { result, resolved: finalResolved, navigationLikely } = await performClick(tabId, args, resolved);

  // #5 导航检测：操作后对比 URL/readyState，若发生导航则等待新页面就绪
  const navigated = navigationLikely || (await detectAndWaitForNavigation(tabId, preState));

  // #4 @e 引用容错：若元素未找到，自动重新快照并按 selector/text 重新匹配后重试一次
  if (result.ok === false && result.error && result.error.includes("未找到元素")) {
    const retry = await retryActionAfterResnapshot(tabId, args, resolved, "click");
    if (retry) {
      const retryNavigated = retry.navigationLikely || (await detectAndWaitForNavigation(tabId, preState));
      if (retry.result.ok === false) throw new Error(retry.result.error || `点击失败: ${args.target}`);
      return {
        clicked: true,
        target: args.target,
        selector: retry.result.selector || retry.resolved.target,
        element: retry.resolved.element,
        navigationLikely: retryNavigated || navigated,
        reSnapshotted: true,
        snapshotId: retry.snapshotId,
      };
    }
    throw new Error(`${result.error}。已尝试自动重新快照但仍无法定位。请重新执行 browser_snapshot 获取最新页面状态。`);
  }

  if (result.ok === false) throw new Error(result.error || `点击失败: ${args.target}`);
  return {
    clicked: true,
    target: args.target,
    selector: result.selector || finalResolved.target,
    element: finalResolved.element,
    navigationLikely: navigated,
  };
}

function buildClickScript(payload) {
  return `(async function() {
  ${BROWSER_RUNTIME_HELPERS}
  const result = await (async function(payload) {
    const { target, element, action, waitMs } = payload || {};
    const found = findActionElement(target, element);
    const el = found && found.el;
    if (!el) return { ok: false, error: "未找到元素: " + (target || element?.ref || "") };
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return { ok: false, error: "元素不可见: " + target };
    if (el.disabled || el.getAttribute("aria-disabled") === "true") return { ok: false, error: "元素已禁用: " + target };
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    await nextFrame();
    if (typeof el.focus === "function") el.focus({ preventScroll: true });
    const clickAction = action || "click";
    if (clickAction === "click") {
      el.click();
    } else {
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const eventInit = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, screenX: window.screenX + cx, screenY: window.screenY + cy };
      if (clickAction === "dblclick") {
        el.dispatchEvent(new MouseEvent("click", eventInit));
        el.dispatchEvent(new MouseEvent("click", eventInit));
        el.dispatchEvent(new MouseEvent("dblclick", eventInit));
      } else if (clickAction === "contextmenu") {
        el.dispatchEvent(new MouseEvent("contextmenu", eventInit));
      } else if (clickAction === "mousedown") {
        el.dispatchEvent(new MouseEvent("mousedown", eventInit));
      } else if (clickAction === "mouseup") {
        el.dispatchEvent(new MouseEvent("mouseup", eventInit));
      } else {
        return { ok: false, error: "不支持的点击动作: " + clickAction };
      }
    }
    await waitForDomSettled(waitMs, el.ownerDocument);
    return { ok: true, selector: found.selector, action: clickAction };
  })(${JSON.stringify(payload)});
  return result;
})()`;
}

async function fill(args) {
  const tabId = await getActiveTabId(args.tabId);
  const resolved = resolveCachedTarget(tabId, args.target, args.snapshotId || args.sessionKey);

  // #3 页面就绪检测：操作前等待页面 readyState 与资源加载完成
  await waitForPageReady(tabId);

  // #5 导航检测：记录操作前页面状态
  const preState = await getPageState(tabId);

  let { result, resolved: finalResolved, navigationLikely } = await performFill(tabId, args, resolved);

  // #5 导航检测：操作后对比 URL/readyState，若发生导航则等待新页面就绪
  const navigated = navigationLikely || (await detectAndWaitForNavigation(tabId, preState));

  // #4 @e 引用容错：若元素未找到，自动重新快照并按 selector/text 重新匹配后重试一次
  if (result.ok === false && result.error && result.error.includes("未找到元素")) {
    const retry = await retryActionAfterResnapshot(tabId, args, resolved, "fill");
    if (retry) {
      const retryNavigated = retry.navigationLikely || (await detectAndWaitForNavigation(tabId, preState));
      if (retry.result.ok === false) throw new Error(retry.result.error || `填充失败: ${args.target}`);
      return {
        filled: true,
        target: args.target,
        selector: retry.result.selector || retry.resolved.target,
        element: retry.resolved.element,
        navigationLikely: retryNavigated || navigated,
        reSnapshotted: true,
        snapshotId: retry.snapshotId,
      };
    }
    throw new Error(`${result.error}。已尝试自动重新快照但仍无法定位。请重新执行 browser_snapshot 获取最新页面状态。`);
  }

  if (result.ok === false) throw new Error(result.error || `填充失败: ${args.target}`);
  return {
    filled: true,
    target: args.target,
    selector: result.selector || finalResolved.target,
    element: finalResolved.element,
    navigationLikely: navigated,
  };
}

function buildFillScript(payload) {
  return `(async function() {
  ${BROWSER_RUNTIME_HELPERS}
  function setNativeValue(el, nextValue) {
    const proto =
      el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype :
      el instanceof HTMLInputElement ? HTMLInputElement.prototype :
      null;
    const setter = proto && Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, nextValue);
    else el.value = nextValue;
  }
  const result = await (async function(payload) {
    const { target, element, value, clear, append, selectBy, waitMs } = payload || {};
    const found = findActionElement(target, element);
    const el = found && found.el;
    if (!el) return { ok: false, error: "未找到元素: " + target };
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    await nextFrame();
    if (typeof el.focus === "function") el.focus({ preventScroll: true });
    if (el instanceof HTMLSelectElement) {
      const by = selectBy || "value";
      if (by === "index") {
        const idx = Number(value);
        if (Number.isInteger(idx) && idx >= 0 && idx < el.options.length) {
          el.selectedIndex = idx;
        } else {
          return { ok: false, error: "无效的选项索引: " + value };
        }
      } else if (by === "text") {
        const needle = String(value || "").trim();
        const option = Array.from(el.options).find((o) => (o.text || "").trim() === needle) ||
                       Array.from(el.options).find((o) => (o.text || "").trim().toLowerCase() === needle.toLowerCase());
        if (!option) return { ok: false, error: "未找到选项文本: " + value };
        el.value = option.value;
      } else {
        el.value = value;
        if (el.value !== value && Array.from(el.options).every((o) => o.value !== value)) {
          return { ok: false, error: "未找到选项 value: " + value };
        }
      }
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } else if ("value" in el) {
      if (clear) setNativeValue(el, "");
      setNativeValue(el, append ? (el.value || "") + value : value);
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } else if (el.isContentEditable) {
      if (!append) el.textContent = "";
      el.textContent = (el.textContent || "") + value;
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      return { ok: false, error: "元素不可输入: " + target };
    }
    await waitForDomSettled(waitMs, el.ownerDocument);
    return { ok: true, selector: found.selector };
  })(${JSON.stringify(payload)});
  return result;
})()`;
}

async function drag(args) {
  const tabId = await getActiveTabId(args.tabId);
  const sourceResolved = resolveCachedTarget(tabId, args.source, args.snapshotId || args.sessionKey);
  const targetResolved = resolveCachedTarget(tabId, args.target, args.snapshotId || args.sessionKey);

  await waitForPageReady(tabId);

  const expression = buildDragScript({
    source: sourceResolved.target,
    sourceElement: sourceResolved.element,
    target: targetResolved.target,
    targetElement: targetResolved.element,
    waitMs: config.waitAfterActionMs,
  });

  try {
    const resp = await cdp(tabId, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    const result = resp.result?.value || resp.value || {};
    if (result.ok === false) throw new Error(result.error || `拖拽失败: ${args.source} -> ${args.target}`);
    return { dragged: true, source: args.source, target: args.target };
  } catch (error) {
    if (!isNavigationTransientError(error)) throw error;
    await sleep(Math.max(100, config.waitAfterActionMs));
    return { dragged: true, source: args.source, target: args.target, navigationLikely: true };
  }
}

function buildDragScript(payload) {
  return `(async function() {
  ${BROWSER_RUNTIME_HELPERS}
  const result = await (async function(payload) {
    const { source, sourceElement, target, targetElement, waitMs } = payload || {};
    const foundSource = findActionElement(source, sourceElement);
    const foundTarget = findActionElement(target, targetElement);
    const src = foundSource && foundSource.el;
    const dst = foundTarget && foundTarget.el;
    if (!src) return { ok: false, error: "未找到源元素: " + (source || sourceElement?.ref || "") };
    if (!dst) return { ok: false, error: "未找到目标元素: " + (target || targetElement?.ref || "") };
    src.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    dst.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    await nextFrame();

    function makeEvent(type, x, y, dataTransfer) {
      return new DragEvent(type, {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: x,
        clientY: y,
        screenX: x,
        screenY: y,
        dataTransfer: dataTransfer || new DataTransfer(),
      });
    }

    const srcRect = src.getBoundingClientRect();
    const dstRect = dst.getBoundingClientRect();
    const srcX = srcRect.left + srcRect.width / 2;
    const srcY = srcRect.top + srcRect.height / 2;
    const dstX = dstRect.left + dstRect.width / 2;
    const dstY = dstRect.top + dstRect.height / 2;
    const dt = new DataTransfer();

    src.dispatchEvent(makeEvent("dragstart", srcX, srcY, dt));
    await nextFrame();
    dst.dispatchEvent(makeEvent("dragenter", dstX, dstY, dt));
    await nextFrame();
    dst.dispatchEvent(makeEvent("dragover", dstX, dstY, dt));
    await nextFrame();
    dst.dispatchEvent(makeEvent("drop", dstX, dstY, dt));
    await nextFrame();
    src.dispatchEvent(makeEvent("dragend", dstX, dstY, dt));
    await waitForDomSettled(waitMs, dst.ownerDocument);
    return { ok: true };
  })(${JSON.stringify(payload)});
  return result;
})()`;
}

async function upload(args) {
  const tabId = await getActiveTabId(args.tabId);
  await waitForPageReady(tabId);

  const target = args.target || args.selector;
  const resolved = resolveCachedTarget(tabId, target, args.snapshotId || args.sessionKey);
  const selector = resolved.target || target;
  if (!selector) throw new Error("无效的文件输入选择器");

  const filePath = args.workDir ? path.resolve(args.workDir, args.filePath) : path.resolve(args.filePath);
  if (!fs.existsSync(filePath)) throw new Error(`文件不存在: ${filePath}`);

  // 通过 CDP DOM 域定位 input[type=file] 并设置文件列表
  const docResp = await cdp(tabId, "DOM.getDocument", {});
  const rootNodeId = docResp.root?.nodeId;
  if (!rootNodeId) throw new Error("无法获取页面 DOM 根节点");

  const queryResp = await cdp(tabId, "DOM.querySelector", { nodeId: rootNodeId, selector });
  const nodeId = queryResp.nodeId;
  if (!nodeId) throw new Error(`未找到文件输入元素: ${target}`);

  await cdp(tabId, "DOM.setFileInputFiles", { nodeId, files: [filePath] });
  return { uploaded: true, selector: target, filePath };
}

async function executeScript(args) {
  const tabId = await getActiveTabId(args.tabId);
  const resp = await cdp(tabId, "Runtime.evaluate", {
    expression: String(args.script || ""),
    returnByValue: true,
    awaitPromise: true,
  });
  if (resp.exceptionDetails) {
    throw new Error(resp.exceptionDetails.exception?.description || resp.exceptionDetails.text || "脚本执行失败");
  }
  return resp.result?.value ?? resp.result;
}

async function screenshot(args) {
  const tabId = await getActiveTabId(args.tabId);
  let params = { format: "png", fromSurface: true };

  if (args.target) {
    const resolved = resolveCachedTarget(tabId, args.target, args.snapshotId || args.sessionKey);
    const expression = buildElementRectScript({ target: resolved.target, element: resolved.element });
    const resp = await cdp(tabId, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    const rect = resp.result?.value || resp.value;
    if (!rect) throw new Error(`未找到截图元素: ${args.target}`);
    params.clip = { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 1 };
    params.captureBeyondViewport = true;
  } else if (args.fullPage) {
    const metrics = await cdp(tabId, "Page.getLayoutMetrics", {});
    const size = metrics.contentSize || metrics.result?.contentSize;
    if (size) {
      params.clip = { x: 0, y: 0, width: Math.ceil(size.width), height: Math.ceil(size.height), scale: 1 };
      params.captureBeyondViewport = true;
    }
  }

  const resp = await cdp(tabId, "Page.captureScreenshot", params, 60000);
  const base64Data = resp.data || resp.result?.data || resp.result || resp;
  if (typeof base64Data !== "string") throw new Error("截图响应格式异常");

  const fs = require("fs");
  const path = require("path");
  const filename = `browser-screenshot-${Date.now()}.png`;
  const workDir = args.workDir || require("os").tmpdir();
  const filepath = path.join(workDir, filename);
  fs.writeFileSync(filepath, Buffer.from(base64Data, "base64"));

  const result = { path: filepath, filename };
  if (args.returnDataUrl === true) result.dataUrl = `data:image/png;base64,${base64Data}`;
  return result;
}

function buildElementRectScript(payload) {
  return `(async function() {
  ${BROWSER_RUNTIME_HELPERS}
  function absoluteRect(el) {
    const rect = el.getBoundingClientRect();
    let x = rect.x;
    let y = rect.y;
    let win = el.ownerDocument.defaultView;
    while (win && win !== window) {
      const frame = win.frameElement;
      if (!frame) break;
      const frameRect = frame.getBoundingClientRect();
      x += frameRect.x;
      y += frameRect.y;
      win = win.parent;
    }
    return { x, y, width: rect.width, height: rect.height };
  }
  const target = ${JSON.stringify(payload?.target ?? null)};
  const element = ${JSON.stringify(payload?.element ?? null)};
  const el = findActionElement(target, element)?.el || (function() {
    const doc = resolveFrameDocument(element?.framePath) || document;
    const selectors = [];
    if (Array.isArray(element?.selectors)) selectors.push(...element.selectors);
    if (target && !String(target).startsWith("@e")) selectors.unshift(target);
    for (const selector of selectors.filter(Boolean)) {
      const found = deepQuerySelector(doc, selector);
      if (found) return found;
    }
    // 文本匹配回退
    const needle = String(element?.text || "").trim().replace(/\\s+/g, " ").toLowerCase();
    if (needle) {
      const byText = deepQuerySelectorAll(doc, interactiveSelector()).find((el) => {
        const t = textFor(el);
        return t === needle || (needle.length > 4 && t.includes(needle));
      });
      if (byText) return byText;
    }
    // bbox 坐标回退
    if (element?.bbox) {
      const x = Number(element.bbox.centerX);
      const y = Number(element.bbox.centerY);
      if (Number.isFinite(x) && Number.isFinite(y)) {
        let el = deepElementFromPoint(x, y);
        if (el) return el;
      }
    }
    return null;
  })();
  if (!el) return null;
  el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  const rect = absoluteRect(el);
  const scrollX = window.scrollX || document.documentElement.scrollLeft || 0;
  const scrollY = window.scrollY || document.documentElement.scrollTop || 0;
  return {
    x: Math.max(0, rect.x + scrollX),
    y: Math.max(0, rect.y + scrollY),
    width: Math.max(1, rect.width),
    height: Math.max(1, rect.height),
  };
})()`;
}

async function networkMonitor(args) {
  const tabId = await getActiveTabId(args.tabId);
  const action = args.action || "list";
  const map = {
    start: "networkStart",
    list: "networkList",
    detail: "networkDetail",
    clear: "networkClear",
    stop: "networkStop",
  };
  const cmd = map[action];
  if (!cmd) throw new Error(`未知网络监控操作: ${action}`);
  return await sendToExtension(cmd, { tabId, ...args });
}

async function consoleMonitor(args) {
  const tabId = await getActiveTabId(args.tabId);
  const action = args.action || "list";
  const map = {
    start: "consoleStart",
    list: "consoleList",
    clear: "consoleClear",
    stop: "consoleStop",
  };
  const cmd = map[action];
  if (!cmd) throw new Error(`未知控制台监控操作: ${action}`);
  return await sendToExtension(cmd, { tabId, ...args });
}

async function syncExtensionPort(port = config.wsPort) {
  const normalized = normalizePort(port, config.wsPort);
  return await sendToExtension("setPort", { port: normalized }, 10000);
}

async function clearDebugSessions() {
  return await sendToExtension("debugClearAll", {}, 10000);
}

function getStatus() {
  const wsConnected = extensionWs && extensionWs.readyState === WebSocket.OPEN;
  return {
    ok: true,
    connected: Boolean(wsConnected && extensionInfo),
    ports: { extension: config.wsPort, api: config.apiPort },
    config: { ...config },
    httpApiEnabled: config.enableHttpApi,
    pendingRequests: pendingRequests.size,
    snapshotCacheSize: snapshotCache.size,
    extension: extensionInfo,
    lastCommandAt,
    lastError,
    tabs: lastTabs,
  };
}

function register(ipcMain) {
  startServices();

  ipcMain.handle("browser-use:call", async (_event, params) => {
    try {
      const result = await handleCommand(params);
      return { ok: true, result };
    } catch (error) {
      lastError = error.message;
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle("browser-use:status", async () => getStatus());

  ipcMain.handle("browser-use:configure", async (_event, nextConfig) => {
    const current = { ...config };
    const normalized = normalizeConfig(nextConfig || {});
    const mustRestart =
      normalized.wsPort !== current.wsPort ||
      normalized.apiPort !== current.apiPort ||
      normalized.enableHttpApi !== current.enableHttpApi;
    config = normalized;
    if (mustRestart) return await restartServices();
    return getStatus();
  });

  ipcMain.handle("browser-use:restart", async () => restartServices());

  ipcMain.handle("browser-use:sync-extension-port", async (_event, payload) => {
    try {
      const result = await syncExtensionPort(payload?.port);
      return { ok: true, result };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle("browser-use:clear-debug-sessions", async () => {
    try {
      const result = await clearDebugSessions();
      return { ok: true, result };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle("browser-use:export-extension", async () => {
    try {
      const result = await dialog.showOpenDialog({
        title: "选择扩展导出位置",
        properties: ["openDirectory", "createDirectory"],
        buttonLabel: "导出到此处",
      });

      if (result.canceled || !result.filePaths[0]) {
        return { ok: false, error: "用户取消" };
      }

      const targetDir = result.filePaths[0];
      const extensionName = "PolarAgent-BrowserUse";
      const exportPath = path.join(targetDir, extensionName);

      // 检查目标目录是否已存在
      if (fs.existsSync(exportPath)) {
        const confirmResult = await dialog.showMessageBox({
          type: "warning",
          title: "目录已存在",
          message: `目录 "${extensionName}" 已存在，是否覆盖？`,
          buttons: ["取消", "覆盖"],
          defaultId: 0,
          cancelId: 0,
        });

        if (confirmResult.response === 0) {
          return { ok: false, error: "用户取消" };
        }

        // 删除已存在的目录
        fs.rmSync(exportPath, { recursive: true, force: true });
      }

      // 获取源目录路径
      const sourcePath = app.isPackaged
        ? path.join(process.resourcesPath, "resources", "builtin", "browser-extension")
        : path.join(app.getAppPath(), "resources", "builtin", "browser-extension");

      if (!fs.existsSync(sourcePath)) {
        return { ok: false, error: `扩展源目录不存在: ${sourcePath}` };
      }

      // 复制目录
      copyDirRecursive(sourcePath, exportPath);

      return { ok: true, path: exportPath };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });
}

function copyDirRecursive(src, dest) {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }

  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

app.on("will-quit", () => {
  void stopServices();
});

module.exports = { register };
