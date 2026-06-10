const { contextBridge, ipcRenderer } = require("electron");

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld("polaragent", {
  app: {
    getDataDir: () => invoke("app:get-data-dir"),
    ensureDataDir: () => invoke("app:ensure-data-dir"),
    openDataDir: () => invoke("app:open-data-dir"),
    openPath: (path) => invoke("app:open-path", { path }),
    openExternal: (url) => invoke("app:open-external", { url }),
    fileUrl: (path) => invoke("app:file-url", { path }),
    pickWorkingDirectory: () => invoke("dialog:pick-directory"),
    pickTextFile: () => invoke("dialog:pick-text-file"),
    pickMultipleFiles: () => invoke("dialog:pick-multiple-files"),
    pickImageFile: () => invoke("dialog:pick-image-file"),
    pickAudioFile: () => invoke("dialog:pick-audio-file"),
  },
  window: {
    minimize: () => invoke("window:minimize"),
    toggleMaximize: () => invoke("window:toggle-maximize"),
    close: () => invoke("window:close"),
    setTitle: (title) => invoke("window:set-title", { title }),
    isMaximized: () => invoke("window:is-maximized"),
    onMaximizedChange: (handler) => {
      const listener = (_event, value) => handler(Boolean(value));
      ipcRenderer.on("window:maximized-change", listener);
      return () => ipcRenderer.removeListener("window:maximized-change", listener);
    },
  },
  preview: {
    open: (path) => invoke("preview:open", { path }),
  },
  fs: {
    readFile: (path) => invoke("fs:read-file", { path }),
    readBase64File: (path) => invoke("fs:read-base64-file", { path }),
    writeFile: (path, content) => invoke("fs:write-file", { path, content }),
    writeBase64File: (path, content) => invoke("fs:write-base64-file", { path, content }),
    appendFile: (path, content) => invoke("fs:append-file", { path, content }),
    createDirectory: (path) => invoke("fs:create-directory", { path }),
    deletePath: (path) => invoke("fs:delete-path", { path }),
    listDirectory: (path) => invoke("fs:list-directory", { path }),
    listDirectoryEntries: (path) => invoke("fs:list-directory-entries", { path }),
    exists: (path) => invoke("fs:exists", { path }),
    stat: (path) => invoke("fs:stat", { path }),
  },
  config: {
    read: (fileName) => invoke("config:read", { fileName }),
    write: (fileName, content) => invoke("config:write", { fileName, content }),
    listAgents: () => invoke("config:list-agents"),
    readAgent: (agentId) => invoke("config:read-agent", { agentId }),
    writeAgent: (agentId, content) => invoke("config:write-agent", { agentId, content }),
    deleteAgent: (agentId) => invoke("config:delete-agent", { agentId }),
    listMcp: () => invoke("config:list-mcp"),
    readMcp: (mcpId) => invoke("config:read-mcp", { mcpId }),
    writeMcp: (mcpId, content) => invoke("config:write-mcp", { mcpId, content }),
    deleteMcp: (mcpId) => invoke("config:delete-mcp", { mcpId }),
    listTeams: () => invoke("config:list-teams"),
    readTeam: (teamId) => invoke("config:read-team", { teamId }),
    writeTeam: (teamId, content) => invoke("config:write-team", { teamId, content }),
    deleteTeam: (teamId) => invoke("config:delete-team", { teamId }),
    fetchBuiltinMcpConfigs: () => invoke("config:fetch-builtin-mcp"),
  },
  llm: {
    chatCompletion: (request) => invoke("llm:chat-completion", { request }),
    chatCompletionStream: (request) => invoke("llm:chat-completion-stream", { request }),
    listModels: (baseUrl, apiKey) => invoke("llm:list-models", { request: { baseUrl, apiKey } }),
    onChatStream: (handler) => {
      const listener = (_event, payload) => handler(payload);
      ipcRenderer.on("llm:chat-stream", listener);
      return () => ipcRenderer.removeListener("llm:chat-stream", listener);
    },
  },
  network: {
    corsFetch: (request) => invoke("network:cors-fetch", { request }),
    skillsMarketSearch: (request) => invoke("network:skills-market-search", { request }),
    fetchAgentIndex: () => invoke("network:fetch-agent-index"),
    fetchAgentCategory: (fileName) => invoke("network:fetch-agent-category", { fileName }),
    webSearch: (request) => invoke("network:web-search", { request }),
    downloadUrlAsBase64: (request) => invoke("network:download-url-as-base64", { request }),
    openaiImageEdit: (request) => invoke("network:openai-image-edit", { request }),
    openaiTranscription: (request) => invoke("network:openai-transcription", { request }),
    openaiSpeech: (request) => invoke("network:openai-speech", { request }),
    mimoSpeech: (request) => invoke("network:mimo-speech", { request }),
  },
  skills: {
    list: (skillType) => invoke("skills:list", { skillType }),
    readMetadata: (skillId) => invoke("skills:read-metadata", { skillId }),
    installFromGit: (repoUrl) => invoke("skills:install-git", { repoUrl }),
    installFromLocal: (sourcePath) => invoke("skills:install-local", { sourcePath }),
  },
  mcp: {
    stdioListTools: (server) => invoke("mcp:stdio-list-tools", { server }),
    stdioCallTool: (request) => invoke("mcp:stdio-call-tool", { request }),
  },
  shell: {
    exec: (request) => invoke("shell:exec", { request }),
  },
  knowledge: {
    create: (request) => invoke("knowledge:create", { request }),
    update: (request) => invoke("knowledge:update", { request }),
    addFiles: (request) => invoke("knowledge:addFiles", { request }),
    removeFile: (request) => invoke("knowledge:removeFile", { request }),
    getFiles: (kbId) => invoke("knowledge:getFiles", { kbId }),
    rebuild: (request) => invoke("knowledge:rebuild", { request }),
    query: (request) => invoke("knowledge:query", { request }),
    delete: (kbId) => invoke("knowledge:delete", { kbId }),
    list: () => invoke("knowledge:list"),
    checkCompatibility: (kbId, config) => invoke("knowledge:checkCompatibility", { kbId, config }),
    reembedIncompatible: (request) => invoke("knowledge:reembedIncompatible", { request }),
  },
});
