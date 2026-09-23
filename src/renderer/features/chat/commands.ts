/**
 * 内置指令的**执行**：可用性判定 + 动作派发 + 反馈文案。
 *
 * 为什么单独一个文件：可用性与执行都必须被**三处**共用 ——
 * 菜单（置灰与原因）、输入框（回车拦截、草稿保留）、发送收口（真正执行）。
 * 三处各写一份判定，迟早会出现「菜单里点得动、发送时却被拒」这种自相矛盾。
 *
 * 这里刻意不碰 React、不碰 store：调用方把「当前会话忙不忙」与「压缩怎么发起」作为
 * 依赖传进来，于是纯逻辑可以在 node project 下直接断言。
 */

import type { CompactOutcome } from "@/shared/contracts/chat";
import { type CommandSpec, findCommandSpec } from "@/shared/contracts/commands";

/**
 * 一条给用户看的提示（i18n 键 + 插值参数）。
 *
 * 为什么要回键而不是回文案：主进程给的中文 message 在英文界面里是错的语言。
 * 已知失败都走稳定键，只有未知失败才回落到主进程那句话。
 *
 * 字段名是 `messageKey` 而不是 `key`：scripts/check-i18n.mjs 会扫描这个字段名，
 * 于是「加了提示却忘了补词条」在门禁上就会红（`key` 太通用，扫它会误报）。
 */
export interface CommandNotice {
  messageKey: string;
  params?: Record<string, string | number>;
  level: "info" | "error";
}

/** 指令执行的结果：成功可以静默（进度由压缩条显示），失败必须给一句话 */
export type CommandFeedback =
  | { ok: true; notice?: CommandNotice }
  | { ok: false; notice: CommandNotice };

/** 会话此刻忙不忙；两个来源刻意分开 —— 它们的含义与界面表现都不同 */
export interface CommandSessionState {
  /** 正在跑一轮（模型/工具在动） */
  running: boolean;
  /** 正在压缩上下文（含手动与自动） */
  compacting: boolean;
}

/** 指令执行需要的副作用入口；由调用方注入（测试里给假实现） */
export interface CommandDeps {
  compact(instructions?: string): Promise<CompactOutcome>;
}

/**
 * 这条指令现在能不能执行；不能则返回原因（i18n 键）。
 *
 * 判定只依赖 `CommandSpec.availability` 与当前会话状态，**不依赖具体是哪条指令** ——
 * 加一条新指令时不需要动这里。
 */
export function unavailableReason(
  spec: CommandSpec,
  state: CommandSessionState,
): CommandNotice | null {
  if (spec.availability === "always") return null;
  // 运行中：内核会以 LaneBusy 拒收（lane.js 的 accept），界面先说清楚，别让用户撞一次报错
  if (state.running) return { messageKey: "chat.commandUnavailableRunning", level: "error" };
  // 正在压缩：压缩占着 lane，再压一次同样会被拒
  if (state.compacting) return { messageKey: "chat.commandUnavailableCompacting", level: "error" };
  return null;
}

/** 按名字找一条内置指令（发送收口只有命令名，规格得从这里查回来） */
export function commandSpec(name: string): CommandSpec | undefined {
  return findCommandSpec(name);
}

/**
 * 执行一条内置指令。
 *
 * 参数口径由 `CommandSpec.argMode` 决定：`none` 的多写了就报用法而不是静默丢弃
 * （「我写了说明但它被吞了」比一句用法提示更让人困惑）。
 */
export async function runCommand(
  spec: CommandSpec,
  rest: string,
  deps: CommandDeps,
): Promise<CommandFeedback> {
  const args = rest.trim();
  if (spec.argMode === "none" && args !== "") {
    return {
      ok: false,
      notice: {
        messageKey: "chat.commandNoArguments",
        params: { name: spec.name },
        level: "error",
      },
    };
  }
  switch (spec.id) {
    case "compact": {
      const outcome = await deps.compact(args === "" ? undefined : args);
      if (outcome.ok) return { ok: true };
      return { ok: false, notice: compactFailureNotice(outcome) };
    }
  }
}

/**
 * 压缩失败 → 提示。
 *
 * `busy` / `nothing` 都是**正常结局**，各给一句明确的话；其余失败带上主进程的原因
 * （那句是中文，但它是唯一有信息量的兜底，比「压缩失败」四个字强）。
 */
export function compactFailureNotice(
  outcome: Extract<CompactOutcome, { ok: false }>,
): CommandNotice {
  if (outcome.code === "busy") return { messageKey: "chat.compactBusy", level: "error" };
  if (outcome.code === "nothing") return { messageKey: "chat.compactNothing", level: "info" };
  return { messageKey: "chat.compactFailed", params: { error: outcome.message }, level: "error" };
}
