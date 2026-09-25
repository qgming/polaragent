// 写回通道（main/files/service.ts 的 writeFileContent）的安全与原子性回归测试。
//
// 这个文件存在的理由有两条：
//  1. **写盘的守卫必须是 realpath 版**。读侧刻意保留了纯字符串判断（见 service.ts 的文件头
//     注释：读错最多是看到不该看的，且与模型侧口径一致），但同一个盲区在写盘上是真实损害 ——
//     root 内的一个符号链接指向外部时，字面路径放行、实际落点却在面板的工作目录之外。
//  2. **失败不能毁掉用户文件**：先写同目录临时文件再 rename，失败时临时文件也不许留下。
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizePath } from "@/main/security/path-guard";
import { writeFileContent } from "./service";

/**
 * 注入 rename 失败。
 *
 * **为什么靠 mock 而不是找一条真会失败的路径**：服务层已经把「目标是目录 / 内容超上限 /
 * 目标本身是二进制」这些会自然失败的形状提前挡在外面了，所以想走到 rename 那一步失败，
 * 只能人为让它抛。注入的失败点正好是**临时文件已经写出来之后**——那才是要验证的中间状态。
 */
const failRename = vi.hoisted(() => ({ enabled: false }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      if (failRename.enabled) throw new Error("EPERM: simulated rename failure");
      return actual.rename(from, to);
    },
  };
});

let root: string;
/** root 的兄弟目录：位于工作目录之外，用来验证越界写入被拒 */
let outside: string;

/** 读侧 MAX_FILE_BYTES 的同一个数（512 KiB），写回上限跟它对齐 */
const WRITE_LIMIT = 512 * 1024;

async function tempFiles(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((name) => name.endsWith(".tmp"));
}

beforeEach(async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "oint-write-"));
  root = path.join(base, "project");
  outside = path.join(base, "outside");
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(root, "note.md"), "# 旧标题\n", "utf8");
  await writeFile(path.join(outside, "secret.txt"), "secret\n", "utf8");
  failRename.enabled = false;
});

afterEach(async () => {
  await rm(path.dirname(root), { recursive: true, force: true });
});

describe("正常写回", () => {
  it("覆盖已有文件，返回落盘路径与字节数，且不留临时文件", async () => {
    const target = path.join(root, "note.md");
    const result = await writeFileContent({ root, path: target, text: "# 新标题\n" });

    expect(result.path).toBe(normalizePath(target));
    expect(result.bytes).toBe(Buffer.byteLength("# 新标题\n", "utf8"));
    expect(await readFile(target, "utf8")).toBe("# 新标题\n");
    expect(await tempFiles(root)).toEqual([]);
  });

  it("清空文件是合法操作（bytes 为 0）", async () => {
    const target = path.join(root, "note.md");
    const result = await writeFileContent({ root, path: target, text: "" });

    expect(result.bytes).toBe(0);
    expect((await stat(target)).size).toBe(0);
  });

  it("**行尾符原样落盘**：CRLF 不会被转成 LF", async () => {
    const target = path.join(root, "crlf.txt");
    await writeFile(target, "a\r\nb\r\n", "utf8");

    await writeFileContent({ root, path: target, text: "a\r\nB\r\n" });

    expect(await readFile(target, "utf8")).toBe("a\r\nB\r\n");
  });

  it("目标不存在时按新建处理（同目录内的新文件名）", async () => {
    const target = path.join(root, "created.txt");
    const result = await writeFileContent({ root, path: target, text: "hello" });

    expect(result.path).toBe(normalizePath(target));
    expect(await readFile(target, "utf8")).toBe("hello");
  });
});

describe("路径守卫（写盘用 realpath 版）", () => {
  it("root 之外的路径被拒，且目标文件一个字都没变", async () => {
    const victim = path.join(outside, "secret.txt");
    await expect(writeFileContent({ root, path: victim, text: "pwned" })).rejects.toThrow(
      /不在允许的工作目录内/,
    );
    expect(await readFile(victim, "utf8")).toBe("secret\n");
  });

  it("用 `..` 从工作目录爬到兄弟目录同样被拒", async () => {
    const viaParent = path.join(root, "..", "outside", "secret.txt");
    await expect(writeFileContent({ root, path: viaParent, text: "pwned" })).rejects.toThrow(
      /不在允许的工作目录内/,
    );
    expect(await readFile(path.join(outside, "secret.txt"), "utf8")).toBe("secret\n");
  });

  it("错误文案里不出现绝对路径（它会原样显示给用户）", async () => {
    const victim = path.join(outside, "secret.txt");
    let message = "";
    await writeFileContent({ root, path: victim, text: "pwned" }).catch((failure: unknown) => {
      // 与渲染层同款：拿到的就是最终要显示给人的那一句
      message = failure instanceof Error ? failure.message : String(failure);
    });

    expect(message).not.toBe("");
    expect(message).not.toContain(outside);
    expect(message).not.toContain(victim);
  });

  /**
   * 符号链接逃逸。**这是写盘必须用 realpath 守卫的全部理由**：
   * 链接的字面路径在 root 内，纯字符串判断会放行，而记录实际落在禁区。
   *
   * 用 `ctx.skip()` 而不是 `it.skipIf`：后者的判据在**收集阶段**求值，那时 beforeAll
   * 还没跑（path-guard.realpath.test.ts 里踩过这个坑）。
   */
  it("root 内指向外部的目录符号链接被拒，链接另一侧的文件未被改动", async (ctx) => {
    const link = path.join(root, "link-dir");
    try {
      await symlink(outside, link, "junction");
    } catch {
      ctx.skip();
      return;
    }

    await expect(
      writeFileContent({ root, path: path.join(link, "secret.txt"), text: "pwned" }),
    ).rejects.toThrow(/不在允许的工作目录内/);
    expect(await readFile(path.join(outside, "secret.txt"), "utf8")).toBe("secret\n");
  });

  it("root 内指向外部的文件符号链接被拒，被指向的文件未被改动", async (ctx) => {
    const link = path.join(root, "link-file.txt");
    try {
      await symlink(path.join(outside, "secret.txt"), link, "file");
    } catch {
      ctx.skip();
      return;
    }

    await expect(writeFileContent({ root, path: link, text: "pwned" })).rejects.toThrow(
      /不在允许的工作目录内/,
    );
    expect(await readFile(path.join(outside, "secret.txt"), "utf8")).toBe("secret\n");
  });

  it("**经目录链接新建**文件也被拒（目标不存在时守卫仍要追到真实祖先）", async (ctx) => {
    // 这是写盘特有的形状：读侧只能读已经存在的东西，而写侧会「经过一个指向外部的
    // 目录链接新建文件」——resolveRealPath 逐级向上找最近的存在祖先，正是为它写的。
    const link = path.join(root, "link-dir");
    try {
      await symlink(outside, link, "junction");
    } catch {
      ctx.skip();
      return;
    }

    await expect(
      writeFileContent({ root, path: path.join(link, "created.txt"), text: "pwned" }),
    ).rejects.toThrow(/不在允许的工作目录内/);
    expect(await readdir(outside)).toEqual(["secret.txt"]);
  });

  it("指向 root 内部的链接放行，写的是它指向的那个文件（链接本身不被替掉）", async (ctx) => {
    const real = path.join(root, "real.txt");
    const link = path.join(root, "alias.txt");
    await writeFile(real, "旧内容", "utf8");
    try {
      await symlink(real, link, "file");
    } catch {
      ctx.skip();
      return;
    }

    const result = await writeFileContent({ root, path: link, text: "新内容" });

    // 返回的是解析后的真实路径；链接还在，且它指向的内容变了
    expect(result.path).toBe(normalizePath(real));
    expect(await readFile(real, "utf8")).toBe("新内容");
    // lstat 而不是 stat：后者会跟穿链接，看不见「链接本身」
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
  });
});

describe("拒绝写入的形状", () => {
  it("目标是目录", async () => {
    const dir = path.join(root, "sub");
    await mkdir(dir);
    await expect(writeFileContent({ root, path: dir, text: "x" })).rejects.toThrow(/目录/);
  });

  it("内容是二进制（含 NUL）", async () => {
    const target = path.join(root, "note.md");
    await expect(writeFileContent({ root, path: target, text: "text\u0000more" })).rejects.toThrow(
      /不是纯文本/,
    );
    // 被拒之后原文件必须一字未动
    expect(await readFile(target, "utf8")).toBe("# 旧标题\n");
  });

  it("内容是二进制（含替换字符 U+FFFD）", async () => {
    await expect(
      writeFileContent({ root, path: path.join(root, "note.md"), text: "text\uFFFDmore" }),
    ).rejects.toThrow(/不是纯文本/);
  });

  it("目标文件本身是二进制时也拒（读侧给不出可编辑内容，保存等于清空它）", async () => {
    const target = path.join(root, "logo.png");
    const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x00, 0x1a, 0x0a]);
    await writeFile(target, binary);

    await expect(writeFileContent({ root, path: target, text: "x" })).rejects.toThrow(/二进制/);
    expect(await readFile(target)).toEqual(binary);
  });

  it("待写内容超过 512 KiB 上限", async () => {
    await expect(
      writeFileContent({
        root,
        path: path.join(root, "note.md"),
        text: "x".repeat(WRITE_LIMIT + 1),
      }),
    ).rejects.toThrow(/超过 512 KB/);
  });

  it("目标文件本身超过 512 KiB（读侧只给得出开头，保存会截断它）", async () => {
    const target = path.join(root, "big.log");
    await writeFile(target, "x".repeat(WRITE_LIMIT + 1), "utf8");

    await expect(writeFileContent({ root, path: target, text: "小内容" })).rejects.toThrow(
      /超过 512 KB/,
    );
    expect((await stat(target)).size).toBe(WRITE_LIMIT + 1);
  });

  it("新建文件的父目录不存在", async () => {
    await expect(
      writeFileContent({ root, path: path.join(root, "no-such-dir", "x.txt"), text: "x" }),
    ).rejects.toThrow(/目录不存在/);
  });

  it("缺少 path / text 时给出可读消息，而不是裸的类型错误", async () => {
    await expect(writeFileContent({ root, path: "", text: "x" })).rejects.toThrow(/缺少/);
    await expect(
      writeFileContent({ root, path: path.join(root, "note.md"), text: undefined as never }),
    ).rejects.toThrow(/缺少/);
  });
});

describe("原子写失败后原文件未被破坏", () => {
  it("rename 失败：旧内容原样保留，且不留临时文件", async () => {
    const target = path.join(root, "note.md");
    failRename.enabled = true;

    await expect(writeFileContent({ root, path: target, text: "# 新标题\n" })).rejects.toThrow();
    // 关键断言两条：内容还是旧的（不是半截新内容），目录里没有 .tmp 垃圾
    expect(await readFile(target, "utf8")).toBe("# 旧标题\n");
    expect(await tempFiles(root)).toEqual([]);
  });

  it("临时文件写不出来时（文件名过长）同样不动原文件", async () => {
    // 文件名贴着 255 字节的组件上限：原文件建得出来，而它 + `<pid>.<ts>.tmp` 的临时名建不出来
    const target = path.join(root, `${"a".repeat(248)}.txt`);
    await writeFile(target, "旧内容", "utf8");

    await expect(writeFileContent({ root, path: target, text: "新内容" })).rejects.toThrow();
    expect(await readFile(target, "utf8")).toBe("旧内容");
  });
});
