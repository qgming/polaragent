// zip 技能包导入单测：只覆盖解压落盘与安全边界，不碰 IPC 与 Electron。
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractSkillZip } from "./zip-import";

let root: string;
let target: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "oint-skill-zip-"));
  target = path.join(root, "skills");
  await mkdir(target, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** 造一个 zip 夹具并返回它在磁盘上的路径 */
async function writeZip(entries: Record<string, string>, name = "skills.zip"): Promise<string> {
  const archive = zipSync(
    Object.fromEntries(Object.entries(entries).map(([key, value]) => [key, strToU8(value)])),
  );
  const file = path.join(root, name);
  await writeFile(file, archive);
  return file;
}

describe("extractSkillZip", () => {
  it("把技能目录原样解压到目标目录，保留子目录结构", async () => {
    const zip = await writeZip({
      "review/SKILL.md": "---\nname: review\ndescription: 看改动\n---\n正文",
      "review/notes/helper.md": "附注",
    });

    const result = await extractSkillZip(zip, target);

    expect(result.files).toBe(2);
    expect(result.diagnostics).toEqual([]);
    expect(await readFile(path.join(target, "review", "SKILL.md"), "utf8")).toContain(
      "name: review",
    );
    expect(await readFile(path.join(target, "review", "notes", "helper.md"), "utf8")).toBe("附注");
  });

  it("拒绝越界条目：目标目录之外不会落下任何文件", async () => {
    const zip = await writeZip({ "../evil.md": "x", "ok/SKILL.md": "y" });

    const result = await extractSkillZip(zip, target);

    expect(result.files).toBe(1);
    expect(result.diagnostics.join()).toContain("..");
    await expect(readFile(path.join(root, "evil.md"), "utf8")).rejects.toThrow();
  });

  it("跳过 __MACOSX 与系统元数据文件", async () => {
    const zip = await writeZip({
      "__MACOSX/._review": "junk",
      "review/.DS_Store": "junk",
      "review/Thumbs.db": "junk",
      "review/SKILL.md": "y",
    });

    const result = await extractSkillZip(zip, target);

    expect(result.files).toBe(1);
    expect(result.diagnostics.join()).toContain("__MACOSX");
  });

  it("全部条目都被跳过时明确指出没有可导入的文件", async () => {
    const zip = await writeZip({ "../outside.md": "x", "__MACOSX/._x": "junk" });

    const result = await extractSkillZip(zip, target);

    expect(result.files).toBe(0);
    expect(result.diagnostics.join()).toContain("没有可导入的文件");
  });

  it("不是 zip 时抛出中文错误", async () => {
    const fake = path.join(root, "not-a-zip.zip");
    await writeFile(fake, "this is not a zip archive");

    await expect(extractSkillZip(fake, target)).rejects.toThrow("不是有效的 zip 压缩包");
  });
});
