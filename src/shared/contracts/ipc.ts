import type { AppInfo } from "./app";
import type { ApprovalDecision } from "./approval";
import type { ModelRef, WireFormat } from "./common";
import type { AskReply, AskRequest } from "./interaction";
import type { JobInfo } from "./job";
import type { McpProbeResult, McpServerConfig, McpServerView } from "./mcp";
import type { ModelLookupResult } from "./models";
import type { PermissionRuleView } from "./permissions";
import type { Project } from "./project";
import type { PromptTemplateInfo } from "./prompts";
import type {
  LoadSessionMessagesOptions,
  SessionMessagesPage,
  SessionSummary,
  SetSessionModelResult,
} from "./session";
import type { Settings } from "./settings";
import type { SkillInfo } from "./skills";

/**
 * 冻结的 IPC 通道契约：值统一为 "域:动作"。
 * 通道名先于实现冻结，避免渲染层与主进程各自漂移。
 */
export const IPC = {
  app: {
    getInfo: "app:get-info",
    openPath: "app:open-path",
  },
  window: {
    minimize: "window:minimize",
    toggleMaximize: "window:toggle-maximize",
    close: "window:close",
    onMaximizedChange: "window:maximized-change",
  },
  settings: {
    read: "settings:read",
    write: "settings:write",
  },
  sessions: {
    list: "sessions:list",
    create: "sessions:create",
    rename: "sessions:rename",
    delete: "sessions:delete",
    archive: "sessions:archive",
    fork: "sessions:fork",
    pin: "sessions:pin",
    loadMessages: "sessions:load-messages",
    setModel: "sessions:set-model",
  },
  projects: {
    list: "projects:list",
    add: "projects:add",
    remove: "projects:remove",
  },
  chat: {
    send: "chat:send",
    stop: "chat:stop",
    queue: "chat:queue",
    compact: "chat:compact",
    event: "chat:event",
  },
  approvals: {
    respond: "approvals:respond",
  },
  interaction: {
    respond: "interaction:respond",
    pending: "interaction:pending",
  },
  jobs: {
    list: "jobs:list",
    kill: "jobs:kill",
  },
  skills: {
    list: "skills:list",
  },
  prompts: {
    list: "prompts:list",
  },
  permissions: {
    listRules: "permissions:list-rules",
    addRule: "permissions:add-rule",
    removeRule: "permissions:remove-rule",
  },
  agents: {
    read: "agents:read",
    write: "agents:write",
  },
  dialog: {
    pickDirectory: "dialog:pick-directory",
  },
  mcp: {
    list: "mcp:list",
    reload: "mcp:reload",
    probe: "mcp:probe",
  },
  services: {
    fetchModels: "services:fetch-models",
  },
  models: {
    lookup: "models:lookup",
  },
} as const;

/**
 * invoke 通道的类型映射：通道 → { 请求, 响应 }。
 * 新增处理器时同步补充，保证 preload 与主进程类型一致。
 * 注意：IPC.chat.event 是主进程 → 渲染进程的单向推送，不属于 invoke 映射。
 */
export interface IpcInvokeContract {
  [IPC.app.getInfo]: { request: undefined; response: AppInfo };
  [IPC.app.openPath]: {
    request: { path: string };
    response: { ok: true } | { ok: false; reason: string };
  };
  [IPC.window.minimize]: { request: undefined; response: undefined };
  [IPC.window.toggleMaximize]: { request: undefined; response: undefined };
  [IPC.window.close]: { request: undefined; response: undefined };
  [IPC.settings.read]: { request: undefined; response: Settings };
  [IPC.settings.write]: { request: Settings; response: undefined };
  [IPC.sessions.list]: { request: undefined; response: SessionSummary[] };
  [IPC.sessions.create]: {
    request: { cwd?: string; title?: string } | undefined;
    response: SessionSummary;
  };
  [IPC.sessions.rename]: { request: { id: string; title: string }; response: undefined };
  [IPC.sessions.delete]: { request: { id: string }; response: undefined };
  [IPC.sessions.archive]: { request: { id: string; archived: boolean }; response: undefined };
  [IPC.sessions.pin]: { request: { id: string; pinned: boolean }; response: undefined };
  [IPC.sessions.setModel]: {
    request: { id: string; model: ModelRef | null };
    response: SetSessionModelResult;
  };
  [IPC.sessions.fork]: { request: { id: string; entryId: string }; response: SessionSummary };
  [IPC.sessions.loadMessages]: {
    request: { id: string; options?: LoadSessionMessagesOptions };
    response: SessionMessagesPage;
  };
  [IPC.projects.list]: { request: undefined; response: Project[] };
  [IPC.projects.add]: { request: { path: string }; response: Project };
  [IPC.projects.remove]: { request: { id: string }; response: undefined };
  [IPC.chat.send]: {
    request: {
      sessionId: string;
      text: string;
      images?: { data: string; mimeType: string }[];
      /** 渲染层乐观消息 id：主进程回显用户消息时复用，避免 UI 出现两条相同消息 */
      messageId?: string;
    };
    response: undefined;
  };
  [IPC.chat.stop]: { request: { sessionId: string }; response: undefined };
  [IPC.chat.queue]: {
    request: { sessionId: string; text: string; mode: "steer" | "followUp" };
    response: undefined;
  };
  [IPC.chat.compact]: {
    request: { sessionId: string; instructions?: string };
    response: undefined;
  };
  [IPC.approvals.respond]: {
    request: { id: string; decision: ApprovalDecision; note?: string };
    response: undefined;
  };
  [IPC.interaction.respond]: {
    request: { id: string; reply: AskReply };
    response: undefined;
  };
  [IPC.interaction.pending]: {
    request: { sessionId?: string } | undefined;
    response: AskRequest[];
  };
  [IPC.jobs.list]: {
    request: { sessionId: string };
    response: JobInfo[];
  };
  [IPC.jobs.kill]: {
    request: { sessionId: string; id: string };
    response: JobInfo;
  };
  [IPC.skills.list]: {
    request: { workingDir?: string } | undefined;
    response: SkillInfo[];
  };
  [IPC.prompts.list]: {
    request: { workingDir?: string } | undefined;
    response: PromptTemplateInfo[];
  };
  [IPC.permissions.listRules]: { request: undefined; response: PermissionRuleView[] };
  [IPC.permissions.addRule]: { request: PermissionRuleView; response: undefined };
  [IPC.permissions.removeRule]: {
    request: { toolName: string; pattern?: string };
    response: undefined;
  };
  [IPC.agents.read]: { request: undefined; response: string };
  [IPC.agents.write]: { request: { content: string }; response: undefined };
  [IPC.dialog.pickDirectory]: {
    request: { defaultPath?: string } | undefined;
    response: string | null;
  };
  [IPC.mcp.list]: { request: undefined; response: McpServerView[] };
  [IPC.mcp.reload]: { request: undefined; response: McpServerView[] };
  [IPC.mcp.probe]: { request: McpServerConfig; response: McpProbeResult };
  [IPC.services.fetchModels]: {
    request: { baseUrl: string; apiKey: string; wireFormat: WireFormat };
    response: { ok: true; modelIds: string[] } | { ok: false; reason: string };
  };
  [IPC.models.lookup]: { request: { id: string }; response: ModelLookupResult };
}
