// projects 单测：项目列表持久化（新增 / 去重 / 删除 / 坏数据回退）。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProjectsStore } from "./projects";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "oint-projects-"));
  tempDirs.push(dir);
  return dir;
}

/** 建一个真实存在的目录：add 会做 stat 校验 */
function makeProjectDir(baseDir: string, name: string): string {
  const dir = path.join(baseDir, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("projects store", () => {
  it("add 返回 id/name/createdAt，name 取目录名", async () => {
    const baseDir = makeTempDir();
    const store = createProjectsStore(baseDir);
    const dir = makeProjectDir(baseDir, "demo");

    const project = await store.add(dir);
    expect(project.id).not.toBe("");
    expect(project.name).toBe("demo");
    expect(project.path).toBe(path.resolve(dir));
    expect(project.createdAt).toBeGreaterThan(0);
    expect(await store.list()).toEqual([project]);
  });

  it("重复添加同一路径只留一条并返回同一个 id", async () => {
    const baseDir = makeTempDir();
    const store = createProjectsStore(baseDir);
    const dir = makeProjectDir(baseDir, "demo");
    const first = await store.add(dir);

    // 尾部分隔符、路径中间的 ./ 段：resolve 后指向同一目录
    const withSep = await store.add(`${dir}${path.sep}`);
    const withDot = await store.add(
      `${path.dirname(dir)}${path.sep}.${path.sep}${path.basename(dir)}`,
    );

    expect(withSep.id).toBe(first.id);
    expect(withDot.id).toBe(first.id);
    expect(await store.list()).toHaveLength(1);
  });

  it.runIf(process.platform === "win32")("Windows 下大小写不同视为同一路径", async () => {
    const baseDir = makeTempDir();
    const store = createProjectsStore(baseDir);
    const dir = makeProjectDir(baseDir, "Demo");
    const first = await store.add(dir);

    const viaCase = await store.add(dir.toLowerCase());
    expect(viaCase.id).toBe(first.id);
    expect(await store.list()).toHaveLength(1);
  });

  it("remove 之后 list 不再包含它，重复 remove 静默", async () => {
    const baseDir = makeTempDir();
    const store = createProjectsStore(baseDir);
    const first = await store.add(makeProjectDir(baseDir, "one"));
    const second = await store.add(makeProjectDir(baseDir, "two"));

    await store.remove(first.id);
    expect((await store.list()).map((item) => item.id)).toEqual([second.id]);

    await expect(store.remove(first.id)).resolves.toBeUndefined();
  });

  it("文件不存在时 list 返回空数组", async () => {
    const store = createProjectsStore(makeTempDir());
    await expect(store.list()).resolves.toEqual([]);
  });

  it("文件内容损坏时 list 返回空数组且不抛", async () => {
    const baseDir = makeTempDir();
    writeFileSync(path.join(baseDir, "projects.json"), "{ 这不是 JSON", "utf8");
    const store = createProjectsStore(baseDir);
    await expect(store.list()).resolves.toEqual([]);
  });

  it("add 传入不存在的目录时 reject", async () => {
    const baseDir = makeTempDir();
    const store = createProjectsStore(baseDir);
    await expect(store.add(path.join(baseDir, "not-exists"))).rejects.toThrow(
      "项目目录不存在或不是目录",
    );
  });
});
