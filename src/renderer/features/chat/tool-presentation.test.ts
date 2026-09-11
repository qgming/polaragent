import { describe, expect, it } from "vitest";
import {
  BASH_TAIL_LINES,
  bashCommand,
  bashOutput,
  CHIP_LIMIT,
  DIFF_MAX_LINES,
  detailsPatch,
  resolveToolDetail,
  shortenPath,
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
  it("失败优先于一切：有 patch 的 edit 也不给详情", () => {
    expect(resolveToolDetail("bash", undefined, true)).toBeNull();
    expect(resolveToolDetail("edit", { patch: PATCH }, true)).toBeNull();
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

  it("edit 缺 patch 或 patch 不可解析时不给详情（落回内置面板）", () => {
    expect(resolveToolDetail("edit", undefined)).toBeNull();
    expect(resolveToolDetail("edit", { diff: "@@ -1 +1 @@" })).toBeNull();
    expect(resolveToolDetail("edit", { patch: "   " })).toBeNull();
    expect(resolveToolDetail("edit", { patch: "这不是补丁" })).toBeNull();
  });

  it("其余工具不给详情，即使带了 details", () => {
    expect(resolveToolDetail("read", { truncation: { lines: 5 } })).toBeNull();
    expect(resolveToolDetail("write", undefined)).toBeNull();
    expect(resolveToolDetail("未知工具", undefined)).toBeNull();
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
