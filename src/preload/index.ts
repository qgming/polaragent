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
    pickZipFile: () => invoke("dialog:pick-zip-file"),
    getPathForFile: (file: File) => webUtils.getPathForFile(file),
    pickImageFile: () => invoke("dialog:pick-image-file"),
    pickAudioFile: () => invoke("dialog:pick-audio-file"),
    pickDocumentFile: () => invoke("dialog:pick-document-file"),
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
  preview: {
    open: (path: string) => invoke("preview:open", { path }),
  },
  updates: {
    getStatus: () => invoke("updates:get-status"),
    check: () => invoke("updates:check"),
    download: () => invoke("updates:download"),
    install: () => invoke("updates:install"),
    openReleases: () => invoke("updates:open-releases"),
    onStatus: (handler: (payload: unknown) => void) => {
      const listener = (_event: unknown, payload: unknown) => handler(payload);
      ipcRenderer.on("updates:status", listener);
      return () => ipcRenderer.removeListener("updates:status", listener);
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
    listMcp: () => invoke("config:list-mcp"),
    readMcp: (mcpId: string) => invoke("config:read-mcp", { mcpId }),
    writeMcp: (mcpId: string, content: string) => invoke("config:write-mcp", { mcpId, content }),
    deleteMcp: (mcpId: string) => invoke("config:delete-mcp", { mcpId }),
    fetchBuiltinMcpConfigs: () => invoke("config:fetch-builtin-mcp"),
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
    corsFetch: (request: unknown) => invoke("network:cors-fetch", { request }),
    webSearch: (request: unknown) => invoke("network:web-search", { request }),
    downloadUrlAsBase64: (request: unknown) => invoke("network:download-url-as-base64", { request }),
    openaiImageEdit: (request: unknown) => invoke("network:openai-image-edit", { request }),
    openaiTranscription: (request: unknown) => invoke("network:openai-transcription", { request }),
    openaiSpeech: (request: unknown) => invoke("network:openai-speech", { request }),
    mimoSpeech: (request: unknown) => invoke("network:mimo-speech", { request }),
  },
  skills: {
    list: (skillType?: string) => invoke("skills:list", { skillType }),
    readMetadata: (skillId: string) => invoke("skills:read-metadata", { skillId }),
    installFromGit: (repoUrl: string) => invoke("skills:install-git", { repoUrl }),
    installFromLocal: (sourcePath: string) => invoke("skills:install-local", { sourcePath }),
    installFromZip: (zipPath: string) => invoke("skills:install-zip", { zipPath }),
    uninstall: (skillId: string) => invoke("skills:uninstall", { skillId }),
    writeSkill: (name: string, content: string) => invoke("skills:write-skill", { name, content }),
    patchSkill: (name: string, oldString: string, newString: string) => invoke("skills:patch-skill", { name, oldString, newString }),
    deleteSkillByName: (name: string) => invoke("skills:delete-skill", { name }),
  },
  mcp: {
    stdioListTools: (server: unknown) => invoke("mcp:stdio-list-tools", { server }),
    stdioCallTool: (request: unknown) => invoke("mcp:stdio-call-tool", { request }),
  },
  shell: {
    exec: (request: unknown) => invoke("shell:exec", { request }),
  },
  office: {
    htmlToPdf: (request: unknown) => invoke("office:html-to-pdf", { request }),
    htmlToPptx: (request: unknown) => invoke("office:html-to-pptx", { request }),
  },
  cli: {
    detect: (cliName: string) => invoke("cli:detect", { cliName }),
    detectBatch: (cliNames: string[]) => invoke("cli:detect-batch", { cliNames }),
    getVersions: (cliNames: string[]) => invoke("cli:get-versions", { cliNames }),
  },
  knowledge: {
    create: (request: unknown) => invoke("knowledge:create", { request }),
    update: (request: unknown) => invoke("knowledge:update", { request }),
    addFiles: (request: unknown) => invoke("knowledge:addFiles", { request }),
    removeFile: (request: unknown) => invoke("knowledge:removeFile", { request }),
    getFiles: (kbId: string) => invoke("knowledge:getFiles", { kbId }),
    rebuild: (request: unknown) => invoke("knowledge:rebuild", { request }),
    rebuildFile: (request: unknown) => invoke("knowledge:rebuildFile", { request }),
    query: (request: unknown) => invoke("knowledge:query", { request }),
    delete: (kbId: string) => invoke("knowledge:delete", { kbId }),
    list: () => invoke("knowledge:list"),
    checkCompatibility: (kbId: string, config: unknown) => invoke("knowledge:checkCompatibility", { kbId, config }),
    reembedIncompatible: (request: unknown) => invoke("knowledge:reembedIncompatible", { request }),
  },
  memory: {
    list: (request: unknown) => invoke("memory:list", { request }),
    search: (request: unknown) => invoke("memory:search", { request }),
    create: (request: unknown) => invoke("memory:create", { request }),
    update: (request: unknown) => invoke("memory:update", { request }),
    delete: (request: unknown) => invoke("memory:delete", { request }),
    archive: (request: unknown) => invoke("memory:archive", { request }),
    stats: () => invoke("memory:stats"),
    rebuild: (request: unknown) => invoke("memory:rebuild", { request }),
  },
  computeruse: {
    configure: (config: unknown) => invoke("cu:configure", config),
    workerStatus: () => invoke("cu:worker-status"),
    restartWorker: () => invoke("cu:restart-worker"),
    health: () => invoke("cu:health"),
    snapshot: (opts?: unknown) => invoke("cu:snapshot", opts),
    tree: (opts?: unknown) => invoke("cu:tree", opts),
    click: (opts: unknown) => invoke("cu:click", opts),
    doubleClick: (opts: unknown) => invoke("cu:double-click", opts),
    move: (opts: unknown) => invoke("cu:move", opts),
    drag: (opts: unknown) => invoke("cu:drag", opts),
    scroll: (opts: unknown) => invoke("cu:scroll", opts),
    type: (opts: unknown) => invoke("cu:type", opts),
    keypress: (opts: unknown) => invoke("cu:keypress", opts),
    find: (opts: unknown) => invoke("cu:find", opts),
    elementInfo: (opts: unknown) => invoke("cu:element-info", opts),
    focus: (opts: unknown) => invoke("cu:focus", opts),
    invoke: (opts: unknown) => invoke("cu:invoke", opts),
    setValue: (opts: unknown) => invoke("cu:set-value", opts),
    listWindows: (opts?: unknown) => invoke("cu:list-windows", opts),
    activateWindow: (opts: unknown) => invoke("cu:activate-window", opts),
    wait: (opts: unknown) => invoke("cu:wait", opts),
    batch: (opts: unknown) => invoke("cu:batch", opts),
  },
  browseruse: {
    call: (params: unknown) => invoke("browser-use:call", params),
    status: () => invoke("browser-use:status"),
    configure: (config: unknown) => invoke("browser-use:configure", config),
    restart: () => invoke("browser-use:restart"),
    syncExtensionPort: (port: number) => invoke("browser-use:sync-extension-port", { port }),
    clearDebugSessions: () => invoke("browser-use:clear-debug-sessions"),
    exportExtension: () => invoke("browser-use:export-extension"),
  },
});
