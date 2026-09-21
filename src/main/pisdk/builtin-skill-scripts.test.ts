// 内置技能自带的脚本：解压安全与 HTML 转换的单测。
//
// **为什么这些脚本需要单测**：它们是随包分发的**可执行代码**，
// 模型会直接 `node scripts/xxx.mjs` 跑它们。而技能目录里没有任何类型检查或构建步骤覆盖，
// 这里是唯一的自动化防线。
//
// 重点是 `writeEntrySafely` 的**路径穿越防护**：tar 的条目名可以是 `../x`，
// 直接 join 再写就等于把任意文件写到盘上任意位置。Python 上游靠
// `tarfile.extractall(filter="data")`，Node 没有对应内建 —— 只能自己挡，
// 所以必须有测试证明那道挡真的在（已验证：拆掉防护这条测试会红）。
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";

/**
 * 导入要测的脚本。
 *
 * 这些 `.mjs` 是**随包分发的资源**，不在 tsconfig 的 include 范围内，所以没有类型声明。
 * 用**变量拼接**路径来 import 是刻意的：写成字面量时 TypeScript 会去解析那个模块并报
 * TS7016（「找不到声明文件」），而 `@ts-expect-error` 对它不生效
 *（它作用于下一个表达式，模块解析错误却在整条 import 语句上）。
 * 拼成变量后 TS 无法静态解析，于是交给下面的 `as` 断言 ——
 * 类型在这里本来也没价值：被测对象是纯 JavaScript，我们只关心运行时行为。
 */
const scriptPath = "../../../resources/skills/super-research/scripts/fetch_paper.mjs";
const scriptModule = (await import(/* @vite-ignore */ scriptPath)) as {
  extractTarGz: (raw: Buffer) => { name: string; data: Buffer; isDirectory: boolean }[] | null;
  writeEntrySafely: (outDir: string, name: string, data: Buffer) => void;
  htmlToText: (page: string) => string;
};
const { extractTarGz, writeEntrySafely, htmlToText } = scriptModule;

/** 手工构造一个 tar 条目（512 字节头 + 数据补齐到 512 的倍数） */
function tarEntry(name: string, content: string): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write("0000644\0", 100, 8, "utf8");
  header.write("0000000\0", 108, 8, "utf8");
  header.write("0000000\0", 116, 8, "utf8");
  header.write(`${content.length.toString(8).padStart(11, "0")}\0`, 124, 12, "utf8");
  header.write("00000000000\0", 136, 12, "utf8");
  header.write("        ", 148, 8, "utf8");
  header.write("0", 156, 1, "utf8");
  header.write("ustar\0", 257, 6, "utf8");
  const data = Buffer.from(content, "utf8");
  const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512);
  data.copy(padded);
  return Buffer.concat([header, padded]);
}

describe("fetch_paper 的 tar 解压", () => {
  it("能解出 tar.gz 里的多个条目", () => {
    const archive = gzipSync(
      Buffer.concat([tarEntry("a.tex", "AAA"), tarEntry("src/b.tex", "BBB")]),
    );
    const entries = extractTarGz(archive);
    expect(entries).not.toBeNull();
    if (entries === null) throw new Error("unreachable");
    expect(entries.map((entry) => entry.name)).toEqual(["a.tex", "src/b.tex"]);
    expect(entries[0]?.data.toString("utf8")).toBe("AAA");
  });

  it("不是 tar 时返回 null（交给单文件分支处理）", () => {
    expect(extractTarGz(Buffer.from("not a tar at all"))).toBeNull();
  });

  /**
   * **路径穿越防护。**
   *
   * tar 里的条目名可以是 `../PWNED.txt`，直接 join 再写就等于把任意文件写到盘上任意位置。
   * Python 那边靠 `tarfile.extractall(filter="data")`，Node 没有对应内建 —— 只能自己挡。
   * 这条测试就是那道防线的证明。
   */
  it("越界条目被跳过，不写到 outDir 之外", () => {
    const root = mkdtempSync(path.join(tmpdir(), "oint-tar-"));
    const outDir = path.join(root, "out");

    writeEntrySafely(outDir, "good.tex", Buffer.from("ok"));
    writeEntrySafely(outDir, "../PWNED.txt", Buffer.from("should never land"));

    expect(readdirSync(outDir)).toEqual(["good.tex"]);
    expect(readFileSync(path.join(outDir, "good.tex"), "utf8")).toBe("ok");
    // 关键：越界文件根本不存在
    expect(() => readFileSync(path.join(root, "PWNED.txt"), "utf8")).toThrow();
  });

  it("绝对路径条目也被挡住", () => {
    const root = mkdtempSync(path.join(tmpdir(), "oint-tar2-"));
    const outDir = path.join(root, "out");
    writeEntrySafely(outDir, path.join(root, "absolute.txt"), Buffer.from("nope"));
    expect(() => readFileSync(path.join(root, "absolute.txt"), "utf8")).toThrow();
  });
});

describe("htmlToText", () => {
  it("去掉脚本样式，块级标签保留段落边界", () => {
    const html = `<html><head><style>p{color:red}</style></head>
      <body><h1>标题</h1><p>第一段</p><p>第二段</p>
      <script>alert(1)</script></body></html>`;
    const text = htmlToText(html);
    expect(text).toContain("标题");
    expect(text).toContain("第一段");
    expect(text).not.toContain("alert");
    expect(text).not.toContain("color:red");
    // 段落之间要有换行，不能挤成一行
    expect(text.split("\n").filter((line: string) => line.trim() !== "").length).toBeGreaterThan(1);
  });

  it("解码实体（否则正文里会出现 &amp; 这类噪声）", () => {
    expect(htmlToText("<p>a &amp; b &lt;c&gt; &#65;</p>")).toContain("a & b <c> A");
  });
});
