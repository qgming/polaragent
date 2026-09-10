import path from "node:path";
import { describe, expect, it } from "vitest";
import { isInsidePath, normalizePath, validatePathAccess } from "./path-guard";

const isWindows = process.platform === "win32";
// 当前平台下的绝对根目录样本（Windows 盘符用小写，与 normalizePath 输出一致）
const root = isWindows ? "c:\\workspace\\project" : "/workspace/project";

describe("normalizePath", () => {
  it("去除尾分隔符并统一为当前平台分隔符", () => {
    expect(normalizePath(`${root}${path.sep}src${path.sep}`)).toBe(path.join(root, "src"));
  });

  it("保留根路径本身", () => {
    expect(normalizePath(isWindows ? "C:\\" : "/")).toBe(isWindows ? "c:\\" : "/");
  });

  it.runIf(isWindows)("Windows 盘符归一为小写，且接受正斜杠输入", () => {
    expect(normalizePath("C:/Work/App/")).toBe("c:\\Work\\App");
    expect(normalizePath("d:\\data")).toBe("d:\\data");
  });
});

describe("isInsidePath", () => {
  it("接受同路径与内部子路径", () => {
    expect(isInsidePath(root, root)).toBe(true);
    expect(isInsidePath(path.join(root, "src", "index.ts"), root)).toBe(true);
  });

  it("拒绝外部同前缀目录", () => {
    expect(isInsidePath(`${root}-backup`, root)).toBe(false);
    expect(isInsidePath(isWindows ? "C:\\other" : "/other", root)).toBe(false);
  });

  it("拒绝 .. 穿越", () => {
    const escaped = path.join(root, "..", "secret.txt");
    expect(isInsidePath(escaped, root)).toBe(false);
  });

  it("归一后回到内部的未解析 .. 路径可通过", () => {
    const backInside = `${root}${path.sep}..${path.sep}project${path.sep}a.ts`;
    expect(isInsidePath(backInside, root)).toBe(true);
  });

  it("忽略父子两侧的尾分隔符差异", () => {
    expect(isInsidePath(`${root}${path.sep}`, root)).toBe(true);
    expect(isInsidePath(path.join(root, "src"), `${root}${path.sep}`)).toBe(true);
  });

  it("拒绝把目录名当作分隔符（parent 前缀相同但不是子路径）", () => {
    expect(isInsidePath(path.join(root, "..", "project2"), root)).toBe(false);
  });

  it.runIf(isWindows)("Windows 大小写不敏感并兼容正反斜杠混用", () => {
    expect(isInsidePath("c:\\WORKSPACE\\PROJECT\\src\\a.ts", "C:\\workspace\\project")).toBe(true);
    expect(isInsidePath("C:/workspace/project/a.ts", "c:\\workspace\\project")).toBe(true);
  });
});

describe("validatePathAccess", () => {
  it("允许 root 内部路径并返回归一结果", () => {
    const result = validatePathAccess(path.join(root, "src", "a.ts"), [root]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.resolved).toBe(path.join(root, "src", "a.ts"));
  });

  it("拒绝 root 外路径", () => {
    const outside = isWindows ? "C:\\Windows\\System32" : "/etc/passwd";
    const result = validatePathAccess(outside, [root]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("允许的工作目录");
  });

  it("拒绝 .. 穿越到 root 之外", () => {
    const result = validatePathAccess(path.join(root, "..", "secret.txt"), [root]);
    expect(result.ok).toBe(false);
  });

  it("roots 为空时拒绝并提示未指定工作目录", () => {
    const result = validatePathAccess(root, []);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("工作目录");
  });

  it("多 root 时任一命中即通过", () => {
    const other = isWindows ? "D:\\shared" : "/shared";
    expect(validatePathAccess(path.join(other, "a.txt"), [root, other]).ok).toBe(true);
  });
});
