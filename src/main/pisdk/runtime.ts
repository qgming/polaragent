// 会话运行时：装配 AgentHarness、把 pi 事件桥接为 ChatEvent、维护运行/队列/审批门。

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AgentHarness,
  type AgentHarnessTool,
  type AgentLane,
  type AgentMessage,
  type AgentToolResult,
  BACKGROUND_CONTEXT,
  type CustomMessage,
  createCustomMessage,
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
  ChatStreamSnapshot,
  QueuedMessage,
} from "@/shared/contracts/chat";
import { type AgentMode, DEFAULT_AGENT_MODE, type ModelRef } from "@/shared/contracts/common";
import type { JobInfo } from "@/shared/contracts/job";
import { mcpServerRuleName, parseMcpToolName } from "@/shared/contracts/mcp";
import type {
  ChatMessageUsage,
  ChatPart,
  ContextBreakdown,
  ReasoningPart,
  SessionTokenUsage,
  SetSessionModelResult,
  TextPart,
  ToolCallPart,
} from "@/shared/contracts/session";
import type { Settings } from "@/shared/contracts/settings";
import type { SubagentEventEnvelope } from "@/shared/contracts/subagent";
import {
  isSubagentRunFinished,
  type SubagentDefinition,
  type SubagentRun,
} from "@/shared/contracts/subagent";
import { resolveEffectiveModelRef } from "@/shared/model-ref";
import { renderPrompt } from "@/shared/prompts/template";
import type { BrowserAutomation } from "../browser/types";
import { agentModeSection, shouldIncludeDelegationRules } from "./agent-mode-prompt";
import type { ApprovalService } from "./approvals";
import { errorText } from "./error-text";
import { createExecEnv } from "./exec-env";
import { createInteractionService, type InteractionService } from "./interactions";
import { buildJobResult } from "./job-delivery";
import { createJobService, type JobService } from "./jobs";
import type { McpToolSource } from "./mcp-servers";
import {
  assessToolRisk,
  commandWarning,
  getSharedPermissionRuleStore,
  type PermissionRuleStore,
} from "./permissions";
import { buildProviders, resolveModel } from "./providers";
import {
  createRepeatChain,
  hardRepeatReason,
  inspectRepeat,
  type RepeatChain,
  softRepeatNotice,
} from "./repeat-guard";
import { buildSubagentResult } from "./report-delivery";
import { resolveBuiltinSkillDir, resolvePromptTemplateDirs, resolveSkillDirs } from "./resources";
import {
  deriveContextBreakdown,
  estimateTokens,
  estimateToolsTokens,
  initSessionStatsState,
  onFirstToken,
  onMessageEnd,
  onMessageStart,
  onRunEnd,
  onToolEnd,
  onToolStart,
  onTurnStart,
  type SessionStatsState,
  sessionStatsView,
} from "./session-stats";
import type { SessionStore } from "./session-store";
import { loadSubagentCatalog } from "./subagent-catalog";
import {
  buildDelegationPrompt,
  buildSubagentSystemPrompt,
  formatSubagentsForSystemPrompt,
} from "./subagent-prompt";
// 循环依赖是刻意的：runner 需要 runtime 的 registerSubagentSession / getChatRuntime，
// runtime 需要 runner 的运行管理。两边都只在函数体内互相调用，模块初始化期不取值，安全。
import {
  abortSubagentRunsForParent,
  forgetSubagentRuns,
  listSubagentRuns,
  noteSubagentAssistantMessage,
  noteSubagentRunEnd,
  noteSubagentToolCall,
  reconcileSubagentRuns,
  reserveSubagentSlot,
  setSubagentEmitter,
  startSubagentRun,
  stopSubagentRun,
  waitSubagentRuns,
} from "./subagent-runner";
import { autoTitleSession, type SessionTitleGenerator } from "./title-generator";
import { type AppToolContext, buildTools, restrictTools, TOOL_NAMES } from "./tools";
import { createAskTool } from "./tools/ask";
import { createJobTools, JOB_OUTPUT_TOOL_NAME } from "./tools/jobs";
import { createSubagentTools } from "./tools/subagent";
import { createTodoState, parseTodoEntries, type TodoState, toTodoPayload } from "./tools/todo";

export interface ChatRuntimeDeps {
  getSettings: () => Promise<Settings>;
  sessionStore: SessionStore;
  /** 发往渲染进程的事件（由 IPC 层注入，内部做好异常隔离）；带会话 id，见 ChatEventEnvelope */
  emit: (payload: ChatEventEnvelope) => void;
  /**
   * 子智能体运行事件（派发、进度、状态、报告）的出口。
   *
   * 与 emit 分开而不是复用：它走 `subagents:event` 通道，emit 只在 `chat:event` 上发
   * 会话自己的消息流。两条流分开，渲染层才不必从会话消息里反推「这条是不是子智能体的」。
   * 同样由 IPC 层注入；不注入（单测）时子智能体照常运行，只是没有进度事件。
   */
  emitSubagent?: (envelope: SubagentEventEnvelope) => void;
  approvals: ApprovalService;
  /**
   * 提问服务（ask_user 用的那个）。
   *
   * 由 bootstrap 创建后注入 —— IPC 层也要拿同一个实例回填答案；未注入时（单测等场景）
   * 这里就地建一个，保证内置的 ask_user 工具始终有服务可用。
   */
  interactions?: InteractionService;
  /**
   * 后台作业服务（bash_background / job_output / job_list / job_kill 用的那个）。
   *
   * 与提问服务同源：由 bootstrap 创建后注入（IPC 层的 jobs:list / jobs:kill 要用同一份），
   * 未注入时就地建一份。**不要在 bootstrap 与这里各建一份** —— 两边各自持有一张作业表，
   * 渲染层看到的与工具操作的就会对不上。
   */
  jobs?: JobService;
  /**
   * 内置浏览器自动化（browser_* 工具用的那个）。
   *
   * 同样是「由 bootstrap 注入、未注入就没有浏览器工具」：实现依赖 Electron 的
   * WebContents，**在这里 import 它会把 electron 拖进 runtime 的单测**（node 环境），
   * 所以只能走依赖注入。生产环境传主进程单例（browser/service.ts 的 getBrowserAutomation）。
   */
  browser?: BrowserAutomation;
  /** 首轮问答结束后自动命名会话；未注入时（测试等场景）不做命名 */
  sessionTitles?: SessionTitleGenerator;
  /** 会话工作目录解析：取索引里绑定的 cwd，未绑定时由实现方回退进程当前目录 */
  resolveWorkingDir: (sessionId: string) => Promise<string>;
  /**
   * 应用根目录（`app.getAppPath()`），用来定位**随包分发的内置技能**
   * （`<appPath>/resources/skills`）。
   *
   * 由 bootstrap 注入而不是在这里 import electron：与 `browser` / `mcp` 同一套路，
   * runtime 必须能在 node 单测里跑。未注入时（测试）就只有数据目录与项目目录两个来源。
   */
  appPath?: string;
  /**
   * MCP 工具来源；未注入时（测试等场景）只装配内置工具。
   *
   * 连接管理在 pisdk/mcp-servers.ts，这里只取快照 + 订阅变化：
   * 新增/断开的 server 会让下一轮就拿到新的工具数组。
   */
  mcp?: McpToolSource;
}

/**
 * 每个会话连续被作业退出唤醒的上限。
 *
 * 没有它就会出现自激：「作业结束 → 唤醒模型 → 模型又起一个作业 → 又结束 → 再唤醒」，
 * 用户看到的是永远停不下来的运行。到上限后只发 job-changed 事件，模型下一次被用户
 * 叫起来时仍能从 job_list / job_output 看到结果 —— 信息不丢，只是不再自动开口。
 *
 * 计数在**用户自己发消息**时清零（见 send 的 internal 参数）。
 */
const MAX_JOB_WAKES = 3;

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
    console.warn(`读取当前 tip 失败：${errorText(error)}`);
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
  /**
   * 该会话当前流式消息的完整快照；没有在流的消息时为 null。
   *
   * 增量事件（part-delta）不带「从哪里开始」的信息，渲染层一旦发现缺口就必须整条补齐，
   * 否则拼出来的文本是错的。这里返回的就是主进程累积中的那份原文（权威来源）。
   */
  streamSnapshot(sessionId: string): ChatStreamSnapshot | null;
  isRunning(sessionId: string): boolean;
  /**
   * 列出该会话的后台作业。
   *
   * 渲染层切会话就要刷新一次作业面板，所以这里**不创建会话运行时**：只是看一眼列表面孔，
   * 不该顺带打开存储、附着 harness。作业表由作业服务独立持有，没有作业时就是空数组。
   */
  listJobs(sessionId: string): JobInfo[];
  /**
   * 杀掉某个后台作业（界面上「停止」按钮用）；返回杀后快照。
   *
   * 会话 fence 由作业服务校验：作业不存在、或不属于该会话，一律抛错（中文文案，可直接展示）。
   */
  killJob(sessionId: string, id: string): Promise<JobInfo>;
  /**
   * 子智能体交回报告时的投递入口（由 subagent-runner 在终态调用）。
   *
   * 为什么放在这里而不是让 runner 自己 send：唤醒预算与「父会话在不在跑」只有本闭包拿得到，
   * 而这两样正是投递决策的输入（规则见 report-delivery.ts）。放在这里也让子智能体复用
   * 与作业退出唤醒**同一格预算** —— 两套预算各算各的，等于把自激的上限翻倍。
   */
  deliverSubagentReport(run: SubagentRun): void;
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
  /** 这条流式消息的创建时刻（快照补齐时渲染层要用，与 message-added 一致） */
  createdAt: number;
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
  /**
   * 本会话是否正有一次 send 走在「已进入、还没开跑」的窗口里。
   *
   * 为什么不能只看 `running`：`send` 要 await 两个异步步骤（对齐模型、对齐思考档位）
   * 才把 running 置真，而并发进来的第二次 send 在这个窗口里看到的 running 仍是 false ——
   * 两次都调 lane.prompt，第二个被内核以 LaneBusy 拒收，随后**重试分支会 abort 掉
   * 第一个调用方的活跃运行**（一次用户消息静默杀死另一次）。
   * 这个标志在**任何 await 之前**同步置位，把窗口关掉。
   */
  sending: boolean;
  /** 本次运行的本地 runId，保证 run-started 与 run-ended 对应 */
  runId?: string;
  /**
   * **内核**为当前这一轮生成的 runId（由 run_start 事件捕获）。
   *
   * 为什么单独存一份：run_end 事件带的是内核的 id，而 `runId` 是 send 自己生成的 ——
   * 两套 id 没有关系。只有记下内核这个值，才能判断一条 run_end 是不是**上一轮的尾巴**
   *（见 handleRunEnd）。用本地 runId 去比会导致每一条 run_end 都被误丢。
   */
  kernelRunId?: string;
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
  /**
   * 本会话创建时装配的那四个子智能体工具（只有主会话有，子智能体会话是空数组）。
   *
   * 存一份是为了 MCP 热替换：`harness.setTools` 是**整表替换**，
   * 不带回去这些工具就会在那次替换后凭空消失（ask_user 踩过同一个坑）。
   */
  subagentTools: AgentHarnessTool<AppToolContext>[];
  queue: QueuedMessage[];
  unsubscribers: Array<() => void>;
  /** 本次会话是否已经试过自动命名（失败也在内存里记下，避免每轮重复请求） */
  titleAttempted?: boolean;
  /**
   * MCP 工具集合在本轮运行期间变过（连上/断开/工具列表变化）。
   *
   * 运行中不动工具集：`harness.setTools` 会影响正在进行的这一轮，
   * 于是先记下，等 run_end 再一次性应用（下一轮就带新工具）。
   */
  mcpToolsStale?: boolean;
  /** 本会话已被作业退出唤醒几次（上限 MAX_JOB_WAKES）；用户自己发消息时清零 */
  jobWakes: number;
  /** 下一条从该会话发出的用户消息是否由系统内部产生（如作业结束通知）。由 notifyJobExit 在调用 send/queue 前设置；handleMessageStart user 分支消费后清空。 */
  pendingSynthetic?: "job";
  /**
   * 会话级统计折叠状态：turn/step 计数与 LLM/工具/TTFT/解码耗时。
   * 由 session-stats.ts 的纯函数增量维护，变化时经 emitSessionStats 推送渲染层。
   */
  stats: SessionStatsState;
  /**
   * 会话级 Token 用量合计：未缓存输入 / 缓存读取 / 缓存写入 / 输出。
   * 每次 assistant message_end 携带 usage 时累加，变化时经 emitTokenUsage 推送。
   */
  tokenUsage: SessionTokenUsage;
  /**
   * 上下文占用分解的固定项（系统提示词 / 工具定义，按请求装配时的估算值）。
   * messageTokens 由每次 usage 样本经 deriveContextBreakdown 倒推。
   */
  contextBreakdown: Omit<ContextBreakdown, "messageTokens">;
  /**
   * 最近一次的 usage 样本（未缓存输入 / 缓存读取 / 缓存写入）。
   *
   * 留着它是为了落盘：run_end 时索引里要存**已用**上下文（含对话消息段），
   * 而那个数只有从最近一次请求的 usage 才推得出来（见 persistUsage）。
   */
  lastUsage?: { input: number; cacheRead?: number; cacheWrite?: number };
  /**
   * 重复调用守卫的**链状态**（同名同参数的连续调用计数）。
   *
   * 每个会话一条链（一个 session = 一个 agent），用户新消息时清空 —— 见 repeat-guard.ts。
   * 放在会话上而不是进程级：两条会话的重复绝不该互相触发提醒。
   */
  repeatChain: RepeatChain;
  /**
   * 待注入的重复提醒文本。
   *
   * 为什么需要这一格中转：检测发生在 `after_tool`（工具刚跑完），而**往上下文里
   * 追加一条消息**必须在 `transform_context`（请求组装前）做。两个钩子的时机不同，
   * 所以中间要有个暂存位。注入后即清空。
   *
   * 内核没有 dsh 的 `additionalContexts`，所以这里是唯一的投递路径（见 repeat-guard 文件头）。
   */
  pendingRepeatNotice?: string;
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
    console.warn(`清理会话 ${sessionId} 的遗留操作失败：${errorText(result.error)}`);
    return false;
  } catch (error) {
    console.warn(`清理会话 ${sessionId} 的遗留操作异常：${errorText(error)}`);
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
    uncachedInputTokens: usage.input,
    cacheReadTokens: usage.cacheRead,
    cacheWriteTokens: usage.cacheWrite,
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

/**
 * 取一条消息的可见文本。**助手与用户都要能取**。
 *
 * 提到模块级并导出是为了可测：这条链（harness message_end → agentMessageText → 报告）
 * 原先没有任何测试，而两个消费端（排队中的用户消息、子智能体的报告）各错一次都很难看出来
 * —— 见下面那段历史。
 *
 * 曾经这里第一行是 `if (message.role !== "user") return "";` —— 那时它只被用来取排队中的用户消息。
 * 后来子智能体用它取**助手消息**当报告（见 noteSubagentAssistantMessage 的调用点），
 * 于是常数式返回空串：报告永远为空、而轮次照常 +1，坏得极隐蔽
 * （TaskWait 一律「（没有产出报告）」，但状态、轮次、工具计数全都正常）。
 *
 * 角色判断留给调用方：这里只回答「这条消息的正文是什么」，
 * 一个会把助手消息取成空串的取文函数，本身就是个陷阱。
 *
 * 类型上要显式收窄 content：`AgentMessage` 是联合类型，原来那句 `role !== "user"` 的早退
 * 恰好充当了收窄条件 —— 去掉它之后必须自己判「content 是不是数组」，
 * 否则助手消息那条分支根本编译不过（TypeScript 帮我们记住了这个改动的影响面）。
 */
export function agentMessageText(message: AgentMessage): string {
  const content = "content" in message ? message.content : undefined;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
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
 * 能执行任意代码的「解释器 / 包管理器」首词。
 *
 * 对它们**不派生规则**：批准一次 `npm run build` 若记成「允许 npm」，
 * 等于连带放行 `npm install evil-pkg`、`npm publish`、`npm config set ...:_authToken`；
 * `node` / `python` 同理（`node -e "..."` 就是任意执行）。
 * 这类命令每次都该问一次 —— 「始终允许」的便利性不值得把 shell 交出去。
 *
 * 注意这是一份**保守名单**，不是完备的「什么能执行代码」清单：
 * 漏掉某个二进制时的后果是「多问一次」，而不是「少问一次」，方向是安全的。
 */
const INTERPRETER_FIRST_WORDS = new Set([
  "node",
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "bun",
  "deno",
  "python",
  "python3",
  "pip",
  "pip3",
  "uv",
  "uvx",
  "ruby",
  "gem",
  "perl",
  "php",
  "composer",
  "go",
  "cargo",
  "rustc",
  "java",
  "javac",
  "dotnet",
  "bash",
  "sh",
  "zsh",
  "fish",
  "pwsh",
  "powershell",
  "cmd",
  "wsl",
  "env",
  "xargs",
  "eval",
  "exec",
  "source",
]);

/**
 * always_allow 的规则模式：bash 取命令首词，write/edit 取路径首段。
 *
 * **派生不出「有意义且足够窄」的模式时返回 undefined**，调用方据此**不写规则**
 *（见 gateTool 的 always_allow 分支）—— 后果是下次还得点一次卡，
 * 而不是把门永久打开。两个刻意的收窄：
 *
 * 1. **解释器/包管理器不派生**（见 INTERPRETER_FIRST_WORDS）：
 *    `npm run build` → 不写规则。否则一条「允许 npm」放行的东西远超用户批准的那一次。
 * 2. **绝对路径不派生**：`C:\Users\me\.ssh\authorized_keys` 的首段是 `Users`，
 *    `/home/u/...` 是 `home` —— 这种「作用域」宽到毫无意义（等于放行整个用户目录）。
 *    只有**相对路径**（项目内，如 `src/foo.ts` → `src`）才是有意义的授权范围。
 */
export function deriveRulePattern(
  toolName: string,
  args: Record<string, unknown>,
): string | undefined {
  if (toolName === TOOL_NAMES.bash) {
    const command = typeof args.command === "string" ? args.command.trim() : "";
    const first = command.split(/\s+/)[0];
    if (first === undefined || first === "") return undefined;
    // 解释器首词：不派生规则（详见常量说明）
    if (INTERPRETER_FIRST_WORDS.has(first.toLowerCase())) return undefined;
    return first;
  }
  if (toolName === TOOL_NAMES.write || toolName === TOOL_NAMES.edit) {
    const target = typeof args.path === "string" ? args.path.trim() : "";
    if (target === "") return undefined;
    // 绝对路径的首段是盘符/根下的第一层（Users、home、tmp…），作为授权范围没有意义
    if (path.isAbsolute(target)) return undefined;
    // `./src/a.ts` 的首段是 `.` —— 同样没有授权意义，去掉前导 `./` 再取
    const normalized = target.replace(/^\.[\\/]+/, "");
    return normalized
      .split(/[\\/]+/)
      .find((item) => item !== "" && item !== "." && !/^[a-zA-Z]:$/.test(item));
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

/**
 * AGENTS.md 的两层读取结果：全局（数据目录）与项目（会话工作目录）。
 *
 * 两层都可能为空串（文件不存在、不可读、或内容只有空白）。
 */
export interface AgentsMdLayers {
  global: string;
  project: string;
}

/**
 * 读 AGENTS.md 的两层：**数据目录的全局指令 + 工作目录的项目指令**。
 *
 * 为什么要两层：`~/.oint/AGENTS.md` 里的东西是**跨项目的长期偏好**
 * （「回答用中文」「别写没用的注释」），而 `<项目>/AGENTS.md` 是**这个项目的约定**
 * （「这个仓库用 pnpm」「测试在 test/ 下」）。只有一层时用户得二选一 ——
 * 要么把项目约定也塞进全局（污染所有项目），要么每个项目重复写一遍个人偏好。
 *
 * 两层都在时**都注入**：全局在前、项目在后（项目离当前任务更近，放后面更醒目）。
 *
 * 三个边界：
 * 1. **任一层缺失或不可读都静默忽略** —— 与原有行为一致，绝不能因为一个可选的
 *    指令文件让会话创建失败；
 * 2. **同路径去重**：`OINT_HOME` 被设成会话工作目录时两层会指向同一个文件，
 *    那时只读一次（否则同一段指令在提示里出现两遍）；
 * 3. 用**普通 fs 读**，不走 ExecutionEnv —— 与数据目录那层保持一致，
 *    也避免让调用方以为这份读取受 allowedRoots 约束。
 */
export async function readAgentsMd(cwd: string): Promise<AgentsMdLayers> {
  const globalPath = path.join(dataDir(), "AGENTS.md");
  const projectPath = path.join(cwd, "AGENTS.md");

  const readOne = async (file: string): Promise<string> => {
    try {
      return (await readFile(file, "utf8")).trim();
    } catch {
      // 不存在 / 不可读：静默忽略（可选文件，不该阻断会话）
      return "";
    }
  };

  const global = await readOne(globalPath);
  // 同一个文件不读第二遍：路径归一后比较，避免 `a/./AGENTS.md` 这类写法绕过判重
  const project =
    path.resolve(globalPath) === path.resolve(projectPath) ? "" : await readOne(projectPath);
  return { global, project };
}

/**
 * 系统提示：**模式身份段** + 工具指导 + 技能索引 + 两层 AGENTS.md；保持简洁，不做复杂模板。
 *
 * 模式段替换的是**开头那一段身份与工作方式**（见 agent-mode-prompt.ts）——
 * 两个模式的工具与能力完全相同，区别只在怎么写这段。
 */
export async function buildSystemPrompt(
  settings: Settings,
  cwd: string,
  skillsSection?: string,
  mode: AgentMode = DEFAULT_AGENT_MODE,
): Promise<string> {
  // 模式身份段里的 {{cwd}} 在这里渲染掉：模板只留一个占位符，避免两处各写一遍拼接
  const identity = renderPrompt(agentModeSection(mode, settings.language), { cwd });
  const sections = [identity, TOOL_GUIDANCE];

  // 技能以「名称 + 描述 + 文件路径」的紧凑索引注入，完整 SKILL.md 由模型按需通过 lane.skill 读取。
  // 该索引稳定不变，放在提示前缀里不会破坏缓存 —— 但**不要**在这里拼接技能全文。
  if (skillsSection !== undefined && skillsSection !== "") sections.push(skillsSection);

  /**
   * 两层 AGENTS.md（见 readAgentsMd 的说明）。
   *
   * 两段的标题刻意不同：用户与测试都要能分清哪段来自全局、哪段来自项目。
   * 全局在前、项目在后 —— 项目级更贴近当前任务，放在后面更醒目
   *（也是「越靠后的指令越新」这个直觉）。
   */
  const agents = await readAgentsMd(cwd);
  if (agents.global !== "") sections.push(`用户自定义指令（全局 AGENTS.md）：\n${agents.global}`);
  if (agents.project !== "") sections.push(`项目指令（AGENTS.md）：\n${agents.project}`);
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
 *
 * `appPath` 是**可选**的：给了才扫描随包分发的内置技能（`<appPath>/resources/skills`）。
 * 测试与不关心内置技能的调用方可以省略。
 */
export async function loadAgentResources(
  env: ExecutionEnv,
  settings: Settings,
  cwd: string,
  appPath?: string,
): Promise<LoadedAgentResources> {
  // 目录顺序即优先级（同名先出现者胜）：数据目录 → 项目 → 内置，所以用户能覆盖内置
  const skillDirs = resolveSkillDirs(cwd, appPath).map((dir) => path.resolve(cwd, dir));

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
    console.warn(`技能加载失败，按无技能继续：${errorText(error)}`);
  }

  let promptTemplates: PromptTemplate[] = [];
  try {
    const result = await loadPromptTemplates(
      env,
      resolvePromptTemplateDirs(cwd).map((dir) => path.resolve(cwd, dir)),
      BACKGROUND_CONTEXT,
    );
    for (const diagnostic of result.diagnostics) {
      console.warn(`提示模板加载警告（${diagnostic.code}）：${diagnostic.message}`);
    }
    promptTemplates = result.promptTemplates;
  } catch (error) {
    console.warn(`提示模板加载失败，按无模板继续：${errorText(error)}`);
  }

  return { skills, promptTemplates, skillsSection: formatSkillsForSystemPrompt(skills) };
}

/**
 * 子智能体子会话的登记表：子会话 id → 它的定义与父会话。
 *
 * 为什么放在模块级而不是 SessionRuntime 上：`createRuntime` 装配工具与系统提示时必须知道
 * 「这是不是一个子智能体会话」，而那一刻 runtime 对象还不存在（同一个先有鸡还是先有蛋的问题，
 * 见下面 laneRef / runtimeRef 的注释）。登记由 subagent-runner 在建好子会话、发出第一条消息
 * 之前完成，所以装配阶段一定读得到。
 *
 * 只增不减不行：会话关闭 / 运行收尾都要注销，否则同一个会话 id 被复用时会认错身份。
 */
const subagentSessions = new Map<string, SubagentSessionSpec>();

/** 子智能体子会话的装配依据：定义 + 它归属的父会话 */
export interface SubagentSessionSpec {
  definition: SubagentDefinition;
  parentSessionId: string;
}

/** 登记一个子智能体子会话（由 subagent-runner 在启动运行前调用） */
export function registerSubagentSession(childSessionId: string, spec: SubagentSessionSpec): void {
  subagentSessions.set(childSessionId, spec);
}

/** 注销子智能体子会话：会话关闭时调用，避免登记表随运行次数无界增长 */
export function unregisterSubagentSession(childSessionId: string): void {
  subagentSessions.delete(childSessionId);
}

/**
 * 当前真正可派的子智能体：被禁用的名字剔掉，其余照常装配。
 *
 * 读一次、用完就丢 —— 不缓存是刻意的：用户在设置里新建/启用了定义之后，
 * 下一次 Task 调用就该能派到它，不该等到会话重建。
 *
 * **不需要 ExecutionEnv**：定义目录是固定的两处，读取走普通 fs、不经过路径守卫
 *（技能那条路不同，见 loadAgentResources）。所以这里也不再有「目录不在 allowedRoots 里
 * 就一个定义都读不到」那个坑。
 */
async function loadEnabledSubagents(
  settings: Settings,
  cwd: string,
): Promise<SubagentDefinition[]> {
  try {
    const { definitions, diagnostics } = await loadSubagentCatalog(cwd);
    for (const diagnostic of diagnostics) console.warn(`子智能体定义警告：${diagnostic}`);
    return definitions.filter((def) => !settings.disabledSubagentNames.includes(def.name));
  } catch (error) {
    // 委派只是增强：定义读不出来就当没有子智能体，绝不能因此让会话创建失败
    console.warn(`读取子智能体定义失败，按无子智能体继续：${errorText(error)}`);
    return [];
  }
}

/** 本会话此刻生效的思考档位（子智能体定义优先，其次设置）；子智能体工具的依赖要拿它做显示 */
async function effectiveThinkingLevel(
  runtime: SessionRuntime,
  settings: Settings,
): Promise<Settings["thinkingLevel"]> {
  const spec = subagentSessions.get(runtime.sessionId);
  return spec?.definition.thinkingLevel ?? settings.thinkingLevel;
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
    console.warn(`恢复待办清单失败，按空清单继续：${errorText(error)}`);
  }
}
/**
 * 会话 ExecutionEnv 的允许根：工作目录 + **数据目录下的资源子目录** + 系统临时目录。
 *
 * 为什么不是整个数据目录（`dataDir()`）：那个目录里还住着 `settings.json`（含各服务的
 * API Key）、`permission-rules.json`（审批规则）与 `sessions/`（全部会话转录）——
 * 把数据根整个放行，等于让模型的 `read` 工具可以直接取走凭据、或改写自己的审批规则。
 * 资源文件只住在三个固定子目录里（见 resources.ts 的目录解析），所以只放行这三个。
 *
 * 三个来源的必要性：
 * - cwd：会话工作目录，技能/模板可能落在它下面的 `.oint/` 里；
 * - skills / prompts / subagents：数据目录里的全局资源，`loadAgentResources` 要经守卫读取；
 * - tmpdir：bash spill 的硬要求 —— 超长输出由内核写到 `os.tmpdir()/tmp-*` 下，
 *   工具结果里会附 "Full output: <path>"，那条路径不在允许根内时 read 会直接拒绝，
 *   模型只能退回去用 bash cat（等于 spill 白落，还多一次工具往返）。
 *
 * 注意：子目录此时可能还不存在（首次启动前）。`validatePathAccess` 是纯字符串判断、
 * 不做文件系统访问，所以不存在的根不会报错，只是永远匹配不上。
 */
export function sessionAllowedRoots(cwd: string, appPath?: string): string[] {
  const data = dataDir();
  const roots = [
    cwd,
    path.join(data, "skills"),
    path.join(data, "prompts"),
    path.join(data, "subagents"),
    tmpdir(),
  ];
  /**
   * 内置技能目录（`<appPath>/resources/skills`）也必须在允许根里。
   *
   * 漏掉它的症状与「技能目录不在 allowedRoots 内」完全一样：目录存在却 0 个技能，
   * 而 diagnostics 里只有一行 list_failed，很容易被当成「应用没带内置技能」。
   * 只放行 `resources/skills` 这一层，不放行整个 appPath —— 那是应用代码目录，
   * 没有理由让模型的 read 直接翻。
   */
  if (appPath !== undefined && appPath !== "") {
    roots.push(resolveBuiltinSkillDir(appPath));
  }
  return roots;
}

/**
 * 一轮结束时哪些 toolCallId 必须留在 `toolParts` 里。
 *
 * 唯一的判据是「结论还可能回填到这里吗」：
 * - 作业（`bash_background`）**跨轮**：起完进程这一轮就结束了，结论要等进程退出才有，
 *   那时才回写到启动它的那次调用上 —— 所以只要作业还在跑，它的 toolCallId 就得留；
 * - 子智能体委派同理，且它的终态由子会话的 run_end 决定，可能晚于父会话这一轮很久。
 *
 * 其余条目（read / write / edit / bash / grep 这些当轮就出结论的）一律可以回收：
 * 它们的结果在 emit 出去那一刻就已经写好，事件也发完了。
 *
 * 抽成纯函数是为了能直接单测这条判定 —— 它是「回收」与「回填」之间唯一的耦合点，
 * 判错任何一侧都会静默出错（漏回收 = 内存泄漏；多回收 = 结论丢失）。
 */
export function keptToolCallIds(input: {
  jobs: readonly { status: string; toolCallId: string | undefined }[];
  subagentRuns: readonly { status: SubagentRun["status"]; delegationId: string }[];
}): Set<string> {
  const keep = new Set<string>();
  for (const job of input.jobs) {
    if (job.status !== "running") continue;
    if (job.toolCallId !== undefined) keep.add(job.toolCallId);
  }
  for (const run of input.subagentRuns) {
    if (!isSubagentRunFinished(run.status)) keep.add(run.delegationId);
  }
  return keep;
}

export function createChatRuntime(deps: ChatRuntimeDeps): ChatRuntime {
  const runtimes = new Map<string, SessionRuntime>();
  const creations = new Map<string, Promise<SessionRuntime>>();
  // 子智能体运行事件的出口：模块级登记表，运行管理器 publish 时用它。
  // 在这里设而不是在 bootstrap：运行记录的生命周期与这个运行时实例一致，
  // 换一个实例（单测）就该换一个出口，留着上一条窗口的引用会往已销毁的窗口发消息。
  setSubagentEmitter(deps.emitSubagent ?? null);
  // 提问服务：与 approvals 一样是「跨会话共用、按会话结算」的服务；bootstrap 注入的那份
  // 同时被 IPC 层持有（渲染层回填答案走它），未注入时就地建一份给单测用
  const interactions = deps.interactions ?? createInteractionService({ emit: deps.emit });
  // 作业服务与提问服务一样跨会话共用一份：作业退出时交给 notifyJobExit 决定「注入还是唤醒」
  const jobs = deps.jobs ?? createJobService({ emit: deps.emit, onExited: notifyJobExit });

  function emitSafe(sessionId: string, event: ChatEvent): void {
    try {
      deps.emit({ sessionId, event });
    } catch (error) {
      console.warn(`发送聊天事件失败：${errorText(error)}`);
    }
  }

  function emitSessionStats(runtime: SessionRuntime): void {
    emitSafe(runtime.sessionId, {
      type: "session-stats",
      stats: sessionStatsView(runtime.stats),
    });
  }

  function emitTokenUsage(runtime: SessionRuntime): void {
    emitSafe(runtime.sessionId, {
      type: "token-usage",
      usage: runtime.tokenUsage,
    });
  }

  /** 按最近一次 usage 样本推导三段分解并推送（无 usage 时只推固定项） */
  function emitContextBreakdown(
    runtime: SessionRuntime,
    usage?: { input: number; cacheRead?: number; cacheWrite?: number },
  ): void {
    const breakdown =
      usage === undefined
        ? { ...runtime.contextBreakdown, messageTokens: 0 }
        : deriveContextBreakdown(runtime.contextBreakdown, {
            inputTokens: usage.input,
            cacheReadTokens: usage.cacheRead,
            cacheWriteTokens: usage.cacheWrite,
          });
    emitSafe(runtime.sessionId, { type: "context-breakdown", breakdown });
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
            console.warn(`处理会话事件失败（${type}）：${errorText(error)}`);
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

  /**
   * 流式增量：只发新增的那一小段，而不是整段累积文本。
   *
   * 逐 token 的全量下发在长回复上是 O(n²) 的 IPC 负载（序列化 + 结构化克隆），
   * 渲染层还会被每条事件推着整篇重渲染。增量把两样都降成 O(n)：
   * 权威校正由 part 的 start/end（走 part-upsert 全量）与渲染层的快照补齐负责。
   */
  function emitDelta(
    runtime: SessionRuntime,
    stream: AssistantStream,
    partIndex: number,
    kind: "text" | "reasoning" | "args",
    delta: string,
  ): void {
    if (delta === "") return;
    emitSafe(runtime.sessionId, {
      type: "part-delta",
      messageId: stream.messageId,
      partIndex,
      kind,
      delta,
    });
  }

  /** 取或创建文本 / 推理 part，保证 contentIndex 与 parts 下标一一对应 */
  function partFor(
    stream: AssistantStream,
    contentIndex: number,
    kind: "text" | "reasoning",
  ): { part: TextPart | ReasoningPart; index: number; created: boolean } {
    const existingIndex = stream.partIndexByContent.get(contentIndex);
    if (existingIndex !== undefined) {
      const existing = stream.parts[existingIndex];
      if (existing?.type === kind) {
        return { part: existing as TextPart | ReasoningPart, index: existingIndex, created: false };
      }
    }
    const created: TextPart | ReasoningPart =
      kind === "text" ? { type: "text", text: "" } : { type: "reasoning", text: "" };
    stream.parts.push(created);
    const index = stream.parts.length - 1;
    stream.partIndexByContent.set(contentIndex, index);
    return { part: created, index, created: true };
  }

  /** 取或创建工具调用 part；工具流式期间允许参数文本增量追加 */
  function toolPartFor(
    stream: AssistantStream,
    contentIndex: number,
    toolCall: { id: string; name: string; arguments: Record<string, unknown> },
  ): { part: ToolCallPart; index: number; created: boolean } {
    const existingIndex = stream.partIndexByContent.get(contentIndex);
    if (existingIndex !== undefined) {
      const existing = stream.parts[existingIndex];
      if (existing?.type === "tool-call") {
        if (toolCall.name !== "") existing.toolName = toolCall.name;
        if (toolCall.id !== "") existing.toolCallId = toolCall.id;
        return { part: existing, index: existingIndex, created: false };
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
    return { part: created, index, created: true };
  }

  function handleMessageStart(
    runtime: SessionRuntime,
    event: Extract<HarnessEvent, { type: "message_start" }>,
  ): void {
    const message = event.message;
    // custom 消息（如作业结束通知）待链路层支持后再启用
    if (message.role === "assistant") {
      const messageId = randomUUID();
      const createdAt = Date.now();
      runtime.stream = { messageId, createdAt, parts: [], partIndexByContent: new Map() };
      runtime.lastAssistantMessageId = messageId;
      // 会话统计：assistant 消息开始计时（message_start → message_end 为一步）
      runtime.stats = onMessageStart(runtime.stats, messageId, createdAt);
      // 排队等 entry_added 把条目 id 配回来（渲染层的「分支」入口需要它）
      runtime.pendingEntries.push({ messageId, role: "assistant" });
      emitSafe(runtime.sessionId, {
        type: "message-added",
        message: {
          id: messageId,
          role: "assistant",
          createdAt,
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
      // 作业唤醒产生的用户消息要标成系统来源；标记读一次即清，只影响这一条
      const origin = runtime.pendingSynthetic === "job" ? "system" : undefined;
      runtime.pendingSynthetic = undefined;
      emitSafe(runtime.sessionId, {
        type: "message-added",
        message: {
          id: messageId,
          role: "user",
          origin,
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
      const { part, index, created } = partFor(stream, update.contentIndex, "text");
      const textPart = part as TextPart;
      if (update.type === "text_delta") {
        // 会话统计：首个非空正文增量的到达时间即 TTFT 的第一 token
        runtime.stats = onFirstToken(runtime.stats, stream.messageId, Date.now());
        textPart.text += update.delta;
        // 少了 start 的防御路径：增量落在新 part 上，先把创建事件补出去，渲染层才有落点
        if (created) upsertPart(runtime, stream, index, textPart);
        emitDelta(runtime, stream, index, "text", update.delta);
        return;
      }
      // start 是结构事件（创建 part），end 带权威全文：两者都全量下发。
      // end 的全量顺带校正渲染层可能丢掉的增量，所以增量协议始终是「可丢的优化通道」。
      if (update.type === "text_end") textPart.text = update.content;
      upsertPart(runtime, stream, index, textPart);
      return;
    }

    // reasoning=false 时也可能出现 thinking 事件，这里完全按增量防御性处理
    if (
      update.type === "thinking_start" ||
      update.type === "thinking_delta" ||
      update.type === "thinking_end"
    ) {
      const { part, index, created } = partFor(stream, update.contentIndex, "reasoning");
      const reasoningPart = part as ReasoningPart;
      if (update.type === "thinking_delta") {
        // 会话统计：推理 delta 也算首 token（模型先吐思考再吐正文时 TTFT 应含思考）
        runtime.stats = onFirstToken(runtime.stats, stream.messageId, Date.now());
        reasoningPart.text += update.delta;
        if (created) upsertPart(runtime, stream, index, reasoningPart);
        emitDelta(runtime, stream, index, "reasoning", update.delta);
        return;
      }
      if (update.type === "thinking_end") reasoningPart.text = update.content;
      upsertPart(runtime, stream, index, reasoningPart);
      return;
    }

    if (update.type === "toolcall_start" || update.type === "toolcall_delta") {
      const content = update.partial.content[update.contentIndex];
      if (content?.type !== "toolCall") return;
      const { part, index, created } = toolPartFor(stream, update.contentIndex, content);
      runtime.toolParts.set(part.toolCallId, {
        messageId: stream.messageId,
        partIndex: index,
        part,
      });
      if (update.type === "toolcall_delta") {
        part.argsText += update.delta;
        if (created) upsertPart(runtime, stream, index, part);
        emitDelta(runtime, stream, index, "args", update.delta);
        return;
      }
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
    // 会话统计：折叠这一步的 LLM 耗时 / TTFT / 解码速度与 step 计数
    const now = Date.now();
    runtime.stats = onMessageEnd(runtime.stats, stream.messageId, now, message.usage?.output ?? 0);
    emitSessionStats(runtime);
    // 会话 Token 总量：累加本条消息的四个计费桶（usage 缺失时跳过）
    if (message.usage !== undefined) {
      const usage = message.usage;
      // 留一份样本给 run_end 落盘用（已用上下文要含对话消息段）
      runtime.lastUsage = usage;
      runtime.tokenUsage = {
        uncachedInputTokens: runtime.tokenUsage.uncachedInputTokens + usage.input,
        outputTokens: runtime.tokenUsage.outputTokens + usage.output,
        cacheReadTokens: runtime.tokenUsage.cacheReadTokens + usage.cacheRead,
        cacheWriteTokens: runtime.tokenUsage.cacheWriteTokens + usage.cacheWrite,
      };
      emitTokenUsage(runtime);
      emitContextBreakdown(runtime, usage);
    }
    /**
     * 子智能体进度的唯一计数点：轮次按「一条助手消息」算，报告取最后一条非空文本。
     *
     * 放在 message_end 而不是 message_update：流式期间每条消息会被更新很多次，
     * 在那里计数会把一次回复算成几十轮。非子智能体会话调用这里是空操作（runner 按子会话 id 查表）。
     */
    noteSubagentAssistantMessage(runtime.sessionId, {
      text: agentMessageText(message),
      failed,
    });
    runtime.lastAssistantMessageId = stream.messageId;
    runtime.stream = undefined;
  }

  function handleToolStart(
    runtime: SessionRuntime,
    event: Extract<HarnessEvent, { type: "tool_start" }>,
  ): void {
    // 会话统计：工具调用开始计时
    runtime.stats = onToolStart(runtime.stats, event.toolCallId, Date.now());
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
    // 计数要在早退之前：part 缺失只是渲染层的防御分支，这次工具调用确实发生过
    noteSubagentToolCall(runtime.sessionId);
    // 会话统计：工具调用结束，累加 toolMs
    runtime.stats = onToolEnd(runtime.stats, event.toolCallId, Date.now());
    emitSessionStats(runtime);
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
    /**
     * 陈旧 run_end：丢掉，别拿它给**当前**这一轮盖章。
     *
     * 场景：用户点停止 → `stop()` 立刻把 running 置 false 并发出 run-ended，
     * 然后 await 那次很慢的 `lane.abort()`（正在跑的工具没有中断通道）。
     * 用户随即又发了一条 → 新的 send 起了一轮新运行。此时旧操作的 run_end 才到。
     * 早先这里无条件 `running = false`，于是**新一轮刚跑起来就被翻成「未运行」**，
     * UI 在流式中途停转（`:2212` 那句「runEnded 保证不会把状态翻回去」并没有实现）。
     *
     * 判据必须是**内核自己的 runId**（`kernelRunId`，由 run_start 捕获），
     * 不能拿 send 里另生成的本地 runId 去比 —— 那是两套互不相干的 id 空间，
     * 比出来的结果恒为「不相等」，正常收尾会被全部误丢（会话永远停在 running）。
     *
     * 宽松侧兜底：没捕获到 kernelRunId 时照常处理。宁可多收尾一次（幂等），
     * 也不要因为缺少一个 id 就把这一轮永久挂住。
     */
    if (runtime.kernelRunId !== undefined && event.runId !== runtime.kernelRunId) {
      return;
    }
    runtime.kernelRunId = undefined;
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
    // 会话统计：run 结束，清理 pending calls
    runtime.stats = onRunEnd(runtime.stats);
    emitSessionStats(runtime);
    // 用量快照随会话落盘：下一轮或重启后打开这个会话时，底栏不必重算就有数
    void persistUsage(runtime);
    // 收尾一次子智能体运行：completed / aborted / failed 三态由内核给出。
    // 子智能体被**重复调用守卫**硬档终止时，runner 已经先落过 failed 终态（带原因），
    // noteSubagentRunEnd 是先到者为准的幂等操作，所以这里不会把它覆盖成 aborted。
    noteSubagentRunEnd(runtime.sessionId, {
      status:
        event.status === "failed" ? "failed" : event.status === "aborted" ? "aborted" : "completed",
      ...(event.status === "failed" ? { error: event.error.message } : {}),
    });
    runtime.runEnded = true;
    runtime.queue = [];
    pruneToolParts(runtime);
    emitSafe(runtime.sessionId, { type: "queue-updated", items: [] });
    emitSafe(runtime.sessionId, {
      type: "run-ended",
      runId: runtime.runId ?? event.runId,
      reason: event.status,
    });
    void touchSession(runtime);
    // 一轮问答结束：会话还没名字时，用这轮内容生成标题
    void maybeTitleSession(runtime, event.status);
    // 本轮跑动期间 MCP 工具集合变过：现在这一轮结束了，可以安全换工具（下一轮生效）
    if (runtime.mcpToolsStale === true && deps.mcp !== undefined) {
      void applyMcpTools(runtime, deps.mcp);
    }
  }

  /**
   * 一轮结束时回收 `toolParts` 里已经用不上的条目。
   *
   * 这张表按全局唯一的 toolCallId 累积，每个 part 带着 result / details / diff 全文；
   * 不回收的话，长会话每轮几十次工具调用会一直挂在内存里直到进程退出。
   *
   * **不能无条件清空**：作业（`bash_background`）与子智能体委派都是**跨轮**的 ——
   * 它们在这一轮结束后才到终态，而结论要回填到启动它的那次调用上
   * （见 deliverJobResult / deliverSubagentReport）。清空等于让那些回填永远找不到落点。
   * 保留集合由 `keptToolCallIds` 算出（纯函数，单测直接盖）。
   *
   * 历史消息的 part 由 `loadMessages` 从存储重建，不依赖这张内存表，
   * 因此这里的回收不影响回读。
   */
  function pruneToolParts(runtime: SessionRuntime): void {
    const keep = keptToolCallIds({
      jobs: jobs.list(runtime.sessionId).map((job) => ({
        status: job.status,
        toolCallId: jobs.toolCallIdOf(job.id),
      })),
      subagentRuns: listSubagentRuns(runtime.sessionId).map((run) => ({
        status: run.status,
        delegationId: run.delegationId,
      })),
    });
    for (const toolCallId of [...runtime.toolParts.keys()]) {
      if (!keep.has(toolCallId)) runtime.toolParts.delete(toolCallId);
    }
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
    // 流式尾部的 usage 样本同样可用于上下文分解（message_end 会再推一次，幂等覆盖）
    runtime.lastUsage = event.row.usage;
    emitContextBreakdown(runtime, event.row.usage);
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
      console.warn(`更新会话统计失败 ${runtime.sessionId}：${errorText(error)}`);
    }
  }

  /**
   * 把用量快照写回会话索引。
   *
   * 触发点是 run_end（一轮结束时落一次）：流式期间每个 step 都写盘会把索引打成一堆
   * 无谓的原子写，而这一轮结束时的值已经是完整的。
   * 写失败只告警：它是展示派生数据，坏了不该影响正在进行的对话。
   */
  async function persistUsage(runtime: SessionRuntime): Promise<void> {
    try {
      const sample = runtime.lastUsage;
      await deps.sessionStore.writeUsage(runtime.sessionId, {
        stats: sessionStatsView(runtime.stats),
        tokenUsage: runtime.tokenUsage,
        breakdown:
          sample === undefined
            ? { ...runtime.contextBreakdown, messageTokens: 0 }
            : deriveContextBreakdown(runtime.contextBreakdown, {
                inputTokens: sample.input,
                cacheReadTokens: sample.cacheRead,
                cacheWriteTokens: sample.cacheWrite,
              }),
      });
    } catch (error) {
      console.warn(`保存会话用量失败 ${runtime.sessionId}：${errorText(error)}`);
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
      console.warn(`会话自动命名失败，保留默认名称：${errorText(error)}`);
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
    subscribe(runtime, "run_start", (event) => {
      // 记下内核这一轮的 id：run_end 判「是不是上一轮的尾巴」全靠它（见 handleRunEnd）
      runtime.kernelRunId = event.runId;
    });
    subscribe(runtime, "turn_start", (event) => {
      // 会话统计：轮次计数（同 turnId 只计一次，见 session-stats 的 onTurnStart）
      runtime.stats = onTurnStart(runtime.stats, event.turnId);
      emitSessionStats(runtime);
    });
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

  /**
   * 把当前 MCP 工具数组写回 harness（内核的 setTools 支持热替换工具集）。
   *
   * 只在没有运行中进行时调用：会话句柄、lane、上下文都不变，换的只是工具表，
   * 于是「新连上的 server 的工具」下一轮就能用。
   *
   * 工具表是**整表替换**：这里必须把会话的 ask 工具一并重建传进去，
   * 否则 MCP 刷新一次，ask_user 就会凭空消失（见 tools.ts 的 buildTools 注释）。
   */
  async function applyMcpTools(runtime: SessionRuntime, mcp: McpToolSource): Promise<void> {
    runtime.mcpToolsStale = false;
    try {
      await runtime.harness.setTools(
        buildTools(
          mcp.tools(),
          createAskTool({ sessionId: runtime.sessionId, interactions }),
          jobToolsFor(runtime.sessionId),
          deps.browser,
        ),
        BACKGROUND_CONTEXT,
      );
    } catch (error) {
      console.warn(`刷新 MCP 工具失败：${errorText(error)}`);
    }
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

    // 黑名单命中时给审批卡带一行警示（它不再决定弹不弹卡，只是上下文）
    const warning = commandWarning(args);
    const decision = await deps.approvals.request({
      sessionId: runtime.sessionId,
      toolCallId,
      toolName,
      argsText,
      risk,
      // 交给 AI 预审：它需要工作目录来判断操作是否越出项目范围
      workingDir: runtime.env.cwd,
      ...(warning === undefined ? {} : { warning }),
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
      /**
       * MCP 工具名由 server 决定、数量不可预知：逐工具放行等于每次调用都弹卡，
       * 所以「始终允许」在 MCP 上写的是 server 级前缀规则（mcp__<server>__*）。
       * 前缀规则**不带 pattern** 是刻意的，它只覆盖第三方 server 的工具。
       */
      const mcp = parseMcpToolName(toolName);
      if (mcp !== null) {
        await runtime.rules.add({
          toolName: mcpServerRuleName(mcp.serverId),
          createdAt: Date.now(),
        });
      } else {
        /**
         * 内置工具：**派生不出 pattern 就不写规则**。
         *
         * 无 pattern 的规则等于把该工具永久全局放行（`matchesPermissionRule` 对空 pattern
         * 直接返回 true）。派生失败说明这次调用的参数形态我们认不出来，
         * 此时写一条宽规则就是在没有用户明确同意「这个工具以后都不用问」的前提下把门打开。
         * 只放行这一次（函数末尾 return undefined 的效果），下次照常弹卡。
         */
        const pattern = deriveRulePattern(toolName, args);
        if (pattern !== undefined && pattern !== "") {
          await runtime.rules.add({ toolName, pattern, createdAt: Date.now() });
        }
      }
    }
    return undefined;
  }

  async function createRuntime(sessionId: string): Promise<SessionRuntime> {
    const opened = await deps.sessionStore.open(sessionId);
    if (!opened) throw new Error(`无法打开会话：${sessionId}`);

    const settings = await deps.getSettings();
    const cwd = await deps.resolveWorkingDir(sessionId);
    /**
     * 子智能体子会话：登记表里有 spec 就按定义装配（工具子集、系统提示、模型与档位都随定义走）。
     * spec 由 subagent-runner 在「建好子会话、发出第一条消息之前」登记，所以这里一定读得到 ——
     * 读不到就说明这不是子智能体会话，按主会话那一套来。
     */
    const spec = subagentSessions.get(sessionId);
    // 允许根见 sessionAllowedRoots：cwd / dataDir 兜住技能与模板目录、
    // appPath 兜住随包分发的内置技能，tmpdir 让 read 能打开 bash spill 文件（"Full output: <path>"）。
    const env = await createExecEnv({
      cwd,
      allowedRoots: sessionAllowedRoots(cwd, deps.appPath),
    });

    const loaded = await loadAgentResources(env, settings, cwd, deps.appPath);

    // 会话级待办状态：create() 时就得交给工具，而 lane 要等 create 之后才有 ——
    // 所以持久化回调走一个可变的 laneRef（工具真正调用它时 lane 一定已就绪）
    const todo = createTodoState();
    let laneRef: AgentLane | undefined;

    const { models } = buildProviders(settings);
    /**
     * 模型：子智能体定义固定了模型就按定义（pin），否则继承**父会话实际在用的那个** ——
     * 读父会话的绑定而不是「设置里的默认」，否则主会话绑定过具体模型时，子智能体会悄悄跑在另一个模型上。
     * 会话自己绑定的优先，否则用设置里的默认模型；绑定失效（服务/模型被删）时
     * resolveEffectiveModelRef 会自动回落默认，不至于让一个旧会话打不开。
     */
    const boundModel =
      spec === undefined
        ? await deps.sessionStore.readModel(sessionId)
        : (spec.definition.model ?? (await deps.sessionStore.readModel(spec.parentSessionId)));
    const modelRef = resolveEffectiveModelRef(settings, boundModel);
    const model = resolveModel(settings, modelRef);
    if (!model || modelRef === null || models.getProviders().length === 0) {
      throw new Error("请先在设置中配置模型服务");
    }

    /**
     * 子智能体工具（Task 系列）只在**主会话**装配：子智能体不允许再委派（见 tools/subagent.ts），
     * 而且它们需要父会话 id、聊天运行时与运行管理器 —— 这三样只有 runtime.ts 拿得到（见 tools.ts 注释）。
     * 「本会话现在用哪个模型 / 哪一档」走 runtimeRef：装配时 runtime 还没建好（与 laneRef 同一个套路）。
     */
    let runtimeRef: SessionRuntime | undefined;
    const subagentTools =
      spec === undefined
        ? createSubagentTools({
            sessionId,
            cwd: () => env.cwd,
            // 定义每次现读：中途新增 / 启用了定义，下一次 Task 就能派它，不用重建会话
            definitions: async () => loadEnabledSubagents(await deps.getSettings(), env.cwd),
            /**
             * 名额预约：同步占位，因此同一条消息里并发发出的多个 Task 不会各看各的快照
             * （见 tools/subagent.ts 里那段为什么必须同步的说明）。失败时的占位者名单
             * 就是拒绝文案里要指名道姓的那批人。
             */
            reserveSlot: (delegationId, agentName) =>
              reserveSubagentSlot(sessionId, delegationId, agentName),
            start: async (request) =>
              startSubagentRun(request, {
                sessionId,
                cwd: env.cwd,
                parentModelId: runtimeRef?.model.id ?? model.id,
                parentThinkingLevel:
                  runtimeRef === undefined
                    ? settings.thinkingLevel
                    : await effectiveThinkingLevel(runtimeRef, settings),
              }),
            wait: (delegationIds, mode, minCompleted, timeoutSeconds) =>
              waitSubagentRuns(sessionId, delegationIds, mode, minCompleted, timeoutSeconds),
            // 对账后的列表（盘上 + 本进程）：TaskList 与并发上限都要看见重启前派出去、没跑完的那些
            list: () => reconcileSubagentRuns(sessionId),
            // 未知 id 直接跳过：由工具在文案里说明「没找到」（见 subagent-runner 的 stopSubagentRun）
            stop: async (delegationIds) => {
              const stopped: SubagentRun[] = [];
              for (const delegationId of delegationIds) {
                const run = await stopSubagentRun(sessionId, delegationId);
                if (run !== undefined) stopped.push(run);
              }
              return stopped;
            },
            parentModelId: () => runtimeRef?.model.id ?? model.id,
          })
        : [];

    /**
     * 系统提示：
     * - 主会话：交互式提示（工作目录 + 工具指导 + 工作规则 + 技能索引 + AGENTS.md），
     *   再追加**子智能体索引**与**委派路由段**；
     * - 子智能体：换成定义里的 prompt 正文 + 子智能体的工作规则。刻意不给它技能索引、
     *   也不给它子智能体索引：它是被派来干一件具体的事，不能再委派（契约不允许嵌套）。
     *
     * 索引与路由段的分工（两段刻意分开，见 subagent-prompt.ts 的文件头）：
     * - **索引**（`<available_subagents>`）是**目录**，两个模式都有 —— 没有它，
     *   通用模式下的模型看不见用户自定义的子智能体（内置那些能从 Task 描述里看到）；
     * - **路由段**是**策略**（该不该派、怎么派、怎么收敛），**只有编排模式**注入
     *   （判据见 agent-mode-prompt.ts 的 shouldIncludeDelegationRules）。
     *
     * ⚠️ **必须把结果真的交给内核**：`AgentHarness.create` 的 `systemPrompt` 缺省时，
     * 内核的 `resolveSystemPrompt` 直接返回空串（`generation.js`）—— 也就是说
     * 「算出来了但没传」等价于**完全没有系统提示**，而且不会有任何报错。
     * 这个坑曾经真的踩过：整段提示（身份 / 工具指导 / 技能索引 / AGENTS.md /
     * 子智能体清单 / 委派规则）只被用来估了个 token 数，一个字都没进模型。
     *
     * 用**函数形式**而不是字符串：内核每个 generation 都调一次（`resolveSystemPrompt`
     * 对函数型配置现算），于是**切换模式在下一次请求就生效**，不必重建 harness。
     * 静态部分（技能索引、子智能体清单、AGENTS.md）在会话创建时算一次就够，
     * 只有模式与语言每次现读 —— 否则每轮都要扫一遍磁盘。
     */
    const availableSubagents = spec === undefined ? await loadEnabledSubagents(settings, cwd) : [];
    /** 静态骨架 + 动态模式 → 完整系统提示（主会话用） */
    const composeMainPrompt = async (): Promise<string> => {
      const current = await deps.getSettings();
      // 会话级绑定优先，未绑定时跟随设置里的默认模式
      const mode = (await deps.sessionStore.readAgentMode(sessionId)) ?? current.agentMode;
      const parts = [await buildSystemPrompt(current, cwd, loaded.skillsSection, mode)];
      const index = formatSubagentsForSystemPrompt(availableSubagents);
      if (index !== "") parts.push(index);
      if (shouldIncludeDelegationRules(mode)) {
        const delegation = buildDelegationPrompt(availableSubagents, model.id);
        if (delegation !== "") parts.push(delegation);
      }
      return parts.join("\n\n");
    };
    const subagentPrompt =
      spec === undefined ? "" : buildSubagentSystemPrompt(spec.definition, cwd);
    const resolvePrompt = async (): Promise<string> =>
      spec === undefined ? await composeMainPrompt() : subagentPrompt;
    // 先算一次：上下文分解的固定项要一个具体数字，而函数形式拿不到「当前值」以外的东西
    const systemPrompt = await resolvePrompt();
    /**
     * 工具表：
     * - 主会话：全套（子智能体工具由第 5 个参数传入 —— 它们需要会话 id 与运行管理器）；
     * - 子智能体：**同一批工具对象**按定义里的 tools 过滤（restrictTools），
     *   于是「定义里写了 bash」与「子智能体拿到的是 bash」不可能漂移；ask_user / 作业 / 浏览器 /
     *   MCP / Task 系列都不在可分配名单里，过滤后自然拿不到（见 tools.ts 的注释）。
     */
    const tools =
      spec === undefined
        ? buildTools(
            deps.mcp?.tools() ?? [],
            createAskTool({ sessionId, interactions }),
            jobToolsFor(sessionId),
            deps.browser,
            subagentTools,
          )
        : restrictTools(
            buildTools(
              deps.mcp?.tools() ?? [],
              createAskTool({ sessionId, interactions }),
              jobToolsFor(sessionId),
              deps.browser,
            ),
            spec.definition.tools,
          );
    // 上下文分解的固定项：系统提示词与工具定义按「请求装配时」的估算值缓存
    const systemTokens = estimateTokens(systemPrompt);
    const toolsTokens = estimateToolsTokens(tools);
    const created = await AgentHarness.create(
      {
        session: opened.session,
        models,
        model,
        tools,
        /**
         * 函数形式：每个 generation 现算（内核 resolveSystemPrompt 对函数型配置每轮求值）。
         * 于是切换模式在下一次请求就生效，不必重建 harness。
         *
         * **这一行是系统提示唯一的投递点** —— 漏掉它时内核返回空串，
         * 模型拿不到任何身份、规则、技能索引与 AGENTS.md，且不会有任何报错。
         */
        systemPrompt: resolvePrompt,
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
        // 档位：子智能体以定义为准（没写才跟随设置），主会话按设置
        thinkingLevel: spec?.definition.thinkingLevel ?? settings.thinkingLevel,
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
      sending: false,
      runEnded: false,
      pendingEntries: [],
      toolParts: new Map(),
      queue: [],
      unsubscribers: [],
      jobWakes: 0,
      // 会话创建时装配的那一份（MCP 热替换时整表替换，必须原样带回去，否则这些工具会凭空消失）
      subagentTools,
      repeatChain: createRepeatChain(),
      stats: initSessionStatsState(),
      tokenUsage: {
        uncachedInputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      contextBreakdown: { systemTokens, toolsTokens },
    };
    // 供子智能体工具的依赖读取「本会话现在用哪个模型 / 哪一档」（装配时 runtime 还不存在）
    runtimeRef = runtime;
    runtime.unsubscribers.push(
      created.harness.hooks.on("before_tool", async (event) => {
        try {
          return await gateTool(runtime, event.toolName, event.toolCallId, event.args);
        } catch (error) {
          // 任何异常都按安全侧默认拒绝
          console.warn(`工具权限校验失败（${event.toolName}）：${errorText(error)}`);
          return { block: { reason: "权限校验失败，已拒绝该操作" } };
        }
      }),
    );

    /**
     * **重复调用守卫**（取代了原来的 maxTurns 截断，见 repeat-guard.ts 的文件头）。
     *
     * 为什么挂 `after_tool` 而不是 `before_tool`：
     * - 与四家实现（opencode / Roo / Cline / OpenHands）一致，它们都在**执行之后**计数；
     * - 而且被权限门拒绝的调用也应当计数 —— 模型反复尝试被拒的调用，
     *   恰恰是最需要打断的那类循环。`before_tool` 的返回值里插不进「顺便记一笔」。
     *
     * 两个会话类型一视同仁：主会话也会陷入重复，没有理由只守卫子智能体。
     */
    runtime.unsubscribers.push(
      created.harness.hooks.on("after_tool", async (event) => {
        try {
          const verdict = inspectRepeat(runtime.repeatChain, event.toolName, event.args);
          if (verdict === null) return undefined;
          if (verdict.level === "soft") {
            // 只暂存，投递交给 transform_context（两个钩子的时机不同）
            runtime.pendingRepeatNotice = softRepeatNotice(
              verdict.toolName,
              verdict.count,
              verdict.argsText,
            );
            console.warn(
              `重复调用守卫：${runtime.sessionId} 连续 ${verdict.count} 次调用 ${verdict.toolName}`,
            );
            return undefined;
          }
          /**
           * 硬档：终止这次运行。
           *
           * **先把终态定下来再请求中止**（顺序不能反）：`noteSubagentRunEnd` 是幂等的、
           * 先到者为准，所以这次运行的结局会是「失败：检测到重复调用」而不是笼统的
           * 「已停止」—— 用户与主代理都要能看出**这是异常**，不是跑太久了。
           */
          if (subagentSessions.has(runtime.sessionId)) {
            noteSubagentRunEnd(runtime.sessionId, {
              status: "failed",
              error: hardRepeatReason(verdict.toolName, verdict.count),
            });
          }
          console.warn(
            `重复调用守卫：${runtime.sessionId} 连续 ${verdict.count} 次调用 ${verdict.toolName}，已终止`,
          );
          // 不 await：本函数在工具回调里，等中止会让这一轮卡在这儿（stop 自己的注释也是这个理由）
          void stop(runtime.sessionId);
        } catch (error) {
          // 守卫只是增强：它自己出错绝不能影响工具调用的结果
          console.warn(`重复调用守卫失败（${event.toolName}）：${errorText(error)}`);
        }
        // 守卫从不改写工具结果（四家共识：只提醒 / 只中止，不篡改调用本身）
        return undefined;
      }),
    );

    /**
     * 把暂存的重复提醒**作为一条 user 角色的 custom 消息**追加进请求。
     *
     * 为什么用 custom 而不是普通 user 消息：
     * - `convertToLlm` 把它转成 user 角色（模型看得见，与 dsh 的做法一致）；
     * - 而 message-mapper **忽略 custom 条目**，所以它不会出现在用户的对话流里 ——
     *   它是给模型的自纠提示，不是用户说的话，不该伪装成用户发言。
     *
     * 注入后立刻清空：提醒只该出现在它触发之后的那一次请求里，
     * 留着会让它跟着整段历史一直重复。
     */
    runtime.unsubscribers.push(
      created.harness.hooks.on("transform_context", (event) => {
        const notice = runtime.pendingRepeatNotice;
        if (notice === undefined) return;
        runtime.pendingRepeatNotice = undefined;
        return {
          messages: [
            ...event.messages,
            createCustomMessage("repeat-notice", notice, false, undefined, Date.now()),
          ],
        };
      }),
    );

    // MCP 工具集合变化（server 连上/断开/工具列表变了）时刷新本会话的工具数组。
    // 运行中不打断当前这一轮：只打标记，等 run_end 再应用。
    if (deps.mcp !== undefined) {
      const mcp = deps.mcp;
      runtime.unsubscribers.push(
        mcp.subscribe(() => {
          if (runtime.running) {
            runtime.mcpToolsStale = true;
            return;
          }
          void applyMcpTools(runtime, mcp);
        }),
      );
    }

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
    const text = errorText(cause);
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
    /**
     * 子智能体的模型：定义里固定了就按定义（pin），否则**继承父会话实际在用的那个** ——
     * 读父会话的绑定而不是「设置里的默认」，否则主会话绑定过具体模型时，子智能体会悄悄跑在另一个模型上。
     */
    const spec = subagentSessions.get(runtime.sessionId);
    const bound =
      spec === undefined
        ? await deps.sessionStore.readModel(runtime.sessionId)
        : (spec.definition.model ?? (await deps.sessionStore.readModel(spec.parentSessionId)));
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
      console.warn(`应用会话模型失败（沿用当前值）：${errorText(error)}`);
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
      // 子智能体以定义为准（没写才跟随设置）：否则「定义里写了 high 的子智能体」会被这里的设置值
      // 按回去，定义形同虚设
      const desired = clampThinkingLevel(
        runtime.model,
        subagentSessions.get(runtime.sessionId)?.definition.thinkingLevel ?? settings.thinkingLevel,
      );
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
    internal?: { jobWake?: boolean; message?: CustomMessage },
  ): Promise<void> {
    const runtime = await ensureRuntime(sessionId);
    // 用户自己发起的消息清零作业唤醒预算；作业通知走 jobWake，不算用户发言（见 notifyJobExit）
    if (internal?.jobWake !== true) runtime.jobWakes = 0;
    /**
     * 并发闸门：同步置位，**早于下面任何 await**。
     *
     * 只看 `running` 是不够的 —— 从进入本函数到 `running = true`（`:1917` 附近）之间隔着
     * `applyModel` / `applyThinkingLevel` 两个 await，并发进来的第二次 send 在这个窗口里
     * 看到的 running 仍是 false。两次都会走到 lane.prompt，第二个被内核以 LaneBusy 拒收，
     * 而重试分支会 `abortStaleOperation` 再重发 —— 把**第一个调用方的活跃运行**中止掉。
     *
     * 运行中 / 启动中的重复 send 一律转为排队（followUp）：这与渲染层「运行中按回车
     * 就是排队」的既有行为一致，只是判定从「await 之后」提前到了「await 之前」。
     *
     * 这里直接调 `enqueueToLane` 而不是 `queue`：`queue` 在空闲时会转回 `send`，
     * 而此刻闸门已占、`running` 可能还是 false —— 走那条路会无限互相递归。
     */
    if (runtime.running || runtime.sending) {
      await enqueueToLane(runtime, text, "followUp");
      return;
    }
    runtime.sending = true;
    try {
      await sendLocked(runtime, text, images, messageId, options, internal);
    } finally {
      runtime.sending = false;
    }
  }

  /** send 的临界区：闸门已在调用方置位，这里负责真正开跑一轮 */
  async function sendLocked(
    runtime: SessionRuntime,
    text: string,
    images: ImageContent[] | undefined,
    messageId: string | undefined,
    options: ChatSendOptions | undefined,
    internal: { jobWake?: boolean; message?: CustomMessage } | undefined,
  ): Promise<void> {
    // 模型与思考档位都按**当前设置**对齐（设置每次现读，改完下一条消息就生效）：
    // 模型必须在档位之前 —— 档位的就近降级按 runtime.model 的支持范围算
    const settings = await deps.getSettings();
    await applyModel(runtime, settings);
    await applyThinkingLevel(runtime, settings);

    runtime.running = true;
    runtime.runEnded = false;
    /**
     * 重复调用守卫：**用户的新指令清空链**。
     *
     * 全新指令意味着前提变了 —— 模型接下来重复上一轮的调用完全可能是对的
     * （「再跑一次那个测试」），把它算作循环就是误报。
     *
     * 只在**用户真的说话**时清（`internal` 是系统内部消息：作业唤醒、子智能体报告投递），
     * 那两类不是用户意图，不该顺手洗白一条已经形成的循环。
     */
    if (internal?.message === undefined && internal?.jobWake !== true) {
      runtime.repeatChain = createRepeatChain();
    }
    // 上一次运行若因异常没能收到全部 entry_added，队列里会留下过期项：新一次运行先清空
    runtime.pendingEntries = [];
    // 记录渲染层乐观用户消息 id：主进程回显同一条用户消息时复用，避免 UI 出现两条
    // 系统通知消息（internal.message）没有乐观 id：通过 message_start 事件自带 id，不走 pending
    if (internal?.message === undefined) runtime.pendingUserMessageId = messageId;
    const runId = randomUUID();
    runtime.runId = runId;
    /**
     * 新一轮指令：上一轮派出去的委派不该继续跑 —— 新指令很可能已经改了前提（用户换了方向、
     * 原问题不再成立），让它们跑完只是白烧 token，还会在用户看得见的列表里留下过时的运行。
     * 只对**主会话**做：子智能体自己不会有委派（契约不允许嵌套）。
     */
    if (!subagentSessions.has(runtime.sessionId)) abortSubagentRunsForParent(runtime.sessionId);
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
  /** 启动这次作业的那次工具调用 id：结论要回填到它上面（见 job-delivery 的文件头） */
  function jobToolCallId(jobId: string): string | undefined {
    return jobs.toolCallIdOf(jobId);
  }

  /**
   * 作业到达终态：把结论**回填到启动它的那次 `bash_background` 调用上**。
   *
   * 与子智能体的 deliverSubagentReport 同一个形状与同一个理由：结论属于「这次调用」，
   * 写进它的 part（result / details / isError / status）就等于「这一步的结果回来了」，
   * 界面据此渲染成工具状态组件，模型下一轮也能在上下文里读到 ——
   * 而不是往对话里发一条用户消息。
   *
   * 找不到那次调用（part 已不在内存、或这是一次重启后的历史作业）时静默跳过：
   * 作业的输出仍可由 job_output 读到，界面那份 `job-changed` 事件也已经把状态更新了。
   */
  function deliverJobResult(job: JobInfo): void {
    const runtime = runtimes.get(job.sessionId);
    if (!runtime) return;
    const toolCallId = jobToolCallId(job.id);
    if (toolCallId === undefined) return;
    const ref = runtime.toolParts.get(toolCallId);
    if (!ref) return;
    const result = buildJobResult(job, jobs.peekTail(job.id).replace(/\s+$/, ""));
    // running 不写回：还没结束就没有结论（与子智能体同一个约定）
    if (result === null) return;
    ref.part.result = result.text;
    ref.part.details = { job };
    ref.part.isError = result.isError;
    ref.part.status = result.isError ? "error" : "done";
    emitSafe(runtime.sessionId, {
      type: "part-upsert",
      messageId: ref.messageId,
      partIndex: ref.partIndex,
      part: ref.part,
    });
  }

  /**
   * 作业退出后的**提醒**（不再是「结论」）。
   *
   * 结论已经在这一刻被 deliverJobResult 回填到那次调用上了（那是转录的一部分，
   * 模型下一轮看得到），所以这条推给对话的消息只做一件事：**让模型现在就醒来看一眼**。
   * 因此它不再复制尾部输出 —— 那会与工具结果里那份重复一遍，
   * 而重复的长文本正是要避免的（构建日志可以很长）。
   *
   * 唤醒决策一律保持不变（正在跑就 steer、空闲就 send 且受 MAX_JOB_WAKES 约束）：
   * 作业在会话空闲时结束，模型确实需要被叫起来，去掉它等于悄悄砍掉一个已有特性。
   * 这条通知不消耗 job_output 的 drain 游标，所以模型照着提示去读仍能读到那些内容。
   */
  function jobExitNotice(job: JobInfo): string {
    const code = job.exitCode === undefined ? "" : `，退出码 ${job.exitCode}`;
    return (
      `后台作业 ${job.id} 已结束（状态 ${job.status}${code}）：${job.command}\n` +
      `它的输出与结论已经写在上面那次调用的结果里；` +
      `要读还没看过的输出就调用 ${JOB_OUTPUT_TOOL_NAME} {"id":"${job.id}"}。`
    );
  }

  /**
   * 作业退出后的唤醒决策（**本特性的关键**，别省）：
   * - 该会话正在运行 → 用 steer 把通知插进当前轮次，**不计**唤醒次数（这次唤醒本来就要发生）；
   * - 空闲 → 用 send 起一轮新运行，但要过唤醒预算：连续唤醒超过 MAX_JOB_WAKES 就只留事件，
   *   不再自动开口，避免「作业结束 → 唤醒 → 模型又起作业」的自激；
   * - cancelSession / dispose 清理导致的退出由服务侧拦下（不会调到这里的回调），这里不必再判。
   */
  function notifyJobExit(job: JobInfo): void {
    const runtime = runtimes.get(job.sessionId);
    // 会话已经关掉（或还没建起来）时没有可通知的对象
    if (!runtime || jobs.isSuppressed(job.sessionId)) return;
    // 先落结论（界面与模型都在那次调用上看到它），再决定要不要叫醒模型 ——
    // 标记下一条 user 消息是系统产生的（见 pendingSynthetic 说明）
    runtime.pendingSynthetic = "job";
    // 顺序有讲究：结论是必做的，唤醒只是提醒；反过来会让「到预算了就不写结论」成为可能
    deliverJobResult(job);
    const text = jobExitNotice(job);
    /**
     * 判定必须同时看 `sending`，不能只看 `running`。
     *
     * 两者之间有窗口：`sending` 在 send 一进入就置位，而 `running` 要等对齐模型/档位
     * 之后才置真。只判 `running` 时，在这个窗口里结束的作业会走下面的 `send(...)` 分支 ——
     * 而 send 见到闸门已占又把它转成 followUp，于是这条通知被排到**下一轮**才可能被消费，
     * 而唤醒预算已经扣掉了。更糟的是 `stop()` 期间（running 已 false、sending 仍 true、
     * abort 还在飞）走这条路，sendLocked 的 finally 会清空 queue，通知直接消失。
     *
     * 用 steer 是安全的：运行中它插进当前轮次；若这一轮其实正在收尾，lane 会把它
     * 交给下一次边界（followUp 语义），比「丢掉」好。
     */
    if (runtime.running || runtime.sending) {
      void queue(runtime.sessionId, text, "steer").catch(async (error: unknown) => {
        /**
         * steer 失败说明 lane 上其实没有可插入的操作（`sending` 为真但 prompt 还没被
         * lane 受理——正是那个启动窗口）。这时退回 `send` 走正常唤醒路径：
         * 此刻闸门可能已经放开，`send` 会起一轮真正的运行。
         * 两次都失败才记日志 —— 通知本身不能因为一次路由判断失误就消失。
         */
        console.warn(`注入作业结束通知失败，改走唤醒：${job.id}：${errorText(error)}`);
        if (runtime.jobWakes >= MAX_JOB_WAKES) return;
        runtime.jobWakes += 1;
        await send(runtime.sessionId, text, undefined, undefined, undefined, {
          jobWake: true,
        }).catch((retryError: unknown) => {
          console.warn(`发送作业结束通知失败 ${job.id}：${errorText(retryError)}`);
        });
      });
      return;
    }
    if (runtime.jobWakes >= MAX_JOB_WAKES) {
      // 到预算了：不发消息，只留下已经发过的 job-changed 事件；用户下次说话时模型再看 job_list
      return;
    }
    runtime.jobWakes += 1;
    void send(runtime.sessionId, text, undefined, undefined, undefined, { jobWake: true }).catch(
      (error: unknown) => {
        console.warn(`发送作业结束通知失败 ${job.id}：${errorText(error)}`);
      },
    );
  }
  /**
   * 子智能体到达终态：把结果**回填到那次 Task 调用的 part 上**（本次修复的核心形状）。
   *
   * 用户的要求是：报告不作为用户消息出现，而是作为「调用子智能体」这一步的结果，
   * 显示在「xxx 已完成」这个状态里。所以这里不做「推一条消息」，而是改写那次调用的 part：
   * 它已经在转录里、已经在界面上，补上终态与报告就等于「这次调用的结果回来了」。
   *
   * 为什么要写进 part 而不是只在 store 里留一份：
   * - 界面：渲染层从 part.artifact（= details）解析出 SubagentDetailData，pill 因此从
   *   「已完成」直接取到报告；
   * - 模型：这条 part 的 details/result 是**会话转录的一部分**，模型下一次发言时它就在
   *   上下文里 —— 这就是「主会话可以来读取这个内容」，不需要系统替模型开口，
   *   也就不再有自激唤醒的问题（原先那套唤醒预算因此删掉）。
   *
   * 找不到那次调用的 part 时静默跳过：可能已经滚出内存、或这是一次重启后的历史运行。
   * 那种情况下报告仍在运行记录与右侧栏面板里，界面不会因此显示错状态。
   */
  function deliverSubagentReport(run: SubagentRun): void {
    const runtime = runtimes.get(run.sessionId);
    if (!runtime) return;
    const ref = runtime.toolParts.get(run.delegationId);
    if (!ref) return;
    const result = buildSubagentResult(run);
    // running 不写回：正在跑的运行不该有「结果」，那一步由进度事件负责
    if (result === null) return;
    ref.part.result = result.text;
    ref.part.details = run;
    ref.part.isError = result.isError;
    ref.part.status = result.isError ? "error" : "done";
    emitSafe(runtime.sessionId, {
      type: "part-upsert",
      messageId: ref.messageId,
      partIndex: ref.partIndex,
      part: ref.part,
    });
  }

  /**
   * 组装该会话的四个作业工具。
   *
   * **两处 buildTools 调用都必须带上**（会话创建 + MCP 热替换）：工具表是整表替换，
   * 漏一处就会出现「MCP 一刷新，作业工具凭空消失」。
   */
  function jobToolsFor(sessionId: string): AgentHarnessTool<ExecutionToolContext>[] {
    return createJobTools({ sessionId, jobs }) as AgentHarnessTool<ExecutionToolContext>[];
  }

  /** lane 上是否压着没收尾的操作（压缩、导航等不经过 running 标记） */
  async function hasActiveOperation(runtime: SessionRuntime): Promise<boolean> {
    try {
      const info = await runtime.lane.inspectExecution(BACKGROUND_CONTEXT);
      return info.current !== null;
    } catch (error) {
      // 读不出来按「没有」处理：宁可放行也不要因为一次读取失败把功能锁死
      console.warn(`读取 lane 执行状态失败：${errorText(error)}`);
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
    interactions.cancelSession(sessionId);
    runtime.queue = [];
    emitSafe(runtime.sessionId, { type: "queue-updated", items: [] });
    /**
     * 先把「这次运行结束了」定下来，再去请求内核中止。
     *
     * 为什么顺序不能反：`lane.abort()` 不只是「请求中止」，它会 `await this.drive({operationId})`
     * —— 也就是**驱动那一轮跑到能收尾为止**再返回。而正在执行的工具没有中断通道
     *（工具只从 `context.abortSignal` 拿到信号，我们的工具集一个都没读），
     * 所以一条长命令会把 abort 拖到它自己结束。原来这里 await 完才（在失败分支）改 running，
     * 用户看到的就是「点了停止没反应」。
     *
     * 现在把顺序反过来：用户按下的那一刻运行就算结束了 —— UI 立刻脱离 running、
     * 队列清空、也不再接受新的插话。内核那次 abort 仍是**必须**发出去的（否则这一轮
     * 的工具调用还会继续、还会往会话里写），只是不再拿它的完成当作用户看到结果的前提。
     *
     * 与 handleRunEnd 的关系：那边收到 run_end 时会再设一次 running=false 并写终态，
     * 都是幂等的；`runEnded` 标志保证不会把状态翻回去（见 handleRunEnd 末尾）。
     */
    runtime.running = false;
    runtime.runEnded = true;
    runtime.queue = [];
    emitSafe(runtime.sessionId, { type: "queue-updated", items: [] });
    emitSafe(runtime.sessionId, {
      type: "run-ended",
      runId: runtime.runId ?? randomUUID(),
      reason: "aborted",
    });
    try {
      await runtime.lane.abort(BACKGROUND_CONTEXT);
    } catch (error) {
      console.warn(`请求中止运行失败 ${sessionId}：${errorText(error)}`);
    }
  }

  async function queue(sessionId: string, text: string, mode: "steer" | "followUp"): Promise<void> {
    const runtime = await ensureRuntime(sessionId);
    /**
     * 重复调用守卫：排队 / 插话也是**用户的新指令**，同样清空链。
     *
     * 注意这里也会覆盖「作业结束唤醒」那条内部路径（notifyJobExit 经 queue 发 steer）——
     * 那是可接受的：作业结束是一条**新信息**，前提确实变了，此时重置链是对的
     *（模型接下来重复调用可能是合理的反应）。
     */
    runtime.repeatChain = createRepeatChain();
    /**
     * 空闲时直接按发送处理，避免消息无声挂起。
     *
     * `sending` 也要判：那一刻有一轮 send 正走在「已进入、还没开跑」的窗口里
     * （见 SessionRuntime.sending 的说明）。此时**不能**转回 send —— 那条路会立刻
     * 走「闸门已占」的分支再调回本函数，形成 send ↔ queue 的无限互相递归。
     * 交给 lane 入队才是对的：即将开始的那一轮会把它一起带出去。
     */
    if (!runtime.running && !runtime.sending) {
      await send(sessionId, text);
      return;
    }
    await enqueueToLane(runtime, text, mode);
  }

  /**
   * 真正把消息交给 lane 的队列入队。
   *
   * 从 `queue` 里抽出来，是为了让 `send` 的「闸门已占」分支能直接调它 ——
   * 那条分支若走 `queue`，而 `queue` 在空闲时又转回 `send`，两者会无限递归。
   * 本函数**不做任何路由判断**，只负责入队与占位项的生命周期。
   */
  async function enqueueToLane(
    runtime: SessionRuntime,
    text: string,
    mode: "steer" | "followUp",
  ): Promise<void> {
    const item: QueuedMessage = { id: randomUUID(), text, mode };
    runtime.queue = [...runtime.queue, item];
    emitSafe(runtime.sessionId, { type: "queue-updated", items: [...runtime.queue] });
    try {
      const result =
        mode === "steer"
          ? await runtime.lane.steer(text, undefined, BACKGROUND_CONTEXT)
          : await runtime.lane.followUp(text, undefined, BACKGROUND_CONTEXT);
      if (!result.ok) throw new Error(`消息入队失败：${errorText(result.error)}`);
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
    if (!result.ok) throw new Error(`压缩上下文失败：${errorText(result.error)}`);
  }

  function isRunning(sessionId: string): boolean {
    return runtimes.get(sessionId)?.running ?? false;
  }

  /** 当前流式消息的快照；parts 复制一层数组，避免调用方拿到会被后续增量改写的引用 */
  function streamSnapshot(sessionId: string): ChatStreamSnapshot | null {
    const stream = runtimes.get(sessionId)?.stream;
    if (!stream) return null;
    return {
      messageId: stream.messageId,
      parts: [...stream.parts],
      createdAt: stream.createdAt,
    };
  }

  /**
   * 列出该会话的后台作业。
   *
   * 刻意**不走 ensureRuntime**：渲染层切会话就要刷一次作业面板，为了列个表去建整套会话运行时
   * （打开存储、附着 harness、注册事件）代价太大，也带来「只是看了一眼就有了运行时」的副作用。
   * 作业表由 JobService 独立持有，因此这里不需要会话运行时也能给出正确结果（没有就是空数组）。
   */
  function listJobs(sessionId: string): JobInfo[] {
    return jobs.list(sessionId);
  }

  /** 杀掉一个后台作业；存在性与会话归属由作业服务校验，找不到时它抛的就是中文错误 */
  async function killJob(sessionId: string, id: string): Promise<JobInfo> {
    return jobs.kill(sessionId, id);
  }

  async function closeSession(sessionId: string): Promise<void> {
    // 子智能体子会话（或它的父会话）：注销定义登记 —— 放在「有没有 runtime」之前，
    // 因为登记表是模块级的，即便这个会话已经没有运行时也不该在里面留下条目。
    unregisterSubagentSession(sessionId);
    const runtime = runtimes.get(sessionId);
    if (!runtime) {
      // 没有运行时的会话（没被打开过）也要清运行记录：登记表同样是模块级的
      forgetSubagentRuns(sessionId);
      return;
    }
    runtimes.delete(sessionId);
    deps.approvals.cancelSession(sessionId);
    interactions.cancelSession(sessionId);
    jobs.cancelSession(sessionId);
    runtime.queue = [];
    emitSafe(runtime.sessionId, { type: "queue-updated", items: [] });
    for (const unsubscribe of runtime.unsubscribers) {
      try {
        unsubscribe();
      } catch (error) {
        console.warn(`取消事件订阅失败 ${sessionId}：${errorText(error)}`);
      }
    }

    // 运行中直接关掉（退出/释放）会把「活跃操作」留在会话里，下次打开就是 LaneBusy；
    // 先尽力收敛一次，失败也不阻塞关闭流程 —— 这里已经不再需要这次运行的结果了
    if (runtime.running) {
      await abortStaleOperation(runtime.lane, runtime.sessionId);
    }
    /**
     * `forgetSubagentRuns` 必须在 abort **之后**。
     *
     * 它会把这次运行从 `liveByChild` 里摘掉，而 `noteSubagentRunEnd` 正是靠那张表
     * 找到条目并写下终态 —— 早先放在 abort 之前，于是 aborted 的 run_end 到达时
     * 查不到条目、直接 return，运行就**永远停在盘上的 running**，
     * 只能等下次启动由 reconcile 纠正成 interrupted（用户看到一次假的「运行中」）。
     */
    forgetSubagentRuns(sessionId);
    try {
      await runtime.harness.close(BACKGROUND_CONTEXT);
    } catch (error) {
      console.warn(`关闭 Agent 运行时失败 ${sessionId}：${errorText(error)}`);
    }
    try {
      await runtime.session.close(BACKGROUND_CONTEXT);
    } catch (error) {
      console.warn(`关闭会话失败 ${sessionId}：${errorText(error)}`);
    }
  }

  async function dispose(): Promise<void> {
    await Promise.allSettled([...creations.values()]);
    for (const sessionId of [...runtimes.keys()]) {
      try {
        await closeSession(sessionId);
      } catch (error) {
        console.warn(`释放会话运行时失败 ${sessionId}：${errorText(error)}`);
      }
    }
    // 兜底：作业是系统资源，会话循环覆盖不到的（理论上不该有）也在这里一并收掉
    await jobs.dispose();
    /**
     * 拆掉子智能体事件出口：它是模块级登记表，闭包里握着窗口广播函数。
     * 不置空的话，退出后（或单测换一个 runtime 实例后）仍会往已销毁的窗口发消息。
     * API 本身就提供了「传 null 取消」这条语义（见 subagent-runner 的说明）。
     */
    setSubagentEmitter(null);
    if (defaultRuntime === api) defaultRuntime = null;
  }
  const api: ChatRuntime = {
    send,
    stop,
    queue,
    compact,
    streamSnapshot,
    isRunning,
    listJobs,
    killJob,
    setModel,
    closeSession,
    deliverSubagentReport,
    dispose,
  };
  defaultRuntime = api;
  return api;
}
