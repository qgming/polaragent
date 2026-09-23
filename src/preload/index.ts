import { contextBridge, ipcRenderer } from "electron";
import type { OintApi } from "@/shared/contracts/api";
import type { BrowserEvent } from "@/shared/contracts/browser";
import type { ChatEventEnvelope } from "@/shared/contracts/chat";
import { IPC } from "@/shared/contracts/ipc";
import type { SubagentEventEnvelope } from "@/shared/contracts/subagent";
import type { TerminalEvent } from "@/shared/contracts/terminal";

// 渲染进程唯一入口：只暴露白名单方法，不透传 ipcRenderer 原始能力
const api = {
  app: {
    getInfo: () => ipcRenderer.invoke(IPC.app.getInfo),
    openPath: (target) => ipcRenderer.invoke(IPC.app.openPath, { path: target }),
  },
  window: {
    minimize: () => ipcRenderer.invoke(IPC.window.minimize),
    toggleMaximize: () => ipcRenderer.invoke(IPC.window.toggleMaximize),
    close: () => ipcRenderer.invoke(IPC.window.close),
    onMaximizedChange: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, maximized: boolean) =>
        callback(maximized);
      ipcRenderer.on(IPC.window.onMaximizedChange, listener);
      return () => ipcRenderer.removeListener(IPC.window.onMaximizedChange, listener);
    },
  },
  settings: {
    read: () => ipcRenderer.invoke(IPC.settings.read),
    write: (next) => ipcRenderer.invoke(IPC.settings.write, next),
  },
  sessions: {
    list: () => ipcRenderer.invoke(IPC.sessions.list),
    create: (options) => ipcRenderer.invoke(IPC.sessions.create, options),
    rename: (id, title) => ipcRenderer.invoke(IPC.sessions.rename, { id, title }),
    setArchived: (id, archived) => ipcRenderer.invoke(IPC.sessions.archive, { id, archived }),
    setPinned: (id, pinned) => ipcRenderer.invoke(IPC.sessions.pin, { id, pinned }),
    remove: (id) => ipcRenderer.invoke(IPC.sessions.delete, { id }),
    fork: (id, entryId) => ipcRenderer.invoke(IPC.sessions.fork, { id, entryId }),
    loadMessages: (id, options) => ipcRenderer.invoke(IPC.sessions.loadMessages, { id, options }),
    setModel: (id, model) => ipcRenderer.invoke(IPC.sessions.setModel, { id, model }),
    setMode: (id, mode) => ipcRenderer.invoke(IPC.sessions.setMode, { id, mode }),
  },
  chat: {
    send: (sessionId, text, images, messageId, options) =>
      ipcRenderer.invoke(IPC.chat.send, { sessionId, text, images, messageId, options }),
    stop: (sessionId) => ipcRenderer.invoke(IPC.chat.stop, { sessionId }),
    queue: (sessionId, text, mode) => ipcRenderer.invoke(IPC.chat.queue, { sessionId, text, mode }),
    cancelQueued: (sessionId, entryId) =>
      ipcRenderer.invoke(IPC.chat.cancelQueued, { sessionId, entryId }),
    compact: (sessionId, instructions) =>
      ipcRenderer.invoke(IPC.chat.compact, { sessionId, instructions }),
    snapshot: (sessionId) => ipcRenderer.invoke(IPC.chat.snapshot, { sessionId }),
    onEvent: (callback) => {
      // 透传信封（事件 + 所属会话 id）：归属由主进程给出，渲染层不再靠「当前会话」猜
      const listener = (_event: Electron.IpcRendererEvent, payload: ChatEventEnvelope) =>
        callback(payload);
      ipcRenderer.on(IPC.chat.event, listener);
      return () => ipcRenderer.removeListener(IPC.chat.event, listener);
    },
  },
  approvals: {
    respond: (id, decision, note) =>
      ipcRenderer.invoke(IPC.approvals.respond, { id, decision, note }),
  },
  interaction: {
    respond: (id, reply) => ipcRenderer.invoke(IPC.interaction.respond, { id, reply }),
    pending: (sessionId) => ipcRenderer.invoke(IPC.interaction.pending, { sessionId }),
  },
  jobs: {
    list: (sessionId) => ipcRenderer.invoke(IPC.jobs.list, { sessionId }),
    kill: (sessionId, id) => ipcRenderer.invoke(IPC.jobs.kill, { sessionId, id }),
  },
  skills: {
    list: (workingDir) => ipcRenderer.invoke(IPC.skills.list, { workingDir }),
    import: () => ipcRenderer.invoke(IPC.skills.import),
    read: (name) => ipcRenderer.invoke(IPC.skills.read, { name }),
    remove: (name) => ipcRenderer.invoke(IPC.skills.remove, { name }),
  },
  prompts: {
    list: (workingDir) => ipcRenderer.invoke(IPC.prompts.list, { workingDir }),
    write: (request) => ipcRenderer.invoke(IPC.prompts.write, request),
    remove: (name) => ipcRenderer.invoke(IPC.prompts.remove, { name }),
  },
  subagents: {
    list: (workingDir) => ipcRenderer.invoke(IPC.subagents.list, { workingDir }),
    read: (name) => ipcRenderer.invoke(IPC.subagents.read, { name }),
    write: (request) => ipcRenderer.invoke(IPC.subagents.write, request),
    remove: (name) => ipcRenderer.invoke(IPC.subagents.remove, { name }),
    reveal: (name) => ipcRenderer.invoke(IPC.subagents.reveal, { name }),
    runs: (sessionId) => ipcRenderer.invoke(IPC.subagents.runs, { sessionId }),
    stop: (sessionId, delegationId) =>
      ipcRenderer.invoke(IPC.subagents.stop, { sessionId, delegationId }),
    onEvent: (callback) => {
      // 与 chat.onEvent 同一套：透传信封（事件 + 所属父会话 id）
      const listener = (_event: Electron.IpcRendererEvent, payload: SubagentEventEnvelope) =>
        callback(payload);
      ipcRenderer.on(IPC.subagents.event, listener);
      return () => ipcRenderer.removeListener(IPC.subagents.event, listener);
    },
  },
  permissions: {
    listRules: () => ipcRenderer.invoke(IPC.permissions.listRules),
    addRule: (rule) => ipcRenderer.invoke(IPC.permissions.addRule, rule),
    removeRule: (toolName, pattern) =>
      ipcRenderer.invoke(IPC.permissions.removeRule, { toolName, pattern }),
  },
  agents: {
    read: () => ipcRenderer.invoke(IPC.agents.read),
    write: (content) => ipcRenderer.invoke(IPC.agents.write, { content }),
  },
  projects: {
    list: () => ipcRenderer.invoke(IPC.projects.list),
    add: (path) => ipcRenderer.invoke(IPC.projects.add, { path }),
    remove: (id) => ipcRenderer.invoke(IPC.projects.remove, { id }),
  },
  dialog: {
    pickDirectory: (defaultPath) => ipcRenderer.invoke(IPC.dialog.pickDirectory, { defaultPath }),
  },
  mcp: {
    list: () => ipcRenderer.invoke(IPC.mcp.list),
    reload: () => ipcRenderer.invoke(IPC.mcp.reload),
    reconnect: (serverId) => ipcRenderer.invoke(IPC.mcp.reconnect, { serverId }),
    probe: (config) => ipcRenderer.invoke(IPC.mcp.probe, config),
  },
  services: {
    fetchModels: (request) => ipcRenderer.invoke(IPC.services.fetchModels, request),
  },
  models: {
    lookup: (id) => ipcRenderer.invoke(IPC.models.lookup, { id }),
  },
  terminal: {
    list: () => ipcRenderer.invoke(IPC.terminal.list),
    create: (options) => ipcRenderer.invoke(IPC.terminal.create, options),
    replay: (id, fromSeq) => ipcRenderer.invoke(IPC.terminal.replay, { id, fromSeq }),
    write: (id, data) => ipcRenderer.invoke(IPC.terminal.write, { id, data }),
    resize: (id, cols, rows) => ipcRenderer.invoke(IPC.terminal.resize, { id, cols, rows }),
    close: (id) => ipcRenderer.invoke(IPC.terminal.close, { id }),
    onEvent: (callback) => {
      // 与 chat.onEvent 同一套：透传事件本体，归属由事件自己的 id 字段给出
      const listener = (_event: Electron.IpcRendererEvent, payload: TerminalEvent) =>
        callback(payload);
      ipcRenderer.on(IPC.terminal.event, listener);
      return () => ipcRenderer.removeListener(IPC.terminal.event, listener);
    },
  },
  files: {
    // 只传 sessionId：根目录由主进程从会话索引解析，渲染层给不了路径
    listDirectory: (request) => ipcRenderer.invoke(IPC.files.listDirectory, request),
    readFile: (request) => ipcRenderer.invoke(IPC.files.readFile, request),
    readImage: (request) => ipcRenderer.invoke(IPC.files.readImage, request),
  },
  review: {
    summary: (sessionId) => ipcRenderer.invoke(IPC.review.summary, { sessionId }),
  },
  browser: {
    status: () => ipcRenderer.invoke(IPC.browser.status),
    registerTab: (tabId, webContentsId, requestId) =>
      ipcRenderer.invoke(IPC.browser.registerTab, { tabId, webContentsId, requestId }),
    unregisterTab: (tabId) => ipcRenderer.invoke(IPC.browser.unregisterTab, { tabId }),
    activateTab: (tabId) => ipcRenderer.invoke(IPC.browser.activateTab, { tabId }),
    onEvent: (callback) => {
      // 与 chat.onEvent / terminal.onEvent 同一套：透传事件本体，归属由事件自己的字段给出
      const listener = (_event: Electron.IpcRendererEvent, payload: BrowserEvent) =>
        callback(payload);
      ipcRenderer.on(IPC.browser.event, listener);
      return () => ipcRenderer.removeListener(IPC.browser.event, listener);
    },
  },
  web: {
    // 用草稿配置做一次真实检索：「测试连接」与「是否已保存」解耦
    test: (request) => ipcRenderer.invoke(IPC.web.test, request),
  },
} satisfies OintApi;

contextBridge.exposeInMainWorld("oint", api);
