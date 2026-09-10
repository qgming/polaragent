export interface LlmChatMessage {
  role: "assistant" | "user";
  content: string;
}

export interface LlmChatCompletionRequest {
  requestId?: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
  messages: LlmChatMessage[];
  temperature?: number;
  maxTokens?: number;
  responseFormat?: "json_object";
}

export interface LlmChatCompletionResponse {
  content: string;
  model: string;
  usage: { input: number; output: number; totalTokens: number };
}

export interface LlmChatStreamEvent {
  requestId: string;
  delta?: string;
  done: boolean;
  error?: string;
  model?: string;
  usage?: { input: number; output: number; totalTokens: number };
}

export interface DirEntry {
  name: string;
  isDir: boolean;
}

export interface SecurityScopedOptions {
  securityMode?: import("@/types/permissions").ToolPermissionMode;
}

function api() {
  if (!window.polaragent) throw new Error("Electron preload API 未初始化");
  return window.polaragent;
}

export function isElectronRuntime(): boolean {
  return Boolean(window.polaragent);
}

export async function chatCompletionStream(
  request: LlmChatCompletionRequest,
  handlers: {
    onDelta: (delta: string) => void;
    onDone: (result: LlmChatCompletionResponse) => void;
    onError: (message: string) => void;
  },
): Promise<void> {
  const requestId =
    request.requestId ??
    (typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `llm-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  let content = "";
  let settled = false;

  const unlisten = api().llm.onChatStream((event: LlmChatStreamEvent) => {
    if (event.requestId !== requestId) return;
    if (event.error) {
      settled = true;
      handlers.onError(event.error);
      unlisten();
      return;
    }
    if (event.delta) {
      content += event.delta;
      handlers.onDelta(event.delta);
    }
    if (event.done) {
      settled = true;
      handlers.onDone({
        content,
        model: event.model ?? request.model,
        usage: event.usage ?? { input: 0, output: 0, totalTokens: 0 },
      });
      unlisten();
    }
  });

  try {
    await api().llm.chatCompletionStream({ ...request, requestId });
  } catch (error) {
    if (!settled) handlers.onError(error instanceof Error ? error.message : String(error));
    unlisten();
  }
}

export function chatCompletion(request: LlmChatCompletionRequest) {
  return api().llm.chatCompletion(request);
}

export function listRemoteModels(baseUrl: string, apiKey: string) {
  return api().llm.listModels(baseUrl, apiKey);
}

export const pickWorkingDirectory = () => api().app.pickWorkingDirectory();
export const pickTextFile = (): Promise<string | null> => api().app.pickTextFile();
export const pickMultipleFiles = (): Promise<string[]> => api().app.pickMultipleFiles();
export const getPathForFile = (file: File): string => api().app.getPathForFile(file);
export const pickImageFile = () => api().app.pickImageFile();
export const getDataDir = () => api().app.getDataDir();
export const getHomeDir = () => api().app.getHomeDir();
export const openDataDir = () => api().app.openDataDir();
export const openPath = (path: string) => api().app.openPath(path);
export const openExternal = (url: string) => api().app.openExternal(url);
export const fileUrl = (path: string) => api().app.fileUrl(path);
export const ensureDataDir = () => api().app.ensureDataDir();

export const listDirectory = (path: string, options?: SecurityScopedOptions) => api().fs.listDirectory(path, options);
export const listDirectoryEntries = (path: string, options?: SecurityScopedOptions) => api().fs.listDirectoryEntries(path, options);
export const readFile = (path: string, options?: SecurityScopedOptions) => api().fs.readFile(path, options);
export const readBase64File = (path: string, options?: SecurityScopedOptions) => api().fs.readBase64File(path, options);
export const fileExists = (path: string, options?: SecurityScopedOptions): Promise<boolean> => api().fs.exists(path, options);
export const writeFile = (path: string, content: string, options?: SecurityScopedOptions) => api().fs.writeFile(path, content, options);
export const writeBase64File = (path: string, content: string, options?: SecurityScopedOptions) => api().fs.writeBase64File(path, content, options);
export const appendFile = (path: string, content: string, options?: SecurityScopedOptions) => api().fs.appendFile(path, content, options);
export const renamePath = (src: string, dest: string, options?: SecurityScopedOptions) => api().fs.rename(src, dest, options);
export const copyPath = (src: string, dest: string, options?: SecurityScopedOptions) => api().fs.copy(src, dest, options);
export const createDirectory = (path: string, options?: SecurityScopedOptions) => api().fs.createDirectory(path, options);
export const deleteFile = (path: string, options?: SecurityScopedOptions) => api().fs.deletePath(path, options);

export async function readConfig<T = any>(fileName: string): Promise<T> {
  return JSON.parse(await api().config.read(fileName)) as T;
}

export function writeConfig(fileName: string, content: any): Promise<void> {
  return api().config.write(fileName, JSON.stringify(content, null, 2));
}

// AGENTS.md 读写：固定路径 {dataDir}/AGENTS.md
export const readAgentsMd = (): Promise<string> => api().config.readAgentsMd();
export const writeAgentsMd = (content: string): Promise<void> => api().config.writeAgentsMd(content);

/**
 * 主进程流式 fetch（与设置页模型测试同出网路径）。
 * 在 Electron 中替代 globalThis.fetch；非 Electron 环境回退到原生 fetch。
 *
 * 注意：openai / @anthropic-ai SDK 内部直接用 globalThis.fetch，
 * 不会读取任何 options.fetch —— 所以必须通过 installIpcFetch 全局替换，
 * 否则渲染进程直连会被浏览器 CORS 拦截（请求到达 API 但响应被拒）。
 */
const nativeFetch: typeof globalThis.fetch =
  typeof globalThis !== "undefined" ? globalThis.fetch : undefined as unknown as typeof globalThis.fetch;

export function ipcFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const url =
    typeof input === "string" ? input
    : input instanceof URL ? input.toString()
    : input.url;

  if (!isElectronRuntime() || !api().network?.fetchStream) {
    return nativeFetch(input, init);
  }

  const headers: Record<string, string> = {};
  if (init?.headers) {
    if (init.headers instanceof Headers) {
      init.headers.forEach((value, key) => {
        headers[key] = value;
      });
    } else if (Array.isArray(init.headers)) {
      for (const [key, value] of init.headers) headers[key] = value;
    } else {
      for (const [key, value] of Object.entries(init.headers)) {
        if (value !== undefined && value !== null) headers[key] = String(value);
      }
    }
  }

  let body: string | undefined;
  if (init?.body !== undefined && init.body !== null) {
    if (typeof init.body === "string") {
      body = init.body;
    } else if (init.body instanceof Uint8Array || init.body instanceof ArrayBuffer) {
      body = new TextDecoder().decode(
        init.body instanceof ArrayBuffer ? init.body : init.body.buffer.slice(
          init.body.byteOffset,
          init.body.byteOffset + init.body.byteLength,
        ),
      );
    } else if (typeof ReadableStream !== "undefined" && init.body instanceof ReadableStream) {
      // 极少见的上传流：回退到原生 fetch（Electron 下仍受 CORS 约束，但 LLM 请求不依赖此路径）
      return nativeFetch(input, init);
    } else {
      body = String(init.body);
    }
  }

  return streamViaMainProcess(url, init?.method || "GET", headers, body, init?.signal ?? undefined);
}

/** 主进程出网事件（与 src/preload/index.ts 的 fetchStream 契约一一对应） */
export type FetchStreamEvent =
  | { type: "meta"; status: number; statusText: string; headers: Array<[string, string]> }
  | { type: "chunk"; data: ArrayBuffer }
  | { type: "done" }
  | { type: "error"; message: string };

/**
 * 经主进程出网，并在渲染层重建 Response。
 *
 * 为什么 Response 不能放在 preload 里构造：contextBridge 传不了 Response 与
 * ReadableStream，渲染层只会拿到一个空对象（丢 status/body），SDK 随即报出与
 * 实际原因无关的错误。因此 preload 只回传事件与字节，Response 在能用的一侧组装。
 */
function streamViaMainProcess(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  signal: AbortSignal | undefined,
): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    let settled = false;
    // body 流是否已终结（close 或 error）。终结后不再重复操作。
    let bodyFinished = false;
    let handle: { abort: () => void } | null = null;

    const abortUpstream = () => {
      try {
        handle?.abort();
      } catch {
        // 端口可能已关闭
      }
    };

    const detach = () => {
      if (signal) signal.removeEventListener("abort", rejectAborted);
    };

    /** 让 body 流以指定原因终止（已终结则忽略） */
    const failBody = (error: Error) => {
      if (bodyFinished) return;
      bodyFinished = true;
      try {
        controller?.error(error);
      } catch {
        // 流已关闭
      }
    };

    const closeBody = () => {
      if (bodyFinished) return;
      bodyFinished = true;
      try {
        controller?.close();
      } catch {
        // 流已关闭
      }
    };

    /**
     * 中止处理。
     *
     * 关键：meta 已到达（settled=true）时，Response 已经交给调用方，此时必须用
     * AbortError 终结 body 流。否则调用方的 response.text() / for await 会永久
     * 挂起 —— openai SDK 的流迭代器不与 signal 竞速，等不到事件就永远不返回。
     */
    const rejectAborted = () => {
      abortUpstream();
      detach();
      const error = new DOMException("请求已中止", "AbortError");
      if (!settled) {
        settled = true;
        reject(error);
        return;
      }
      failBody(error as unknown as Error);
    };

    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
      cancel() {
        abortUpstream();
      },
    });

    handle = api().network.fetchStream({ url, method, headers, body }, (event) => {
      if (event.type === "meta") {
        if (settled) return;
        settled = true;
        resolve(
          new Response(stream, {
            status: event.status,
            statusText: event.statusText,
            headers: toHeaders(event.headers),
          }),
        );
        return;
      }

      if (event.type === "chunk") {
        if (bodyFinished) return;
        try {
          controller?.enqueue(new Uint8Array(event.data));
        } catch {
          // 流已关闭
        }
        return;
      }

      if (event.type === "done") {
        detach();
        closeBody();
        return;
      }

      // 首字节之前就失败：合成 502，让真实原因能穿过 SDK 的错误模型
      if (!settled) {
        settled = true;
        detach();
        resolve(buildTransportFailureResponse(url, method, event.message));
        return;
      }
      detach();
      failBody(new Error(event.message || "主进程请求失败"));
    });

    if (signal) {
      if (signal.aborted) rejectAborted();
      else signal.addEventListener("abort", rejectAborted, { once: true });
    }
  });
}

/**
 * 出网失败时合成一个 502 响应，把真实原因放进 body。
 *
 * OpenAI SDK 会把任何 fetch 异常统一包装成 message 固定为 "Connection error." 的
 * APIConnectionError，pi-ai 又只读 message（从不遍历 cause），直接 reject 会让真实
 * 原因彻底丢失。合成 502 后 SDK 会构造带 status/body 的 APIError，pi-ai 的
 * normalizeProviderError 会把该 body 拼进 errorMessage，原因即可见。
 * 中止不走这条路：那必须是一个 AbortError，否则会被误判成连接失败。
 */
function buildTransportFailureResponse(url: string, method: string, message: string): Response {
  // 主进程的失败消息已自带「主进程请求失败（METHOD URL）」上下文，这里只在
  // 缺失时补前缀，避免同一段 URL 在错误里出现两遍。
  const detail = String(message || "").trim();
  const text = detail || `主进程出网失败（${method} ${redactUrl(url)}）`;
  return new Response(JSON.stringify({ error: { message: text } }), {
    status: 502,
    statusText: "Bad Gateway",
    headers: { "content-type": "application/json" },
  });
}

/** 事件头数组 → Headers（非法头名忽略） */
function toHeaders(list: Array<[string, string]>): Headers {
  const headers = new Headers();
  for (const [key, value] of list) {
    try {
      headers.append(key, value);
    } catch {
      // 忽略非法头名
    }
  }
  return headers;
}

/** 去掉 query，避免把可能的密钥或参数写进错误信息 */
function redactUrl(url: string): string {
  const raw = String(url || "");
  const index = raw.indexOf("?");
  return index === -1 ? raw : raw.slice(0, index);
}

/**
 * 渲染进程启动时调用：把 globalThis.fetch 全局替换为 ipcFetch，
 * 使 openai / anthropic SDK 与其它库的请求全部经主进程出网，
 * 与设置页「测试模型」完全同路径，绕开渲染进程 CORS 限制。
 */
export function installIpcFetch(): void {
  if (isElectronRuntime() && typeof globalThis !== "undefined") {
    if (globalThis.fetch !== ipcFetch) {
      globalThis.fetch = ipcFetch as typeof globalThis.fetch;
      console.log("[net] globalThis.fetch 已替换为主进程 ipcFetch");
    }
  }
}

// Shell 命令执行 —— 由主进程在指定工作目录下执行 shell 命令，供 bash 工具使用。
// 主进程会做黑名单校验、超时 kill、输出截断。
export interface ShellExecRequest {
  command: string;
  cwd: string;
  timeoutMs?: number;
  securityMode?: import("@/types/permissions").ToolPermissionMode;
}

export interface ShellExecResponse {
  success: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  error?: string;
  blocked?: boolean;
}

export function runShell(request: ShellExecRequest): Promise<ShellExecResponse> {
  return api().shell.exec(request);
}
