import { contextBridge, ipcRenderer, webUtils } from "electron";

const invoke = (channel: string, payload?: unknown) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld("polaragent", {
  app: {
    getDataDir: () => invoke("app:get-data-dir"),
    getHomeDir: () => invoke("app:get-home-dir"),
    ensureDataDir: () => invoke("app:ensure-data-dir"),
    openDataDir: () => invoke("app:open-data-dir"),
    openPath: (path: string) => invoke("app:open-path", { path }),
    openExternal: (url: string) => invoke("app:open-external", { url }),
    fileUrl: (path: string) => invoke("app:file-url", { path }),
    pickWorkingDirectory: () => invoke("dialog:pick-directory"),
    pickTextFile: () => invoke("dialog:pick-text-file"),
    pickMultipleFiles: () => invoke("dialog:pick-multiple-files"),
    pickImageFile: () => invoke("dialog:pick-image-file"),
    getPathForFile: (file: File) => webUtils.getPathForFile(file),
  },
  window: {
    minimize: () => invoke("window:minimize"),
    toggleMaximize: () => invoke("window:toggle-maximize"),
    close: () => invoke("window:close"),
    setTitle: (title: string) => invoke("window:set-title", { title }),
    isMaximized: () => invoke("window:is-maximized"),
    onMaximizedChange: (handler: (value: boolean) => void) => {
      const listener = (_event: unknown, value: unknown) => handler(Boolean(value));
      ipcRenderer.on("window:maximized-change", listener);
      return () => ipcRenderer.removeListener("window:maximized-change", listener);
    },
  },
  fs: {
    // 安全说明：故意不接受 options 参数 —— 渲染层无法通过 fs API
    // 注入 securityMode 等安全模式覆盖字段。安全模式只能由用户通过
    // security:set-mode IPC 一次性同步到主进程。
    readFile: (path: string) => invoke("fs:read-file", { path }),
    readBase64File: (path: string) => invoke("fs:read-base64-file", { path }),
    readBinaryFile: (path: string) => invoke("fs:read-binary-file", { path }),
    writeFile: (path: string, content: string) => invoke("fs:write-file", { path, content }),
    writeBase64File: (path: string, content: string) => invoke("fs:write-base64-file", { path, content }),
    appendFile: (path: string, content: string) => invoke("fs:append-file", { path, content }),
    createDirectory: (path: string) => invoke("fs:create-directory", { path }),
    deletePath: (path: string) => invoke("fs:delete-path", { path }),
    rename: (src: string, dest: string) => invoke("fs:rename", { src, dest }),
    copy: (src: string, dest: string) => invoke("fs:copy", { src, dest }),
    listDirectory: (path: string) => invoke("fs:list-directory", { path }),
    listDirectoryEntries: (path: string) => invoke("fs:list-directory-entries", { path }),
    exists: (path: string) => invoke("fs:exists", { path }),
    stat: (path: string) => invoke("fs:stat", { path }),
    createTempDir: (prefix?: string) => invoke("fs:create-temp-dir", { prefix }),
    createTempFile: (opts?: { prefix?: string; suffix?: string }) => invoke("fs:create-temp-file", opts || {}),
  },
  security: {
    setMode: (mode: string) => invoke("security:set-mode", { mode }),
  },
  config: {
    read: (fileName: string) => invoke("config:read", { fileName }),
    write: (fileName: string, content: string) => invoke("config:write", { fileName, content }),
    readAgentsMd: () => invoke("config:read-agents-md"),
    writeAgentsMd: (content: string) => invoke("config:write-agents-md", { content }),
  },
  llm: {
    chatCompletion: (request: unknown) => invoke("llm:chat-completion", { request }),
    chatCompletionStream: (request: unknown) => invoke("llm:chat-completion-stream", { request }),
    listModels: (baseUrl: string, apiKey: string) => invoke("llm:list-models", { request: { baseUrl, apiKey } }),
    onChatStream: (handler: (payload: unknown) => void) => {
      const listener = (_event: unknown, payload: unknown) => handler(payload);
      ipcRenderer.on("llm:chat-stream", listener);
      return () => ipcRenderer.removeListener("llm:chat-stream", listener);
    },
  },
  network: {
    /**
     * 流式 Fetch：经主进程 net.fetch 出网。
     *
     * 只桥接「事件 + 字节」，绝不在 preload 内构造 Response / ReadableStream：
     * 这两类对象不能跨 contextBridge，传到渲染层会退化成空对象（丢 status/body），
     * 让 SDK 侧报出与实际原因无关的错误。
     * 中止由渲染层用 AbortSignal 驱动返回的 abort 句柄完成。
     */
    fetchStream: (
      request: {
        url: string;
        method?: string;
        headers?: Record<string, string>;
        body?: string;
      },
      onEvent: (
        event:
          | { type: "meta"; status: number; statusText: string; headers: Array<[string, string]> }
          | { type: "chunk"; data: ArrayBuffer }
          | { type: "done" }
          | { type: "error"; message: string },
      ) => void,
    ): { abort: () => void } => {
      const { port1, port2 } = new MessageChannel();
      let aborted = false;

      const closePort = () => {
        try {
          port1.close();
        } catch {
          // ignore
        }
      };

      const abort = () => {
        if (aborted) return;
        aborted = true;
        try {
          port1.postMessage({ type: "abort" });
        } catch {
          // ignore
        }
        closePort();
      };

      port1.onmessage = (event: MessageEvent) => {
        const msg = event.data as
          | { type: "meta"; status: number; statusText: string; headers: Array<[string, string]> }
          | { type: "chunk"; data: ArrayBuffer }
          | { type: "done" }
          | { type: "error"; message: string };

        if (!msg || typeof msg !== "object") return;
        onEvent(msg);
        if (msg.type === "done" || msg.type === "error") closePort();
      };

      port1.onmessageerror = () => {
        onEvent({ type: "error", message: "主进程 fetch 消息反序列化失败" });
        closePort();
      };

      ipcRenderer.postMessage("network:fetch-stream", request, [port2]);
      return { abort };
    },
  },
  shell: {
    exec: (request: unknown) => invoke("shell:exec", { request }),
  },
});
