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
      writeFile: (path: string, content: string) => Promise<void>;
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
      webSearch: (request: unknown) => Promise<import("@/lib/electron/electron-api").WebSearchResponse>;
      webRead: (request: unknown) => Promise<import("@/lib/electron/electron-api").WebReadResponse>;
      skillsMarketSearch: (request: unknown) => Promise<string>;
      fetchAgentIndex: () => Promise<string>;
      fetchAgentCategory: (fileName: string) => Promise<string>;
    };
    skills: {
      list: (skillType: "builtin" | "custom") => Promise<string[]>;
      readMetadata: (skillId: string) => Promise<string>;
      installFromGit: (repoUrl: string) => Promise<string>;
      installFromLocal: (sourcePath: string) => Promise<string>;
    };
    mcp: {
      stdioListTools: (server: import("@/types/config").McpServerConfig) => Promise<import("@/lib/electron/electron-api").McpRemoteTool[]>;
      stdioCallTool: (request: {
        server: import("@/types/config").McpServerConfig;
        toolName: string;
        arguments?: Record<string, unknown>;
      }) => Promise<unknown>;
    };
  };
}
