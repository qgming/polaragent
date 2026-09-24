// 宿主 ↔ 插件进程的 RPC 契约。
//
// ## 传输与形状
//
// 走 `utilityProcess` 的 `postMessage`（结构化克隆）。**消息是纯 JSON 可表达的值**，
// 不带函数、不带类实例 —— 结构化克隆能过的东西比 JSON 多，但只在 JSON 范围内设计
// 让"这条消息能不能跨进程"不需要试。
//
// ## 为什么是"声明 + 调用"两段，而不是让插件自己注册
//
// 插件进程启动时**一次性声明**它提供什么（工具、命令），宿主据此在模型侧建出工具表；
// 之后每一次调用都是宿主 → 插件的单向请求。
//
// 这样设计的原因：模型看到工具表的那一刻，表必须是完整的（内核的 `activeToolNames`
// 在创建时播种，中途加工具要重建会话）。让插件在运行期随时 `registerTool` 会制造
// "工具表在两次请求之间变了"这种状态，而内核不打算支持它。
//
// **钩子是唯一的例外**：它在**清单**里声明（`hooks[]`），不在 `ready` 里。
// 理由见 `PluginHookMessage` 的注释（要能在装之前展示、要在进程没起来时也知道它存在）。
//
// ## 版本
//
// 每条消息带 `v`。不匹配就**拒绝启动**而不是尽量解析 —— 与清单的 `apiVersion`
// 同一条纪律：不认识的版本按旧版解释，字段对不上而没有任何提示。

import type { PluginHookEvent } from "./plugin";

/** RPC 协议的版本；与清单的 `apiVersion` 独立（协议可以单独演进） */
export const PLUGIN_RPC_VERSION = 1;

/** 插件声明的一个工具 */
export interface PluginToolDecl {
  /** 工具名（模型看到的）。宿主会加 `plugin__<key>__` 前缀，避免与内置/MCP 冲突 */
  name: string;
  /** 给模型看的说明。**它进模型上下文**，所以有长度上限 */
  description: string;
  /** 参数的 JSON Schema（`type: "object"`）。窄一点比宽一点好：模型按它填 */
  parameters: Record<string, unknown>;
}

/** 插件声明的一个命令（进命令面板与斜杠菜单） */
export interface PluginCommandDecl {
  name: string;
  description: string;
}

/** 插件进程启动时的声明 */
export interface PluginReadyMessage {
  type: "ready";
  v: number;
  tools: PluginToolDecl[];
  commands: PluginCommandDecl[];
  /**
   * 这个进程**实现了哪些钩子**（清单 `hooks[].id` 的一个子集，且必须完全相等）。
   *
   * ## 为什么要单独报一次，而不是信任清单
   *
   * 清单说"我注册了 `no-rm` 这个 PreToolUse 钩子"，但真正接住这次回调的是**插件进程里的
   * 代码**。两者对不上时有两种表现，都很糟：
   *
   * - 声明了、代码里没实现 → 宿主每次调用都失败，而 `PreToolUse` 的失败默认按"拒绝"
   *   处理（`hookFailsClosed`）—— 用户会突然发现所有工具都被一个坏钩子挡住；
   * - 代码实现了、清单里没声明 → 那一段代码**永远不会被调用**，作者却以为策略生效了。
   *
   * 所以在这里对一次账：**对不上就拒绝加载整个插件**（与"声明的工具不合法就拒绝启动"
   * 同一条纪律 —— 让问题在加载期暴露，而不是在第一次工具调用时）。
   */
  hooks: string[];
}

/** 宿主 → 插件的初始化参数 */
export interface PluginInitMessage {
  type: "init";
  v: number;
  /** 插件自己的 id（反向域名） */
  pluginId: string;
  /** 清单里授予的权限。**插件侧只读** —— 真正的检查永远在宿主侧 */
  permissions: string[];
  /** 插件私有数据目录的绝对路径（`fs` 权限的作用域之一） */
  dataDir: string;
}

/** 宿主 → 插件：调用一个工具 */
export interface PluginCallMessage {
  type: "call";
  id: number;
  tool: string;
  args: unknown;
  /**
   * 这次调用发生在哪个工作目录。
   *
   * **放在调用上而不是 init 上**：一个插件进程服务**所有会话**，而会话各有各的
   * 工作目录。放 init 里的话，第一个启动的会话的工作目录会被当成全局的 ——
   * 症状是"在另一个仓库里打开，工具还在操作上一个仓库"，而且没有任何报错。
   */
  workspaceDir: string;
}

/**
 * 宿主 → 插件：执行一个命令。
 *
 * 为什么与 `call` 分开而不是复用（给 `call` 加个 `kind` 字段）：两者的**触发者不同** ——
 * 工具是**模型**调的，命令是**用户**点或敲的。分开的收益是插件侧一眼能看出
 * "这次是人要的"，而那个区别会影响它怎么反馈（命令可以弹界面，工具不该）。
 * 共用的是**机制**（同一个 id 空间、同一个 result 形状），不是语义。
 */
export interface PluginRunMessage {
  type: "run";
  id: number;
  command: string;
  /** 用户在命令面板里跟的那串参数（没有就是空串） */
  args: string;
  workspaceDir: string;
}

/** 插件 → 宿主：一次请求的结果（工具与命令共用同一个形状） */
export interface PluginResultMessage {
  type: "result";
  id: number;
  /** 失败时给人/给模型看的文案 */
  error?: string;
  /** 成功时的文本结果 */
  text?: string;
}

/** 插件 → 宿主：日志（进插件的诊断流，不进模型上下文） */
export interface PluginLogMessage {
  type: "log";
  level: "info" | "warn" | "error";
  message: string;
}

/**
 * 宿主 → 插件：调用一个钩子。
 *
 * ## 为什么钩子的名字来自**清单**而不是 `ready` 的注册表
 *
 * 工具与命令是插件在 `ready` 里报的（"我有哪些能力"）；钩子不是 —— 它在清单里声明。
 * 两个理由，都是这一侧特有的：
 *
 * 1. `PreToolUse` 能拦住工具调用，用户要在**装之前**就看见它（权限卡上多一句
 *    "这个插件会介入工具调用"）；`ready` 里的东西只有跑起来才知道；
 * 2. 宿主需要在**插件进程没起来时**也知道有哪些钩子存在 —— 否则"进程崩了"会静默
 *    变成一个"没有钩子"的世界，而对 fail-closed 的钩子（见 `hookFailsClosed`）来说，
 *    那正好是安全侧失效：本该挡住的调用被放行了。
 *
 * 于是 `hook` 字段是清单里的 `hooks[].id`，宿主只调声明过的 id（调用前还会再过一次
 * 匹配与权限），插件按 id 分派自己的处理函数。
 */
export interface PluginHookMessage {
  type: "hook";
  id: number;
  /** 清单里声明的钩子 id */
  hook: string;
  event: PluginHookEvent;
  payload: PluginHookPayload;
}

/**
 * 一次钩子调用的输入。
 *
 * 一个扁平结构而不是按事件分几种：跨进程传的就是 JSON，作者一眼看全"我能拿到什么"，
 * 比让他在几个类型之间找强。**哪些字段在哪类事件里有值**写在每个字段上。
 */
export interface PluginHookPayload {
  /** 模型看到的工具名（含 `plugin__` / `mcp__` 前缀）。**所有事件都有** */
  toolName: string;
  /** 这次调用的参数（原样，**钩子改不了它** —— 见文件头"钩子无权改写"）。**所有事件都有** */
  args: unknown;
  /** 会话工作目录（钩子据此判断"这个调用发生在哪个仓库"）。**所有事件都有** */
  workspaceDir: string;
  /** 工具是否报错。**只有 PostToolUse / PostToolUseFailure 有** */
  isError?: boolean;
  /**
   * 工具结果的**文本预览**。只有 post 两个事件有，且**已截断**（见 MAX_HOOK_TEXT_CHARS）。
   *
   * 截断而不是全文：这是过 IPC 进插件进程的东西，一次 `bash` 的输出可能是几 MB。
   * 需要全文的钩子应当自己去读工具写下的 spill 文件（工具结果里带 `Full output:` 路径）。
   */
  text?: string;
}

/** 插件 → 宿主：钩子的结论 */
export interface PluginHookResultMessage {
  type: "hookResult";
  id: number;
  /**
   * **非空即拒绝**（只有 `PreToolUse` 会真的拦下这次调用）。
   *
   * 形状直接取方案 §4.6 的草图：`{ block?: string }`，字符串是给模型与用户看的理由。
   * 刻意**没有** `allow` 这个值：钩子只能加限制，不能放行 —— 一个 `allow` 字段会让
   * "插件能不能绕过宿主的权限门"变成一个必须靠读实现来回答的问题。
   */
  block?: string;
  /**
   * 给模型的补充说明，在**下一次请求组装时**注入。
   *
   * 上限见 MAX_HOOK_CONTEXT_CHARS —— 它每次请求都在上下文里，是"每次对话的税"。
   * 注入的是给模型的提示，不是新的一轮对话：与重复调用守卫那条提醒同一条路径
   *（custom 条目，不出现在用户的对话流里）。
   */
  additionalContext?: string;
  /**
   * 钩子自己失败了（作者自己 catch 之后填这里）。
   *
   * 不填也不算成功：超时、进程退出、消息格式不对，宿主都按失败结算
   *（见 `hookFailsClosed`）。**抛异常等于失败** —— 未捕获的异常会打到进程顶层，
   * 而宿主的处理是"该进程挂起的调用全部按失败结算"，代价比 catch 一下大得多。
   */
  error?: string;
}

export type PluginToHostMessage =
  | PluginReadyMessage
  | PluginResultMessage
  | PluginHookResultMessage
  | PluginLogMessage;
export type HostToPluginMessage =
  | PluginInitMessage
  | PluginCallMessage
  | PluginRunMessage
  | PluginHookMessage;

/**
 * 工具描述与参数 schema 的长度上限。
 *
 * 它们**每个请求都进模型上下文**，所以不是"存储成本"而是"每次对话的税"。
 * 一个装了十个插件的用户，如果每个插件都写 2000 字的说明，工具表会占掉可观的一截。
 * 超限**拒绝注册并给出可读原因**，而不是截断 —— 截断后的 schema 会让模型填错参数，
 * 而那时作者完全不知道为什么。
 */
export const MAX_TOOL_DESCRIPTION = 2000;
export const MAX_TOOL_SCHEMA_BYTES = 8000;
export const MAX_TOOLS_PER_PLUGIN = 32;
export const MAX_COMMANDS_PER_PLUGIN = 32;
/** 一个插件最多注册多少条钩子（每条都是一次跨进程往返，见 hooks.ts 的超时） */
export const MAX_HOOKS_PER_PLUGIN = 16;
/** 拒绝理由的长度上限（它要进审批卡与工具结果，太长的理由会被截断得莫名其妙） */
export const MAX_HOOK_BLOCK_CHARS = 500;
/**
 * 注入模型的补充说明上限。
 *
 * 比工具描述更严（2000 字），因为它**每次请求都在**：一条 4000 字的钩子说明会让
 * 每一轮都多付这份钱。超限**截断并注明**（与工具声明"拒绝注册"不同）——
 * 这里截断的代价只是说明短了一点，而拒绝会让一个已经跑通的钩子突然失效。
 */
export const MAX_HOOK_CONTEXT_CHARS = 4000;
/** 传给钩子的工具结果预览上限（截断，见 PluginHookPayload.text） */
export const MAX_HOOK_TEXT_CHARS = 2000;

/** 工具名的字符集：字母数字与 `_` / `-`，字母开头 */
const TOOL_NAME = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

/** 校验插件声明的工具；返回可读问题列表（空数组 = 全部合法） */
export function validateToolDecls(decls: unknown): { tools: PluginToolDecl[]; issues: string[] } {
  const tools: PluginToolDecl[] = [];
  const issues: string[] = [];
  if (!Array.isArray(decls)) return { tools, issues: ["ready.tools 必须是数组"] };

  if (decls.length > MAX_TOOLS_PER_PLUGIN) {
    issues.push(`一个插件最多注册 ${MAX_TOOLS_PER_PLUGIN} 个工具，收到 ${decls.length} 个`);
  }

  const seen = new Set<string>();
  for (const raw of decls.slice(0, MAX_TOOLS_PER_PLUGIN)) {
    if (typeof raw !== "object" || raw === null) {
      issues.push("工具声明必须是对象");
      continue;
    }
    const { name, description, parameters } = raw as Partial<PluginToolDecl>;
    if (typeof name !== "string" || !TOOL_NAME.test(name)) {
      issues.push(`工具名不合法（字母开头的 1–64 位字母数字下划线连字符）：${String(name)}`);
      continue;
    }
    if (seen.has(name)) {
      issues.push(`工具名重复：${name}`);
      continue;
    }
    if (typeof description !== "string" || description.trim() === "") {
      issues.push(`工具 ${name} 缺少说明 —— 模型靠它决定要不要调用`);
      continue;
    }
    if (description.length > MAX_TOOL_DESCRIPTION) {
      issues.push(`工具 ${name} 的说明超过 ${MAX_TOOL_DESCRIPTION} 字（它每个请求都进模型上下文）`);
      continue;
    }
    if (typeof parameters !== "object" || parameters === null || Array.isArray(parameters)) {
      issues.push(`工具 ${name} 的 parameters 必须是 JSON Schema 对象`);
      continue;
    }
    const size = JSON.stringify(parameters).length;
    if (size > MAX_TOOL_SCHEMA_BYTES) {
      issues.push(`工具 ${name} 的参数 schema 超过 ${MAX_TOOL_SCHEMA_BYTES} 字节`);
      continue;
    }
    if ((parameters as { type?: unknown }).type !== "object") {
      // 顶层不是 object 的 schema 会让模型没法填 —— 内核也要求对象参数
      issues.push(`工具 ${name} 的 parameters.type 必须是 "object"`);
      continue;
    }
    seen.add(name);
    tools.push({ name, description, parameters });
  }
  return { tools, issues };
}

/** 校验插件声明的命令 */
export function validateCommandDecls(decls: unknown): {
  commands: PluginCommandDecl[];
  issues: string[];
} {
  const commands: PluginCommandDecl[] = [];
  const issues: string[] = [];
  if (!Array.isArray(decls)) return { commands, issues: ["ready.commands 必须是数组"] };
  if (decls.length > MAX_COMMANDS_PER_PLUGIN) {
    issues.push(`一个插件最多注册 ${MAX_COMMANDS_PER_PLUGIN} 个命令，收到 ${decls.length} 个`);
  }
  const seen = new Set<string>();
  for (const raw of decls.slice(0, MAX_COMMANDS_PER_PLUGIN)) {
    if (typeof raw !== "object" || raw === null) {
      issues.push("命令声明必须是对象");
      continue;
    }
    const { name, description } = raw as Partial<PluginCommandDecl>;
    if (typeof name !== "string" || !TOOL_NAME.test(name)) {
      issues.push(`命令名不合法：${String(name)}`);
      continue;
    }
    if (seen.has(name)) {
      issues.push(`命令名重复：${name}`);
      continue;
    }
    if (typeof description !== "string" || description.trim() === "") {
      issues.push(`命令 ${name} 缺少说明`);
      continue;
    }
    seen.add(name);
    commands.push({ name, description });
  }
  return { commands, issues };
}
