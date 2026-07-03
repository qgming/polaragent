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
const HOST_RESIZE_RETRY_LIMIT = 20;
const WIDGET_BASE_CSS = `
:root {
  color-scheme: light dark;
  --widget-fg: #111827;
  --widget-muted: #6b7280;
  --widget-border: #e5e7eb;
  --widget-surface: rgba(249, 250, 251, 0.7);
  --widget-button: #2563eb;
  --widget-button-hover: #1d4ed8;
}
@media (prefers-color-scheme: dark) {
  :root {
    --widget-fg: #e5e7eb;
    --widget-muted: #9ca3af;
    --widget-border: #374151;
    --widget-surface: rgba(31, 41, 55, 0.45);
    --widget-button: #3b82f6;
    --widget-button-hover: #60a5fa;
  }
}
*, *::before, *::after { box-sizing: border-box; }
html, body { width: 100%; min-height: 100%; margin: 0; padding: 0; overflow: hidden; }
body {
  font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
  font-size: 14px;
  line-height: 1.55;
  color: var(--widget-fg);
  background: transparent;
}
#widget-root {
  display: block;
  width: 100%;
}
table { border-collapse: collapse; width: 100%; }
th, td { border: 1px solid var(--widget-border); padding: 8px 12px; text-align: left; }
th { background: var(--widget-surface); font-weight: 600; }
input, select, textarea, button { font-family: inherit; font-size: inherit; }
input, select, textarea {
  width: 100%;
  border: 1px solid var(--widget-border);
  border-radius: 6px;
  padding: 6px 10px;
  color: var(--widget-fg);
  background: transparent;
}
button {
  border: none;
  border-radius: 6px;
  padding: 6px 14px;
  cursor: pointer;
  background: var(--widget-button);
  color: #fff;
}
button:hover { background: var(--widget-button-hover); }
svg { display: inline-block; vertical-align: middle; }
`;

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

function measureWidgetFallbackHeight(rawHtml: string, width: number): number | null {
  if (typeof document === "undefined" || width <= 0) return null;

  const container = document.createElement("div");
  container.setAttribute("aria-hidden", "true");
  container.style.position = "absolute";
  container.style.left = "-100000px";
  container.style.top = "0";
  container.style.width = `${Math.ceil(width)}px`;
  container.style.visibility = "hidden";
  container.style.pointerEvents = "none";
  container.style.overflow = "visible";
  container.style.zIndex = "-1";

  const style = document.createElement("style");
  style.textContent = `${WIDGET_BASE_CSS}\n#widget-root{display:block;width:100%;}`;

  const root = document.createElement("div");
  root.id = "widget-root";
  root.innerHTML = sanitizeWidgetHtmlForMeasurement(rawHtml);

  container.append(style, root);
  document.body.appendChild(container);

  const measuredHeight = Math.max(
    MIN_WIDGET_HEIGHT,
    Math.ceil(container.getBoundingClientRect().height),
    Math.ceil(root.getBoundingClientRect().height),
    container.scrollHeight,
    root.scrollHeight,
  );

  container.remove();
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
      root ? root.scrollHeight : 0,
      root ? root.offsetHeight : 0,
      rootRect ? Math.ceil(rootRect.height) : 0,
      widget ? widget.scrollHeight : 0,
      widget ? widget.offsetHeight : 0,
      widgetRect ? Math.ceil(widgetRect.height) : 0
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
    window.setTimeout(syncWidgetFrame, 32);
    window.setTimeout(syncWidgetFrame, 96);
    window.setTimeout(syncWidgetFrame, 220);
    if (resizeBurstTimer !== null) {
      window.clearTimeout(resizeBurstTimer);
    }
    resizeBurstTimer = window.setTimeout(function() {
      syncWidgetFrame();
      resizeBurstTimer = null;
    }, 420);
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
    const nextHeight = Math.max(
      MIN_WIDGET_HEIGHT,
      reportedHeightRef.current,
      fallbackHeightRef.current ?? 0,
      liveHeightRef.current ?? 0,
    );
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
      body?.scrollHeight ?? 0,
      body?.offsetHeight ?? 0,
      bodyRect ? Math.ceil(bodyRect.height) : 0,
      widget?.scrollHeight ?? 0,
      widget?.offsetHeight ?? 0,
      widgetRect ? Math.ceil(widgetRect.height) : 0,
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

    const tick = () => {
      if (lastMeasuredHeightRef.current > MIN_WIDGET_HEIGHT) {
        clearHostResizeRetry();
        return;
      }

      if (hostRetryCountRef.current >= HOST_RESIZE_RETRY_LIMIT) {
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
        if (nextHeight > MIN_WIDGET_HEIGHT) {
          clearHostResizeRetry();
        }
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
      void measureLiveIframeHeight();
      syncFallbackMeasuredHeight();
      requestResizeSyncBurst();
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
      style={{ height: frameHeight, minHeight: frameHeight, overflow: "hidden", maxHeight: "none" }}
    />
  );
}

export type { WidgetSandboxProps };
