// read 工具的输出契约：tools.ts 的描述承诺「返回带行号的内容」，实现必须真的给出来 ——
// 曾经的版本照抄内核 read（只回原文），子智能体因此被描述误导（行号对不上它想引用的位置）。
//
// 全部在真实临时文件上跑：路径守卫、分页与截断都走内核的真实逻辑，替身会把要验的东西验成空的。

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  type AgentHarnessToolInvocation,
  BACKGROUND_CONTEXT,
  type ExecutionEnv,
} from "@earendil-works/pi-agent-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createExecEnv } from "../exec-env";
import { buildTools } from "../tools";
import { numberLines } from "./read";

let root: string;
let env: ExecutionEnv;

const INVOCATION: AgentHarnessToolInvocation = {
  invocationId: "call-1",
  operationId: "op-1",
  turnId: "turn-1",
  getMemo: async () => undefined,
  setMemo: async () => {},
};

/** 走装配后的 read 工具（而不是单独构造包装）：tools.ts 里接错工具时这里必须变红 */
async function runRead(params: { path: string; offset?: number; limit?: number }) {
  const tool = buildTools().find((candidate) => candidate.name === "read");
  if (tool === undefined) throw new Error("缺少 read 工具");
  return tool.execute(
    "call-read",
    params,
    () => {},
    { env } as never,
    INVOCATION,
    BACKGROUND_CONTEXT,
  );
}

async function readText(params: {
  path: string;
  offset?: number;
  limit?: number;
}): Promise<string> {
  const result = await runRead(params);
  return result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
}

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "oint-read-"));
  env = await createExecEnv({ cwd: root });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("numberLines", () => {
  it("cat -n 风格：行号从 firstLine 开始、右对齐、Tab 分隔", () => {
    expect(numberLines("alpha\nbeta", 1)).toBe("1\talpha\n2\tbeta");
  });

  it("行号按最宽的那个对齐（个位数前面补空格）", () => {
    const body = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n");
    const numbered = numberLines(body, 1).split("\n");

    expect(numbered[0]).toBe(" 1\tline 1");
    expect(numbered[9]).toBe("10\tline 10");
  });

  it("从 offset 的真实行号开始编号（不是从 1 重来）", () => {
    expect(numberLines("delta\nepsilon", 4)).toBe("4\tdelta\n5\tepsilon");
  });

  it("末尾换行不产生不存在的空行号；空内容照旧为空", () => {
    expect(numberLines("alpha\nbeta\n", 1)).toBe("1\talpha\n2\tbeta");
    expect(numberLines("", 1)).toBe("");
  });
});

describe("read 输出", () => {
  it("每行带文件里的真实行号", async () => {
    await writeFile(path.join(root, "plain.txt"), "alpha\nbeta\ngamma\n", "utf8");

    expect(await readText({ path: "plain.txt" })).toBe("1\talpha\n2\tbeta\n3\tgamma");
  });

  it("offset 读中段：行号接着原文件数（不是从 1 重来），分页尾注原样保留", async () => {
    await writeFile(path.join(root, "five.txt"), "one\ntwo\nthree\nfour\nfive\n", "utf8");

    // 尾注里的 "1 more lines" 是内核对「末尾换行也算一行」的既有口径，这里照抄它的原文
    expect(await readText({ path: "five.txt", offset: 4, limit: 2 })).toBe(
      "4\tfour\n5\tfive\n\n[1 more lines in file. Use offset=6 to continue.]",
    );
  });

  it("截断时内容行照常编号，内核的续读尾注原样保留（不能被当成内容行编号）", async () => {
    const body = Array.from({ length: 2_100 }, (_, index) => `line ${index + 1}`).join("\n");
    await writeFile(path.join(root, "big.txt"), body, "utf8");

    const lines = (await readText({ path: "big.txt" })).split("\n");
    expect(lines[0]).toBe("   1\tline 1");
    expect(lines[1_999]).toBe("2000\tline 2000");
    // 尾注是内核分页语义的一部分：不带行号，且一个字都不能改
    expect(lines[2_000]).toBe("");
    expect(lines[2_001]).toBe("[Showing lines 1-2000 of 2100. Use offset=2001 to continue.]");
  });

  it("单行超过字节上限时原样回内核的提示（整段没有可编号的内容行）", async () => {
    await writeFile(path.join(root, "huge-line.txt"), "x".repeat(60_000), "utf8");

    const text = await readText({ path: "huge-line.txt" });
    expect(text.startsWith("[Line 1 is ")).toBe(true);
    expect(text).toContain("exceeds 50.0KB limit");
  });

  it("图片按附件返回：说明文字不会被当成内容行编号", async () => {
    // 1x1 透明 PNG（最小合法文件）：内核按魔数识别成图片，返回文本块 + image 块
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
      "base64",
    );
    await writeFile(path.join(root, "pixel.png"), png);

    const result = await runRead({ path: "pixel.png" });
    expect(result.content[0]).toEqual({ type: "text", text: "Read image file [image/png]" });
    expect(result.content.some((block) => block.type === "image")).toBe(true);
  });
});
