import type { AppInfo } from "./app";
import type { ApprovalDecision } from "./approval";
import type { ChatEvent, ChatSendOptions } from "./chat";
import type { WireFormat } from "./common";
import type { ModelLookupResult } from "./models";
import type { PermissionRuleView } from "./permissions";
import type { LoadSessionMessagesOptions, SessionMessagesPage, SessionSummary } from "./session";
import type { Settings } from "./settings";
import type { SkillInfo } from "./skills";

/** preload 暴露给渲染进程的全部能力面；渲染进程除此外无特权通道 */
export interface PolarAgentApi {
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
    remove(id: string): Promise<void>;
    fork(id: string, entryId: string): Promise<SessionSummary>;
    loadMessages(id: string, options?: LoadSessionMessagesOptions): Promise<SessionMessagesPage>;
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
    /** 订阅主进程推送的聊天事件，返回取消订阅函数 */
    onEvent(callback: (event: ChatEvent) => void): () => void;
  };
  approvals: {
    respond(id: string, decision: ApprovalDecision, note?: string): Promise<void>;
  };
  skills: {
    /** 扫描全局与会话工作目录的技能；workingDir 缺省用默认工作目录 */
    list(workingDir?: string): Promise<SkillInfo[]>;
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
}
