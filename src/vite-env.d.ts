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
      getPathForFile: (file: File) => string;
      pickImageFile: () => Promise<string | null>;
      pickAudioFile: () => Promise<string | null>;
    };
    window: {
      minimize: () => Promise<void>;
      toggleMaximize: () => Promise<boolean>;
      close: () => Promise<void>;
      setTitle: (title: string) => Promise<void>;
      isMaximized: () => Promise<boolean>;
      onMaximizedChange: (handler: (maximized: boolean) => void) => () => void;
    };
    preview: {
      open: (path: string) => Promise<void>;
    };
    fs: {
      readFile: (path: string) => Promise<string>;
      readBase64File: (path: string) => Promise<string>;
      writeFile: (path: string, content: string) => Promise<void>;
      writeBase64File: (path: string, content: string) => Promise<void>;
      appendFile: (path: string, content: string) => Promise<void>;
      createDirectory: (path: string) => Promise<void>;
      deletePath: (path: string) => Promise<void>;
      listDirectory: (path: string) => Promise<string[]>;
      listDirectoryEntries: (path: string) => Promise<Array<{ name: string; isDir: boolean }>>;
      exists: (path: string) => Promise<boolean>;
      stat: (path: string) => Promise<{
        isDirectory: boolean;
        isFile: boolean;
        isSymlink: boolean;
        size: number;
        mtimeMs: number;
      }>;
    };
    config: {
      read: (fileName: string) => Promise<string>;
      write: (fileName: string, content: string) => Promise<void>;
      listAgents: () => Promise<string[]>;
      readAgent: (agentId: string) => Promise<string>;
      writeAgent: (agentId: string, content: string) => Promise<void>;
      deleteAgent: (agentId: string) => Promise<void>;
      listMcp: () => Promise<string[]>;
      readMcp: (mcpId: string) => Promise<string>;
      writeMcp: (mcpId: string, content: string) => Promise<void>;
      deleteMcp: (mcpId: string) => Promise<void>;
      listTeams: () => Promise<string[]>;
      readTeam: (teamId: string) => Promise<string>;
      writeTeam: (teamId: string, content: string) => Promise<void>;
      deleteTeam: (teamId: string) => Promise<void>;
      fetchBuiltinMcpConfigs: () => Promise<string>;
    };
    llm: {
      chatCompletion: (request: import("@/lib/electron/electron-api").LlmChatCompletionRequest) => Promise<import("@/lib/electron/electron-api").LlmChatCompletionResponse>;
      chatCompletionStream: (request: import("@/lib/electron/electron-api").LlmChatCompletionRequest) => Promise<void>;
      listModels: (baseUrl: string, apiKey: string) => Promise<string[]>;
      onChatStream: (handler: (event: import("@/lib/electron/electron-api").LlmChatStreamEvent) => void) => () => void;
    };
    network: {
      corsFetch: (request: {
        url: string;
        method?: string;
        headers?: Record<string, string>;
        body?: string;
        timeoutMs?: number;
      }) => Promise<unknown>;
      skillsMarketSearch: (request: unknown) => Promise<string>;
      fetchAgentIndex: () => Promise<string>;
      fetchAgentCategory: (fileName: string) => Promise<string>;
      webSearch: (request: {
        provider: string;
        query: string;
        limit?: number;
        apiKey?: string;
        // Tavily 特定参数
        searchDepth?: string;
        includeDomains?: string;
        excludeDomains?: string;
        includeAnswer?: boolean;
        includeRawContent?: boolean;
        includeImages?: boolean;
        // Exa 特定参数
        type?: string;
        useAutoprompt?: boolean;
        category?: string;
        includeText?: boolean;
        includeHighlights?: boolean;
        includeSummary?: boolean;
        // Serper 特定参数
        gl?: string;
        hl?: string;
        // SearXNG 特定参数
        instances?: string;
        // Brave 特定参数
        country?: string;
        searchLang?: string;
      }) => Promise<{
        success: boolean;
        provider: string;
        instance?: string;
        results: Array<{
          title: string;
          url: string;
          snippet: string;
          score?: number;
          rawContent?: string;
          images?: string[];
          text?: string;
          highlights?: string[];
          summary?: string;
        }>;
        answer?: string;
      }>;
      downloadUrlAsBase64: (request: import("@/lib/electron/electron-api").DownloadUrlAsBase64Request) => Promise<import("@/lib/electron/electron-api").DownloadUrlAsBase64Response>;
      openaiImageEdit: (request: import("@/lib/electron/electron-api").OpenAiImageEditRequest) => Promise<import("@/lib/electron/electron-api").OpenAiImageResponse>;
      openaiTranscription: (request: import("@/lib/electron/electron-api").OpenAiTranscriptionRequest) => Promise<import("@/lib/electron/electron-api").OpenAiTranscriptionResponse>;
      openaiSpeech: (request: import("@/lib/electron/electron-api").OpenAiSpeechRequest) => Promise<import("@/lib/electron/electron-api").OpenAiSpeechResponse>;
      mimoSpeech: (request: import("@/lib/electron/electron-api").MimoSpeechRequest) => Promise<import("@/lib/electron/electron-api").MimoSpeechResponse>;
    };
    skills: {
      list: (skillType: "builtin" | "custom") => Promise<string[]>;
      readMetadata: (skillId: string) => Promise<string>;
      installFromGit: (repoUrl: string) => Promise<string>;
      installFromLocal: (sourcePath: string) => Promise<string>;
    };
    mcp: {
      stdioListTools: (server: import("@/lib/mcp").McpServerConfig) => Promise<import("@/lib/mcp").McpDiscoveredTool[]>;
      stdioCallTool: (request: {
        server: import("@/lib/mcp").McpServerConfig;
        toolName: string;
        arguments?: Record<string, unknown>;
      }) => Promise<unknown>;
    };
    shell: {
      exec: (request: {
        command: string;
        cwd: string;
        timeoutMs?: number;
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
    cli: {
      detect: (cliName: string) => Promise<{ exists: boolean; command: string }>;
      detectBatch: (cliNames: string[]) => Promise<Array<{ exists: boolean; command: string }>>;
      getVersions: (cliNames: string[]) => Promise<Array<{ command: string; version: string | null }>>;
    };
    knowledge: {
      create: (request: {
        kbId: string;
        name: string;
        description?: string;
        chunkSize?: number;
        overlap?: number;
      }) => Promise<{
        success: boolean;
        knowledgeBase: {
          id: string;
          name: string;
          description?: string;
          enabled: boolean;
          createdAt: number;
          updatedAt: number;
          chunkSize: number;
          overlap: number;
          fileCount: number;
          chunkCount: number;
        };
      }>;
      update: (request: {
        kbId: string;
        updates: Partial<{
          name: string;
          description: string;
          enabled: boolean;
          chunkSize: number;
          overlap: number;
        }>;
      }) => Promise<{
        success: boolean;
        knowledgeBase: {
          id: string;
          name: string;
          description?: string;
          enabled: boolean;
          createdAt: number;
          updatedAt: number;
          chunkSize: number;
          overlap: number;
          fileCount: number;
          chunkCount: number;
        };
      }>;
      addFiles: (request: {
        kbId: string;
        filePaths: string[];
        config: {
          chunkSize?: number;
          overlap?: number;
          embedding: {
            apiKey: string;
            baseURL: string;
            model: string;
            dimension: number;
          };
        };
      }) => Promise<{
        success: boolean;
        addedFiles: Array<{
          id: string;
          kbId: string;
          name: string;
          path: string;
          size: number;
          type: string;
          status: "pending" | "processing" | "ready" | "error";
          error?: string;
          chunkCount: number;
          createdAt: number;
          updatedAt: number;
        }>;
        totalFiles: number;
        totalChunks: number;
      }>;
      removeFile: (request: { kbId: string; fileId: string }) => Promise<{ success: boolean }>;
      getFiles: (kbId: string) => Promise<Array<{
        id: string;
        kbId: string;
        name: string;
        path: string;
        size: number;
        type: string;
        status: "pending" | "processing" | "ready" | "error" | "incompatible";
        error?: string;
        chunkCount: number;
        createdAt: number;
        updatedAt: number;
      }>>;
      checkCompatibility: (kbId: string, config: {
        embedding: {
          apiKey: string;
          baseURL: string;
          model: string;
          dimension: number;
        };
      }) => Promise<Array<{
        id: string;
        kbId: string;
        name: string;
        path: string;
        size: number;
        type: string;
        status: "pending" | "processing" | "ready" | "error" | "incompatible";
        error?: string;
        chunkCount: number;
        createdAt: number;
        updatedAt: number;
      }>>;
      reembedIncompatible: (request: {
        kbId: string;
        config: {
          embedding: {
            apiKey: string;
            baseURL: string;
            model: string;
            dimension: number;
          };
        };
      }) => Promise<{ success: boolean; reembedded: number }>;
      rebuild: (request: {
        kbId: string;
        config: {
          embedding: {
            apiKey: string;
            baseURL: string;
            model: string;
            dimension: number;
          };
        };
      }) => Promise<{ success: boolean; fileCount: number; chunkCount: number }>;
      rebuildFile: (request: {
        kbId: string;
        fileId: string;
        config: {
          embedding: {
            apiKey: string;
            baseURL: string;
            model: string;
            dimension: number;
          };
        };
      }) => Promise<{
        success: boolean;
        file: {
          id: string;
          kbId: string;
          name: string;
          path: string;
          size: number;
          type: string;
          status: "pending" | "processing" | "ready" | "error" | "incompatible";
          error?: string;
          chunkCount: number;
          createdAt: number;
          updatedAt: number;
        };
        fileCount: number;
        chunkCount: number;
      }>;
      query: (request: {
        kbId: string;
        query: string;
        config: {
          embedding: {
            apiKey: string;
            baseURL: string;
            model: string;
            dimension: number;
          };
        };
        topK?: number;
        threshold?: number;
      }) => Promise<{
        success: boolean;
        results: Array<{
          id: string;
          file: string;
          chunk: number;
          text: string;
          score: number;
        }>;
      }>;
      delete: (kbId: string) => Promise<{ success: boolean }>;
      list: () => Promise<Array<{
        id: string;
        name: string;
        description?: string;
        enabled: boolean;
        createdAt: number;
        updatedAt: number;
        chunkSize: number;
        overlap: number;
        fileCount: number;
        chunkCount: number;
      }>>;
    };
    computeruse: {
      health: () => Promise<ComputerUseHealthResult>;
      snapshot: (opts?: ComputerUseSnapshotOptions) => Promise<ComputerUseSnapshotResult>;
      tree: (opts?: ComputerUseTreeOptions) => Promise<ComputerUseTreeResult>;
      click: (opts: ComputerUseClickOptions) => Promise<ComputerUseActionResult>;
      doubleClick: (opts: ComputerUseClickOptions) => Promise<ComputerUseActionResult>;
      move: (opts: ComputerUseMoveOptions) => Promise<ComputerUseActionResult>;
      drag: (opts: ComputerUseDragOptions) => Promise<ComputerUseActionResult>;
      scroll: (opts: ComputerUseScrollOptions) => Promise<ComputerUseActionResult>;
      type: (opts: ComputerUseTypeOptions) => Promise<ComputerUseActionResult>;
      keypress: (opts: ComputerUseKeypressOptions) => Promise<ComputerUseActionResult>;
      find: (opts: ComputerUseFindOptions) => Promise<ComputerUseFindResult>;
      elementInfo: (opts: ComputerUseElementInfoOptions) => Promise<ComputerUseElementInfoResult>;
      focus: (opts: ComputerUseFocusOptions) => Promise<ComputerUseActionResult>;
      invoke: (opts: ComputerUseInvokeOptions) => Promise<ComputerUseActionResult>;
      setValue: (opts: ComputerUseSetValueOptions) => Promise<ComputerUseActionResult>;
      listWindows: (opts?: ComputerUseListWindowsOptions) => Promise<ComputerUseListWindowsResult>;
      activateWindow: (opts: ComputerUseActivateWindowOptions) => Promise<ComputerUseActionResult>;
      wait: (opts?: ComputerUseWaitOptions) => Promise<ComputerUseActionResult>;
    };
    browseruse: {
      call: (params: any) => Promise<{ ok: boolean; result?: any; error?: string }>;
      status: () => Promise<{ ok: boolean; connected: boolean; ports: { extension: number; api: number } }>;
    };
  };
}

// Computer Use 类型定义
interface ComputerUseHealthResult {
  ok: boolean;
  error?: string;
}

interface ComputerUseSnapshotOptions {
  scope?: "active_window" | "desktop";
  windowTitle?: string;
  processId?: number;
  nativeWindowHandle?: number;
  activate?: boolean;
  viewMode?: "control" | "content" | "raw";
  includeOffscreen?: boolean;
  detailLevel?: "compact" | "full";
  includeScreenshot?: boolean;
  maxDepth?: number;
  maxNodes?: number;
}

interface ComputerUseTreeOptions {
  scope?: "active_window" | "desktop";
  windowTitle?: string;
  processId?: number;
  nativeWindowHandle?: number;
  activate?: boolean;
  viewMode?: "control" | "content" | "raw";
  includeOffscreen?: boolean;
  detailLevel?: "compact" | "full";
  maxDepth?: number;
  maxNodes?: number;
}

interface ComputerUseElementInfo {
  id: string;
  depth: number;
  name: string;
  automationId: string;
  className: string;
  controlType: string;
  boundingBox?: {
    x: number;
    y: number;
    width: number;
    height: number;
    centerX: number;
    centerY: number;
  };
  isEnabled?: boolean;
  isOffscreen?: boolean;
  hasKeyboardFocus?: boolean;
  processId?: number;
  nativeWindowHandle?: number;
  runtimeId?: string;
  value?: string;
  patterns?: string[];
  children?: ComputerUseElementInfo[];
}

interface ComputerUseSnapshotResult {
  ok: boolean;
  tree: ComputerUseElementInfo;
  screenshot?: {
    base64: string;
    mimeType: string;
    bounds: { x: number; y: number; width: number; height: number };
    path?: string;
  };
  scope: string;
  error?: string;
}

interface ComputerUseTreeResult {
  ok: boolean;
  tree: ComputerUseElementInfo;
  scope: string;
  error?: string;
}

interface ComputerUseClickOptions {
  elementId?: string;
  x?: number;
  y?: number;
  button?: "left" | "right" | "middle";
  windowTitle?: string;
  processId?: number;
  nativeWindowHandle?: number;
  activate?: boolean;
  viewMode?: "control" | "content" | "raw";
  includeOffscreen?: boolean;
}

interface ComputerUseMoveOptions {
  elementId?: string;
  x?: number;
  y?: number;
  windowTitle?: string;
  processId?: number;
  nativeWindowHandle?: number;
  activate?: boolean;
  viewMode?: "control" | "content" | "raw";
  includeOffscreen?: boolean;
}

interface ComputerUseDragOptions {
  path: Array<{ x: number; y: number }>;
  button?: "left" | "right" | "middle";
  windowTitle?: string;
  processId?: number;
  nativeWindowHandle?: number;
  activate?: boolean;
}

interface ComputerUseScrollOptions {
  elementId?: string;
  x?: number;
  y?: number;
  deltaY?: number;
  deltaX?: number;
  windowTitle?: string;
  processId?: number;
  nativeWindowHandle?: number;
  activate?: boolean;
  viewMode?: "control" | "content" | "raw";
  includeOffscreen?: boolean;
}

interface ComputerUseTypeOptions {
  text: string;
  restoreClipboard?: boolean;
  windowTitle?: string;
  processId?: number;
  nativeWindowHandle?: number;
  activate?: boolean;
}

interface ComputerUseKeypressOptions {
  keys: string[];
  windowTitle?: string;
  processId?: number;
  nativeWindowHandle?: number;
  activate?: boolean;
}

interface ComputerUseFindOptions {
  query: string;
  scope?: "active_window" | "desktop";
  windowTitle?: string;
  processId?: number;
  nativeWindowHandle?: number;
  activate?: boolean;
  viewMode?: "control" | "content" | "raw";
  includeOffscreen?: boolean;
  controlType?: string;
  maxDepth?: number;
  maxNodes?: number;
  maxResults?: number;
}

interface ComputerUseFindResult {
  ok: boolean;
  results: ComputerUseElementInfo[];
  count: number;
  error?: string;
}

interface ComputerUseElementInfoOptions {
  elementId?: string;
  x?: number;
  y?: number;
  windowTitle?: string;
  processId?: number;
  nativeWindowHandle?: number;
  activate?: boolean;
  viewMode?: "control" | "content" | "raw";
  includeOffscreen?: boolean;
}

interface ComputerUseElementInfoResult {
  ok: boolean;
  element: ComputerUseElementInfo;
  error?: string;
}

interface ComputerUseFocusOptions {
  elementId: string;
  windowTitle?: string;
  processId?: number;
  nativeWindowHandle?: number;
  activate?: boolean;
  viewMode?: "control" | "content" | "raw";
  includeOffscreen?: boolean;
}

interface ComputerUseInvokeOptions {
  elementId: string;
  fallbackClick?: boolean;
  windowTitle?: string;
  processId?: number;
  nativeWindowHandle?: number;
  activate?: boolean;
  viewMode?: "control" | "content" | "raw";
  includeOffscreen?: boolean;
}

interface ComputerUseSetValueOptions {
  elementId: string;
  value: string;
  fallbackType?: boolean;
  restoreClipboard?: boolean;
  windowTitle?: string;
  processId?: number;
  nativeWindowHandle?: number;
  activate?: boolean;
  viewMode?: "control" | "content" | "raw";
  includeOffscreen?: boolean;
}

interface ComputerUseListWindowsOptions {
  includeInvisible?: boolean;
  maxWindows?: number;
}

interface ComputerUseListWindowsResult {
  ok: boolean;
  windows: ComputerUseElementInfo[];
  count: number;
  error?: string;
}

interface ComputerUseActivateWindowOptions {
  windowTitle?: string;
  processId?: number;
  nativeWindowHandle?: number;
  activate?: boolean;
}

interface ComputerUseWaitOptions {
  milliseconds?: number;
}

interface ComputerUseActionResult {
  ok: boolean;
  action?: string;
  x?: number;
  y?: number;
  elementId?: string;
  method?: string;
  error?: string;
}
