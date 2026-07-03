// Widget Sandbox 组件 -- 提供 iframe 隔离环境并处理双向通信
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { WidgetEventMessage, WidgetUpdateMode } from "@/types/widget";

interface WidgetSandboxProps {
  widgetId: string;
  html: string;
  data?: Record<string, unknown>;
  updateMode?: WidgetUpdateMode;
  onEvent?: (message: WidgetEventMessage) => void;
}

// 沙箱属性：仅允许脚本执行，刻意不携带 allow-same-origin。
// 关键安全说明：HTML 规范明确，当 iframe 同时具有 allow-scripts 与
// allow-same-origin 时，iframe 与父文档同源，可读写父窗口的
// localStorage/sessionStorage/cookie/document.cookie，并能通过
// window.parent 调用宿主暴露的 IPC 对象（如 window.polaragent.*），
// 这相当于无沙箱。仅保留 allow-scripts 时，iframe 走 opaque origin，
// 无法访问父 origin 资源，widget 内联脚本即便被注入也无法越权。
// 参考：OWASP / Electron 安全文档 "Don't enable both allow-scripts
// and allow-same-origin"。
const SANDBOX_ATTR = "allow-scripts";
const MIN_WIDGET_HEIGHT = 56;
const HOST_RESIZE_MESSAGE = "WIDGET_HOST_RESIZE";
const HOST_RESIZE_RETRY_INTERVAL_MS = 120;
// host resize retry 上限：原 20 次 × 120ms = 2.4 秒后停。但中文字体加载、
// SVG 异步布局、widget IIFE 修改 DOM 等延迟可能 > 2.4 秒，导致 host 早停后
// widget 真实高度已增加但无人问询。提升到 60 次 × 120ms ≈ 7.2 秒，且改为
// 与「连续 N 次无增长」组合判断（见 scheduleHostResizeRetry 的 stableStreak），
// 避免 host 在 widget 仍在增高时彻底退出。
const HOST_RESIZE_RETRY_LIMIT = 60;
const HOST_RESIZE_STABLE_STREAK_LIMIT = 6;
const WIDGET_THEME_TOKENS_CSS = `
:root {
  color-scheme: light dark;
  --widget-fg: #202421;
  --widget-muted: #858b86;
  --widget-border: #e5e7eb;
  --widget-card: #ffffff;
  --widget-surface: #f5f5f7;
  --widget-tint: #f1eafb;
  --widget-accent: #9b6fe0;
  --widget-accent-strong: #5b3a9e;
  --widget-button: #5b3a9e;
  --widget-button-hover: #4f3289;
  --widget-button-fg: #ffffff;
}
@media (prefers-color-scheme: dark) {
  :root {
    --widget-fg: #ededed;
    --widget-muted: #9e9e9e;
    --widget-border: #2e2e2e;
    --widget-card: #1a1a1a;
    --widget-surface: #232326;
    --widget-tint: #2e2342;
    --widget-accent: #b898f0;
    --widget-accent-strong: #c9aef5;
    --widget-button: #b898f0;
    --widget-button-hover: #c9aef5;
    --widget-button-fg: #140f1d;
  }
}
`;
const WIDGET_BASE_CSS = `
${WIDGET_THEME_TOKENS_CSS}
*, *::before, *::after { box-sizing: border-box; }
/* 注意：body 用 overflow:hidden 是 widget 内最深层防滚动条。
   iframe 自身 scrolling="no" + overflow:hidden 是「视口层」，
   body overflow:hidden 是「内容层」——双层防滚动，冗余但稳。
   之前曾把 body 改 visible 试图让 scrollHeight 上报准确，但实测会引入
   widget 内部滚动条（content overflow 触发浏览器 fallback 渲染）且并未真正修高度。
   高度精度由父端 syncFrameHeight 的 HEIGHT_BUFFER 缓冲兜底，
   无需让 body overflow:visible 才能拿到准确上报值。 */
html, body { width: 100%; min-height: 100%; margin: 0; padding: 0; overflow: hidden; }
body {
  font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
  font-size: 14px;
  line-height: 1.55;
  color: var(--widget-fg);
  background: transparent;
}
/* widget 根节点不再额外加底部 padding。
   widget 的下方留白由 widget_card 模板内的 padding 控制（各模板自己 16px），
   高度精度问题由 syncFrameHeight 的 HEIGHT_BUFFER 缓冲兜底，
   避免双重底部留白让 widget 看上去空旷。 */
#widget-root {
  display: block;
  width: 100%;
}
table { border-collapse: collapse; width: 100%; }
th, td { border: 1px solid var(--widget-border); padding: 8px 12px; text-align: left; }
th { background: var(--widget-surface); color: var(--widget-muted); font-weight: 600; }
input, select, textarea, button { font-family: inherit; font-size: inherit; }
input, select, textarea {
  width: 100%;
  border: 1px solid var(--widget-border);
  border-radius: 8px;
  padding: 8px 10px;
  color: var(--widget-fg);
  background: var(--widget-card);
}
button {
  border: none;
  border-radius: 8px;
  padding: 8px 14px;
  cursor: pointer;
  background: var(--widget-button);
  color: var(--widget-button-fg);
  font-weight: 600;
}
button:hover { background: var(--widget-button-hover); }
:where(button, input, select, textarea, [role="button"], [tabindex]):focus-visible {
  outline: 2px solid var(--widget-accent);
  outline-offset: 2px;
}
svg { display: inline-block; vertical-align: middle; }
`;
const WIDGET_HOST_TOKEN_OVERRIDE_CSS = `${WIDGET_THEME_TOKENS_CSS}`;

type FormStateItem =
  | { key: string; tag: "input"; inputType: string; value: string; checked: boolean }
  | { key: string; tag: "textarea"; value: string }
  | { key: string; tag: "select"; value: string };

function serializeForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function widgetContentSignature(
  widgetId: string,
  html: string,
  data: Record<string, unknown>,
  updateMode: WidgetUpdateMode,
): string {
  return JSON.stringify({ widgetId, html, data, updateMode });
}

function stripUnsafeWidgetTags(rawHtml: string): string {
  return rawHtml
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, "")
    .replace(/<object\b[^>]*>[\s\S]*?<\/object>/gi, "")
    .replace(/<embed\b[^>]*\/?>/gi, "")
    .replace(/<base\b[^>]*\/?>/gi, "")
    .replace(/<link\b[^>]*\/?>/gi, "")
    .replace(/<script\b[^>]*\bsrc\s*=\s*(?:\"[^\"]*\"|'[^']*')[^>]*>[\s\S]*?<\/script>/gi, "");
}

function extractWidgetBodyHtml(rawHtml: string): string {
  const cleanedHtml = stripUnsafeWidgetTags(rawHtml);
  const bodyMatch = cleanedHtml.match(/<body\b[^>]*>([\s\S]*)<\/body>/i);
  return bodyMatch ? bodyMatch[1] : cleanedHtml;
}

function sanitizeWidgetHtmlForMeasurement(rawHtml: string): string {
  const withoutScripts = extractWidgetBodyHtml(rawHtml).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");

  if (typeof DOMParser === "undefined") {
    return withoutScripts.replace(/\son[a-z-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  }

  try {
    const doc = new DOMParser().parseFromString(withoutScripts, "text/html");
    for (const element of Array.from(doc.body.querySelectorAll("*"))) {
      for (const attribute of Array.from(element.attributes)) {
        if (/^on/i.test(attribute.name)) {
          element.removeAttribute(attribute.name);
        }
      }
    }
    return doc.body.innerHTML;
  } catch {
    return withoutScripts.replace(/\son[a-z-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  }
}

function extractWidgetHeadStyleCss(rawHtml: string): string {
  const cleanedHtml = stripUnsafeWidgetTags(rawHtml);
  const headMatch = cleanedHtml.match(/<head\b[^>]*>([\s\S]*)<\/head>/i);
  if (!headMatch) return "";

  const headHtml = headMatch[1];
  if (typeof DOMParser !== "undefined") {
    try {
      const doc = new DOMParser().parseFromString(`<html><head>${headHtml}</head><body></body></html>`, "text/html");
      return Array.from(doc.head.querySelectorAll("style"))
        .map((style) => style.textContent ?? "")
        .join("\n");
    } catch {
      // fall through to regex extraction
    }
  }

  const chunks: string[] = [];
  headHtml.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (_match, css: string) => {
    chunks.push(css);
    return "";
  });
  return chunks.join("\n");
}

function measureVisualBottom(root: Element | null): number {
  if (!root) return 0;

  const rootRect = root.getBoundingClientRect();
  if (!Number.isFinite(rootRect.top) || !Number.isFinite(rootRect.bottom)) {
    return 0;
  }

  const view = root.ownerDocument.defaultView;
  let maxBottom = Math.ceil(rootRect.height);
  for (const element of Array.from(root.querySelectorAll("*"))) {
    if (view?.getComputedStyle(element).position === "fixed") continue;
    const rect = element.getBoundingClientRect();
    if (!Number.isFinite(rect.top) || !Number.isFinite(rect.bottom)) continue;
    maxBottom = Math.max(maxBottom, Math.ceil(rect.bottom - rootRect.top));
  }
  return maxBottom;
}

function measureWidgetFallbackHeight(rawHtml: string, width: number): number | null {
  if (typeof document === "undefined" || width <= 0) return null;

  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.tabIndex = -1;
  iframe.style.position = "absolute";
  iframe.style.left = "-100000px";
  iframe.style.top = "0";
  iframe.style.width = `${Math.ceil(width)}px`;
  iframe.style.height = "1px";
  iframe.style.visibility = "hidden";
  iframe.style.pointerEvents = "none";
  iframe.style.overflow = "hidden";
  iframe.style.border = "0";
  iframe.style.zIndex = "-1";
  document.body.appendChild(iframe);

  const doc = iframe.contentDocument;
  if (!doc) {
    iframe.remove();
    return null;
  }

  const measurementCss = [
    WIDGET_BASE_CSS,
    // fallback 只关心固有内容高度，不要让 html/body 的 min-height 跟 iframe 视口绑定。
    "html, body { min-height: 0 !important; height: auto !important; overflow: visible !important; }",
    "body { margin: 0 !important; }",
    extractWidgetHeadStyleCss(rawHtml),
    WIDGET_HOST_TOKEN_OVERRIDE_CSS,
  ].join("\n");

  doc.open();
  doc.write(`<!DOCTYPE html><html lang=zh-CN><head><meta charset=\"UTF-8\"><style>${measurementCss}</style></head><body><div id=widget-root>${sanitizeWidgetHtmlForMeasurement(rawHtml)}</div></body></html>`);
  doc.close();

  const body = doc.body;
  const root = doc.getElementById("widget-root");
  const bodyRect = body?.getBoundingClientRect();
  const rootRect = root?.getBoundingClientRect();
  const measuredHeight = Math.max(
    MIN_WIDGET_HEIGHT,
    body?.scrollHeight ?? 0,
    body?.offsetHeight ?? 0,
    bodyRect ? Math.ceil(bodyRect.height) : 0,
    measureVisualBottom(body),
    root?.scrollHeight ?? 0,
    root?.offsetHeight ?? 0,
    rootRect ? Math.ceil(rootRect.height) : 0,
    measureVisualBottom(root),
  );

  iframe.remove();
  return Number.isFinite(measuredHeight) ? measuredHeight : null;
}

function buildSandboxDocument(
  rawHtml: string,
  widgetId: string,
  data: Record<string, unknown>,
  formState: FormStateItem[],
): string {
  const cspParts = [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    "connect-src 'none'",
    "frame-src 'none'",
    "child-src 'none'",
    "img-src data:",
    "font-src 'none'",
    "media-src 'none'",
    "object-src 'none'",
  ];
  const csp = cspParts.join("; ");

  const cleanedHtml = stripUnsafeWidgetTags(rawHtml);
  const bodyContent = extractWidgetBodyHtml(rawHtml);

  const headMatch = cleanedHtml.match(/<head\b[^>]*>([\s\S]*)<\/head>/i);
  const headContent = headMatch ? headMatch[1] : "";

  const serializedData = serializeForScript(data);
  const serializedFormState = serializeForScript(formState);

  return `<!DOCTYPE html>
<html lang=zh-CN>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content=${JSON.stringify(csp)}>
<style>
${WIDGET_BASE_CSS}
</style>
<script>
;(function() {
  var widgetId = ${JSON.stringify(widgetId)};
  var initialData = ${serializedData};
  var initialFormState = ${serializedFormState};
  var pendingDocumentHtml = null;
  var resizeBurstTimer = null;

  function extractBodyHtml(source) {
    var match = String(source || "").match(/<body\b[^>]*>([\s\S]*)<\/body>/i);
    return match ? match[1] : String(source || "");
  }

  function widgetRoot() {
    return document.getElementById("widget-root");
  }

  function applyPendingDocumentHtml() {
    var root = widgetRoot();
    if (!root || pendingDocumentHtml === null) return;
    root.innerHTML = extractBodyHtml(pendingDocumentHtml);
    pendingDocumentHtml = null;
  }

  function stateKey(element, index) {
    return [
      element.tagName.toLowerCase(),
      element.id || "",
      element.getAttribute("name") || "",
      element.getAttribute("data-widget-key") || "",
      String(index)
    ].join("::");
  }

  function captureFormState() {
    return Array.from(document.querySelectorAll("input, textarea, select")).map(function(element, index) {
      var key = stateKey(element, index);
      if (element instanceof HTMLInputElement) {
        return {
          key: key,
          tag: "input",
          inputType: element.type,
          value: element.value,
          checked: element.checked,
        };
      }
      if (element instanceof HTMLTextAreaElement) {
        return {
          key: key,
          tag: "textarea",
          value: element.value,
        };
      }
      return {
        key: key,
        tag: "select",
        value: element.value,
      };
    });
  }

  function restoreFormState(state) {
    var byKey = new Map((state || []).map(function(item) { return [item.key, item]; }));
    Array.from(document.querySelectorAll("input, textarea, select")).forEach(function(element, index) {
      var saved = byKey.get(stateKey(element, index));
      if (!saved) return;
      if (element instanceof HTMLInputElement && saved.tag === "input") {
        if (saved.inputType === "checkbox" || saved.inputType === "radio") {
          element.checked = !!saved.checked;
        } else {
          element.value = saved.value || "";
        }
        return;
      }
      if (element instanceof HTMLTextAreaElement && saved.tag === "textarea") {
        element.value = saved.value || "";
        return;
      }
      if (element instanceof HTMLSelectElement && saved.tag === "select") {
        element.value = saved.value || "";
      }
    });
  }

  function post(message) {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage(Object.assign({ widgetId: widgetId, timestamp: Date.now() }, message), "*");
    }
  }

  function measureVisualBottom(rootEl) {
    if (!rootEl) return 0;
    var rootRect = rootEl.getBoundingClientRect();
    if (!isFinite(rootRect.top) || !isFinite(rootRect.bottom)) return 0;
    var maxBottom = Math.ceil(rootRect.height);
    var elements = rootEl.querySelectorAll("*");
    for (var i = 0; i < elements.length; i += 1) {
      var el = elements[i];
      if (window.getComputedStyle && window.getComputedStyle(el).position === "fixed") continue;
      var rect = el.getBoundingClientRect();
      if (!isFinite(rect.top) || !isFinite(rect.bottom)) continue;
      maxBottom = Math.max(maxBottom, Math.ceil(rect.bottom - rootRect.top));
    }
    return maxBottom;
  }

  function emitResize() {
    var root = document.documentElement;
    var body = document.body;
    var widget = widgetRoot();
    var bodyRect = body ? body.getBoundingClientRect() : null;
    var rootRect = root ? root.getBoundingClientRect() : null;
    var widgetRect = widget ? widget.getBoundingClientRect() : null;
    var nextHeight = Math.max(
      ${MIN_WIDGET_HEIGHT},
      body ? body.scrollHeight : 0,
      body ? body.offsetHeight : 0,
      bodyRect ? Math.ceil(bodyRect.height) : 0,
      body ? measureVisualBottom(body) : 0,
      root ? root.scrollHeight : 0,
      root ? root.offsetHeight : 0,
      rootRect ? Math.ceil(rootRect.height) : 0,
      widget ? widget.scrollHeight : 0,
      widget ? widget.offsetHeight : 0,
      widgetRect ? Math.ceil(widgetRect.height) : 0,
      widget ? measureVisualBottom(widget) : 0
    );
    post({ type: "WIDGET_RESIZE", height: nextHeight });
  }

  function emitState() {
    post({ type: "WIDGET_STATE", state: captureFormState() });
  }

  function syncWidgetFrame() {
    emitState();
    emitResize();
  }

  function scheduleSyncBurst() {
    syncWidgetFrame();
    requestAnimationFrame(syncWidgetFrame);
    // 短窗 burst（32~420ms）：覆盖首屏布局稳定、SVG 第一帧渲染、widget 内 IIFE 改 DOM。
    window.setTimeout(syncWidgetFrame, 32);
    window.setTimeout(syncWidgetFrame, 96);
    window.setTimeout(syncWidgetFrame, 220);
    // 长窗 burst（600~2000ms）：覆盖中文字体加载完 metric 切换、fonts.ready 二次重排、
    //   异步数据填充后 DOM 变化、SVG 渐进布局。原只到 420ms 不够，导致 widget 异步
    //   增高后 host 不再收到 WIDGET_RESIZE 上报，host frameHeight 锁在早期较小的值，
    //   表现就是「下方被截且不是固定值」。
    window.setTimeout(syncWidgetFrame, 600);
    window.setTimeout(syncWidgetFrame, 1000);
    window.setTimeout(syncWidgetFrame, 1500);
    window.setTimeout(syncWidgetFrame, 2000);
    if (resizeBurstTimer !== null) {
      window.clearTimeout(resizeBurstTimer);
    }
    resizeBurstTimer = window.setTimeout(function() {
      syncWidgetFrame();
      resizeBurstTimer = null;
    }, 3000);
  }

  function documentOpenShim() {
    pendingDocumentHtml = "";
    return document;
  }

  function documentWriteShim(content) {
    if (pendingDocumentHtml === null) {
      pendingDocumentHtml = "";
    }
    pendingDocumentHtml += String(content || "");
  }

  function documentCloseShim() {
    if (pendingDocumentHtml === null) return;
    applyPendingDocumentHtml();
    restoreFormState(initialFormState);
    scheduleSyncBurst();
  }

  document.open = documentOpenShim;
  document.write = documentWriteShim;
  document.close = documentCloseShim;
  try {
    if (window.Document && window.Document.prototype) {
      window.Document.prototype.open = documentOpenShim;
      window.Document.prototype.write = documentWriteShim;
      window.Document.prototype.close = documentCloseShim;
    }
  } catch (_error) {
    // 某些环境下原型方法不可写；忽略即可，至少保证尺寸同步脚本继续运行。
  }

  window.__WIDGET_ID__ = widgetId;
  window.__WIDGET_DATA__ = initialData;
  window.__WIDGET_EVENT = function(type, payload) {
    post({ type: "WIDGET_EVENT", event: type, data: payload });
  };
  window.__WIDGET_ON_UPDATE__ = function(message) {
    var root = widgetRoot();
    if (!root) return;
    if (typeof message.html === "string") {
      root.innerHTML = extractBodyHtml(message.html);
    }
    if (message && message.data && typeof message.data === "object") {
      window.__WIDGET_DATA__ = message.data;
    }
    restoreFormState(initialFormState);
    scheduleSyncBurst();
  };

  window.addEventListener("message", function(e) {
    if (e.data && e.data.type === ${JSON.stringify(HOST_RESIZE_MESSAGE)} && e.data.widgetId === widgetId) {
      scheduleSyncBurst();
      return;
    }
    if (!e.data || e.data.type !== "WIDGET_UPDATE" || e.data.widgetId !== widgetId) return;
    if (typeof window.__WIDGET_ON_UPDATE__ === "function") {
      window.__WIDGET_ON_UPDATE__(e.data);
    }
    scheduleSyncBurst();
  });

  document.addEventListener("input", syncWidgetFrame, true);
  document.addEventListener("change", syncWidgetFrame, true);
  window.addEventListener("resize", syncWidgetFrame);

  window.addEventListener("load", function() {
    applyPendingDocumentHtml();
    restoreFormState(initialFormState);
    scheduleSyncBurst();
  });

  if (typeof ResizeObserver === "function") {
    var observer = new ResizeObserver(function() {
      scheduleSyncBurst();
    });
    observer.observe(document.documentElement);
    if (document.body) {
      observer.observe(document.body);
    }
    if (widgetRoot()) {
      observer.observe(widgetRoot());
    }
  }

  if (typeof MutationObserver === "function") {
    var mutationObserver = new MutationObserver(function() {
      scheduleSyncBurst();
    });
    mutationObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });
  }

  if (document.fonts && typeof document.fonts.ready === "object") {
    document.fonts.ready.then(function() {
      scheduleSyncBurst();
    }).catch(function() {
      scheduleSyncBurst();
    });
  }
})();
<\/script>
${headContent}
<style>
${WIDGET_HOST_TOKEN_OVERRIDE_CSS}
</style>
</head>
<body>
<div id=widget-root>${bodyContent}</div>
</body>
</html>`;
}

export function WidgetSandbox({ widgetId, html, data = {}, updateMode = "replace", onEvent }: WidgetSandboxProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const mountedWidgetIdRef = useRef<string | null>(null);
  const contentSignatureRef = useRef<string | null>(null);
  const liveObserverCleanupRef = useRef<(() => void) | null>(null);
  const hostSyncTimersRef = useRef<number[]>([]);
  const hostRetryTimerRef = useRef<number | null>(null);
  const hostRetryCountRef = useRef(0);
  const lastObservedMeasurementWidthRef = useRef(0);
  // 记录 host retry 期间「lastMeasuredHeightRef 连续无增长」的次数：
  // 一次 tick 内若 lastMeasuredHeightRef 与上一次 tick 持平，streak++；
  // 否则 streak 归零。连续达到 HOST_RESIZE_STABLE_STREAK_LIMIT 才视为稳定、
  // 停止 retry。比单纯「>MIN 就立刻停」更稳，覆盖字体加载延迟、SVG 异步等场景。
  const hostRetryStableStreakRef = useRef(0);
  const lastTickMeasuredHeightRef = useRef(MIN_WIDGET_HEIGHT);
  const reportedHeightRef = useRef(MIN_WIDGET_HEIGHT);
  const fallbackHeightRef = useRef<number | null>(null);
  const liveHeightRef = useRef<number | null>(null);
  const lastMeasuredHeightRef = useRef(MIN_WIDGET_HEIGHT);
  const formStateRef = useRef<FormStateItem[]>([]);
  const [frameHeight, setFrameHeight] = useState(MIN_WIDGET_HEIGHT);
  const contentSignature = useMemo(
    () => widgetContentSignature(widgetId, html, data, updateMode),
    [widgetId, html, data, updateMode],
  );

  const srcDoc = useMemo(() => {
    const shouldPreserveState =
      updateMode === "patch" && mountedWidgetIdRef.current === widgetId;
    return buildSandboxDocument(
      html,
      widgetId,
      data,
      shouldPreserveState ? formStateRef.current : [],
    );
  }, [data, html, updateMode, widgetId]);

  useEffect(() => {
    const widgetChanged = mountedWidgetIdRef.current !== widgetId;
    const contentChanged = contentSignatureRef.current !== contentSignature;

    if (updateMode !== "patch" || widgetChanged) {
      formStateRef.current = [];
    }

    if (widgetChanged) {
      reportedHeightRef.current = MIN_WIDGET_HEIGHT;
      fallbackHeightRef.current = null;
      liveHeightRef.current = null;
      lastObservedMeasurementWidthRef.current = 0;
      hostRetryStableStreakRef.current = 0;
      lastTickMeasuredHeightRef.current = MIN_WIDGET_HEIGHT;
      lastMeasuredHeightRef.current = MIN_WIDGET_HEIGHT;
      setFrameHeight(MIN_WIDGET_HEIGHT);
    } else if (contentChanged) {
      setFrameHeight((current) => Math.max(current, lastMeasuredHeightRef.current, MIN_WIDGET_HEIGHT));
    }

    mountedWidgetIdRef.current = widgetId;
    contentSignatureRef.current = contentSignature;
  }, [contentSignature, updateMode, widgetId]);

  const clearHostSyncTimers = () => {
    for (const timer of hostSyncTimersRef.current) {
      window.clearTimeout(timer);
    }
    hostSyncTimersRef.current = [];
  };

  const clearHostResizeRetry = () => {
    if (hostRetryTimerRef.current !== null) {
      window.clearTimeout(hostRetryTimerRef.current);
      hostRetryTimerRef.current = null;
    }
  };

  const clearLiveContentObservers = () => {
    liveObserverCleanupRef.current?.();
    liveObserverCleanupRef.current = null;
  };

  const requestResizeSync = () => {
    iframeRef.current?.contentWindow?.postMessage(
      {
        type: HOST_RESIZE_MESSAGE,
        widgetId,
      },
      "*",
    );
  };

  const syncFrameHeight = () => {
    const rawHeight = Math.max(
      MIN_WIDGET_HEIGHT,
      reportedHeightRef.current,
      fallbackHeightRef.current ?? 0,
      liveHeightRef.current ?? 0,
    );
    // 动态缓冲：内容越高，缓冲越大，覆盖中文字体 metrics、SVG 异步布局等差异。
    const HEIGHT_BUFFER = Math.max(16, Math.ceil(rawHeight * 0.04));
    const nextHeight = rawHeight + HEIGHT_BUFFER;
    lastMeasuredHeightRef.current = nextHeight;
    setFrameHeight(nextHeight);
  };

  const getMeasurementWidth = () => {
    const iframe = iframeRef.current;
    if (!iframe) return 0;
    return Math.ceil(
      iframe.parentElement?.clientWidth ?? iframe.clientWidth ?? iframe.getBoundingClientRect().width,
    );
  };

  const syncFallbackMeasuredHeight = () => {
    const width = getMeasurementWidth();
    const measured = measureWidgetFallbackHeight(html, width);
    if (!measured || !Number.isFinite(measured)) return;
    fallbackHeightRef.current = measured;
    syncFrameHeight();
  };

  const measureLiveIframeHeight = () => {
    const iframe = iframeRef.current;
    const doc = iframe?.contentDocument;
    if (!iframe || !doc) return false;

    const root = doc.documentElement;
    const body = doc.body;
    const widget = doc.getElementById("widget-root");
    const rootRect = root?.getBoundingClientRect();
    const bodyRect = body?.getBoundingClientRect();
    const widgetRect = widget?.getBoundingClientRect();

    const nextHeight = Math.max(
      MIN_WIDGET_HEIGHT,
      root?.scrollHeight ?? 0,
      root?.offsetHeight ?? 0,
      rootRect ? Math.ceil(rootRect.height) : 0,
      measureVisualBottom(root),
      body?.scrollHeight ?? 0,
      body?.offsetHeight ?? 0,
      bodyRect ? Math.ceil(bodyRect.height) : 0,
      measureVisualBottom(body),
      widget?.scrollHeight ?? 0,
      widget?.offsetHeight ?? 0,
      widgetRect ? Math.ceil(widgetRect.height) : 0,
      measureVisualBottom(widget),
    );

    if (!Number.isFinite(nextHeight) || nextHeight <= 0) return false;
    liveHeightRef.current = nextHeight;
    syncFrameHeight();
    return true;
  };

  const attachLiveContentObservers = () => {
    clearLiveContentObservers();

    const doc = iframeRef.current?.contentDocument;
    if (!doc) return;

    const cleanup: Array<() => void> = [];
    const observeTargets: Element[] = [];
    if (doc.documentElement) observeTargets.push(doc.documentElement);
    if (doc.body) observeTargets.push(doc.body);
    const widgetRoot = doc.getElementById("widget-root");
    if (widgetRoot) observeTargets.push(widgetRoot);

    if (typeof ResizeObserver === "function" && observeTargets.length > 0) {
      const resizeObserver = new ResizeObserver(() => {
        void measureLiveIframeHeight();
      });
      for (const target of observeTargets) {
        resizeObserver.observe(target);
      }
      cleanup.push(() => resizeObserver.disconnect());
    }

    if (typeof MutationObserver === "function" && doc.documentElement) {
      const mutationObserver = new MutationObserver(() => {
        void measureLiveIframeHeight();
      });
      mutationObserver.observe(doc.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
      });
      cleanup.push(() => mutationObserver.disconnect());
    }

    if (doc.fonts && typeof doc.fonts.ready === "object") {
      doc.fonts.ready.then(() => {
        void measureLiveIframeHeight();
      }).catch(() => {
        void measureLiveIframeHeight();
      });
    }

    liveObserverCleanupRef.current = () => {
      for (const dispose of cleanup) {
        dispose();
      }
    };
  };

  const requestResizeSyncBurst = () => {
    clearHostSyncTimers();
    requestResizeSync();
    window.requestAnimationFrame(() => {
      requestResizeSync();
    });
    hostSyncTimersRef.current.push(window.setTimeout(requestResizeSync, 32));
    hostSyncTimersRef.current.push(window.setTimeout(requestResizeSync, 96));
    hostSyncTimersRef.current.push(window.setTimeout(requestResizeSync, 220));
  };

  const scheduleHostResizeRetry = () => {
    clearHostResizeRetry();
    hostRetryCountRef.current = 0;
    hostRetryStableStreakRef.current = 0;
    lastTickMeasuredHeightRef.current = MIN_WIDGET_HEIGHT;

    const tick = () => {
      if (hostRetryCountRef.current >= HOST_RESIZE_RETRY_LIMIT) {
        clearHostResizeRetry();
        return;
      }

      const currentMeasured = lastMeasuredHeightRef.current;
      if (currentMeasured <= lastTickMeasuredHeightRef.current) {
        hostRetryStableStreakRef.current += 1;
      } else {
        hostRetryStableStreakRef.current = 0;
      }
      lastTickMeasuredHeightRef.current = currentMeasured;

      if (hostRetryStableStreakRef.current >= HOST_RESIZE_STABLE_STREAK_LIMIT) {
        clearHostResizeRetry();
        return;
      }

      hostRetryCountRef.current += 1;
      requestResizeSyncBurst();
      hostRetryTimerRef.current = window.setTimeout(tick, HOST_RESIZE_RETRY_INTERVAL_MS);
    };

    hostRetryTimerRef.current = window.setTimeout(tick, HOST_RESIZE_RETRY_INTERVAL_MS);
  };

  useLayoutEffect(() => {
    function handleMessage(event: MessageEvent<unknown>) {
      // 安全说明：仅接受来自本 widget iframe 的消息。
      // 没有该校验时，任何同源 iframe / 注入脚本都能伪造 {widgetId, type}
      // 消息触发宿主重新计算高度或劫持 onEvent。配合 sandbox 已去掉
      // allow-same-origin，远端 iframe 难以伪造 source，这里再加一层 source
      // 校验作为防御纵深。
      if (event.source !== iframeRef.current?.contentWindow) return;
      const msg = event.data as Record<string, unknown>;
      if (msg.widgetId !== widgetId || msg.type !== "WIDGET_RESIZE") return;
      if (typeof msg.height === "number" && Number.isFinite(msg.height)) {
        const nextHeight = Math.max(MIN_WIDGET_HEIGHT, Math.ceil(msg.height));
        reportedHeightRef.current = nextHeight;
        syncFrameHeight();
      }
    }

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [widgetId]);

  useEffect(() => {
    function handleMessage(event: MessageEvent<unknown>) {
      // 同上：仅接受来自本 widget iframe 的消息。
      if (event.source !== iframeRef.current?.contentWindow) return;
      const msg = event.data as Record<string, unknown>;
      if (msg.widgetId !== widgetId) return;

      if (msg.type === "WIDGET_STATE") {
        if (Array.isArray(msg.state)) {
          formStateRef.current = msg.state as FormStateItem[];
        }
        return;
      }

      if (msg?.type !== "WIDGET_EVENT") return;

      const eventMessage: WidgetEventMessage = {
        type: "WIDGET_EVENT",
        widgetId: msg.widgetId as string,
        event: msg.event as WidgetEventMessage["event"],
        data: msg.data,
        timestamp: typeof msg.timestamp === "number" ? msg.timestamp : Date.now(),
      };
      onEvent?.(eventMessage);
    }

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [widgetId, onEvent]);

  useEffect(() => {
    syncFallbackMeasuredHeight();
    void measureLiveIframeHeight();
    requestResizeSyncBurst();
    scheduleHostResizeRetry();

    return () => {
      clearLiveContentObservers();
      clearHostSyncTimers();
      clearHostResizeRetry();
    };
  }, [widgetId, srcDoc]);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe || typeof ResizeObserver !== "function") return undefined;

    const observer = new ResizeObserver(() => {
      const nextWidth = getMeasurementWidth();
      const widthChanged = nextWidth > 0 && nextWidth !== lastObservedMeasurementWidthRef.current;
      if (widthChanged) {
        lastObservedMeasurementWidthRef.current = nextWidth;
      }

      void measureLiveIframeHeight();
      syncFallbackMeasuredHeight();
      requestResizeSyncBurst();
      if (widthChanged) {
        scheduleHostResizeRetry();
      }
    });

    const parent = iframe.parentElement;
    if (parent) observer.observe(parent);
    observer.observe(iframe);

    return () => {
      observer.disconnect();
    };
  }, [widgetId, srcDoc]);

  useEffect(() => {
    return () => {
      clearLiveContentObservers();
      clearHostSyncTimers();
      clearHostResizeRetry();
    };
  }, []);

  return (
    <iframe
      ref={iframeRef}
      title={`widget-${widgetId}`}
      sandbox={SANDBOX_ATTR}
      srcDoc={srcDoc}
      scrolling="no"
      className="block w-full border-0 bg-transparent"
      onLoad={() => {
        attachLiveContentObservers();
        void measureLiveIframeHeight();
        syncFallbackMeasuredHeight();
        requestResizeSyncBurst();
        scheduleHostResizeRetry();
      }}
      /* iframe 自身必须 overflow:hidden + scrolling="no"：
         (1) iframe 是 HTML replaced element，超出 height 的内容会被 viewport 裁，
             scrolling 控制是否给用户出滚动条——我们要「不要滚动条」 → scrolling="no"。
         (2) overflow:"hidden" 同步阻断，确保 view 端不出任何滚动 UI。
         高度精度由父端 frameHeight + syncFrameHeight 的动态 HEIGHT_BUFFER
         保证：iframe height 永远略大于 widget 真实内容，不会出现「内容溢出 iframe 视口」
         的视觉被切情形。 */
      style={{ height: frameHeight, minHeight: frameHeight, overflow: "hidden", maxHeight: "none" }}
    />
  );
}

export type { WidgetSandboxProps };
