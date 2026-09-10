/// <reference types="vite/client" />

interface Window {
  polaragent: {
    app: {
      getDataDir: () => Promise<string>;
      getHomeDir: () => Promise<string>;
      ensureDataDir: () => Promise<void>;
      openDataDir: () => Promise<void>;
      openPath: (path: string) => Promise<void>;
      openExternal: (url: string) => Promise<void>;
      fileUrl: (path: string) => Promise<string>;
      pickWorkingDirectory: () => Promise<string | null>;
      pickTextFile: () => Promise<string | null>;
      pickMultipleFiles: () => Promise<string[]>;
      pickImageFile: () => Promise<string | null>;
      getPathForFile: (file: File) => string;
    };
    window: {
      minimize: () => Promise<void>;
      toggleMaximize: () => Promise<boolean>;
      close: () => Promise<void>;
      setTitle: (title: string) => Promise<void>;
      isMaximized: () => Promise<boolean>;
      onMaximizedChange: (handler: (maximized: boolean) => void) => () => void;
    };
    fs: {
      readFile: (path: string, options?: import("@/lib/electron/electron-api").SecurityScopedOptions) => Promise<string>;
      readBase64File: (path: string, options?: import("@/lib/electron/electron-api").SecurityScopedOptions) => Promise<string>;
      readBinaryFile: (path: string, options?: import("@/lib/electron/electron-api").SecurityScopedOptions) => Promise<string>;
      writeFile: (path: string, content: string, options?: import("@/lib/electron/electron-api").SecurityScopedOptions) => Promise<void>;
      writeBase64File: (path: string, content: string, options?: import("@/lib/electron/electron-api").SecurityScopedOptions) => Promise<void>;
      appendFile: (path: string, content: string, options?: import("@/lib/electron/electron-api").SecurityScopedOptions) => Promise<void>;
      createDirectory: (path: string, options?: import("@/lib/electron/electron-api").SecurityScopedOptions) => Promise<void>;
      deletePath: (path: string, options?: import("@/lib/electron/electron-api").SecurityScopedOptions) => Promise<void>;
      rename: (src: string, dest: string, options?: import("@/lib/electron/electron-api").SecurityScopedOptions) => Promise<void>;
      copy: (src: string, dest: string, options?: import("@/lib/electron/electron-api").SecurityScopedOptions) => Promise<void>;
      listDirectory: (path: string, options?: import("@/lib/electron/electron-api").SecurityScopedOptions) => Promise<string[]>;
      listDirectoryEntries: (path: string, options?: import("@/lib/electron/electron-api").SecurityScopedOptions) => Promise<Array<{ name: string; isDir: boolean }>>;
      exists: (path: string, options?: import("@/lib/electron/electron-api").SecurityScopedOptions) => Promise<boolean>;
      stat: (path: string, options?: import("@/lib/electron/electron-api").SecurityScopedOptions) => Promise<{
        isDirectory: boolean;
        isFile: boolean;
        isSymlink: boolean;
        size: number;
        mtimeMs: number;
      }>;
      createTempDir: (prefix?: string) => Promise<string>;
      createTempFile: (options?: { prefix?: string; suffix?: string }) => Promise<string>;
    };
    security: {
      setMode: (mode: import("@/types/permissions").ToolPermissionMode) => Promise<void>;
    };
    config: {
      read: (fileName: string) => Promise<string>;
      write: (fileName: string, content: string) => Promise<void>;
      readAgentsMd: () => Promise<string>;
      writeAgentsMd: (content: string) => Promise<void>;
    };
    llm: {
      chatCompletion: (request: import("@/lib/electron/electron-api").LlmChatCompletionRequest) => Promise<import("@/lib/electron/electron-api").LlmChatCompletionResponse>;
      chatCompletionStream: (request: import("@/lib/electron/electron-api").LlmChatCompletionRequest) => Promise<void>;
      listModels: (baseUrl: string, apiKey: string) => Promise<string[]>;
      onChatStream: (handler: (event: import("@/lib/electron/electron-api").LlmChatStreamEvent) => void) => () => void;
    };
    network: {
      /**
       * 主进程流式 fetch：只回传事件与字节，Response 由渲染层组装。
       * 返回中止句柄 —— AbortSignal 无法跨 contextBridge，只能由渲染层驱动。
       */
      fetchStream: (
        request: {
          url: string;
          method?: string;
          headers?: Record<string, string>;
          body?: string;
        },
        onEvent: (event: import("@/lib/electron/electron-api").FetchStreamEvent) => void,
      ) => { abort: () => void };
    };
    shell: {
      exec: (request: {
        command: string;
        cwd: string;
        timeoutMs?: number;
        securityMode?: import("@/types/permissions").ToolPermissionMode;
      }) => Promise<{
        success: boolean;
        exitCode: number | null;
        stdout: string;
        stderr: string;
        timedOut: boolean;
        truncated: boolean;
        error?: string;
        blocked?: boolean;
      }>;
    };
  };
}
