// IPC：网络出网
// 渲染进程的 globalThis.fetch 被替换为 ipcFetch 后，全部请求经这里的
// network:fetch-stream 通道用主进程 net.fetch 转发，绕开渲染层 CORS 限制。
import { net } from "electron";
import type { IpcMain } from "electron";

// 错误信息中的 URL 脱敏：去掉 query，避免潜在密钥写入日志/错误链路
function redactUrl(url: string | URL): string {
  try {
    const parsed = new URL(String(url));
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return String(url).split("?")[0];
  }
}

type FetchStreamPort = Electron.MessagePortMain;

type FetchStreamMeta = {
  type: "meta";
  status: number;
  statusText: string;
  headers: Array<[string, string]>;
};

type FetchStreamChunk = { type: "chunk"; data: ArrayBuffer };
type FetchStreamDone = { type: "done" };
type FetchStreamError = { type: "error"; message: string };

/** 主进程流式 fetch：用 net.fetch 发起请求，经 MessagePort 回传 meta/chunk/done */
async function handleFetchStream(port: FetchStreamPort, request: Record<string, unknown>) {
  port.start();
  const send = (msg: FetchStreamMeta | FetchStreamChunk | FetchStreamDone | FetchStreamError) => {
    try {
      port.postMessage(msg);
    } catch {
      // 端口已关闭
    }
  };

  let aborted = false;
  port.on("message", (event) => {
    const data = event.data as { type?: string } | null;
    if (data?.type === "abort") {
      aborted = true;
    }
  });
  port.on("close", () => {
    aborted = true;
  });

  const url = String(request.url || "");
  if (!url) {
    send({ type: "error", message: "缺少 url" });
    port.close();
    return;
  }

  const method = String(request.method || "GET").toUpperCase();
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries((request.headers as Record<string, unknown>) || {})) {
    if (value !== undefined && value !== null) {
      headers[key] = String(value);
    }
  }

  const init: RequestInit = { method, headers, redirect: "follow" };
  const body = request.body;
  if (body !== undefined && body !== null && method !== "GET" && method !== "HEAD") {
    init.body = typeof body === "string" ? body : String(body);
  }

  try {
    const response = await net.fetch(url, init);
    const headerList: Array<[string, string]> = [];
    response.headers.forEach((value, key) => {
      headerList.push([key, value]);
    });
    send({
      type: "meta",
      status: response.status,
      statusText: response.statusText,
      headers: headerList,
    });

    if (!response.body) {
      send({ type: "done" });
      port.close();
      return;
    }

    const reader = response.body.getReader();
    while (!aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) {
        // 复制对齐的 buffer 再传输，避免底层缓冲偏移/被 detach
        send({ type: "chunk", data: value.slice().buffer as ArrayBuffer });
      }
    }
    try {
      await reader.cancel();
    } catch {
      // ignore
    }
    if (!aborted) send({ type: "done" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // 打印到主进程控制台，便于定位模型请求失败的真实原因（超时/代理/状态码等）
    console.error(`[fetch-stream] 主进程模型请求失败（${method} ${redactUrl(url)}）: ${message}`);
    send({ type: "error", message: `主进程请求失败（${method} ${redactUrl(url)}）：${message}` });
  } finally {
    try {
      port.close();
    } catch {
      // ignore
    }
  }
}

function register(ipcMain: IpcMain) {
  // 流式 Fetch：供渲染进程 pi-ai / llm-call 使用，经主进程 net.fetch 出网
  ipcMain.on("network:fetch-stream", (event, request: Record<string, unknown>) => {
    const [port] = event.ports;
    if (!port) return;
    void handleFetchStream(port, request);
  });
}

export { register };
