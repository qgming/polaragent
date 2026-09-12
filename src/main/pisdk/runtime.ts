// 会话运行时：装配 AgentHarness、把 pi 事件桥接为 ChatEvent、维护运行/队列/审批门。

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  AgentHarness,
  type AgentLane,
  type AgentMessage,
  type AgentToolResult,
  BACKGROUND_CONTEXT,
  type ExecutionEnv,
  type ExecutionToolContext,
  formatSkillsForSystemPrompt,
  type HarnessEvent,
  type HarnessEventType,
  loadPromptTemplates,
  loadSkills,
  type PromptTemplate,
  type Skill,
} from "@earendil-works/pi-agent-core";
import {
  type Api,
  clampThinkingLevel,
  type ImageContent,
  type Model,
  type MutableModels,
  type Usage,
} from "@earendil-works/pi-ai";
import { dataDir } from "@/main/app/paths";
import type {
  ChatEvent,
  ChatEventEnvelope,
  ChatSendOptions,
  QueuedMessage,
} from "@/shared/contracts/chat";
import type { ModelRef } from "@/shared/contracts/common";
import type {
  ChatMessageUsage,
  ChatPart,
  ReasoningPart,
  SetSessionModelResult,
  TextPart,
  ToolCallPart,
} from "@/shared/contracts/session";
import type { Settings } from "@/shared/contracts/settings";
import { resolveEffectiveModelRef } from "@/shared/model-ref";
import type { ApprovalService } from "./approvals";
import { createExecEnv } from "./exec-env";
import {
  assessToolRisk,
  getSharedPermissionRuleStore,
  type PermissionRuleStore,
} from "./permissions";
import { buildProviders, resolveModel } from "./providers";
import { resolvePromptTemplateDirs, resolveSkillDirs } from "./resources";
import type { SessionStore } from "./session-store";
import { autoTitleSession, type SessionTitleGenerator } from "./title-generator";
import { buildTools, TOOL_NAMES } from "./tools";
import { createTodoState, parseTodoEntries, type TodoState, toTodoPayload } from "./tools/todo";

export interface ChatRuntimeDeps {
  getSettings: () => Promise<Settings>;
  sessionStore: SessionStore;
  /** 发往渲染进程的事件（由 IPC 层注入，内部做好异常隔离） */
  /** 发往渲染进程的事件（由 IPC 层注入，内部做好异常隔离）；带会话 id，见 ChatEventEnvelope */
  emit: (payload: ChatEventEnvelope) => void;
  approvals: ApprovalService;
  /** 首轮问答结束后自动命名会话；未注入时（测试等场景）不做命名 */
  sessionTitles?: SessionTitleGenerator;
  /** 会话工作目录解析；默认取索引 cwd，其次 settings.defaultWorkingDir */
  resolveWorkingDir: (sessionId: string) => Promise<string>;
}

/**
 * 当前 lane 的 tip（条目 id，可能为 null 表示空会话）。
 *
 * `known: false` 表示读取失败 —— 与「tip 是 null」是两回事，调用方必须能区分：
 * 把读失败当成 null 会让「回退到会话开头」被误判成「目标已是 tip」而跳过导航。
 */
async function currentTip(
  runtime: SessionRuntime,
): Promise<{ known: boolean; tipId: string | null }> {
  try {
    const info = await runtime.lane.inspectExecution(BACKGROUND_CONTEXT);
    return { known: true, tipId: info.tipId };
  } catch (error) {
    console.warn(`读取当前 tip 失败：${toErrorText(error)}`);
    return { known: false, tipId: null };
  }
}

export interface ChatRuntime {
  send(
    sessionId: string,
    text: string,
    images?: ImageContent[],
    messageId?: string,
    options?: ChatSendOptions,
  ): Promise<void>;
  stop(sessionId: string): Promise<void>;
  queue(sessionId: string, text: string, mode: "steer" | "followUp"): Promise<void>;
  compact(sessionId: string, instructions?: string): Promise<void>;
  isRunning(sessionId: string): boolean;
  /**
   * 切换会话使用的模型（null = 跟随设置里的默认模型）。
   *
   * 热切换：直接把新模型写到 lane 的配置上（内核 `lane.setModel`），**不重建 harness、
   * 不动会话句柄** —— 于是同一段对话的上下文完整保留，下一条消息就用新模型。
   * 运行中拒绝（同一次运行里换模型会让工具调用/思考历史跨供应商）。
   */
  setModel(sessionId: string, model: ModelRef | null): Promise<SetSessionModelResult>;
  closeSession(sessionId: string): Promise<void>;
  dispose(): Promise<void>;
}

/** before_tool 钩子判定结果：返回 block 即阻断工具调用 */
export interface ToolPermissionResult {
  block: { reason: string; terminate?: boolean };
}

type SessionHandle = NonNullable<Awaited<ReturnType<SessionStore["open"]>>>["session"];

/** 流式 assistant 消息的累积状态 */
interface AssistantStream {
  messageId: string;
  parts: ChatPart[];
  /** contentIndex → parts 下标，保证同一内容块增量合并 */
  partIndexByContent: Map<number, number>;
}

/** toolCallId → 消息中的 part 引用，供 tool_end / 权限门回填状态 */
interface ToolCallPartRef {
  messageId: string;
  partIndex: number;
  part: ToolCallPart;
}

interface SessionRuntime {
  sessionId: string;
  /**
   * 这个会话实际在用的模型引用（会话绑定优先，否则默认模型）。
   *
   * 与 `model` 一起维护：`model` 是给内核/思考档位 clamp 用的 pi-ai 对象，`modelRef` 是它的
   * 来源坐标 —— 切模型时两者一起换，`applyModel` 也据此判断「是否真的变了」。
   * null = 当前设置里一个可用模型都没有（此时发送会报「请先配置模型服务」）。
   */
  modelRef: ModelRef | null;
  /**
   * harness 创建时的模型注册表快照。
   *
   * 请求阶段只查这份快照（内核 `prepareGeneration` 用 lane.models.getModel），所以切换模型前
   * 必须在这里先查一遍：设置里新加的服务/模型还没进这份注册表，写进去只会让下一次运行以
   * `model_unavailable` 失败。
   */
  models: MutableModels;
  session: SessionHandle;
  harness: AgentHarness<ExecutionToolContext>;
  lane: AgentLane;
  env: ExecutionEnv;
  /**
   * 本会话真正在用的模型（会话绑定优先，之后随 `setModel` 热切换）。
   *
   * 留一份在这里是为了定思考档位时按**这个模型**的支持范围降级 —— 若改用「当前设置里的
   * 默认模型」，用户切了模型就会出现「档位按 A 算、请求其实发给 B」。
   */
  model: Model<Api>;
  rules: PermissionRuleStore;
  running: boolean;
  /** 本次运行的本地 runId，保证 run-started 与 run-ended 对应 */
  runId?: string;
  /** run_end 事件是否已处理，避免 prompt 异常时重复发 run-ended */
  runEnded: boolean;
  stream?: AssistantStream;
  lastAssistantMessageId?: string;
  /**
   * 已建好但还没拿到 entryId 的消息，按建立顺序排队。
   *
   * 条目要到消息落盘时才产生（entry_added 事件），而渲染层需要 entryId 才有「分支」入口、
   * 重新生成也需要它作为回退点。**必须带角色**：一次运行会先落用户条目再落助手条目，
   * 只按顺序弹队首会把助手条目配到用户消息上（用户消息永远拿不到 id、助手拿到错 id，
   * 重新生成随即报 "target must differ from the current tip"）。
   */
  pendingEntries: PendingEntry[];
  /** 渲染层乐观用户消息 id：主进程回显同一条用户消息时复用，避免 UI 出现两条 */
  pendingUserMessageId?: string;
  toolParts: Map<string, ToolCallPartRef>;
  queue: QueuedMessage[];
  unsubscribers: Array<() => void>;
  /** 本次会话是否已经试过自动命名（失败也在内存里记下，避免每轮重复请求） */
  titleAttempted?: boolean;
}

/** 等待 entry_added 配对的消息：id 与角色（角色用来和条目对齐） */
export interface PendingEntry {
  messageId: string;
  role: "user" | "assistant";
}

let defaultRuntime: ChatRuntime | null = null;

/** 默认单例：bootstrap 装配时经 createChatRuntime 注册，IPC 层通过 getChatRuntime 取用 */
export function getChatRuntime(): ChatRuntime {
  if (!defaultRuntime) throw new Error("聊天运行时尚未初始化");
  return defaultRuntime;
}

/** 规则库：与 IPC 层共用同一实例（见 permissions.ts 的共享单例），避免两份缓存不同步 */
function getRuleStore(): PermissionRuleStore {
  return getSharedPermissionRuleStore(dataDir());
}

function toErrorText(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

/** 我们只用一条 lane：pi 侧固定叫 main */
const LANE_NAME = "main";

/**
 * lane 配置里**实际**在用的模型引用；读不出来（模型已从注册表消失）返回 null。
 *
 * 为什么需要单独读它：内核在 lane 已有存储配置时完全忽略 harness 的 seed
 * （harness.js 的 `stored.kind === "lane"` 分支），所以「我们期望用哪个」与「lane 里存的是哪个」
 * 是两件事。只有拿**实际值**做基准，才能发现需要写回的情况 —— 否则「跟随默认」的会话在用户
 * 改了默认模型之后会一直用旧模型，且没有任何地方会去纠正。
 */
export async function readLaneModelRef(lane: AgentLane): Promise<ModelRef | null> {
  const model = await lane.getModel(BACKGROUND_CONTEXT);
  if (!model) return null;
  return { serviceId: String(model.provider), modelId: model.id };
}

/**
 * 是否需要把模型写回 lane。
 *
 * 引用不一致、或 lane 里压根解析不出模型（存储的是已删除的服务）时都要写：
 * 后一种情况若不写，之后每次运行都会以 `model_unavailable` 失败。
 */
export function needsModelWrite(laneRef: ModelRef | null, desired: ModelRef): boolean {
  return (
    laneRef === null ||
    laneRef.serviceId !== desired.serviceId ||
    laneRef.modelId !== desired.modelId
  );
}

/**
 * pi 的 LaneBusy：这条 lane 里已经压着一个活跃操作，新的 prompt / compact / navigate 都会被拒收。
 * 它是带 tag 的错误对象（不是 Error 子类），所以按 `_tag` 而不是 instanceof 识别。
 */
export function isLaneBusy(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { _tag?: unknown })._tag === "LaneBusy"
  );
}

/**
 * 收敛 lane 里遗留的操作，返回是否成功。
 *
 * abort 是 pi 自己的收敛路径：不请求模型，只把该操作写成 aborted 终态、把 lane 的
 * currentOperationId 清空，已落盘的消息不受影响 —— 正适合清「上一次进程没收尾留下的」操作。
 * 没有活跃操作时 abort 会返回 NoActiveOperation，此时返回 false 让调用方决定怎么处理。
 * （导出是为了让单测能直接盖住这条判断，主进程内部不该有别处调用。）
 */
export async function abortStaleOperation(lane: AgentLane, sessionId: string): Promise<boolean> {
  try {
    const result = await lane.abort(BACKGROUND_CONTEXT);
    if (result.ok) return true;
    console.warn(`清理会话 ${sessionId} 的遗留操作失败：${toErrorText(result.error)}`);
    return false;
  } catch (error) {
    console.warn(`清理会话 ${sessionId} 的遗留操作异常：${toErrorText(error)}`);
    return false;
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "{}";
  } catch {
    return "{}";
  }
}

function mapUsage(usage: Usage): ChatMessageUsage {
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    ...(usage.reasoning === undefined ? {} : { reasoningTokens: usage.reasoning }),
    totalTokens: usage.totalTokens,
  };
}

/** 用户消息内容块 → ChatPart（文本 / 图片），与历史回读的映射保持一致 */
function mapUserParts(message: Extract<AgentMessage, { role: "user" }>): ChatPart[] {
  const parts: ChatPart[] = [];
  if (typeof message.content === "string") {
    if (message.content !== "") parts.push({ type: "text", text: message.content });
    return parts;
  }
  for (const block of message.content) {
    if (block.type === "text") {
      parts.push({ type: "text", text: block.text });
    } else if (block.type === "image") {
      parts.push({
        type: "image",
        mimeType: block.mimeType,
        dataUrl: `data:${block.mimeType};base64,${block.data}`,
      });
    }
  }
  return parts;
}

function agentMessageText(message: AgentMessage): string {
  if (message.role !== "user") return "";
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

/** 工具结果 → UI 值：优先文本，其次 details，最后原样返回 */
function toolResultValue(result: AgentToolResult<unknown>): unknown {
  const text = result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  if (text !== "") return text;
  if (result.details !== undefined) return result.details;
  return "";
}

/**
 * 条目落盘 → 配给哪条待配的消息，并把该消息移出队列。
 *
 * 按**角色**配对，而不是弹队首：运行会先落用户条目、后落助手条目，
 * 弹队首会让助手条目认领用户消息的 id（用户消息拿不到 entryId，助手拿到错的）。
 * 同一角色内部仍按 FIFO —— 一次运行的多轮工具调用会连续产生多条助手消息与多个条目。
 * 提到模块级是为了可测：这段判定在 createChatRuntime 的闭包里够不到。
 */
export function pairEntryWithMessage(
  pending: PendingEntry[],
  entry: { type: string; id: string; parentId: string | null; message?: { role?: string } },
): { messageId: string; patch: { entryId: string; parentId: string | null } } | null {
  if (entry.type !== "message") return null;
  const role = entry.message?.role;
  if (role !== "user" && role !== "assistant") return null;

  const index = pending.findIndex((item) => item.role === role);
  if (index < 0) return null;
  const [matched] = pending.splice(index, 1);
  if (matched === undefined) return null;
  return { messageId: matched.messageId, patch: { entryId: entry.id, parentId: entry.parentId } };
}

/**
 * tool_end 事件 → 该 part 的字段补丁（流式路径）。
 *
 * 文本结果会盖住 details，两者都留：工具的结构化详情（edit 的 patch 等）只有 details 里有，
 * 渲染层靠它决定展开面板用 diff 还是纯文本。
 * 提到模块级是为了可测：这段写入在 createChatRuntime 的闭包里够不到，
 * 与 message-mapper 的 applyToolResult（历史回读路径）对称，两条路径各有一个可测入口。
 */
export function applyToolEnd(
  part: ToolCallPart,
  result: AgentToolResult<unknown>,
  isError: boolean,
): void {
  part.result = toolResultValue(result);
  if (result.details !== undefined) part.details = result.details;
  part.isError = isError;
  part.status = isError ? "error" : "done";
}

/**
 * always_allow 的规则模式：bash 取命令首词，write/edit 取路径首段（跳过盘符）；
 * 无法提取时返回 undefined，表示该工具全局放行。
 */
export function deriveRulePattern(
  toolName: string,
  args: Record<string, unknown>,
): string | undefined {
  if (toolName === TOOL_NAMES.bash) {
    const command = typeof args.command === "string" ? args.command.trim() : "";
    const first = command.split(/\s+/)[0];
    return first === undefined || first === "" ? undefined : first;
  }
  if (toolName === TOOL_NAMES.write || toolName === TOOL_NAMES.edit) {
    const target = typeof args.path === "string" ? args.path.trim() : "";
    if (target === "") return undefined;
    return target.split(/[\\/]+/).find((item) => item !== "" && !/^[a-zA-Z]:$/.test(item));
  }
  return undefined;
}

/**
 * 工具使用指导：对齐 dsh/opencode 的做法，把「什么时候用哪个工具」写进系统提示。
 *
 * 这是对四个原生工具 description 的补充而非替代 —— pi 提供的 description 偏操作说明
 * （返回什么、怎么截断），不讲使用场景；两者的分工见 tools.ts 顶部的注释。
 */
const TOOL_GUIDANCE = [
  "工具使用：",
  "1. 修改任何文件前先用 read 读取它，edit 需要唯一匹配的 oldText；",
  "2. 查找内容或文件名优先用 grep / glob，不要用 read 全量读取大文件，也不要用 bash 拼 grep/find；",
  "3. 需要执行命令、跑测试、看 git 状态时用 bash；",
  "4. 工具输出超长会被截断（bash 只保留末尾 2000 行 / 50KB），需要更多内容时缩小范围分次取；",
  "5. 多步任务用 todo 记录进度，每完成一步就更新它；",
  "6. 只依据工具的真实返回作答，不要编造执行结果。",
].join("\n");

/** 系统提示：工作目录 + 工具指导 + 基本规则 + 技能索引 + 可选 AGENTS.md；保持简洁，不做复杂模板 */
export async function buildSystemPrompt(
  settings: Settings,
  cwd: string,
  skillsSection?: string,
): Promise<string> {
  const replyLanguage = settings.language === "en-US" ? "英文" : "简体中文";
  const sections = [
    `你是 Oint 桌面应用中的智能编程助手。当前会话工作目录：${cwd}，相对路径均基于该目录解析。`,
    TOOL_GUIDANCE,
    [
      "工作规则：",
      "1. 修改代码前先阅读相关文件，不要凭空猜测；",
      "2. 通过工具完成文件读写与命令执行，不要编造执行结果；",
      `3. 使用${replyLanguage}回复用户。`,
    ].join("\n"),
  ];

  // 技能以「名称 + 描述 + 文件路径」的紧凑索引注入，完整 SKILL.md 由模型按需通过 lane.skill 读取。
  // 该索引稳定不变，放在提示前缀里不会破坏缓存 —— 但**不要**在这里拼接技能全文。
  if (skillsSection !== undefined && skillsSection !== "") sections.push(skillsSection);

  let custom = "";
  try {
    custom = (await readFile(path.join(dataDir(), "AGENTS.md"), "utf8")).trim();
  } catch {
    // AGENTS.md 不存在或不可读：静默忽略
    custom = "";
  }
  if (custom !== "") sections.push(`用户自定义指令（AGENTS.md）：\n${custom}`);
  return sections.join("\n\n");
}

/** 技能与提示模板的装配结果 */
export interface LoadedAgentResources {
  skills: Skill[];
  promptTemplates: PromptTemplate[];
  /** 已拼好的 <available_skills> 索引；无技能时为空串 */
  skillsSection: string;
}

/**
 * 读取技能与提示模板并拼出系统提示里的技能索引。
 *
 * 两条必须遵守的约束：
 * 1. **路径守卫**：调用方构造的 ExecutionEnv 的 allowedRoots 必须已包含全部技能目录，
 *    否则 listDir/readTextFile 会被 validatePathAccess 拒绝 —— 表现为「目录存在却 0 个技能」，
 *    而且只有 diagnostics 里能看到 list_failed，很容易被当成「没有技能」。
 * 2. **不得阻断会话**：技能只是增强，任何失败都只记 warning 并以空结果继续，
 *    绝不能让 AgentHarness.create 因此抛错。
 *
 * `disabledSkillNames` 在这里过滤；`disableModelInvocation` 的过滤在
 * formatSkillsForSystemPrompt 内部完成（它只把可被模型主动调用的技能写进索引），这里不重复过滤。
 */
export async function loadAgentResources(
  env: ExecutionEnv,
  settings: Settings,
  cwd: string,
): Promise<LoadedAgentResources> {
  if (!settings.skillsEnabled) return { skills: [], promptTemplates: [], skillsSection: "" };

  const skillDirs = resolveSkillDirs(settings, cwd).map((dir) => path.resolve(cwd, dir.path));

  let skills: Skill[] = [];
  try {
    const result = await loadSkills(env, skillDirs, BACKGROUND_CONTEXT);
    for (const diagnostic of result.diagnostics) {
      console.warn(
        `技能加载警告（${diagnostic.code}）：${diagnostic.message}（${diagnostic.path}）`,
      );
    }
    // 缺 description 的技能会被内核静默丢弃，不报错 —— 所以上面必须把 diagnostics 打出来
    skills = result.skills.filter((skill) => !settings.disabledSkillNames.includes(skill.name));
  } catch (error) {
    console.warn(`技能加载失败，按无技能继续：${toErrorText(error)}`);
  }

  let promptTemplates: PromptTemplate[] = [];
  try {
    const result = await loadPromptTemplates(
      env,
      resolvePromptTemplateDirs(settings, cwd).map((dir) => path.resolve(cwd, dir.path)),
      BACKGROUND_CONTEXT,
    );
    for (const diagnostic of result.diagnostics) {
      console.warn(`提示模板加载警告（${diagnostic.code}）：${diagnostic.message}`);
    }
    promptTemplates = result.promptTemplates;
  } catch (error) {
    console.warn(`提示模板加载失败，按无模板继续：${toErrorText(error)}`);
  }

  return { skills, promptTemplates, skillsSection: formatSkillsForSystemPrompt(skills) };
}

/** 会话内待办清单在 session 里的 custom entry 类型 */
const TODO_ENTRY_TYPE = "todo";

/**
 * 从会话里恢复待办清单。
 *
 * 为什么必须做：todo 工具是**整表替换**语义 —— 不恢复的话，应用重启后的第一次 todo 调用
 * 会以空表为基准覆盖，用户之前那张清单就没了。状态本体存在会话的 custom entry 里
 * （每次调用追加一条），这里读最后一条即可。
 *
 * 读不到、或数据不合法，都只是「当作空表」并记 warning：待办是辅助信息，不能阻断会话创建。
 */
async function restoreTodoState(lane: AgentLane, todo: TodoState): Promise<void> {
  try {
    const entry = await lane.findEntry(
      { type: "custom", customType: TODO_ENTRY_TYPE, order: "newestFirst", limit: 1 },
      BACKGROUND_CONTEXT,
    );
    if (entry === undefined || entry.type !== "custom") return;
    const data = entry.data;
    if (typeof data !== "object" || data === null || Array.isArray(data)) return;
    const record = data as Record<string, unknown>;
    const todos = parseTodoEntries(record.todos);
    if (todos === undefined) return;
    todo.todos = todos;
    const revision = record.revision;
    if (typeof revision === "number" && Number.isInteger(revision) && revision >= 0) {
      todo.revision = revision;
    }
  } catch (error) {
    console.warn(`恢复待办清单失败，按空清单继续：${toErrorText(error)}`);
  }
}

export function createChatRuntime(deps: ChatRuntimeDeps): ChatRuntime {
  const runtimes = new Map<string, SessionRuntime>();
  const creations = new Map<string, Promise<SessionRuntime>>();

  function emitSafe(sessionId: string, event: ChatEvent): void {
    try {
      deps.emit({ sessionId, event });
    } catch (error) {
      console.warn(`发送聊天事件失败：${toErrorText(error)}`);
    }
  }

  function subscribe<T extends HarnessEventType>(
    runtime: SessionRuntime,
    type: T,
    handler: (event: Extract<HarnessEvent, { type: T }>) => void | Promise<void>,
  ): void {
    runtime.unsubscribers.push(
      runtime.harness.events.on(type, (event) => {
        void Promise.resolve()
          .then(() => handler(event))
          .catch((error: unknown) => {
            console.warn(`处理会话事件失败（${type}）：${toErrorText(error)}`);
          });
      }),
    );
  }

  function upsertPart(
    runtime: SessionRuntime,
    stream: AssistantStream,
    partIndex: number,
    part: ChatPart,
  ): void {
    emitSafe(runtime.sessionId, {
      type: "part-upsert",
      messageId: stream.messageId,
      partIndex,
      part,
    });
  }

  /** 取或创建文本 / 推理 part，保证 contentIndex 与 parts 下标一一对应 */
  function partFor(
    stream: AssistantStream,
    contentIndex: number,
    kind: "text" | "reasoning",
  ): { part: TextPart | ReasoningPart; index: number } {
    const existingIndex = stream.partIndexByContent.get(contentIndex);
    if (existingIndex !== undefined) {
      const existing = stream.parts[existingIndex];
      if (existing?.type === kind) {
        return { part: existing as TextPart | ReasoningPart, index: existingIndex };
      }
    }
    const created: TextPart | ReasoningPart =
      kind === "text" ? { type: "text", text: "" } : { type: "reasoning", text: "" };
    stream.parts.push(created);
    const index = stream.parts.length - 1;
    stream.partIndexByContent.set(contentIndex, index);
    return { part: created, index };
  }

  /** 取或创建工具调用 part；工具流式期间允许参数文本增量追加 */
  function toolPartFor(
    stream: AssistantStream,
    contentIndex: number,
    toolCall: { id: string; name: string; arguments: Record<string, unknown> },
  ): { part: ToolCallPart; index: number } {
    const existingIndex = stream.partIndexByContent.get(contentIndex);
    if (existingIndex !== undefined) {
      const existing = stream.parts[existingIndex];
      if (existing?.type === "tool-call") {
        if (toolCall.name !== "") existing.toolName = toolCall.name;
        if (toolCall.id !== "") existing.toolCallId = toolCall.id;
        return { part: existing, index: existingIndex };
      }
    }
    const created: ToolCallPart = {
      type: "tool-call",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      argsText: "",
      status: "running",
    };
    stream.parts.push(created);
    const index = stream.parts.length - 1;
    stream.partIndexByContent.set(contentIndex, index);
    return { part: created, index };
  }

  function handleMessageStart(
    runtime: SessionRuntime,
    event: Extract<HarnessEvent, { type: "message_start" }>,
  ): void {
    const message = event.message;
    if (message.role === "assistant") {
      const messageId = randomUUID();
      runtime.stream = { messageId, parts: [], partIndexByContent: new Map() };
      runtime.lastAssistantMessageId = messageId;
      // 排队等 entry_added 把条目 id 配回来（渲染层的「分支」入口需要它）
      runtime.pendingEntries.push({ messageId, role: "assistant" });
      emitSafe(runtime.sessionId, {
        type: "message-added",
        message: {
          id: messageId,
          role: "assistant",
          createdAt: Date.now(),
          parts: [],
          status: "streaming",
        },
      });
      return;
    }
    if (message.role === "user") {
      // 复用渲染层乐观消息 id：upsertMessage 按 id 覆盖，避免同一条用户消息显示两次
      const reuseId = runtime.pendingUserMessageId;
      runtime.pendingUserMessageId = undefined;
      const messageId = reuseId ?? randomUUID();
      // 用户消息也要 entryId：重新生成要靠它把 lane 退回这条（退回后新回复成为兄弟条目）
      runtime.pendingEntries.push({ messageId, role: "user" });
      emitSafe(runtime.sessionId, {
        type: "message-added",
        message: {
          id: messageId,
          role: "user",
          createdAt: Date.now(),
          parts: mapUserParts(message),
          status: "complete",
        },
      });
    }
  }

  function handleMessageUpdate(
    runtime: SessionRuntime,
    event: Extract<HarnessEvent, { type: "message_update" }>,
  ): void {
    const stream = runtime.stream;
    if (!stream) return;
    const update = event.event;

    if (
      update.type === "text_start" ||
      update.type === "text_delta" ||
      update.type === "text_end"
    ) {
      const { part, index } = partFor(stream, update.contentIndex, "text");
      const textPart = part as TextPart;
      if (update.type === "text_delta") textPart.text += update.delta;
      else if (update.type === "text_end") textPart.text = update.content;
      upsertPart(runtime, stream, index, textPart);
      return;
    }

    // reasoning=false 时也可能出现 thinking 事件，这里完全按增量防御性处理
    if (
      update.type === "thinking_start" ||
      update.type === "thinking_delta" ||
      update.type === "thinking_end"
    ) {
      const { part, index } = partFor(stream, update.contentIndex, "reasoning");
      const reasoningPart = part as ReasoningPart;
      if (update.type === "thinking_delta") reasoningPart.text += update.delta;
      else if (update.type === "thinking_end") reasoningPart.text = update.content;
      upsertPart(runtime, stream, index, reasoningPart);
      return;
    }

    if (update.type === "toolcall_start" || update.type === "toolcall_delta") {
      const content = update.partial.content[update.contentIndex];
      if (content?.type !== "toolCall") return;
      const { part, index } = toolPartFor(stream, update.contentIndex, content);
      if (update.type === "toolcall_delta") part.argsText += update.delta;
      runtime.toolParts.set(part.toolCallId, {
        messageId: stream.messageId,
        partIndex: index,
        part,
      });
      upsertPart(runtime, stream, index, part);
      return;
    }

    if (update.type === "toolcall_end") {
      const { part, index } = toolPartFor(stream, update.contentIndex, update.toolCall);
      part.toolCallId = update.toolCall.id;
      part.toolName = update.toolCall.name;
      part.args = update.toolCall.arguments;
      part.argsText = safeStringify(update.toolCall.arguments);
      runtime.toolParts.set(part.toolCallId, {
        messageId: stream.messageId,
        partIndex: index,
        part,
      });
      upsertPart(runtime, stream, index, part);
    }
    // start / done / error 等类型不需要额外动作
  }

  function handleMessageEnd(
    runtime: SessionRuntime,
    event: Extract<HarnessEvent, { type: "message_end" }>,
  ): void {
    const message = event.message;
    const stream = runtime.stream;
    if (message.role !== "assistant" || !stream) return;
    const failed = message.stopReason === "error";
    emitSafe(runtime.sessionId, {
      type: "message-updated",
      messageId: stream.messageId,
      patch: {
        status: failed ? "error" : "complete",
        usage: mapUsage(message.usage),
        ...(failed ? { error: message.errorMessage ?? "模型返回错误" } : {}),
      },
    });
    runtime.lastAssistantMessageId = stream.messageId;
    runtime.stream = undefined;
  }

  function handleToolStart(
    runtime: SessionRuntime,
    event: Extract<HarnessEvent, { type: "tool_start" }>,
  ): void {
    const ref = runtime.toolParts.get(event.toolCallId);
    if (ref) {
      ref.part.toolName = event.toolName;
      ref.part.args = event.args;
      ref.part.argsText = safeStringify(event.args);
      emitSafe(runtime.sessionId, {
        type: "part-upsert",
        messageId: ref.messageId,
        partIndex: ref.partIndex,
        part: ref.part,
      });
      return;
    }
    // 防御：toolcall_end 缺失时补建 part，保证工具状态可见
    const stream = runtime.stream;
    if (!stream) return;
    const part: ToolCallPart = {
      type: "tool-call",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      argsText: safeStringify(event.args),
      args: event.args,
      status: "running",
    };
    stream.parts.push(part);
    const index = stream.parts.length - 1;
    runtime.toolParts.set(event.toolCallId, {
      messageId: stream.messageId,
      partIndex: index,
      part,
    });
    emitSafe(runtime.sessionId, {
      type: "part-upsert",
      messageId: stream.messageId,
      partIndex: index,
      part,
    });
  }

  function handleToolEnd(
    runtime: SessionRuntime,
    event: Extract<HarnessEvent, { type: "tool_end" }>,
  ): void {
    const ref = runtime.toolParts.get(event.toolCallId);
    if (!ref) return;
    applyToolEnd(ref.part, event.result, event.isError);
    emitSafe(runtime.sessionId, {
      type: "part-upsert",
      messageId: ref.messageId,
      partIndex: ref.partIndex,
      part: ref.part,
    });
  }

  function handleRunEnd(
    runtime: SessionRuntime,
    event: Extract<HarnessEvent, { type: "run_end" }>,
  ): void {
    const stream = runtime.stream;
    if (stream) {
      const failed = event.status === "failed";
      emitSafe(runtime.sessionId, {
        type: "message-updated",
        messageId: stream.messageId,
        patch: {
          status: failed ? "error" : "complete",
          ...(failed ? { error: event.error.message } : {}),
        },
      });
      runtime.lastAssistantMessageId = stream.messageId;
      runtime.stream = undefined;
    } else if (event.status === "failed" && runtime.lastAssistantMessageId) {
      emitSafe(runtime.sessionId, {
        type: "message-updated",
        messageId: runtime.lastAssistantMessageId,
        patch: { status: "error", error: event.error.message },
      });
    }
    runtime.running = false;
    runtime.runEnded = true;
    runtime.queue = [];
    emitSafe(runtime.sessionId, { type: "queue-updated", items: [] });
    emitSafe(runtime.sessionId, {
      type: "run-ended",
      runId: runtime.runId ?? event.runId,
      reason: event.status,
    });
    void touchSession(runtime);
    // 一轮问答结束：会话还没名字时，用这轮内容生成标题
    void maybeTitleSession(runtime, event.status);
  }

  function handleUsage(
    runtime: SessionRuntime,
    event: Extract<HarnessEvent, { type: "usage" }>,
  ): void {
    const messageId = runtime.stream?.messageId ?? runtime.lastAssistantMessageId;
    if (!messageId) return;
    emitSafe(runtime.sessionId, {
      type: "message-updated",
      messageId,
      patch: { usage: mapUsage(event.row.usage) },
    });
  }

  /** queue_update 是 lane 的真实队列，直接映射为 UI 队列项 */
  function handleQueueUpdate(
    runtime: SessionRuntime,
    event: Extract<HarnessEvent, { type: "queue_update" }>,
  ): void {
    const items = event.queues.flatMap((item): QueuedMessage[] => {
      if (item.type !== "message" || (item.kind !== "steer" && item.kind !== "followUp")) {
        return [];
      }
      return [{ id: item.entryId, text: agentMessageText(item.message), mode: item.kind }];
    });
    runtime.queue = items;
    emitSafe(runtime.sessionId, { type: "queue-updated", items });
  }

  /** 压缩摘要预览：取不到时返回空串，不阻塞事件流 */
  async function compactionPreview(
    runtime: SessionRuntime,
    entryId: string | undefined,
  ): Promise<string> {
    if (entryId === undefined) return "";
    try {
      const entry = await runtime.session.getEntry(entryId, BACKGROUND_CONTEXT);
      if (entry?.type === "compaction") return entry.summary.slice(0, 200);
    } catch {
      // 摘要读取失败不影响压缩结果展示
      return "";
    }
    return "";
  }

  async function touchSession(runtime: SessionRuntime): Promise<void> {
    try {
      const stats = await runtime.session.getStats(BACKGROUND_CONTEXT);
      await deps.sessionStore.touch(runtime.sessionId, { messageCount: stats.messageCount });
    } catch (error) {
      console.warn(`更新会话统计失败 ${runtime.sessionId}：${toErrorText(error)}`);
    }
  }

  /**
   * 自动命名：仅在会话还没有名字（索引 title 为空）时做一次。
   *
   * 触发点是「首轮问答结束」，素材取会话里第一条用户消息与它之后的助手回复；
   * 标题本身即「已命名」的标记 —— 所以用户手动改过名、或分支会话带着来源标题时，
   * 这里都不会覆盖。命名失败（无模型 / 超时 / 输出为空）保持默认名，且本次进程内不再重试；
   * 只有「素材不足」不记账，留给下一轮（见 title-generator 的 onAttempt）。
   */
  async function maybeTitleSession(
    runtime: SessionRuntime,
    status: Extract<HarnessEvent, { type: "run_end" }>["status"],
  ): Promise<void> {
    const generate = deps.sessionTitles;
    if (!generate || runtime.titleAttempted) return;
    if (status !== "completed") return;

    try {
      const title = await autoTitleSession(runtime.sessionId, {
        generate,
        readTitle: (id) => deps.sessionStore.readTitle(id),
        // 从会话开头取：命名素材必须是「首轮问答」，尾部窗口在大会话里会拿到后面几轮
        loadMessages: async (id) =>
          (await deps.sessionStore.loadMessages(id, { limit: 20, order: "oldestFirst" })).messages,
        rename: (id, next) => deps.sessionStore.rename(id, next),
        onAttempt: () => {
          runtime.titleAttempted = true;
        },
        // 命名用的是这个会话的对话，就该用这个会话的模型
        // 命名用的是这个会话的对话，就该用这个会话的模型（null = 没配模型，交给生成器回落）
        ...(runtime.modelRef === null ? {} : { modelRef: runtime.modelRef }),
      });
      if (title === null) return;
      emitSafe(runtime.sessionId, { type: "session-titled", sessionId: runtime.sessionId, title });
    } catch (error) {
      console.warn(`会话自动命名失败，保留默认名称：${toErrorText(error)}`);
    }
  }

  /**
   * 条目落盘：把 pi 的 entryId / parentId 配回对应的那条助手消息。
   *
   * 渲染层的「分支」入口要求消息带 entryId（主进程按条目 id 复制会话），
   * 而流式产生的消息一出生是没有的 —— 只有历史回读的消息才自带。
   * 按 FIFO 配对：一次运行里的多轮工具调用会交替产生多条助手消息与多个条目。
   */
  function handleEntryAdded(
    runtime: SessionRuntime,
    event: Extract<HarnessEvent, { type: "entry_added" }>,
  ): void {
    const paired = pairEntryWithMessage(runtime.pendingEntries, event.entry);
    if (paired === null) return;
    emitSafe(runtime.sessionId, {
      type: "message-updated",
      messageId: paired.messageId,
      patch: paired.patch,
    });
  }

  function registerEvents(runtime: SessionRuntime): void {
    subscribe(runtime, "message_start", (event) => handleMessageStart(runtime, event));
    subscribe(runtime, "message_update", (event) => handleMessageUpdate(runtime, event));
    subscribe(runtime, "message_end", (event) => handleMessageEnd(runtime, event));
    subscribe(runtime, "entry_added", (event) => handleEntryAdded(runtime, event));
    subscribe(runtime, "tool_start", (event) => handleToolStart(runtime, event));
    subscribe(runtime, "tool_end", (event) => handleToolEnd(runtime, event));
    subscribe(runtime, "run_end", (event) => handleRunEnd(runtime, event));
    subscribe(runtime, "usage", (event) => handleUsage(runtime, event));
    subscribe(runtime, "queue_update", (event) => handleQueueUpdate(runtime, event));
    subscribe(runtime, "compaction_start", () =>
      emitSafe(runtime.sessionId, { type: "compaction-started" }),
    );
    subscribe(runtime, "compaction_end", async (event) => {
      const preview =
        event.status === "completed" ? await compactionPreview(runtime, event.entryId) : "";
      emitSafe(runtime.sessionId, { type: "compaction-ended", summaryPreview: preview });
    });
  }

  /** 权限门：根据审批模式与风险评估决定放行、审批或阻断 */
  async function gateTool(
    runtime: SessionRuntime,
    toolName: string,
    toolCallId: string,
    args: Record<string, unknown>,
  ): Promise<ToolPermissionResult | undefined> {
    const settings = await deps.getSettings();
    // 「完全访问」模式：不再逐次审批（仍受 exec-env 的路径白名单约束）
    if (settings.permissionMode === "full") return undefined;
    const risk = assessToolRisk(toolName, args);
    if (risk === "low") return undefined;

    // 「始终允许」规则优先于审批；三种模式均生效
    const argsText = safeStringify(args);
    if (await runtime.rules.matches(toolName, argsText)) return undefined;
    const ref = runtime.toolParts.get(toolCallId);
    if (ref) {
      ref.part.status = "pending-approval";
      emitSafe(runtime.sessionId, {
        type: "part-upsert",
        messageId: ref.messageId,
        partIndex: ref.partIndex,
        part: ref.part,
      });
    }

    const decision = await deps.approvals.request({
      sessionId: runtime.sessionId,
      toolCallId,
      toolName,
      argsText,
      risk,
      // 交给 AI 预审：它需要工作目录来判断操作是否越出项目范围
      workingDir: runtime.env.cwd,
      // 审批用「这个会话正在用的模型」：会话级绑定过模型时不该拿默认模型去审
      ...(runtime.modelRef === null ? {} : { modelRef: runtime.modelRef }),
    });
    if (decision === "deny") {
      if (ref) {
        ref.part.status = "denied";
        emitSafe(runtime.sessionId, {
          type: "part-upsert",
          messageId: ref.messageId,
          partIndex: ref.partIndex,
          part: ref.part,
        });
      }
      return { block: { reason: "用户拒绝了该操作" } };
    }
    if (decision === "always_allow") {
      const pattern = deriveRulePattern(toolName, args);
      await runtime.rules.add({
        toolName,
        ...(pattern === undefined ? {} : { pattern }),
        createdAt: Date.now(),
      });
    }
    return undefined;
  }

  async function createRuntime(sessionId: string): Promise<SessionRuntime> {
    const opened = await deps.sessionStore.open(sessionId);
    if (!opened) throw new Error(`无法打开会话：${sessionId}`);

    const settings = await deps.getSettings();
    const cwd = await deps.resolveWorkingDir(sessionId);
    // 技能/模板目录可能与工作目录、数据目录都不重叠，必须一并加入路径守卫的根：
    // 否则 loadSkills 的 listDir 会被 validatePathAccess 拒绝，表现为「目录明明存在却是 0 个技能」
    const skillDirPaths = resolveSkillDirs(settings, cwd).map((dir) => path.resolve(cwd, dir.path));
    const env = await createExecEnv({ cwd, allowedRoots: [cwd, dataDir(), ...skillDirPaths] });

    const loaded = await loadAgentResources(env, settings, cwd);

    // 会话级待办状态：create() 时就得交给工具，而 lane 要等 create 之后才有 ——
    // 所以持久化回调走一个可变的 laneRef（工具真正调用它时 lane 一定已就绪）
    const todo = createTodoState();
    let laneRef: AgentLane | undefined;

    const { models } = buildProviders(settings);
    // 模型：会话自己绑定的优先，否则用设置里的默认模型。绑定失效（服务/模型被删）时
    // resolveEffectiveModelRef 会自动回落默认，不至于让一个旧会话打不开。
    const boundModel = await deps.sessionStore.readModel(sessionId);
    const modelRef = resolveEffectiveModelRef(settings, boundModel);
    const model = resolveModel(settings, modelRef);
    if (!model || modelRef === null || models.getProviders().length === 0) {
      throw new Error("请先在设置中配置模型服务");
    }

    const created = await AgentHarness.create(
      {
        session: opened.session,
        models,
        model,
        systemPrompt: await buildSystemPrompt(settings, cwd, loaded.skillsSection),
        tools: buildTools(),
        toolContext: {
          env,
          todo,
          persistTodo: async (state: TodoState) => {
            await laneRef?.appendCustomEntry(
              TODO_ENTRY_TYPE,
              toTodoPayload(state),
              BACKGROUND_CONTEXT,
            );
          },
        },
        resources: { skills: loaded.skills, promptTemplates: loaded.promptTemplates },
        thinkingLevel: settings.thinkingLevel,
        compaction: { enabled: true, reserveTokens: 20_000, keepRecentTokens: 40_000 },
      },
      BACKGROUND_CONTEXT,
    );
    const lane = await created.harness.lane(LANE_NAME, BACKGROUND_CONTEXT);
    laneRef = lane;
    // 必须在返回 runtime 之前恢复：否则重启后的第一次 todo 调用会以空表为基准覆盖用户清单
    await restoreTodoState(lane, todo);

    /**
     * 用 **lane 实际恢复出来的模型**初始化 runtime 的模型视图，而不是「我们期望的那个值」。
     *
     * 这一步是必需的：内核在 lane 已有存储配置时完全忽略 seed（harness.js 的
     * `stored.kind === "lane"` 分支），所以恢复出来的可能与我们刚解析的期望值不同 ——
     * 例如「跟随默认」的会话在上次运行时存的是旧的默认模型，之后用户在设置里换了默认。
     * 若这里写期望值，下面的 applyModel 会以为「已经一致」而永不写回，请求就一直发给旧模型；
     * 同理，存储里留着已删除的服务时，模型对象解析不出来（undefined），也必须让它走写回路径。
     */
    const laneModel = await lane.getModel(BACKGROUND_CONTEXT);
    const currentRef = await readLaneModelRef(lane);
    const currentModel: Model<Api> = laneModel ?? model;

    const runtime: SessionRuntime = {
      sessionId,
      session: opened.session,
      harness: created.harness,
      lane,
      model: currentModel,
      modelRef: currentRef,
      models,
      env,
      rules: getRuleStore(),
      running: false,
      runEnded: false,
      pendingEntries: [],
      toolParts: new Map(),
      queue: [],
      unsubscribers: [],
    };

    runtime.unsubscribers.push(
      created.harness.hooks.on("before_tool", async (event) => {
        try {
          return await gateTool(runtime, event.toolName, event.toolCallId, event.args);
        } catch (error) {
          // 任何异常都按安全侧默认拒绝
          console.warn(`工具权限校验失败（${event.toolName}）：${toErrorText(error)}`);
          return { block: { reason: "权限校验失败，已拒绝该操作" } };
        }
      }),
    );

    // 遗留操作：上一次进程在运行中被关掉（退出 / 崩溃 / 开发期热重载）时，pi 会把「当前操作 id」
    // 留在会话里，下次 attach 原样读回 —— 这条 lane 就天生「有活跃操作」，之后任何
    // prompt / compact 都会被 LaneBusy 拒收。这里在装配阶段先收敛掉。
    if (created.open.some((operation) => operation.lane === LANE_NAME)) {
      await abortStaleOperation(lane, sessionId);
    }
    // 让 lane 的模型与我们这边的判定对齐：内核在 lane 已有存储配置时忽略 seed，
    // 所以「跟随默认」的会话换了默认模型、或存储里留着已删除的服务，都要在这里纠正
    await applyModel(runtime, settings);
    registerEvents(runtime);
    return runtime;
  }

  function ensureRuntime(sessionId: string): Promise<SessionRuntime> {
    const cached = runtimes.get(sessionId);
    if (cached) return Promise.resolve(cached);
    const creating = creations.get(sessionId);
    if (creating) return creating;
    const promise = (async () => {
      try {
        const runtime = await createRuntime(sessionId);
        runtimes.set(sessionId, runtime);
        return runtime;
      } finally {
        creations.delete(sessionId);
      }
    })();
    creations.set(sessionId, promise);
    return promise;
  }

  /** prompt 异常/失败时收尾：错误消息 + run-ended，保证 UI 不会一直转圈 */
  function emitRunFailure(runtime: SessionRuntime, runId: string, cause: unknown): void {
    if (runtime.runEnded) return;
    const text = toErrorText(cause);
    const stream = runtime.stream;
    if (stream) {
      emitSafe(runtime.sessionId, {
        type: "message-updated",
        messageId: stream.messageId,
        patch: { status: "error", error: text },
      });
      runtime.lastAssistantMessageId = stream.messageId;
      runtime.stream = undefined;
    } else {
      emitSafe(runtime.sessionId, {
        type: "message-added",
        message: {
          id: randomUUID(),
          role: "assistant",
          createdAt: Date.now(),
          parts: [],
          status: "error",
          error: text,
        },
      });
    }
    emitSafe(runtime.sessionId, { type: "run-ended", runId, reason: "failed" });
  }

  /**
   * 把「这个会话该用哪个模型」落到 lane 上（会话绑定优先，否则设置里的默认模型）。
   *
   * 为什么不能只靠 harness 的 seed：内核在 lane **已有存储配置**时直接恢复那份配置、完全忽略
   * seed（harness.js 的 `stored.kind === "lane"` 分支）。也就是说 seed 只在会话第一次附着时
   * 生效 —— 于是「跟随默认模型」在会话第二次打开后就不再跟着默认走了，用户改了默认模型也
   * 不会传导到这些会话。所以每次发送前用我们这边的判定对齐一次。
   *
   * 已经一致时不写：setConfiguration 会往会话里落一条配置更新，没必要每条消息写一次。
   */
  async function applyModel(runtime: SessionRuntime, settings: Settings): Promise<void> {
    const bound = await deps.sessionStore.readModel(runtime.sessionId);
    const ref = resolveEffectiveModelRef(settings, bound);
    // 一个可用模型都没有：保持现状，让发送阶段照常报错（这里不该吞掉「请先配置模型服务」）
    if (ref === null) return;
    const model = resolveModel(settings, ref);
    if (!model) return;
    // 请求阶段只查 runtime 创建时的注册表：里面没有的组合写进去必然运行失败，宁可不动
    if (!runtime.models.getModel(ref.serviceId, ref.modelId)) {
      console.warn(`模型 ${ref.serviceId}/${ref.modelId} 不在本会话的模型注册表里，跳过切换`);
      return;
    }

    // 与 lane 里的**实际**配置比较（不是拿「我们上次写的那个」比）：重启后 lane 恢复出来的是
    // 存储里的旧模型，只有以实际值为基准才能发现差异。规则见 needsModelWrite 的注释
    if (!needsModelWrite(runtime.modelRef, ref)) {
      // 引用没变，但 Model 对象可能因设置改动（窗口、能力开关）而更新：跟着换掉即可
      runtime.model = model;
      return;
    }

    try {
      // 内核只记 {provider, modelId}，真正的模型对象由 harness 的 models 注册表解析
      await runtime.lane.setModel(
        { provider: ref.serviceId, modelId: ref.modelId },
        BACKGROUND_CONTEXT,
      );
    } catch (error) {
      console.warn(`应用会话模型失败（沿用当前值）：${toErrorText(error)}`);
      return;
    }
    runtime.modelRef = ref;
    runtime.model = model;
  }

  /**
   * 把设置里的思考档位应用到 lane —— 每条消息前一次，改完设置下一条即生效。
   *
   * 为什么需要这一步：harness 创建时就把 thinkingLevel 定进了配置，之后内核每次请求都从
   * 那份配置取值；不在发送前刷新，用户在设置里改的档位要等重启才起作用（而且 clamp 过的
   * 结果写不回设置 —— 设置里的档位是「用户想要什么」，lane 上的是「这个模型实际能用什么」）。
   *
   * 就低不就地取档由内核 clampThinkingLevel 决定（优先往高找、再往低找），与请求阶段的
   * clamp 完全同一套规则，不会出现「界面显示 A、请求发的是 B」。
   *
   * 失败只告警不中断：档位调不动不该让消息发不出去。
   */
  async function applyThinkingLevel(runtime: SessionRuntime, settings: Settings): Promise<void> {
    try {
      const desired = clampThinkingLevel(runtime.model, settings.thinkingLevel);
      const current = await runtime.lane.getThinkingLevel(BACKGROUND_CONTEXT);
      if (current === desired) return;
      await runtime.lane.setThinkingLevel(desired, BACKGROUND_CONTEXT);
    } catch (error) {
      console.warn(
        `应用思考档位失败（沿用当前值）：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async function send(
    sessionId: string,
    text: string,
    images?: ImageContent[],
    messageId?: string,
    options?: ChatSendOptions,
  ): Promise<void> {
    const runtime = await ensureRuntime(sessionId);
    // 运行中再 send 等价于 followUp 排队
    if (runtime.running) {
      await queue(sessionId, text, "followUp");
      return;
    }

    // 模型与思考档位都按**当前设置**对齐（设置每次现读，改完下一条消息就生效）：
    // 模型必须在档位之前 —— 档位的就近降级按 runtime.model 的支持范围算
    const settings = await deps.getSettings();
    await applyModel(runtime, settings);
    await applyThinkingLevel(runtime, settings);

    runtime.running = true;
    runtime.runEnded = false;
    // 上一次运行若因异常没能收到全部 entry_added，队列里会留下过期项：新一次运行先清空
    runtime.pendingEntries = [];
    // 记录渲染层乐观消息 id：主进程回显同一条用户消息时复用，避免 UI 出现两条
    runtime.pendingUserMessageId = messageId;
    const runId = randomUUID();
    runtime.runId = runId;
    emitSafe(runtime.sessionId, { type: "run-started", runId });
    try {
      const rewound = options?.rewindToEntryId;
      if (rewound !== undefined) {
        // 编辑：先把 tip 退回该用户消息的**父**条目，下面再把 text 作为新用户消息发出。
        // 目标已经是 tip 时跳过导航：pi 对「导航到当前 tip」直接报
        // "Navigation target must differ from the current tip"。
        // tip 读不到时按「未知」处理，照常尝试导航，由 pi 给真实错误。
        const tip = await currentTip(runtime);
        if (!tip.known || tip.tipId !== rewound) {
          const nav = await runtime.lane.navigateTree(rewound, undefined, BACKGROUND_CONTEXT);
          if (!nav.ok) {
            emitRunFailure(runtime, runId, nav.error);
            return;
          }
        }
      }
      /**
       * 必须带上要追加的消息。
       *
       * 不能靠「回退 + 空 prompt 沿用已有用户消息」来省掉这次重发：pi 的 `acceptRun` 在
       * 「prompt 为空且无图片」时确实不追加消息，但紧接着就以
       * `InvalidMessage{reason:"empty"}`（"Acceptance must append at least one message"）拒收。
       * 所以 `text` 一律原样传下去。
       */
      let result = await runtime.lane.prompt(text, images, BACKGROUND_CONTEXT);
      if (
        !result.ok &&
        isLaneBusy(result.error) &&
        (await abortStaleOperation(runtime.lane, runtime.sessionId))
      ) {
        // lane 里还压着没收尾的操作（例如上次 stop 的 abort 没收敛）：清掉再重试一次，
        // 让用户看到真实结果而不是 `Lane "main" already has an active operation`。
        // prompt 被拒时不会追加消息，所以重试不会写出重复的用户消息。
        result = await runtime.lane.prompt(text, images, BACKGROUND_CONTEXT);
      }
      if (!result.ok) emitRunFailure(runtime, runId, result.error);
    } catch (error) {
      emitRunFailure(runtime, runId, error);
    } finally {
      // 无论正常结束还是异常退出，都回收运行态并清空排队展示
      runtime.running = false;
      runtime.runId = undefined;
      runtime.queue = [];
      runtime.pendingUserMessageId = undefined;
      emitSafe(runtime.sessionId, { type: "queue-updated", items: [] });
    }
  }

  /** lane 上是否压着没收尾的操作（压缩、导航等不经过 running 标记） */
  async function hasActiveOperation(runtime: SessionRuntime): Promise<boolean> {
    try {
      const info = await runtime.lane.inspectExecution(BACKGROUND_CONTEXT);
      return info.current !== null;
    } catch (error) {
      // 读不出来按「没有」处理：宁可放行也不要因为一次读取失败把功能锁死
      console.warn(`读取 lane 执行状态失败：${toErrorText(error)}`);
      return false;
    }
  }

  /**
   * 切换会话模型（热切换）。
   *
   * 只改 lane 的模型配置，不重建 harness、不动会话句柄 —— 上下文因此完整保留，
   * 下一条消息就用新模型。这与「改全局默认模型」是两件事：那个只影响新会话。
   *
   * 这些情况不切换：
   * - 会话正在运行（或 runtime 正在创建）→ running：同一次运行里换模型会让工具调用与
   *   思考历史跨供应商，而「创建中」只落盘会让这一次发送仍用旧绑定；
   * - lane 上压着压缩 / 导航 → running：那次操作与它启动时的配置绑定，中途改配置对不上；
   * - 目标模型在设置里不存在，或不在本会话的模型注册表里 → no-model；
   * - 会话还没建 runtime → 只落盘绑定，等第一次发送时按绑定建起来。
   */
  async function setModel(
    sessionId: string,
    model: ModelRef | null,
  ): Promise<SetSessionModelResult> {
    if (runtimes.get(sessionId)?.running === true || creations.has(sessionId)) {
      return { ok: false, reason: "running" };
    }

    const settings = await deps.getSettings();
    // 校验走与创建时同一套判定：null 表示「跟随默认」，于是解析到默认模型
    const effective = resolveEffectiveModelRef(settings, model);
    if (effective === null || !resolveModel(settings, effective)) {
      return { ok: false, reason: "no-model" };
    }

    const runtime = runtimes.get(sessionId);
    if (runtime) {
      // 请求阶段只查 runtime 创建时的注册表快照：新加的服务/模型还没进去，切过去必然运行失败
      if (!runtime.models.getModel(effective.serviceId, effective.modelId)) {
        return { ok: false, reason: "no-model" };
      }
      if (await hasActiveOperation(runtime)) return { ok: false, reason: "running" };
    }

    // 落盘的是**用户的绑定选择**（null = 跟随默认），而不是上面解析出来的 effective ——
    // 否则「跟随默认」会被固化成当时那个具体模型，以后改默认模型就跟不上了。
    await deps.sessionStore.setModel(sessionId, model);

    if (runtime) {
      // 绑定已落盘，applyModel 会读到它（一条代码路径决定「用哪个模型」）
      await applyModel(runtime, settings);
      // 新模型支持的档位可能不同：立刻按它对齐一次，免得等到下一条消息才纠正
      await applyThinkingLevel(runtime, settings);
    }
    return { ok: true };
  }

  async function stop(sessionId: string): Promise<void> {
    const runtime = runtimes.get(sessionId);
    if (!runtime) return;
    deps.approvals.cancelSession(sessionId);
    runtime.queue = [];
    emitSafe(runtime.sessionId, { type: "queue-updated", items: [] });
    try {
      const result = await runtime.lane.abort(BACKGROUND_CONTEXT);
      if (!result.ok) runtime.running = false;
    } catch (error) {
      runtime.running = false;
      console.warn(`停止运行失败 ${sessionId}：${toErrorText(error)}`);
    }
  }

  async function queue(sessionId: string, text: string, mode: "steer" | "followUp"): Promise<void> {
    const runtime = await ensureRuntime(sessionId);
    // 空闲时直接按发送处理，避免消息无声挂起
    if (!runtime.running) {
      await send(sessionId, text);
      return;
    }
    const item: QueuedMessage = { id: randomUUID(), text, mode };
    runtime.queue = [...runtime.queue, item];
    emitSafe(runtime.sessionId, { type: "queue-updated", items: [...runtime.queue] });
    try {
      const result =
        mode === "steer"
          ? await runtime.lane.steer(text, undefined, BACKGROUND_CONTEXT)
          : await runtime.lane.followUp(text, undefined, BACKGROUND_CONTEXT);
      if (!result.ok) throw new Error(`消息入队失败：${toErrorText(result.error)}`);
      // 已交给 lane：移除本地占位项，真实队列由 queue_update 事件同步
      runtime.queue = runtime.queue.filter((queued) => queued.id !== item.id);
      emitSafe(runtime.sessionId, { type: "queue-updated", items: [...runtime.queue] });
    } catch (error) {
      runtime.queue = runtime.queue.filter((queued) => queued.id !== item.id);
      emitSafe(runtime.sessionId, { type: "queue-updated", items: [...runtime.queue] });
      throw error;
    }
  }

  async function compact(sessionId: string, instructions?: string): Promise<void> {
    const runtime = await ensureRuntime(sessionId);
    const options =
      instructions === undefined || instructions === ""
        ? undefined
        : { customInstructions: instructions };
    const result = await runtime.lane.compact(options, BACKGROUND_CONTEXT);
    if (!result.ok) throw new Error(`压缩上下文失败：${toErrorText(result.error)}`);
  }

  function isRunning(sessionId: string): boolean {
    return runtimes.get(sessionId)?.running ?? false;
  }

  async function closeSession(sessionId: string): Promise<void> {
    const runtime = runtimes.get(sessionId);
    if (!runtime) return;
    runtimes.delete(sessionId);
    deps.approvals.cancelSession(sessionId);
    runtime.queue = [];
    emitSafe(runtime.sessionId, { type: "queue-updated", items: [] });
    for (const unsubscribe of runtime.unsubscribers) {
      try {
        unsubscribe();
      } catch (error) {
        console.warn(`取消事件订阅失败 ${sessionId}：${toErrorText(error)}`);
      }
    }

    // 运行中直接关掉（退出/释放）会把「活跃操作」留在会话里，下次打开就是 LaneBusy；
    // 先尽力收敛一次，失败也不阻塞关闭流程 —— 这里已经不再需要这次运行的结果了
    if (runtime.running) {
      await abortStaleOperation(runtime.lane, runtime.sessionId);
    }
    try {
      await runtime.harness.close(BACKGROUND_CONTEXT);
    } catch (error) {
      console.warn(`关闭 Agent 运行时失败 ${sessionId}：${toErrorText(error)}`);
    }
    try {
      await runtime.session.close(BACKGROUND_CONTEXT);
    } catch (error) {
      console.warn(`关闭会话失败 ${sessionId}：${toErrorText(error)}`);
    }
  }

  async function dispose(): Promise<void> {
    await Promise.allSettled([...creations.values()]);
    for (const sessionId of [...runtimes.keys()]) {
      try {
        await closeSession(sessionId);
      } catch (error) {
        console.warn(`释放会话运行时失败 ${sessionId}：${toErrorText(error)}`);
      }
    }
    if (defaultRuntime === api) defaultRuntime = null;
  }
  const api: ChatRuntime = {
    send,
    stop,
    queue,
    compact,
    isRunning,
    setModel,
    closeSession,
    dispose,
  };
  defaultRuntime = api;
  return api;
}
