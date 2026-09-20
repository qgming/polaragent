// 原子写的失败路径：**临时文件不能留下**。
//
// 这个文件来自一次实测：本机数据根积了 7 个 `sessions-index.json.<pid>.<ts>.tmp`
// （48~78 KB，最早两周前）。它们全部来自「写临时文件 → rename」的三行裸代码 ——
// 一旦 writeFile 或 rename 抛错，没有任何人删掉那个临时文件。
//
// 启动时的陈旧扫描（app/paths.ts 的 purgeStaleTempFiles）只是兜底；
// 这条测试钉的是**第一道**：失败当场就删。
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeFileAtomic } from "./atomic-write";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "oint-atomic-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** 目录里所有 .tmp 文件 */
async function tempFiles(): Promise<string[]> {
  return (await readdir(dir)).filter((name) => name.endsWith(".tmp"));
}

describe("writeFileAtomic", () => {
  it("正常路径：写出目标文件，且不留临时文件", async () => {
    const target = path.join(dir, "settings.json");
    await writeFileAtomic(target, '{"a":1}\n');

    expect((await readdir(dir)).sort()).toEqual(["settings.json"]);
  });

  it("目标目录不存在时抛错，且不留下临时文件", async () => {
    const target = path.join(dir, "missing-dir", "settings.json");

    await expect(writeFileAtomic(target, "{}")).rejects.toThrow();
    // 关键断言：失败的这一侧才是当初攒下 7 个 .tmp 的原因
    expect(await tempFiles()).toEqual([]);
  });

  it("rename 失败（目标是已存在的目录）时不留下临时文件", async () => {
    // 目标是一个**目录**：rename 到它上面会失败，但临时文件已经写出来了 ——
    // 这正是需要被清掉的那个中间状态
    const target = path.join(dir, "occupied");
    await rm(target, { recursive: true, force: true });
    const { mkdir } = await import("node:fs/promises");
    await mkdir(target);

    await expect(writeFileAtomic(target, "{}")).rejects.toThrow();
    expect(await tempFiles()).toEqual([]);
  });

  it("覆盖已存在的文件：内容替换成功，不留临时文件", async () => {
    const target = path.join(dir, "sessions-index.json");
    await writeFile(target, "旧内容", "utf8");

    await writeFileAtomic(target, "新内容");

    const { readFile } = await import("node:fs/promises");
    expect(await readFile(target, "utf8")).toBe("新内容");
    expect(await tempFiles()).toEqual([]);
  });

  it("抛出的仍是原始错误（不把 ENOENT 包成别的东西）", async () => {
    const target = path.join(dir, "missing-dir", "x.json");
    await expect(writeFileAtomic(target, "{}")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
