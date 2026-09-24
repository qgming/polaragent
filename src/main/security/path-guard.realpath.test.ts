/**
 * `resolveRealPath` / `validateRealPathAccess` 的回归保护。
 *
 * 这一组存在的理由只有一条：**纯字符串判断看不见符号链接**。一个指向禁区
 *（`~/.oint/settings.json`）的链接，字面路径落在允许根内，于是旧的
 * `validatePathAccess` 放行，而实际读到的是禁区文件。
 *
 * 对 Oint 来说这不是理论风险：README 的「仍有未修的越界读写路径」自己列了
 * 「路径守卫不做 realpath」。引入插件之后它升级为提权链 —— 插件的 `fs` scope
 * 如果不做 realpath 就是一条纸面规则。
 *
 * 符号链接在 Windows 上需要开发者模式或管理员权限，拿不到就跳过那两条用例
 *（其余用例在两种情况下都跑）。
 */

import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveRealPath, validateRealPathAccess } from "./path-guard";

let base: string;
/**
 * 两条链接各自是否创建成功。
 *
 * **分开记而不是合成一个布尔**：Windows 上目录可以用 junction（无需特权），
 * 而文件链接需要开发者模式 —— 合成一个的话，文件链接失败会把目录链接那条
 * 最关键的用例也一起跳过。
 */
let dirLinkWorks = false;
let fileLinkWorks = false;

beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), "oint-guard-"));

  // 允许根：inside/ 与它下面的子目录
  await mkdir(path.join(base, "inside", "nested"), { recursive: true });
  await writeFile(path.join(base, "inside", "ok.txt"), "ok", "utf8");

  // 禁区：模拟 ~/.oint —— 一个绝不该被读到的目录
  await mkdir(path.join(base, "secrets"), { recursive: true });
  await writeFile(path.join(base, "secrets", "settings.json"), '{"apiKey":"sk-x"}', "utf8");

  // 两条链接：一条指向禁区目录，一条指向禁区文件。
  // 这是整个文件存在的理由 —— 它们的**字面路径**都在 inside/ 里面。
  try {
    await symlink(path.join(base, "secrets"), path.join(base, "inside", "link-dir"), "junction");
    dirLinkWorks = true;
  } catch {
    dirLinkWorks = false;
  }
  try {
    await symlink(
      path.join(base, "secrets", "settings.json"),
      path.join(base, "inside", "link-file.json"),
      "file",
    );
    fileLinkWorks = true;
  } catch {
    fileLinkWorks = false;
  }
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("resolveRealPath", () => {
  it("已存在的路径解析到真实路径", async () => {
    const target = path.join(base, "inside", "ok.txt");
    // 与 realpath 逐字比较不了：resolveRealPath 还要过一遍 normalizePath（盘符小写化），
    // 那是它与纯字符串版本共用归一的一部分，不是偏差。
    expect((await resolveRealPath(target)).toLowerCase()).toBe(
      (await realpath(target)).toLowerCase(),
    );
  });

  it("**不存在的路径**退回「最近的存在祖先」+ 剩余段 —— 新建文件因此照常放行", async () => {
    /*
      这条是「不能直接 realpath 失败就拒绝」的回归保护：新建文件的路径永远不存在，
      那样写等于禁掉写入。做法是向上找到最近的已存在祖先，对它 realpath，再拼回剩余段。
    */
    const missing = path.join(base, "inside", "nested", "brand-new", "deep", "file.txt");
    const resolved = await resolveRealPath(missing);
    // 祖先 inside/nested 存在且没有链接，所以结果就是它自己（只差盘符大小写归一）
    expect(resolved.endsWith(path.join("inside", "nested", "brand-new", "deep", "file.txt"))).toBe(
      true,
    );
  });

  it("整条路径都不存在时退化为纯字符串归一（不抛错）", async () => {
    const missing = path.join(base, "no-such-root", "a", "b");
    await expect(resolveRealPath(missing)).resolves.toContain("no-such-root");
  });
});

describe("validateRealPathAccess", () => {
  it("空 roots 一律拒绝（与 validatePathAccess 同款）", async () => {
    const result = await validateRealPathAccess(path.join(base, "inside", "ok.txt"), []);
    expect(result.ok).toBe(false);
  });

  it("根内的普通文件放行", async () => {
    const inside = path.join(base, "inside");
    const result = await validateRealPathAccess(path.join(inside, "ok.txt"), [inside]);
    expect(result.ok).toBe(true);
  });

  it("根外的路径拒绝", async () => {
    const inside = path.join(base, "inside");
    const result = await validateRealPathAccess(path.join(base, "secrets", "settings.json"), [
      inside,
    ]);
    expect(result.ok).toBe(false);
  });

  it("根内新建（还不存在）的路径放行", async () => {
    const inside = path.join(base, "inside");
    const result = await validateRealPathAccess(path.join(inside, "nested", "new", "x.md"), [
      inside,
    ]);
    expect(result.ok).toBe(true);
  });

  /*
    ⚠️ 这两条用**用例内 ctx.skip()** 而不是 `it.skipIf(...)`。
    `it.skipIf` 的判据在**收集阶段**求值 —— 那时 beforeAll 还没跑，标志还是初始的
    false，于是用例会被无条件跳过（实测踩过：看起来"环境不支持"，其实是判据求值太早）。
  */
  it("**指向禁区的目录符号链接被拒** —— 字面路径在根内，真实路径在根外", async (ctx) => {
    if (!dirLinkWorks) ctx.skip();

    const inside = path.join(base, "inside");
    const viaLink = path.join(inside, "link-dir", "settings.json");

    // 先确认这正是旧实现会放行的形状：**字面路径确实在根内**
    const { validatePathAccess } = await import("./path-guard");
    expect(validatePathAccess(viaLink, [inside]).ok).toBe(true);

    // 而 realpath 版本必须拒绝它 —— 这就是这一步的全部价值
    const result = await validateRealPathAccess(viaLink, [inside]);
    expect(result.ok).toBe(false);
  });

  it("指向禁区的文件符号链接同样被拒", async (ctx) => {
    if (!fileLinkWorks) ctx.skip();
    const inside = path.join(base, "inside");
    const result = await validateRealPathAccess(path.join(inside, "link-file.json"), [inside]);
    expect(result.ok).toBe(false);
  });
});
