import type { AppInfo } from "./app";
import type { ApprovalDecision } from "./approval";
import type { ChatEventEnvelope, ChatSendOptions } from "./chat";
import type { ModelRef, WireFormat } from "./common";
import type { DirectoryListing, FileContent } from "./files";
import type { AskReply, AskRequest } from "./interaction";
import type { JobInfo } from "./job";
import type { McpProbeResult, McpServerConfig, McpServerView } from "./mcp";
import type { ModelLookupResult } from "./models";
import type { PermissionRuleView } from "./permissions";
import type { Project } from "./project";
import type { PromptTemplateInfo } from "./prompts";
import type { ReviewSummary } from "./review";
import type {
  LoadSessionMessagesOptions,
  SessionMessagesPage,
  SessionSummary,
  SetSessionModelResult,
} from "./session";
import type { Settings } from "./settings";
import type { SkillInfo } from "./skills";
import type { TerminalEvent, TerminalInfo, TerminalReplay } from "./terminal";

/** preload 暴露给渲染进程的全部能力面；渲染进程除此外无特权通道 */
export interface OintApi {
  app: {
    getInfo(): Promise<AppInfo>;
    /** 用系统默认程序打开一个绝对路径（目录或文件）；失败时返回原因，不抛异常 */
    openPath(path: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  };
  window: {
    minimize(): Promise<void>;
    toggleMaximize(): Promise<void>;
    close(): Promise<void>;
    /** 订阅最大化状态变化，返回取消订阅函数 */
    onMaximizedChange(callback: (maximized: boolean) => void): () => void;
  };
  settings: {
    read(): Promise<Settings>;
    write(next: Settings): Promise<void>;
  };
  sessions: {
    list(): Promise<SessionSummary[]>;
    create(options?: { cwd?: string; title?: string }): Promise<SessionSummary>;
    rename(id: string, title: string): Promise<void>;
    setArchived(id: string, archived: boolean): Promise<void>;
    /** 置顶/取消置顶 */
    setPinned(id: string, pinned: boolean): Promise<void>;
    /**
     * 切换该会话使用的模型（null = 跟随设置里的默认模型）。
     *
     * 立即生效：下一次发送就用新模型，会话上下文完整保留。运行中会被拒绝（reason: "running"）。
     */
    setModel(id: string, model: ModelRef | null): Promise<SetSessionModelResult>;
    remove(id: string): Promise<void>;
    fork(id: string, entryId: string): Promise<SessionSummary>;
    loadMessages(id: string, options?: LoadSessionMessagesOptions): Promise<SessionMessagesPage>;
  };
  projects: {
    list(): Promise<Project[]>;
    /** 绑定一个文件夹；该路径已绑定时返回已有项目（不重复添加） */
    add(path: string): Promise<Project>;
    /** 解绑项目：只删项目本身，会话与其工作目录都不动 */
    remove(id: string): Promise<void>;
  };
  chat: {
    send(
      sessionId: string,
      text: string,
      images?: { data: string; mimeType: string }[],
      messageId?: string,
      /** 重新生成 / 编辑：先回退到指定条目再运行 */
      options?: ChatSendOptions,
    ): Promise<void>;
    stop(sessionId: string): Promise<void>;
    queue(sessionId: string, text: string, mode: "steer" | "followUp"): Promise<void>;
    compact(sessionId: string, instructions?: string): Promise<void>;
    /** 订阅主进程推送的聊天事件（含所属会话 id），返回取消订阅函数 */
    onEvent(callback: (payload: ChatEventEnvelope) => void): () => void;
  };
  approvals: {
    respond(id: string, decision: ApprovalDecision, note?: string): Promise<void>;
  };
  interaction: {
    /** 回填一次提问的答案；未知 id 或已处理时主进程只记日志，不打断渲染层 */
    respond(id: string, reply: AskReply): Promise<void>;
    /** 未决提问列表（会话切换时恢复卡片）；sessionId 缺省返回全部 */
    pending(sessionId?: string): Promise<AskRequest[]>;
  };
  jobs: {
    /** 该会话的后台作业（会话切换时恢复面板用） */
    list(sessionId: string): Promise<JobInfo[]>;
    /** 杀掉一个后台作业（界面上「停止」按钮用） */
    kill(sessionId: string, id: string): Promise<JobInfo>;
  };
  skills: {
    /** 扫描全局与会话工作目录的技能；workingDir 缺省用默认工作目录 */
    list(workingDir?: string): Promise<SkillInfo[]>;
  };
  prompts: {
    /** 扫描全局与会话工作目录的提示模板；workingDir 缺省用默认工作目录 */
    list(workingDir?: string): Promise<PromptTemplateInfo[]>;
  };
  permissions: {
    listRules(): Promise<PermissionRuleView[]>;
    addRule(rule: PermissionRuleView): Promise<void>;
    removeRule(toolName: string, pattern?: string): Promise<void>;
  };
  agents: {
    /** 读取 AGENTS.md；不存在时返回空串 */
    read(): Promise<string>;
    write(content: string): Promise<void>;
  };
  dialog: {
    /** 打开系统目录选择框；取消返回 null */
    pickDirectory(defaultPath?: string): Promise<string | null>;
  };
  mcp: {
    /** 读取 MCP server 配置与连接状态（状态来自主进程的连接池） */
    list(): Promise<McpServerView[]>;
    /** 按当前设置重新连接（连上该连的、断开该断的），返回最新状态 */
    reload(): Promise<McpServerView[]>;
    /** 用草稿配置试连一次：不写设置、不影响已有连接 */
    probe(config: McpServerConfig): Promise<McpProbeResult>;
  };
  services: {
    /** 从 OpenAI 兼容端点拉取可用模型 id 列表 */
    fetchModels(request: {
      baseUrl: string;
      apiKey: string;
      wireFormat: WireFormat;
    }): Promise<{ ok: true; modelIds: string[] } | { ok: false; reason: string }>;
  };
  models: {
    /** 按模型 id 从 models.dev 元数据目录匹配（带本地缓存） */
    lookup(id: string): Promise<ModelLookupResult>;
  };
  /**
   * 用户终端（真 PTY）。
   *
   * 与 jobs 分开：jobs 是模型的后台作业（无 stdin），这里是给人敲的交互式 shell。
   * 输出走 onEvent 推送（带 seq，供按游标回放），replay 用于面板重新挂载时补齐。
   */
  terminal: {
    /** 当前全部终端（面板挂载时拉一次） */
    list(): Promise<TerminalInfo[]>;
    /** 新建一个终端；cwd 由调用方给（会话工作目录） */
    create(options: { cwd: string; cols?: number; rows?: number }): Promise<TerminalInfo>;
    /** 按游标回放：fromSeq 之后的新增输出；面板重新挂载时用它补齐断档 */
    replay(id: string, fromSeq: number): Promise<TerminalReplay>;
    /** 写入按键（键盘输入、粘贴、Ctrl+C 的 \x03） */
    write(id: string, data: string): Promise<void>;
    /** 改尺寸（面板换行或拖宽窄时调用） */
    resize(id: string, cols: number, rows: number): Promise<void>;
    /** 关闭终端（连同进程树） */
    close(id: string): Promise<void>;
    /** 订阅终端事件（输出 / 元信息变化 / 移除），返回取消订阅函数 */
    onEvent(callback: (event: TerminalEvent) => void): () => void;
  };
  /** 右侧面板「文件」：列目录与读文件，根固定为传入的 root */
  files: {
    /** 列一层目录；path 缺省用 root */
    listDirectory(request: { root: string; path?: string }): Promise<DirectoryListing>;
    /** 读一个文件（等宽预览用，超出上限会截断） */
    readFile(request: { root: string; path: string }): Promise<FileContent>;
  };
  /** 右侧面板「审查」：本次会话改动过的文件与补丁 */
  review: {
    /** 从会话消息里的 write / edit 记录汇总改动 */
    summary(sessionId: string): Promise<ReviewSummary>;
  };
}
