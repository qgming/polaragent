// 宿主侧的钩子分发：**匹配 → 调用 → 合并 → 失败处置**。
//
// ## 为什么单独一个文件，而且不 import electron / 不 import 进程池
//
// 这一层决定的是"哪些调用会被拦住"，而它是**纯逻辑**（给定一组声明与一组结论，
// 算出这次调用的处置）。把它和 `utilityProcess` 混在一起写的话，唯一能测的方式就是
// 起真进程，而最需要被钉住的恰恰是那些**看不见**的分支：超时、进程没起来、
// 插件返回一条格式不对的结论、fail-closed 的钩子坏掉。
//
// 所以进程调用走 `HookCaller` 注入（见 process-host.ts 里的实现），
// 这里只负责判定 —— 与 net-guard.ts / surface-exec.ts 同一手法。
//
// ## 三条判定规则
//
// 1. **只有 `PreToolUse` 能阻断**，且取**第一条**阻断的钩子（先到先得，与 DSH 的
//    合并优先级同源：deny 一出现就没有继续问下去的必要）。其余两个事件返回 `block`
//    一律被忽略 —— 工具已经跑完了，"事后拒绝"没有意义。
// 2. **失败按声明处置**：`hookFailsClosed` 为真时算作阻断（理由里写清是哪个插件、
//    哪个钩子、为什么、怎么恢复）；否则只记一条失败，继续走宿主的权限门。
// 3. **补充说明在一次调用里合并**，总量有上限（它每次请求都在上下文里，见
//    MAX_HOOK_CONTEXT_CHARS）：超了就在末尾注明"还有几条被省略"，
//    而不是静默截断 —— 静默截断会让作者以为自己写的话进了模型。

import {
  hookFailsClosed,
  type PluginHookDecl,
  type PluginHookEvent,
} from "@/shared/contracts/plugin";
import {
  MAX_HOOK_BLOCK_CHARS,
  MAX_HOOK_CONTEXT_CHARS,
  MAX_HOOK_TEXT_CHARS,
  type PluginHookPayload,
} from "@/shared/contracts/plugin-rpc";

/** 一个已注册的钩子：声明 + 它属于哪个插件（理由文案里要用插件名） */
export interface RegisteredHook {
  pluginId: string;
  pluginName: string;
  decl: PluginHookDecl;
}

/** 一次钩子调用拿到的结论（进程侧的失败也是这一个形状，见 plugin-process.ts） */
export interface HookOutcome {
  block?: string;
  additionalContext?: string;
  /** 非空即失败：超时、进程没起来、插件返回了错误 */
  failure?: string;
}

/** 真正把调用送出去的东西（可注入：单测里是一个假函数） */
export type HookCaller = (hook: RegisteredHook, payload: PluginHookPayload) => Promise<HookOutcome>;

export interface HookFailure {
  pluginId: string;
  hookId: string;
  message: string;
}

export interface HookDispatch {
  /** 阻断这次调用；只有 PreToolUse 会产出。取第一条阻断的钩子的理由 */
  block?: string;
  /** 注入模型的补充说明（已合并、已裁剪）；没有就是 undefined */
  additionalContext?: string;
  /** 出错的钩子（调用方应记进诊断流 —— 用户要能看到"哪个钩子坏了"） */
  failures: HookFailure[];
}

/**
 * 这条钩子管不管这个工具。
 *
 * 匹配器是**大小写敏感的正则**，对"模型看到的工具名"求值（含 `plugin__` / `mcp__` 前缀）。
 * 省略 = 匹配全部。
 *
 * 非法正则在清单校验期就被拒（见 manifest.ts 的 checkHook），这里再兜一次：
 * 抛出等于让一次工具调用凭空失败，而"某条 matcher 写错了"不该有那个权力。
 */
export function hookMatches(decl: PluginHookDecl, toolName: string): boolean {
  if (decl.matcher === undefined) return true;
  try {
    return new RegExp(decl.matcher).test(toolName);
  } catch {
    console.warn(`钩子 ${decl.id} 的 matcher 不是合法正则，按"不匹配"处理：${decl.matcher}`);
    return false;
  }
}

/**
 * 钩子坏掉时给用户看的理由。
 *
 * 三件事缺一不可：**谁**（插件名 + 钩子 id）、**为什么**（原始失败原因）、
 * **怎么办**（停用它）。fail-closed 的代价必须能被用户一句话消除 ——
 * 否则一个坏插件会让所有工具都不可用，而界面上的解释只有"权限校验失败"。
 */
export function hookFailureReason(hook: RegisteredHook, message: string): string {
  const reason = `插件「${hook.pluginName}」的钩子「${hook.decl.id}」没能做出判定：${message}`;
  return `${reason}。已按保守策略拒绝这次调用 —— 在插件管理里停用该插件即可恢复。`;
}

/** 把多条补充说明合并成一段，超上限就注明省略了几条 */
export function joinHookContext(parts: readonly string[]): string | undefined {
  const kept: string[] = [];
  let used = 0;
  let dropped = 0;
  for (const part of parts) {
    const text = part.trim();
    if (text === "") continue;
    if (used + text.length > MAX_HOOK_CONTEXT_CHARS) {
      dropped += 1;
      continue;
    }
    kept.push(text);
    used += text.length + 1;
  }
  if (kept.length === 0) return undefined;
  const body = kept.join("\n");
  if (dropped === 0) return body;
  return `${body}\n（另有 ${dropped} 条钩子说明因长度上限未注入）`;
}

/**
 * 工具结果的文本预览。
 *
 * `content` 是内核的 `AgentToolResult["content"]`（一个 part 数组）；这里用**结构类型**
 * 取其中的文本部分，而不是 import 内核类型 —— 这一层要能在不依赖内核的单测里跑
 *（与 net-guard.ts 同一个理由：判据是纯函数，就要能被直接断言）。
 *
 * 截断而不是给全文（见 `PluginHookPayload.text` 的说明）：一次 bash 的输出可能是几 MB，
 * 而过 IPC 的东西每一条都要序列化。需要全文的钩子应当自己去读工具写下的 spill 文件。
 *
 * **一个文本 part 都没有时返回 undefined**（例如纯图片结果），让 payload 里干脆没有这个
 * 字段 —— "没有文本"与"文本是空串"对钩子作者是两件事。
 */
export function previewToolText(content: unknown, limit = MAX_HOOK_TEXT_CHARS): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const texts: string[] = [];
  for (const part of content) {
    if (typeof part !== "object" || part === null) continue;
    const record = part as { type?: unknown; text?: unknown };
    if (record.type === "text" && typeof record.text === "string") texts.push(record.text);
  }
  if (texts.length === 0) return undefined;
  const joined = texts.join("\n");
  return joined.length > limit ? `${joined.slice(0, limit)}\n…（已截断）` : joined;
}

/**
 * 分发一次事件。
 *
 * 调用顺序 = 传入顺序（调用方按注册表顺序给，于是"谁先"是可预测的）。
 * `PreToolUse` 一旦被阻断就**不再往下问** —— 后面的钩子不会收到这次事件，
 * 它们的 `additionalContext` 也不会注入（都被拦下了，注入没有意义）。
 */
export async function dispatchHooks(
  hooks: readonly RegisteredHook[],
  event: PluginHookEvent,
  payload: PluginHookPayload,
  caller: HookCaller,
): Promise<HookDispatch> {
  const failures: HookFailure[] = [];
  const contexts: string[] = [];

  for (const hook of hooks) {
    if (hook.decl.event !== event) continue;
    if (!hookMatches(hook.decl, payload.toolName)) continue;

    const outcome = await caller(hook, payload);

    if (outcome.failure !== undefined) {
      failures.push({
        pluginId: hook.pluginId,
        hookId: hook.decl.id,
        message: outcome.failure,
      });
      if (event === "PreToolUse" && hookFailsClosed(hook.decl)) {
        return {
          block: hookFailureReason(hook, outcome.failure).slice(0, MAX_HOOK_BLOCK_CHARS),
          ...(contexts.length === 0 ? {} : { additionalContext: joinHookContext(contexts) }),
          failures,
        };
      }
      continue;
    }

    if (event === "PreToolUse" && outcome.block !== undefined && outcome.block.trim() !== "") {
      return {
        block: outcome.block.trim().slice(0, MAX_HOOK_BLOCK_CHARS),
        ...(contexts.length === 0 ? {} : { additionalContext: joinHookContext(contexts) }),
        failures,
      };
    }

    if (outcome.additionalContext !== undefined && outcome.additionalContext.trim() !== "") {
      contexts.push(outcome.additionalContext);
    }
  }

  const additionalContext = joinHookContext(contexts);
  return {
    ...(additionalContext === undefined ? {} : { additionalContext }),
    failures,
  };
}
