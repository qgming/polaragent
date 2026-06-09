/// <reference types="vite/client" />

interface Window {
  polaragent: {
    app: {
      getDataDir: () => Promise<string>;
      ensureDataDir: () => Promise<void>;
      openDataDir: () => Promise<void>;
      openPath: (path: string) => Promise<void>;
      openExternal: (url: string) => Promise<void>;
      fileUrl: (path: string) => Promise<string>;
      pickWorkingDirectory: () => Promise<string | null>;
      pickTextFile: () => Promise<string | null>;
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
  };
}
