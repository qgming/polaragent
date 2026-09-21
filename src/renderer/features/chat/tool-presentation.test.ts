import { describe, expect, it } from "vitest";
import type { JobInfo } from "@/shared/contracts/job";
import type { SubagentRun, SubagentRunStatus } from "@/shared/contracts/subagent";
import { isSubagentRunFinished } from "@/shared/contracts/subagent";
import {
  BASH_TAIL_LINES,
  bashCommand,
  bashOutput,
  CHIP_LIMIT,
  DIFF_MAX_LINES,
  detailsPatch,
  jobElapsedMs,
  parseWebFetchDetail,
  parseWebSearchDetail,
  resolveToolDetail,
  SUBAGENT_STATUS_LABEL_KEYS,
  shortenPath,
  subagentElapsedMs,
  toEditDiff,
  toolChip,
  toolRows,
} from "./tool-presentation";

const PATCH = [
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,3 @@",
  " 保留行",
  "-旧行",
  "+新行",
  " 尾行",
  "",
].join("\n");

/** 一份典型清单：done / active / pending 各一条，chip 与详情用例共用 */
const TODOS = [
  { id: "1", text: "读代码", status: "done" },
  { id: "2", text: "改实现", status: "active" },
  { id: "3", text: "补测试", status: "pending" },
];

/**
 * 一条完整的子智能体运行记录：Task 系列工具 details 的真实形状（见 shared/contracts/subagent.ts）。
 * 字段给全是为了让「字段一一对应」这类断言有东西可查；各用例只改自己关心的那几项。
 */
function subagentRun(patch: Partial<SubagentRun> = {}): SubagentRun {
  return {
    delegationId: "d-1",
    sessionId: "s-parent",
    parentToolCallId: "d-1",
    childSessionId: "child-1",
    agentName: "explorer",
    agentSource: "builtin",
    description: "调研重试逻辑",
    task: "读 src/retry.ts",
    status: "running",
    startedAt: 1_000,
    model: null,
    modelId: "svc/model-x",
    thinkingLevel: "medium",
    tools: ["read", "grep", "glob"],
    turns: 4,
    toolCalls: 6,
    ...patch,
  };
}

describe("toolChip", () => {
  it("取 command 或 path，再其次任意字符串参数", () => {
    expect(toolChip({ path: "src/a.ts" })).toBe("src/a.ts");
    expect(toolChip({ command: "pnpm test" })).toBe("pnpm test");
    expect(toolChip({ foo: "bar" })).toBe("bar");
    // 真实工具不会同时带两个键；真撞上时以 command 优先
    expect(toolChip({ command: "pnpm test", path: "src/a.ts" })).toBe("pnpm test");
  });

  it("没有字符串参数或参数非对象时为空串", () => {
    expect(toolChip({ count: 3 })).toBe("");
    expect(toolChip("不是对象")).toBe("");
    expect(toolChip(undefined)).toBe("");
  });

  // todo 的主参数是数组：chip 给「已完成/总数」。空清单不占位，与其它非字符串参数同一个结果
  it("todo 的清单参数给进度", () => {
    expect(toolChip({ todos: TODOS })).toBe("1/3");
    expect(toolChip({ todos: [{ id: "a", text: "只有一条", status: "done" }] })).toBe("1/1");
    expect(toolChip({ todos: [] })).toBe("");
    // 非数组的 todos 不命中这条分支：数值参数没有可截的字符串，走通用兜底给空串
    expect(toolChip({ todos: 3 })).toBe("");
  });
  it("长路径保留末级、长命令保留开头", () => {
    const longPath = `${"nested/".repeat(10)}file.ts`;
    expect(longPath.length).toBeGreaterThan(CHIP_LIMIT);
    expect(toolChip({ path: longPath })).toBe("…/file.ts");
    const long = `echo ${"x".repeat(CHIP_LIMIT * 2)}`;
    expect(toolChip({ command: long })).toBe(`${long.slice(0, CHIP_LIMIT)}…`);
  });

  // 回归：命令里几乎一定有斜杠（cd /foo && …）。按「段数 > 2」判路径会把命令截成
  // `…/web` 这种只剩尾巴的样子，正好把要看的部分丢掉
  it("带斜杠的长命令不被当成路径，仍保留开头", () => {
    const cmd = `cd ${"deep/".repeat(20)}dir && pnpm run build --filter=web`;
    expect(cmd.length).toBeGreaterThan(CHIP_LIMIT);
    expect(toolChip({ command: cmd })).toBe(`${cmd.slice(0, CHIP_LIMIT)}…`);
  });

  it("按参数键分流：command 走命令规则，path 走路径规则", () => {
    const cmd = `cd ${"d/".repeat(40)}x && ls`;
    const longPath = `${"nested/".repeat(10)}file.ts`;
    expect(toolChip({ command: cmd })).toBe(`${cmd.slice(0, CHIP_LIMIT)}…`);
    expect(toolChip({ path: longPath })).toBe("…/file.ts");
  });
});

describe("shortenPath", () => {
  it("不超限原样返回", () => {
    expect(shortenPath("src/a.ts")).toBe("src/a.ts");
    expect(shortenPath("x".repeat(CHIP_LIMIT))).toHaveLength(CHIP_LIMIT);
  });

  it("单段（无分隔符）超限时截断开头", () => {
    const single = "y".repeat(CHIP_LIMIT + 10);
    expect(shortenPath(single)).toBe(`${single.slice(0, CHIP_LIMIT)}…`);
  });

  it("末尾为空段时（路径以分隔符结尾）不产出空末级", () => {
    const trailing = `${"z".repeat(CHIP_LIMIT)}/dir/`;
    expect(shortenPath(trailing)).toBe(`${trailing.slice(0, CHIP_LIMIT)}…`);
  });

  it("层级不深时（段数 ≤ 2）退化为截断开头", () => {
    const shallow = `${"w".repeat(CHIP_LIMIT)}/b`;
    expect(shortenPath(shallow)).toBe(`${shallow.slice(0, CHIP_LIMIT)}…`);
  });
});

describe("bashCommand", () => {
  it("取 command；非字符串或缺失时为空串", () => {
    expect(bashCommand({ command: "ls -la" })).toBe("ls -la");
    expect(bashCommand({ command: 1 })).toBe("");
    expect(bashCommand({ path: "a" })).toBe("");
    expect(bashCommand(null)).toBe("");
  });
});

describe("bashOutput", () => {
  it("空结果或非字符串结果按文本处理", () => {
    expect(bashOutput(undefined)).toEqual({ lines: [], omitted: 0 });
    expect(bashOutput(null)).toEqual({ lines: [], omitted: 0 });
    expect(bashOutput("")).toEqual({ lines: [], omitted: 0 });
    // 非字符串结果走 JSON 序列化，再按换行拆成终端行
    expect(bashOutput({ ok: true })).toEqual({ lines: ["{", '  "ok": true', "}"], omitted: 0 });
  });

  it("未超限时全部返回且不省略", () => {
    const lines = Array.from({ length: BASH_TAIL_LINES }, (_, i) => `行${i + 1}`);
    expect(bashOutput(lines.join("\n"))).toEqual({ lines, omitted: 0 });
  });

  it("超限时只留末尾若干行并报出省略行数", () => {
    const total = BASH_TAIL_LINES + 7;
    const lines = Array.from({ length: total }, (_, i) => `行${i + 1}`);
    const { lines: kept, omitted } = bashOutput(lines.join("\n"));

    expect(omitted).toBe(7);
    expect(kept).toHaveLength(BASH_TAIL_LINES);
    // 留的是末尾：首行是第 8 行，末行仍是最后一行
    expect(kept[0]).toBe("行8");
    expect(kept.at(-1)).toBe(`行${total}`);
  });

  // 回归：命令输出几乎都以换行结尾，末尾那个空段不是一行内容。
  // 算作一行会挤掉真正的首行，并把 terminal-block 的末行高亮落到空串上
  it("末尾换行不算一行", () => {
    expect(bashOutput("l1\nl2\nl3\n")).toEqual({ lines: ["l1", "l2", "l3"], omitted: 0 });
    // 恰好卡在上限时也不该因末尾换行被误判成超限
    const atLimit = Array.from({ length: BASH_TAIL_LINES }, (_, i) => `行${i + 1}`);
    expect(bashOutput(`${atLimit.join("\n")}\n`)).toEqual({ lines: atLimit, omitted: 0 });
  });

  it("只去掉末尾换行，中间的与内部的空行都保留", () => {
    expect(bashOutput("a\n\nb\n")).toEqual({ lines: ["a", "", "b"], omitted: 0 });
    expect(bashOutput("a\n\n")).toEqual({ lines: ["a", ""], omitted: 0 });
    expect(bashOutput("\n")).toEqual({ lines: [""], omitted: 0 });
  });
});

describe("detailsPatch", () => {
  it("只认非空的字符串 patch", () => {
    expect(detailsPatch({ patch: "--- a\n+++ b\n" })).toBe("--- a\n+++ b\n");
    expect(detailsPatch({ patch: "   " })).toBeNull();
    expect(detailsPatch({ patch: 1 })).toBeNull();
    expect(detailsPatch({ diff: "@@ -1 +1 @@" })).toBeNull();
    expect(detailsPatch(undefined)).toBeNull();
    expect(detailsPatch("不是对象")).toBeNull();
  });
});

describe("toEditDiff", () => {
  it("把统一补丁映射成 CodeDiff 入参", () => {
    const diff = toEditDiff(PATCH);

    expect(diff).not.toBeNull();
    expect(diff?.additions).toBe(1);
    expect(diff?.deletions).toBe(1);
    expect(diff?.omitted).toBe(0);
    expect(diff?.filename).toContain("src/a.ts");
    expect(diff?.filename.startsWith("b/")).toBe(false);
    expect(diff?.lines).toEqual([
      { kind: "context", text: "保留行" },
      { kind: "removed", text: "旧行" },
      { kind: "added", text: "新行" },
      { kind: "context", text: "尾行" },
    ]);
  });

  it("无内容或不可解析时返回 null 而不是空块", () => {
    expect(toEditDiff("")).toBeNull();
    expect(toEditDiff("这不是补丁")).toBeNull();
  });

  // 回归：只有文件头、没有 hunk 的补丁会被 parse-diff 解析成「1 个文件 / 0 个块」，
  // 若只看有没有文件就会渲染出「文件名 +0 −0」的空块（S2.4 要求不显示空块）
  it("有文件头但没有任何改动行时返回 null", () => {
    expect(toEditDiff("--- a/a.txt\n+++ b/a.txt\n")).toBeNull();
    expect(toEditDiff("--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n")).toBeNull();
  });

  it("超过上限只留前段并报出省略行数", () => {
    const body = Array.from({ length: DIFF_MAX_LINES + 5 }, () => "+新增行");
    const patch = [
      "--- a/big.ts",
      "+++ b/big.ts",
      `@@ -0,0 +1,${body.length} @@`,
      ...body,
      "",
    ].join("\n");

    const diff = toEditDiff(patch);
    expect(diff?.omitted).toBe(5);
    expect(diff?.lines).toHaveLength(DIFF_MAX_LINES);
    expect(diff?.lines.every((line) => line.kind === "added")).toBe(true);
    // 留前段：最后一行不是原文的最后一行
    expect(diff?.lines.at(-1)?.text).not.toBe(body.at(-1));
  });
});

describe("resolveToolDetail", () => {
  /**
   * **失败不再一律取消详情**（这次改动最要紧的一处）。
   *
   * 旧口径是第一行 `if (isError) return null`，于是失败的工具恰恰没有详情 ——
   * 而失败输出多行特征最强（栈、编译错误、命中列表），落到那个不保留换行的面板上
   * 就被压成一整行。现在失败退回**文本详情**：报错原文本身就是内容。
   */
  it("失败时退回文本详情，把报错原文交给 TextDetail（不再返回 null）", () => {
    const bash = resolveToolDetail("bash", undefined, true, undefined, "boom\nline2");
    // bash 是终端详情，与失败无关（它一直有自己的渲染）
    expect(bash).toEqual({ kind: "terminal" });

    // edit 有 patch 但失败了：不给 diff（那次改动没落地），给文本
    const edit = resolveToolDetail("edit", { patch: PATCH }, true, undefined, "Error: 没找到");
    expect(edit?.kind).toBe("text");
    expect(edit?.kind === "text" && edit.body).toBe("Error: 没找到");

    // 子智能体失败：不给 pill（会显示成「运行中」），给文本
    const task = resolveToolDetail(
      "Task",
      { error: "没有这个子智能体" },
      true,
      undefined,
      "Error: 没有这个子智能体",
    );
    expect(task?.kind).toBe("text");
  });

  it("bash 给终端详情", () => {
    expect(resolveToolDetail("bash", undefined)).toEqual({ kind: "terminal" });
    // bash 的 details 是截断信息，不影响选择
    expect(resolveToolDetail("bash", { truncation: { lines: 10 } })).toEqual({ kind: "terminal" });
  });

  it("edit 有可解析的 patch 时给 diff 详情，并把解析结果带上", () => {
    const detail = resolveToolDetail("edit", { patch: PATCH });
    expect(detail?.kind).toBe("diff");
    expect(detail?.kind === "diff" && detail.diff.lines).toEqual([
      { kind: "context", text: "保留行" },
      { kind: "removed", text: "旧行" },
      { kind: "added", text: "新行" },
      { kind: "context", text: "尾行" },
    ]);
  });

  it("edit 缺 patch 或 patch 不可解析时退回文本详情（结果文本里写着为什么）", () => {
    for (const details of [
      undefined,
      { diff: "@@ -1 +1 @@" },
      { patch: "   " },
      { patch: "这不是补丁" },
    ]) {
      const detail = resolveToolDetail(
        "edit",
        details,
        false,
        undefined,
        "Could not find the text",
      );
      expect(detail?.kind).toBe("text");
      expect(detail?.kind === "text" && detail.body).toBe("Could not find the text");
    }
  });

  /**
   * **其余工具也给详情**（这次改动的另一半）。
   *
   * 旧口径是 `if (toolName !== "edit") return null`，除 edit 之外的一切都落回那个
   * Request/Result 面板 —— 而那个面板已经被删掉了。现在兜底是文本详情：
   * 认不出形状的工具也能看到原文，而不是一个把换行压平的转储框。
   */
  it("read / write / 未知工具都有详情，不再落回空面板", () => {
    const read = resolveToolDetail(
      "read",
      { truncation: { lines: 5 } },
      false,
      undefined,
      "  1\tconst a = 1;",
    );
    expect(read?.kind).toBe("text");
    expect(read?.kind === "text" && read.body).toBe("  1\tconst a = 1;");

    // write 从**参数**里取路径与正文（details 是 undefined）
    const write = resolveToolDetail("write", undefined, false, {
      path: "a.ts",
      content: "export {}\n",
    });
    expect(write?.kind).toBe("write");
    expect(write?.kind === "write" && write.path).toBe("a.ts");

    // 完全未知的工具也给文本（这是兜底的全部意义）
    const unknown = resolveToolDetail("未知工具", undefined, false, undefined, "some output");
    expect(unknown?.kind).toBe("text");
    expect(unknown?.kind === "text" && unknown.body).toBe("some output");
  });
});

describe("resolveToolDetail · todo", () => {
  it("details 里的清单映射成 TodoList 的 items（todos → items，revision 一并带上）", () => {
    expect(resolveToolDetail("todo", { todos: TODOS, revision: 7 })).toEqual({
      kind: "todo",
      items: TODOS,
      revision: 7,
    });
  });

  it("失败条目带 reason；缺 revision 时不硬塞", () => {
    const details = { todos: [{ id: "1", text: "跑测试", status: "failed", reason: "超时" }] };
    expect(resolveToolDetail("todo", details)).toEqual({
      kind: "todo",
      items: [{ id: "1", text: "跑测试", status: "failed", reason: "超时" }],
    });
  });

  // 回归：调用刚抵达、结果还没回来时 details（artifact）是 undefined，
  // 这时要靠工具参数里的清单先把卡片画出来，而不是退成 JSON 文本面板
  it("details 还没到（流式中）时用工具参数里的清单兜底", () => {
    expect(resolveToolDetail("todo", undefined, false, { todos: TODOS })).toEqual({
      kind: "todo",
      items: TODOS,
    });
    expect(
      resolveToolDetail("todo", undefined, false, { todos: TODOS, revision: 2 }),
    ).toMatchObject({
      kind: "todo",
      revision: 2,
    });
  });

  // 真实 schema：新条目的 id 是可选的（缺了由主进程自动编号），流式期的参数因此常常没有 id。
  // 这时按位置补一个临时 key 先把清单画出来，details 到了再换成真正的 id
  it("参数里的条目缺 id 也能渲染，key 由位置补", () => {
    const args = { todos: [{ text: "新条目", status: "pending" }] };
    expect(resolveToolDetail("todo", undefined, false, args)).toEqual({
      kind: "todo",
      items: [{ id: "todo-0", text: "新条目", status: "pending" }],
    });
    // details 侧仍然要求 id：主进程产出的成品不允许缺
    expect(
      resolveToolDetail("todo", { todos: [{ text: "新条目", status: "pending" }] }),
    ).toBeNull();
  });

  it("details 优先于参数", () => {
    const args = { todos: [{ id: "x", text: "参数里的旧清单", status: "pending" }] };
    expect(resolveToolDetail("todo", { todos: TODOS, revision: 9 }, false, args)).toEqual({
      kind: "todo",
      items: TODOS,
      revision: 9,
    });
  });

  it("空清单是合法的「已清空」，不是脏数据", () => {
    expect(resolveToolDetail("todo", { todos: [], revision: 3 })).toEqual({
      kind: "todo",
      items: [],
      revision: 3,
    });
  });

  it("非法 details 一律回退到 null 且不抛异常", () => {
    const invalid: unknown[] = [
      undefined,
      null,
      "不是对象",
      42,
      [],
      { todos: "不是数组" },
      { todos: null },
      { todos: [1] },
      { todos: ["待办"] },
      { todos: [{ text: "没有 id", status: "pending" }] },
      { todos: [{ id: "", text: "id 为空", status: "pending" }] },
      { todos: [{ id: "1", status: "pending" }] },
      { todos: [{ id: "1", text: "", status: "pending" }] },
      { todos: [{ id: "1", text: "缺 status" }] },
      { todos: [{ id: "1", text: "状态不在集合里", status: "running" }] },
      { todos: [{ id: "1", text: "reason 类型不对", status: "failed", reason: 7 }] },
    ];
    for (const details of invalid) {
      expect(() => resolveToolDetail("todo", details)).not.toThrow();
      expect(resolveToolDetail("todo", details)).toBeNull();
    }
  });

  it("参数兜底同样过校验：参数不合法也不给半份清单", () => {
    expect(resolveToolDetail("todo", undefined, false, { todos: [{ id: "1" }] })).toBeNull();
    expect(resolveToolDetail("todo", undefined, false, {})).toBeNull();
    expect(resolveToolDetail("todo", undefined, false, "不是对象")).toBeNull();
    expect(resolveToolDetail("todo", undefined)).toBeNull();
  });

  it("失败时也给 todo 详情：清单是这次调用真实的参数，报错不该把它藏起来", () => {
    const detail = resolveToolDetail("todo", { todos: TODOS }, true, { todos: TODOS });
    expect(detail?.kind).toBe("todo");
  });

  it("grep / glob 走文本详情（结果本身就是文本，但要有换行与等宽）", () => {
    const grep = resolveToolDetail("grep", { pattern: "foo" }, false, undefined, "src/a.ts:1:foo");
    expect(grep?.kind).toBe("text");
    expect(grep?.kind === "text" && grep.body).toBe("src/a.ts:1:foo");

    // 多行结果**一行都不少**：早先的写法把首行当「身份行」摘出去，
    // 而 glob 的首行是第一个路径 —— 那等于吞掉一条结果（见 splitToolText 的说明）
    const glob = resolveToolDetail("glob", undefined, false, { pattern: "**/*.ts" }, "a.ts\nb.ts");
    expect(glob?.kind).toBe("text");
    expect(glob?.kind === "text" && glob.body).toBe("a.ts\nb.ts");

    // 尾注与正文分开：方括号整行是元信息（limit 说明、分页提示），不是内容
    const limited = resolveToolDetail(
      "glob",
      undefined,
      false,
      undefined,
      "a.ts\n[Limit 200 reached]",
    );
    expect(limited?.kind === "text" && limited.body).toBe("a.ts");
    expect(limited?.kind === "text" && limited.footer).toBe("[Limit 200 reached]");
  });
});

describe("toolRows", () => {
  const parts = [
    { type: "text", text: "正文" },
    {
      type: "tool-call",
      toolName: "bash",
      args: { command: "ls" },
      result: "x".repeat(500),
      isError: false,
    },
    { type: "tool-call", toolName: "edit", args: { path: "a.ts" }, isError: true },
  ];

  it("按下标取 part，带上下标与失败标记", () => {
    expect(toolRows(parts, [1, 2])).toEqual([
      { partIndex: 1, name: "bash", chip: "ls", failed: false },
      { partIndex: 2, name: "edit", chip: "a.ts", failed: true },
    ]);
  });

  it("快照里不含 result（大块输出不进按 token 重算的那份数据）", () => {
    const serialized = JSON.stringify(toolRows(parts, [1, 2]));
    expect(serialized).not.toContain("xxxx");
    expect(Object.hasOwn(toolRows(parts, [1])[0] ?? {}, "result")).toBe(false);
  });

  it("跳过非 tool-call 与越界下标", () => {
    expect(toolRows(parts, [0, 99])).toEqual([]);
    expect(toolRows([], [0])).toEqual([]);
  });

  it("缺参数的调用 chip 为空串而不是报错", () => {
    expect(toolRows([{ type: "tool-call", toolName: "read" }], [0])).toEqual([
      { partIndex: 0, name: "read", chip: "", failed: false },
    ]);
  });
});

describe("resolveToolDetail · 子智能体", () => {
  it("Task 的 details 是运行记录：给子智能体详情，头部字段与整份 run 一并带上", () => {
    const run = subagentRun({
      status: "completed",
      endedAt: 1_800,
      turns: 5,
      toolCalls: 7,
      report: "重试最多 3 次（src/retry.ts:42）",
    });

    const detail = resolveToolDetail("Task", run);

    expect(detail).toMatchObject({
      kind: "subagent",
      delegationId: "d-1",
      agentName: "explorer",
      status: "completed",
      turns: 5,
      toolCalls: 7,
      modelId: "svc/model-x",
      childSessionId: "child-1",
      elapsedMs: 800,
    });
    // 报告 / 工具列表 / 停止按钮这些用到整份记录的地方直接取 run，避免字段抄两份
    const subagent = detail?.kind === "subagent" ? detail : null;
    expect(subagent?.run).toEqual(run);
  });

  it("仍在跑（没有 endedAt）时不带 elapsedMs：耗时由 run 现算，不在详情里钉一个会过期的值", () => {
    const detail = resolveToolDetail("Task", subagentRun());

    expect(detail?.kind).toBe("subagent");
    expect(detail).not.toHaveProperty("elapsedMs");
  });

  it("失败态优先：委派失败不给子智能体卡片，缺字段的 details 也不硬造", () => {
    // 一次启动失败的 Task details 是 { error }：错误态下必须走 ToolFallback，不能被读成成功卡片
    expect(resolveToolDetail("Task", { error: "没有名为 analyst 的子智能体" }, true)).toBeNull();
    // 非错误态下 { error } 不是运行记录（缺 delegationId / childSessionId），落回内置文本面板
    expect(resolveToolDetail("Task", { error: "没有名为 analyst 的子智能体" })).toBeNull();
    expect(resolveToolDetail("Task", undefined)).toBeNull();
  });

  it("TaskWait / TaskList / TaskStop 的 details 是 { runs }：给批量卡片并带上条数", () => {
    // 这三个工具按契约返回 SubagentRunsDetails（{ runs: [...] }），与 Task 的单条记录不同形状。
    // 两种都要认：只认单条的话它们会静默落回内置文本面板，
    // 而「一次等了三个子智能体」这件事在看板上就消失了 —— 条数因此必须带出来。
    for (const toolName of ["TaskWait", "TaskList", "TaskStop"]) {
      const details = { runs: [subagentRun()] };
      expect(() => resolveToolDetail(toolName, details)).not.toThrow();
      const detail = resolveToolDetail(toolName, details);
      expect(detail?.kind).toBe("subagent");
      // 单条批量：条数为 1，卡片退化成那一条的描述，不额外报数（见 ToolParts 的渲染分支）
      if (detail?.kind === "subagent") expect(detail.batchSize).toBe(1);

      const second = subagentRun({
        delegationId: "d-2",
        parentToolCallId: "d-2",
        childSessionId: "child-2",
      });
      const many = resolveToolDetail(toolName, { runs: [subagentRun(), second] });
      // 两条运行时条数必须报出来：只说主体会让人以为它只动了一条
      expect(many?.kind === "subagent" ? many.batchSize : null).toBe(2);
    }
    // 坏条目被逐条丢掉，而不是让整批消失
    expect(resolveToolDetail("TaskWait", { runs: [subagentRun(), { nope: true }] })).toMatchObject({
      kind: "subagent",
      batchSize: 1,
    });
    // 空批量 / 形状不对 / 缺 details：没有可显示的主体，落回内置文本面板
    expect(resolveToolDetail("TaskWait", { runs: [] })).toBeNull();
    expect(resolveToolDetail("TaskWait", undefined)).toBeNull();
    expect(resolveToolDetail("TaskWait", { delegationIds: ["d-1"] })).toBeNull();
    // 工具参数（description / task）不能凭空补出一份运行记录
    expect(resolveToolDetail("TaskWait", undefined, false, { delegationIds: ["d-1"] })).toBeNull();
  });
});

describe("SUBAGENT_STATUS_LABEL_KEYS", () => {
  /**
   * 契约里的全部状态（枚举自 shared/contracts/subagent.ts 的 SubagentRunStatus）。
   * 新增一档状态时，生产的 Record<SubagentRunStatus, string> 会先出编译错误；
   * 这个列表与下面的「没有多余键」断言再兜住运行时：状态改了而映射没跟上，
   * 面板就会渲染 undefined，而不是在测试里变红。
   */
  const STATUSES: readonly SubagentRunStatus[] = [
    "running",
    "completed",
    "truncated",
    "failed",
    "aborted",
    "denied",
    "interrupted",
  ];

  it("每个状态都有非空词条键，且没有多余键", () => {
    for (const status of STATUSES) {
      const key = SUBAGENT_STATUS_LABEL_KEYS[status];
      expect(key, `状态 ${status} 缺少文案键`).toBeTruthy();
      expect(key.startsWith("rightPanel.")).toBe(true);
    }
    expect(Object.keys(SUBAGENT_STATUS_LABEL_KEYS).sort()).toEqual([...STATUSES].sort());
  });
});

describe("subagentElapsedMs", () => {
  it("interrupted 的耗时冻结在 endedAt 上，不随 now 增长", () => {
    // 主进程对账孤儿行时会把 endedAt 对齐到 updatedAt（最后一次持久化）。
    // 这里若还走 now 兜底，「意外终止」的耗时会随面板停留时间一直变大 —— 读起来就是还在跑
    const run = subagentRun({ status: "interrupted", startedAt: 1_000, endedAt: 5_000 });
    expect(subagentElapsedMs(run, 5_000)).toBe(4_000);
    expect(subagentElapsedMs(run, 60_000)).toBe(4_000);
  });

  it("interrupted 缺 endedAt 时退到 updatedAt / startedAt，同样不增长", () => {
    const withUpdatedAt = subagentRun({
      status: "interrupted",
      startedAt: 1_000,
      updatedAt: 4_000,
    });
    expect(subagentElapsedMs(withUpdatedAt, 5_000)).toBe(3_000);
    expect(subagentElapsedMs(withUpdatedAt, 99_999)).toBe(3_000);

    // 两个时间戳都没有的旧记录：显示 0 秒，而不是一个活的数字
    const bare = subagentRun({ status: "interrupted", startedAt: 1_000 });
    expect(subagentElapsedMs(bare, 99_999)).toBe(0);
  });

  it("running 仍按 now 现算：心跳只喂给真正在跑的行", () => {
    expect(subagentElapsedMs(subagentRun({ startedAt: 1_000 }), 3_000)).toBe(2_000);
  });
});

describe("运行进度不再有百分比", () => {
  /**
   * 早先这里测的是 `subagentProgress` = turns/maxTurns。
   * `maxTurns` 字段已整体删除（见 shared/contracts/subagent.ts 的说明），
   * 而且那个比值本身就是错的口径 —— 它把「轮次」当成了「配额消耗」。
   *
   * 现在只报绝对轮次，所以这里改测**轮次本身就是单调的读数**：
   * 这是它还能当进度用的唯一依据。
   */
  it("turns 是单调读数：调用方可以直接拿它表达「还在动」", () => {
    let previous = -1;
    for (const turns of [0, 1, 2, 3, 7, 15, 29, 30, 31, 80]) {
      const value = subagentRun({ turns }).turns;
      expect(value).toBe(turns);
      expect(value).toBeGreaterThan(previous);
      previous = value;
    }
  });

  it("interrupted 保留它停下那一刻的 turns（不归零、不给哨兵值）", () => {
    const run = subagentRun({ status: "interrupted", turns: 15, endedAt: 5_000 });
    expect(run.turns).toBe(15);
    // 「还在不在跑」由状态决定，调用方据此把它挡在活跃进度之外
    expect(isSubagentRunFinished(run.status)).toBe(true);
  });
});

/** 一条完整的作业快照：JobInfo 的真实形状（见 shared/contracts/job.ts），各用例只改关心的字段 */
function jobInfo(patch: Partial<JobInfo> = {}): JobInfo {
  return {
    id: "job-1",
    sessionId: "s-parent",
    command: "pnpm dev",
    cwd: "D:/dev/app",
    status: "running",
    startedAt: 1_000,
    totalBytes: 0,
    truncated: false,
    ...patch,
  };
}

describe("resolveToolDetail · 后台作业", () => {
  it("单作业工具的 details 是 { job }：给作业详情，jobId 与快照一并带上", () => {
    const job = jobInfo({ status: "exited", exitCode: 0, endedAt: 3_000 });
    const detail = resolveToolDetail("bash_background", { job });

    expect(detail).toMatchObject({ kind: "job", jobId: "job-1", job });
    // 单作业调用没有批量：batch 缺席，pill 才不会平白多报一句条数
    expect(detail).not.toHaveProperty("batch");
  });

  it("job_list 的 details 是 { jobs }：以第一条为主体，整批挂在 batch 上", () => {
    const a = jobInfo({ id: "job-1" });
    const b = jobInfo({ id: "job-2", command: "pnpm test" });
    const detail = resolveToolDetail("job_list", { jobs: [a, b] });

    expect(detail?.kind).toBe("job");
    const jobs = detail?.kind === "job" ? detail : null;
    expect(jobs?.jobId).toBe("job-1");
    expect(jobs?.batch).toEqual([a, b]);
  });

  it("形状不对时不给详情，落回普通工具行", () => {
    // 空批量：没有任何作业可呈现，硬造一张 pill 会让「这次调用成功了、只是没作业」消失
    expect(resolveToolDetail("job_list", { jobs: [] })).toBeNull();
    // 缺 id / status 不是作业快照
    expect(resolveToolDetail("job_output", { job: { command: "x" } })).toBeNull();
    expect(resolveToolDetail("bash_background", undefined)).toBeNull();
    // 非记录形状（比如契约之外的字符串）同样落回
    expect(resolveToolDetail("job_kill", "不是对象")).toBeNull();
  });

  it("坏条目丢掉的只有它自己：一批里有一条记录不全，其余照常显示", () => {
    const good = jobInfo({ id: "job-2" });
    const detail = resolveToolDetail("job_list", { jobs: [{ command: "缺 id" }, good] });

    const jobs = detail?.kind === "job" ? detail : null;
    expect(jobs?.jobId).toBe("job-2");
    expect(jobs?.batch).toEqual([good]);
  });

  it("失败时作业仍然给作业卡片（失败正是它要显示的结论）", () => {
    // 作业在 resolveToolDetail 里**不看失败闸门**：作业失败本身就是这颗 pill 要显示的结论，
    // 藏起来反而看不出「它跑挂了」。调用侧（ToolCallPart）另有一条分支直接读 details，
    // 正是为了确保失败态也能显示成「失败」而不是红叉工具行。
    const detail = resolveToolDetail("bash_background", { job: jobInfo() }, true);
    expect(detail?.kind).toBe("job");
  });
});

describe("jobElapsedMs", () => {
  it("running 按 now 现算，终态冻结在 endedAt 上", () => {
    expect(jobElapsedMs(jobInfo({ startedAt: 1_000 }), 3_000)).toBe(2_000);
    expect(jobElapsedMs(jobInfo({ startedAt: 1_000, endedAt: 2_500 }), 9_999)).toBe(1_500);
  });

  it("终态缺 endedAt 时退回 0，不给一个会随时间增长的读数", () => {
    // 记录不全（例如 spawn 失败、或重启后补拉的旧快照）时宁可显示 0：
    // 一个早就结束的作业挂着走动的秒数，读起来就是「还在跑」
    expect(jobElapsedMs(jobInfo({ status: "failed", startedAt: 1_000 }), 9_999)).toBe(0);
    expect(jobElapsedMs(jobInfo({ status: "killed", startedAt: 1_000 }), 9_999)).toBe(0);
  });

  it("时钟回拨（endedAt 早于 startedAt）时夹到 0，不出现负数读数", () => {
    expect(jobElapsedMs(jobInfo({ startedAt: 5_000, endedAt: 4_000 }), 9_999)).toBe(0);
  });
});

/**
 * 网络工具的 details 解析。
 *
 * details 从主进程过来是 `unknown`，形状不对时必须返回 null（落回内置的文本面板），
 * **绝不能抛** —— 工具卡在渲染期抛错会带塌整条消息。
 */
describe("parseWebSearchDetail", () => {
  it("正常形状", () => {
    const detail = parseWebSearchDetail({
      provider: "searxng",
      sources: [{ url: "https://a.test", title: "A", snippet: "S" }],
      truncated: false,
    });
    expect(detail).toMatchObject({
      kind: "web-search",
      provider: "searxng",
      truncated: false,
      sources: [{ url: "https://a.test", title: "A", snippet: "S" }],
    });
  });

  it("保留 answer 与 instance", () => {
    const detail = parseWebSearchDetail({
      provider: "tavily",
      sources: [{ url: "https://a.test" }],
      truncated: true,
      answer: "42",
    });
    expect(detail?.answer).toBe("42");
    expect(detail?.truncated).toBe(true);
  });

  it("空 sources 是合法的（「没有结果」也是一种结果）", () => {
    expect(
      parseWebSearchDetail({ provider: "searxng", sources: [], truncated: false }),
    ).toMatchObject({
      sources: [],
    });
  });

  it("缺少 sources / sources 不是数组时返回 null", () => {
    expect(parseWebSearchDetail({ provider: "searxng", truncated: false })).toBeNull();
    expect(parseWebSearchDetail({ sources: "nope" })).toBeNull();
  });

  it("来源项缺 url 时整体放弃（而不是只丢那一项）", () => {
    expect(
      parseWebSearchDetail({
        provider: "searxng",
        sources: [{ url: "https://a.test" }, { title: "没有 url" }],
        truncated: false,
      }),
    ).toBeNull();
  });

  it("可选字段类型不对时返回 null", () => {
    expect(
      parseWebSearchDetail({
        provider: "searxng",
        sources: [{ url: "https://a.test", title: 42 }],
        truncated: false,
      }),
    ).toBeNull();
  });

  it("非对象输入返回 null（不抛）", () => {
    for (const bad of [null, undefined, "string", 42, []]) {
      expect(parseWebSearchDetail(bad), String(bad)).toBeNull();
    }
  });

  it("provider 缺失时回空串（卡片仍要能画）", () => {
    const detail = parseWebSearchDetail({ sources: [], truncated: false });
    expect(detail?.provider).toBe("");
  });

  it("空 answer 不带上（避免渲染一个空块）", () => {
    expect(
      parseWebSearchDetail({ provider: "x", sources: [], truncated: false, answer: "" }),
    ).not.toHaveProperty("answer");
  });
});

describe("parseWebFetchDetail", () => {
  it("正常形状", () => {
    expect(
      parseWebFetchDetail({ url: "https://a.test", statusCode: 200, title: "T", truncated: false }),
    ).toEqual({ kind: "web-fetch", url: "https://a.test", statusCode: 200, title: "T" });
  });

  it("非 2xx 也是合法详情（状态码本身就是信息）", () => {
    expect(parseWebFetchDetail({ url: "https://a.test", statusCode: 404 })).toMatchObject({
      statusCode: 404,
    });
  });

  it("缺 url / statusCode 非数字时返回 null", () => {
    expect(parseWebFetchDetail({ statusCode: 200 })).toBeNull();
    expect(parseWebFetchDetail({ url: "", statusCode: 200 })).toBeNull();
    expect(parseWebFetchDetail({ url: "https://a.test" })).toBeNull();
    expect(parseWebFetchDetail({ url: "https://a.test", statusCode: "200" })).toBeNull();
  });

  it("非对象输入返回 null（不抛）", () => {
    for (const bad of [null, undefined, "string", 42]) {
      expect(parseWebFetchDetail(bad), String(bad)).toBeNull();
    }
  });

  it("空 title 不带上", () => {
    expect(
      parseWebFetchDetail({ url: "https://a.test", statusCode: 200, title: "" }),
    ).not.toHaveProperty("title");
  });
});

describe("网络工具走卡片而不是内置文本面板", () => {
  it("web_search 有 details 时解析成 web-search 详情", () => {
    const detail = resolveToolDetail("web_search", {
      provider: "searxng",
      sources: [{ url: "https://a.test" }],
      truncated: false,
    });
    expect(detail?.kind).toBe("web-search");
  });

  it("web_fetch 有 details 时解析成 web-fetch 详情", () => {
    const detail = resolveToolDetail("web_fetch", { url: "https://a.test", statusCode: 200 });
    expect(detail?.kind).toBe("web-fetch");
  });

  it("失败时不给详情（与其它工具同一口径：失败结果不再显示成卡片）", () => {
    expect(
      resolveToolDetail("web_search", { provider: "searxng", sources: [], truncated: false }, true),
    ).toBeNull();
  });

  it("details 形状不对时落回内置面板（返回 null）", () => {
    expect(resolveToolDetail("web_search", { unexpected: true })).toBeNull();
    expect(resolveToolDetail("web_fetch", { unexpected: true })).toBeNull();
  });
});
