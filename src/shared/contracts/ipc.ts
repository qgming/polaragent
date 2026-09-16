import type { AppInfo } from "./app";
import type { ApprovalDecision } from "./approval";
import type { BrowserStatus } from "./browser";
import type { ModelRef, WireFormat } from "./common";
import type { DirectoryListing, FileContent } from "./files";
import type { AskReply, AskRequest } from "./interaction";
import type { JobInfo } from "./job";
import type { McpProbeResult, McpServerConfig, McpServerView } from "./mcp";
import type { ModelLookupResult } from "./models";
import type { PermissionRuleView } from "./permissions";
import type { Project } from "./project";
import type { PromptTemplateInfo, PromptTemplateWriteRequest } from "./prompts";
import type { ReviewSummary } from "./review";
import type {
  LoadSessionMessagesOptions,
  SessionCreateOptions,
  SessionMessagesPage,
  SessionSummary,
  SetSessionModelResult,
} from "./session";
import type { Settings } from "./settings";
import type { SkillDetail, SkillImportResult, SkillInfo } from "./skills";
import type {
  SubagentCatalog,
  SubagentInfo,
  SubagentReadResult,
  SubagentRun,
  SubagentWriteRequest,
} from "./subagent";
import type { TerminalInfo, TerminalReplay } from "./terminal";

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
    /** 拉取某会话当前流式消息的完整快照（增量缺口时整条补齐，见 ChatStreamSnapshot） */
    snapshot: "chat:snapshot",
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
    /** 弹出文件选择框，把 zip 技能包解压导入数据目录的 skills/ */
    import: "skills:import",
    read: "skills:read",
    remove: "skills:remove",
  },
  prompts: {
    list: "prompts:list",
    write: "prompts:write",
    remove: "prompts:remove",
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
  /**
   * 子智能体：定义目录的读写 + 运行记录的查询/停止。
   *
   * `runs` 按**父会话**过滤：一次委派是主会话里的一次工具调用，
   * 详情面板取的是「当前这个会话派出去的子智能体」，而不是全局运行列表。
   * `event` 与 chat:event 同构，是主进程 → 渲染进程的单向推送，不属于 invoke 映射。
   */
  subagents: {
    list: "subagents:list",
    read: "subagents:read",
    write: "subagents:write",
    remove: "subagents:remove",
    reveal: "subagents:reveal",
    runs: "subagents:runs",
    stop: "subagents:stop",
    event: "subagents:event",
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
  terminal: {
    list: "terminal:list",
    create: "terminal:create",
    replay: "terminal:replay",
    write: "terminal:write",
    resize: "terminal:resize",
    close: "terminal:close",
    /** 主进程 → 渲染进程的单向推送（与 chat:event 一样不属于 invoke 映射） */
    event: "terminal:event",
  },
  files: {
    listDirectory: "files:list-directory",
    readFile: "files:read-file",
  },
  review: {
    summary: "review:summary",
  },
  /**
   * 内置浏览器：状态读取 + 标签注册（三个 invoke 通道）。
   *
   * 页面的驱动（导航 / 点击 / 读内容）**不经过渲染层**：guest 由主进程从
   * did-attach-webview 拿到后直接操作（见 browser/service.ts）。渲染层的面板只需
   * 把 <webview> 建出来、把「哪个 tabId 对应哪个 webContents」登记回来，
   * 再用下面的 event 订阅「页面变了 / 模型在操作 / 请你开标签」。
   */
  browser: {
    status: "browser:status",
    /** 登记一个标签：渲染层建好 webview 后调用，主进程据此把 tabId 与 guest 绑定 */
    registerTab: "browser:register-tab",
    /** 注销一个标签：标签页被关闭时调用，主进程释放它的 guest 引用与缓冲 */
    unregisterTab: "browser:unregister-tab",
    /** 用户切到了某个标签：主进程用它回答「active 是哪一个」 */
    activateTab: "browser:activate-tab",
    /** 主进程 → 渲染进程的单向推送（同 terminal:event） */
    event: "browser:event",
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
    request: SessionCreateOptions | undefined;
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
  [IPC.skills.import]: { request: undefined; response: SkillImportResult };
  [IPC.skills.read]: { request: { name: string }; response: SkillDetail };
  [IPC.skills.remove]: { request: { name: string }; response: undefined };
  [IPC.prompts.write]: {
    request: PromptTemplateWriteRequest;
    response: PromptTemplateInfo;
  };
  [IPC.prompts.remove]: { request: { name: string }; response: undefined };
  [IPC.subagents.list]: {
    request: { workingDir?: string } | undefined;
    response: SubagentCatalog;
  };
  [IPC.subagents.read]: { request: { name: string }; response: SubagentReadResult };
  [IPC.subagents.write]: { request: SubagentWriteRequest; response: SubagentInfo };
  [IPC.subagents.remove]: { request: { name: string }; response: undefined };
  [IPC.subagents.reveal]: { request: { name: string }; response: { ok: boolean } };
  [IPC.subagents.runs]: { request: { sessionId: string }; response: SubagentRun[] };
  [IPC.subagents.stop]: {
    request: { sessionId: string; delegationId: string };
    /** 不在本进程运行中的记录没有可停的东西（例如对账出来的 interrupted） */
    response: SubagentRun | undefined;
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
  [IPC.terminal.list]: { request: undefined; response: TerminalInfo[] };
  [IPC.terminal.create]: {
    request: { cwd: string; cols?: number; rows?: number };
    response: TerminalInfo;
  };
  [IPC.terminal.replay]: {
    request: { id: string; fromSeq: number };
    response: TerminalReplay;
  };
  [IPC.terminal.write]: { request: { id: string; data: string }; response: undefined };
  [IPC.terminal.resize]: {
    request: { id: string; cols: number; rows: number };
    response: undefined;
  };
  [IPC.terminal.close]: { request: { id: string }; response: undefined };
  [IPC.files.listDirectory]: {
    request: { path?: string; root: string };
    response: DirectoryListing;
  };
  [IPC.files.readFile]: { request: { path: string; root: string }; response: FileContent };
  [IPC.review.summary]: { request: { sessionId: string }; response: ReviewSummary };
  [IPC.browser.status]: { request: undefined; response: BrowserStatus };
  [IPC.browser.registerTab]: {
    /**
     * 渲染层把一个浏览器标签的 guest 交给主进程。
     *
     * webContentsId 由 webview 元素的 getWebContentsId() 给出（主进程据此找到那个
     * guest）；requestId 是回执：主进程之前在 open-request 里给的凭据，
     * 带回来表示「你要的那个标签已经建好并挂上了」。
     */
    request: { tabId: string; webContentsId: number; requestId?: string };
    response: undefined;
  };
  [IPC.browser.unregisterTab]: { request: { tabId: string }; response: undefined };
  [IPC.browser.activateTab]: { request: { tabId: string }; response: undefined };
}
