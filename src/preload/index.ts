import { contextBridge, ipcRenderer } from "electron";
import type { PolarAgentApi } from "@/shared/contracts/api";
import type { ChatEvent } from "@/shared/contracts/chat";
import { IPC } from "@/shared/contracts/ipc";

// 渲染进程唯一入口：只暴露白名单方法，不透传 ipcRenderer 原始能力
const api = {
  app: {
    getInfo: () => ipcRenderer.invoke(IPC.app.getInfo),
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
    remove: (id) => ipcRenderer.invoke(IPC.sessions.delete, { id }),
    fork: (id, entryId) => ipcRenderer.invoke(IPC.sessions.fork, { id, entryId }),
    loadMessages: (id, options) => ipcRenderer.invoke(IPC.sessions.loadMessages, { id, options }),
  },
  chat: {
    send: (sessionId, text, images, messageId) =>
      ipcRenderer.invoke(IPC.chat.send, { sessionId, text, images, messageId }),
    stop: (sessionId) => ipcRenderer.invoke(IPC.chat.stop, { sessionId }),
    queue: (sessionId, text, mode) => ipcRenderer.invoke(IPC.chat.queue, { sessionId, text, mode }),
    compact: (sessionId, instructions) =>
      ipcRenderer.invoke(IPC.chat.compact, { sessionId, instructions }),
    onEvent: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, event: ChatEvent) => callback(event);
      ipcRenderer.on(IPC.chat.event, listener);
      return () => ipcRenderer.removeListener(IPC.chat.event, listener);
    },
  },
  approvals: {
    respond: (id, decision, note) =>
      ipcRenderer.invoke(IPC.approvals.respond, { id, decision, note }),
  },
  skills: {
    list: (workingDir) => ipcRenderer.invoke(IPC.skills.list, { workingDir }),
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
  dialog: {
    pickDirectory: (defaultPath) => ipcRenderer.invoke(IPC.dialog.pickDirectory, { defaultPath }),
  },
  services: {
    fetchModels: (request) => ipcRenderer.invoke(IPC.services.fetchModels, request),
  },
  models: {
    lookup: (id) => ipcRenderer.invoke(IPC.models.lookup, { id }),
  },
} satisfies PolarAgentApi;

contextBridge.exposeInMainWorld("polaragent", api);
