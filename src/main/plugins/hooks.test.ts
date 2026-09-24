/**
 * 钩子分发层的单测。
 *
 * 这一层决定"哪些调用会被拦住"，而它最需要钉住的恰恰是那些**看不见**的分支：
 * 超时 / 进程没起来 / 插件回了一条格式不对的结论 / fail-closed 的钩子坏掉。
 * 所以 `HookCaller` 是注入的 —— 不需要起真进程就能把每条分支走一遍。
 *
 * 四条贯穿全篇的口径：
 *  1. **只有 PreToolUse 能阻断**，且第一条阻断的钩子说了算（后面的不再被调用）；
 *  2. **失败按声明处置**：fail-closed 的 PreToolUse 坏掉 = 拒绝，且理由要能指导用户恢复；
 *  3. **补充说明合并后有上限**，超了要**说明**省略了几条（静默丢弃会让作者以为生效了）；
 *  4. **钩子改不了参数** —— 这一层根本没有改写 args 的出口（类型里没有那个字段）。
 */

import { describe, expect, it, vi } from "vitest";
import type { PluginHookDecl } from "@/shared/contracts/plugin";
import {
  dispatchHooks,
  type HookCaller,
  type HookOutcome,
  hookFailureReason,
  hookMatches,
  joinHookContext,
  previewToolText,
  type RegisteredHook,
} from "./hooks";

function hook(id: string, decl: Partial<PluginHookDecl> = {}): RegisteredHook {
  return {
    pluginId: `dev.example.${id}`,
    pluginName: `${id} 插件`,
    decl: { id, event: "PreToolUse", ...decl } as PluginHookDecl,
  };
}

/** 一个只回答固定结论的调用器；记下它被调过哪些钩子 */
function callerReturning(answers: Record<string, HookOutcome>): {
  caller: HookCaller;
  called: string[];
} {
  const called: string[] = [];
  const caller: HookCaller = async (target) => {
    called.push(target.decl.id);
    return answers[target.decl.id] ?? {};
  };
  return { caller, called };
}

const TOOL = { toolName: "bash", args: { command: "ls" }, workspaceDir: "/repo" };

describe("hookMatches", () => {
  it("省略 matcher = 匹配全部", () => {
    expect(hookMatches(hook("all").decl, "bash")).toBe(true);
    expect(hookMatches(hook("all").decl, "mcp__github__list")).toBe(true);
  });

  it("matcher 是**大小写敏感**的正则（ZCode 的语义，也是它自己列的第一号坑）", () => {
    expect(hookMatches(hook("a", { matcher: "^bash$" }).decl, "bash")).toBe(true);
    // 「bash」写成小写不会命中 Bash 之类的名字 —— 这条与 ZCode 的行为一致，不是我们的选择
    expect(hookMatches(hook("a", { matcher: "^Bash$" }).decl, "bash")).toBe(false);
    expect(hookMatches(hook("a", { matcher: "write|edit" }).decl, "edit")).toBe(true);
    // 别名式的前缀名（MCP / 插件工具）也在匹配面上
    expect(hookMatches(hook("a", { matcher: "^mcp__" }).decl, "mcp__github__list")).toBe(true);
  });

  it("非法正则按「不匹配」处理并留一行警告（校验期已经拒过一次，这里是兜底）", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // 抛出的后果会严重得多：一次工具调用凭空失败，而原因是"某条 matcher 写错了"
    expect(hookMatches(hook("broken", { matcher: "([" }).decl, "bash")).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("dispatchHooks / PreToolUse", () => {
  it("第一条阻断的钩子说了算，后面的不再被调用", async () => {
    const { caller, called } = callerReturning({
      first: { block: "本插件禁用 bash" },
      second: { block: "另一条也会挡" },
    });

    const result = await dispatchHooks([hook("first"), hook("second")], "PreToolUse", TOOL, caller);

    expect(result.block).toBe("本插件禁用 bash");
    expect(called).toEqual(["first"]);
  });

  it("没有钩子阻断时 block 为 undefined（宿主的权限门照常生效）", async () => {
    const { caller } = callerReturning({ a: {} });
    const result = await dispatchHooks([hook("a")], "PreToolUse", TOOL, caller);
    expect(result.block).toBeUndefined();
    expect(result.failures).toEqual([]);
  });

  it("block 是空白串 = 没阻断（避免「手滑写了个空串」变成全部被拦）", async () => {
    const { caller } = callerReturning({ a: { block: "   " } });
    const result = await dispatchHooks([hook("a")], "PreToolUse", TOOL, caller);
    expect(result.block).toBeUndefined();
  });

  it("阻断理由超长会截断（它要进审批卡与工具结果）", async () => {
    const { caller } = callerReturning({ a: { block: "x".repeat(2000) } });
    const result = await dispatchHooks([hook("a")], "PreToolUse", TOOL, caller);
    expect(result.block?.length).toBe(500);
  });

  it("fail-closed 的钩子坏掉 = 拒绝，理由里写清谁、为什么、怎么办", async () => {
    const { caller } = callerReturning({ guard: { failure: "插件在 5000ms 内没有返回结果" } });

    const result = await dispatchHooks([hook("guard")], "PreToolUse", TOOL, caller);

    expect(result.block).toContain("guard 插件");
    expect(result.block).toContain("guard");
    expect(result.block).toContain("5000ms");
    // 恢复方式必须写出来：否则一个坏插件会让所有工具都不可用而用户不知道为什么
    expect(result.block).toContain("停用该插件");
    expect(result.failures.map((failure) => failure.hookId)).toEqual(["guard"]);
  });

  it("failure: open 的钩子坏掉只是记一笔，不拦（给观察型钩子用）", async () => {
    const { caller } = callerReturning({ logger: { failure: "崩了" } });

    const result = await dispatchHooks(
      [hook("logger", { failure: "open" })],
      "PreToolUse",
      TOOL,
      caller,
    );

    expect(result.block).toBeUndefined();
    expect(result.failures).toHaveLength(1);
  });

  it("matcher 不命中的钩子**不会收到调用**", async () => {
    const { caller, called } = callerReturning({ a: { block: "挡" } });
    const result = await dispatchHooks(
      [hook("a", { matcher: "^read$" })],
      "PreToolUse",
      TOOL,
      caller,
    );
    expect(called).toEqual([]);
    expect(result.block).toBeUndefined();
  });

  it("前面钩子的补充说明会被保留下来（即使后面那条拦住了）", async () => {
    const { caller } = callerReturning({
      talker: { additionalContext: "这个仓库不要动 vendor/" },
      guard: { block: "禁用 bash" },
    });

    const result = await dispatchHooks([hook("talker"), hook("guard")], "PreToolUse", TOOL, caller);

    expect(result.block).toBe("禁用 bash");
    expect(result.additionalContext).toBe("这个仓库不要动 vendor/");
  });
});

describe("dispatchHooks / 其余事件", () => {
  it("PostToolUse 上的 block 被忽略 —— 工具已经跑完了，事后拒绝没有意义", async () => {
    const { caller } = callerReturning({ a: { block: "不该生效" } });
    const result = await dispatchHooks(
      [hook("a", { event: "PostToolUse" })],
      "PostToolUse",
      TOOL,
      caller,
    );
    expect(result.block).toBeUndefined();
  });

  it("只分发**事件相同**的钩子（两条 post 事件不互相串台）", async () => {
    const { caller, called } = callerReturning({});
    await dispatchHooks(
      [hook("ok", { event: "PostToolUse" }), hook("fail", { event: "PostToolUseFailure" })],
      "PostToolUseFailure",
      TOOL,
      caller,
    );
    expect(called).toEqual(["fail"]);
  });

  it("多条补充说明按顺序合并", async () => {
    const { caller } = callerReturning({
      a: { additionalContext: "第一条" },
      b: { additionalContext: "第二条" },
    });
    const result = await dispatchHooks(
      [hook("a", { event: "PostToolUse" }), hook("b", { event: "PostToolUse" })],
      "PostToolUse",
      TOOL,
      caller,
    );
    expect(result.additionalContext).toBe("第一条\n第二条");
  });

  it("post 事件的钩子坏掉只记失败，永远不影响工具结果", async () => {
    const { caller } = callerReturning({ a: { failure: "超时" } });
    const result = await dispatchHooks(
      [hook("a", { event: "PostToolUseFailure" })],
      "PostToolUseFailure",
      TOOL,
      caller,
    );
    expect(result.block).toBeUndefined();
    expect(result.failures).toHaveLength(1);
  });
});

describe("joinHookContext", () => {
  it("空输入返回 undefined（界面与注入路径据此判断「有没有」）", () => {
    expect(joinHookContext([])).toBeUndefined();
    expect(joinHookContext(["", "   "])).toBeUndefined();
  });

  it("超上限的那几条被丢掉，并**注明**丢了几条", () => {
    const big = "你".repeat(3000);
    const joined = joinHookContext([big, big, big]);
    expect(joined?.startsWith(big)).toBe(true);
    // 静默丢弃会让作者以为自己写的话进了模型 —— 所以必须有这句注记
    expect(joined).toContain("另有 2 条钩子说明因长度上限未注入");
  });
});

describe("hookFailureReason", () => {
  it("三件事缺一不可：谁、为什么、怎么办", () => {
    const reason = hookFailureReason(hook("guard"), "进程已退出");
    expect(reason).toContain("guard 插件");
    expect(reason).toContain("guard");
    expect(reason).toContain("进程已退出");
    expect(reason).toContain("停用该插件即可恢复");
  });
});

describe("previewToolText", () => {
  it("只取文本 part，多个 part 用换行接起来", () => {
    expect(
      previewToolText([
        { type: "text", text: "第一段" },
        { type: "image", data: "..." },
        { type: "text", text: "第二段" },
      ]),
    ).toBe("第一段\n第二段");
  });

  it("超长截断并注明", () => {
    const text = previewToolText([{ type: "text", text: "a".repeat(3000) }]);
    expect(text?.endsWith("…（已截断）")).toBe(true);
    expect(text?.length).toBeLessThan(3000);
  });

  it("一个文本 part 都没有时返回 undefined（让 payload 里干脆没有这个字段）", () => {
    expect(previewToolText([{ type: "image", data: "..." }])).toBeUndefined();
    expect(previewToolText(undefined)).toBeUndefined();
    expect(previewToolText("不是数组")).toBeUndefined();
  });
});
