// grep / glob 的行为测试：全部在真实临时目录上跑（node:fs/promises 造夹具），
// 因为这两个工具的价值就在「遍历 + 跳过规则 + 路径守卫」这些只有真实文件系统才能验的地方。

import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  type AgentHarnessToolInvocation,
  BACKGROUND_CONTEXT,
  type ExecutionEnv,
  type ExecutionToolContext,
} from "@earendil-works/pi-agent-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGlobTool, createGrepTool } from "./search";

let root: string;
// 临时根目录之外的兄弟文件：用来验证越界路径被拒且内容不外泄
const outsideFile = path.join(os.tmpdir(), `oint-search-outside-${process.pid}.ts`);

/** search 工具只读 env.cwd，这里给最小替身，不为测试构造完整 ExecutionEnv */
function toolContext(cwd: string): ExecutionToolContext {
  return { env: { cwd } as ExecutionEnv };
}

/** 工具调用里用不到 invocation，但签名要求给一个 */
const INVOCATION: AgentHarnessToolInvocation = {
  invocationId: "call-1",
  operationId: "op-1",
  turnId: "turn-1",
  getMemo: async () => undefined,
  setMemo: async () => {},
};

type GrepParams = Parameters<ReturnType<typeof createGrepTool>["execute"]>[1];
type GrepOutcome = Awaited<ReturnType<ReturnType<typeof createGrepTool>["execute"]>>;
type GlobParams = Parameters<ReturnType<typeof createGlobTool>["execute"]>[1];
type GlobOutcome = Awaited<ReturnType<ReturnType<typeof createGlobTool>["execute"]>>;

function runGrep(cwd: string, params: GrepParams): Promise<GrepOutcome> {
  return createGrepTool().execute(
    "call-grep",
    params,
    () => {},
    toolContext(cwd),
    INVOCATION,
    BACKGROUND_CONTEXT,
  );
}

function runGlob(cwd: string, params: GlobParams): Promise<GlobOutcome> {
  return createGlobTool().execute(
    "call-glob",
    params,
    () => {},
    toolContext(cwd),
    INVOCATION,
    BACKGROUND_CONTEXT,
  );
}

/** content 里的文本（两个工具都只回文本） */
function textOf(outcome: GrepOutcome | GlobOutcome): string {
  return outcome.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
}

/** 有命中时末行是汇总行，前几行才是数据行 */
function dataLines(text: string): string[] {
  return text.split("\n").slice(0, -1);
}

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "oint-search-"));
  await mkdir(path.join(root, "bin"), { recursive: true });
  await mkdir(path.join(root, "empty-dir"), { recursive: true });
  await mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
  await mkdir(path.join(root, "order"), { recursive: true });
  await mkdir(path.join(root, "src", "deep", "nested"), { recursive: true });

  await writeFile(path.join(root, "a.ts"), "export const alpha = 1;\nexport const beta = 2;\n");
  await writeFile(path.join(root, "b.tsx"), "export const jsx = true;\n");
  await writeFile(path.join(root, "notes.md"), "alpha in markdown\n");
  await writeFile(
    path.join(root, "many.txt"),
    Array.from({ length: 600 }, (_, index) => `needle line ${index + 1}`).join("\n"),
  );
  // 超过 1 MiB：必须被大小上限跳过
  await writeFile(path.join(root, "oversized.ts"), "alpha oversized\n".repeat(100_000));
  // 前 8 KiB 里有 NUL 字节：必须被判为二进制
  await writeFile(
    path.join(root, "bin", "blob.bin"),
    Buffer.concat([Buffer.from("alpha in a binary\n"), Buffer.from([0x00, 0x01, 0x02])]),
  );
  await writeFile(path.join(root, "src", "deep", "c.ts"), "alpha again\n");
  await writeFile(path.join(root, "src", "deep", "nested", "d.ts"), "alpha deep\n");
  await writeFile(path.join(root, "node_modules", "pkg", "index.ts"), "alpha in a dependency\n");

  const oldFile = path.join(root, "order", "old.ts");
  const newFile = path.join(root, "order", "new.ts");
  await writeFile(oldFile, "old entry\n");
  await writeFile(newFile, "new entry\n");
  const now = Date.now();
  const hourAgo = new Date(now - 60 * 60 * 1000);
  await utimes(oldFile, hourAgo, hourAgo);
  await utimes(newFile, new Date(now), new Date(now));

  await writeFile(outsideFile, "outside alpha\n");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outsideFile, { force: true });
});

describe("grep", () => {
  it("递归命中，输出 path:line:text，并跳过 node_modules", async () => {
    const outcome = await runGrep(root, { pattern: "alpha", include: "*.ts" });
    const text = textOf(outcome);

    expect(text).toContain("a.ts:1:export const alpha = 1;");
    expect(text).toContain("src/deep/c.ts:1:alpha again");
    expect(text).toContain("src/deep/nested/d.ts:1:alpha deep");
    expect(text).not.toContain("node_modules");
    expect(outcome.details).toEqual({
      root: expect.any(String),
      matches: 3,
      files: 3,
      truncated: false,
    });
  });

  it("汇总行的英文单复数正确：3 matches，不是 3 matchs", async () => {
    const text = textOf(await runGrep(root, { pattern: "alpha", include: "*.ts" }));

    // match 的复数是 matches（es）：按单数拼 "s" 会写出 "matchs" —— 模型会照抄这个词
    expect(text.split("\n").at(-1)).toContain("3 matches in 3 files");
  });

  it("只有一条命中时用单数 match / file", async () => {
    const text = textOf(await runGrep(root, { pattern: "jsx" }));

    expect(text.split("\n").at(-1)).toContain("1 match in 1 file");
  });

  it("无命中时给出明确文案而不是空响应，并报告搜过的文件数", async () => {
    const outcome = await runGrep(root, { pattern: "definitely-not-here" });
    const text = textOf(outcome);

    expect(text).toContain("No matches for");
    expect(text).toContain("searched");
    expect(outcome.details.matches).toBe(0);
    expect(outcome.details.truncated).toBe(false);
  });

  it("include 只作用于文件名：*.md 命中 markdown，*.ts 不命中它", async () => {
    const markdown = textOf(await runGrep(root, { pattern: "alpha", include: "*.md" }));
    expect(dataLines(markdown)).toEqual(["notes.md:1:alpha in markdown"]);

    const typescript = textOf(await runGrep(root, { pattern: "alpha", include: "*.ts" }));
    expect(typescript).not.toContain("notes.md");
    expect(typescript).toContain("a.ts:1:");
  });

  it("limit 截断时只回 limit 条并说明还有更多", async () => {
    const outcome = await runGrep(root, { pattern: "alpha", include: "*.ts", limit: 2 });
    const text = textOf(outcome);

    expect(dataLines(text)).toHaveLength(2);
    expect(text).toContain("Limit 2 reached");
    expect(text).toContain("more matches exist");
    expect(outcome.details).toEqual({
      root: expect.any(String),
      matches: 2,
      files: 2,
      truncated: true,
    });
  });

  it("limit 超过硬上限 500 时按上限截断", async () => {
    const outcome = await runGrep(root, { pattern: "needle", limit: 9999 });

    expect(outcome.details.matches).toBe(500);
    expect(outcome.details.truncated).toBe(true);
    expect(textOf(outcome)).toContain("many.txt:1:needle line 1");
  });

  it("path 指向二进制文件所在目录时判为二进制并跳过", async () => {
    const outcome = await runGrep(root, { pattern: "alpha", path: "bin" });
    const text = textOf(outcome);

    expect(text).toContain("No matches for");
    expect(text).not.toContain("blob.bin");
  });

  it("超过 1 MiB 的文件被跳过", async () => {
    const outcome = await runGrep(root, { pattern: "oversized" });

    expect(textOf(outcome)).toContain("No matches for");
    expect(outcome.details.matches).toBe(0);
  });

  it("path 指向单个文件时只扫该文件", async () => {
    const text = textOf(await runGrep(root, { pattern: "alpha", path: "a.ts" }));

    expect(dataLines(text)).toEqual(["a.ts:1:export const alpha = 1;"]);
  });

  it("拒绝工作目录之外的 path，且不回传外部文件内容", async () => {
    const relativeEscape = await runGrep(root, { pattern: "alpha", path: ".." });
    const absoluteEscape = await runGrep(root, { pattern: "alpha", path: outsideFile });

    for (const outcome of [relativeEscape, absoluteEscape]) {
      const text = textOf(outcome);
      expect(text).toContain("Error:");
      expect(text).toContain("路径不在允许的工作目录内");
      expect(text).not.toContain("outside alpha");
      expect(outcome.details.matches).toBe(0);
    }
  });

  it("path 不存在时明确报错", async () => {
    const text = textOf(await runGrep(root, { pattern: "alpha", path: "missing-dir" }));

    expect(text).toContain("Error: Path not found");
  });

  it("非法正则返回错误文案而不是抛异常", async () => {
    const text = textOf(await runGrep(root, { pattern: "a(" }));

    expect(text).toContain("invalid regular expression");
  });
});

describe("glob", () => {
  it("**/*.ts 递归匹配（含根目录下的一层）且跳过 node_modules", async () => {
    const outcome = await runGlob(root, { pattern: "**/*.ts" });

    expect(dataLines(textOf(outcome)).sort()).toEqual(
      [
        "a.ts",
        "order/new.ts",
        "order/old.ts",
        "oversized.ts",
        "src/deep/c.ts",
        "src/deep/nested/d.ts",
      ].sort(),
    );
    expect(outcome.details.truncated).toBe(false);
  });

  it("*.ts 只匹配单层，?.ts 只匹配单字符文件名", async () => {
    const single = await runGlob(root, { pattern: "*.ts" });
    expect(dataLines(textOf(single)).sort()).toEqual(["a.ts", "oversized.ts"]);

    const oneChar = await runGlob(root, { pattern: "?.ts" });
    expect(dataLines(textOf(oneChar))).toEqual(["a.ts"]);
  });

  it("按 mtime 倒序，最新的排在最前", async () => {
    const outcome = await runGlob(root, { pattern: "order/*.ts" });

    expect(dataLines(textOf(outcome))).toEqual(["order/new.ts", "order/old.ts"]);
  });

  it("limit 截断时说明还有更多，limit 下限被抬到 1", async () => {
    const truncated = await runGlob(root, { pattern: "**/*.ts", limit: 2 });
    expect(dataLines(textOf(truncated))).toHaveLength(2);
    expect(textOf(truncated)).toContain("more files match");
    expect(truncated.details).toEqual({ root: expect.any(String), matches: 2, truncated: true });

    const zeroLimit = await runGlob(root, { pattern: "**/*.ts", limit: 0 });
    expect(zeroLimit.details.matches).toBe(1);
    expect(zeroLimit.details.truncated).toBe(true);
  });

  it("无匹配时给出明确文案", async () => {
    const outcome = await runGlob(root, { pattern: "**/*.nope" });
    const text = textOf(outcome);

    expect(text).toContain("No files match");
    expect(outcome.details.matches).toBe(0);
  });

  it("拒绝工作目录之外的 path", async () => {
    const text = textOf(await runGlob(root, { pattern: "**/*.ts", path: ".." }));

    expect(text).toContain("Error:");
    expect(text).toContain("路径不在允许的工作目录内");
  });
});
