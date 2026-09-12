import { contextBridge, ipcRenderer } from "electron";
import type { OintApi } from "@/shared/contracts/api";
import type { ChatEventEnvelope } from "@/shared/contracts/chat";
import { IPC } from "@/shared/contracts/ipc";

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
  },
  chat: {
    send: (sessionId, text, images, messageId, options) =>
      ipcRenderer.invoke(IPC.chat.send, { sessionId, text, images, messageId, options }),
    stop: (sessionId) => ipcRenderer.invoke(IPC.chat.stop, { sessionId }),
    queue: (sessionId, text, mode) => ipcRenderer.invoke(IPC.chat.queue, { sessionId, text, mode }),
    compact: (sessionId, instructions) =>
      ipcRenderer.invoke(IPC.chat.compact, { sessionId, instructions }),
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
  },
  prompts: {
    list: (workingDir) => ipcRenderer.invoke(IPC.prompts.list, { workingDir }),
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
    probe: (config) => ipcRenderer.invoke(IPC.mcp.probe, config),
  },
  services: {
    fetchModels: (request) => ipcRenderer.invoke(IPC.services.fetchModels, request),
  },
  models: {
    lookup: (id) => ipcRenderer.invoke(IPC.models.lookup, { id }),
  },
} satisfies OintApi;

contextBridge.exposeInMainWorld("oint", api);
