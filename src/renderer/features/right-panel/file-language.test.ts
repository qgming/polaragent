/**
 * 「这个文件能怎么读」的测试。
 *
 * 钉住三件事：
 *   1. markdown 家族有渲染档，而且是**排版**那一种；
 *   2. 代码文件也有渲染档（用户要求），而且是**高亮**那一种 —— 早先它只有源码一档；
 *   3. 纯文本（.txt / .log / 无扩展名）**没有**渲染档：给一个点了没变化的切换按钮
 *      比不给更糟（这条原则在本仓已有先例，见 job-tool-ui.test.tsx）。
 *
 * 最后一条用例是防笔误的：语言 id 写错不会报错，只会静默退回纯文本 ——
 * 界面上表现为「切换按钮点了没变化」，而那正是上面第 3 条要避免的东西。
 */

// 直接问 shiki 要语言清单：手抄一份「合法 id 表」等于把同一个事实写两遍，
// 而漂移的表现是「某个扩展名悄悄不高亮了」。react-shiki 用的就是这个包的全量 bundle。
import { bundledLanguages } from "shiki";
import { describe, expect, it } from "vitest";
import { languageOf, renderedKindOf } from "./file-language";

describe("renderedKindOf", () => {
  it("markdown 家族按文档排版", () => {
    expect(renderedKindOf("notes.md")).toBe("markdown");
    expect(renderedKindOf("D:/proj/README.MARKDOWN")).toBe("markdown");
    expect(renderedKindOf("docs/guide.mdx")).toBe("markdown");
  });

  it("代码文件有渲染档，且是语法高亮那一种", () => {
    expect(renderedKindOf("src/a.ts")).toBe("code");
    expect(renderedKindOf("src/a.tsx")).toBe("code");
    expect(renderedKindOf("scripts/build.py")).toBe("code");
    expect(renderedKindOf("C:/proj/Main.java")).toBe("code");
    expect(renderedKindOf("styles/app.css")).toBe("code");
    expect(renderedKindOf("conf/app.yaml")).toBe("code");
    expect(renderedKindOf("package.json")).toBe("code");
  });

  it("没有扩展名的约定文件（Dockerfile / Makefile）也算代码", () => {
    expect(renderedKindOf("Dockerfile")).toBe("code");
    expect(renderedKindOf("D:/proj/Makefile")).toBe("code");
    expect(languageOf("Dockerfile")).toBe("dockerfile");
  });

  it("纯文本没有渲染档", () => {
    expect(renderedKindOf("notes.txt")).toBeNull();
    expect(renderedKindOf("run.log")).toBeNull();
    expect(renderedKindOf("LICENSE")).toBeNull();
    expect(renderedKindOf(".gitignore")).toBeNull();
    expect(renderedKindOf("data.csv")).toBeNull();
  });
});

describe("languageOf", () => {
  it("扩展名与 shiki 语言 id 不同时也能对上", () => {
    // 这几个是「按扩展名直接当 id 用会静默退回纯文本」的典型
    expect(languageOf("include/a.h")).toBe("c");
    expect(languageOf("a.hpp")).toBe("cpp");
    expect(languageOf("fix.patch")).toBe("diff");
    expect(languageOf("build.gradle")).toBe("groovy");
    expect(languageOf("a.htm")).toBe("html");
    expect(languageOf("icon.svg")).toBe("xml");
    expect(languageOf("a.ex")).toBe("elixir");
  });

  it("不是代码文件时为 null", () => {
    expect(languageOf("notes.md")).toBeNull();
    expect(languageOf("notes.txt")).toBeNull();
  });

  it("表里每个语言 id 都是 shiki 认得的 —— 写错只会静默退回纯文本", () => {
    const unknown = new Set<string>();
    // 逐个扩展名问一遍：表本身不对外暴露，这里用真实文件名的形态覆盖到每一项
    for (const extension of CODE_EXTENSIONS_IN_TEST) {
      const language = languageOf(`file.${extension}`);
      if (language === null) unknown.add(`${extension}（表里没有）`);
      else if (!Object.hasOwn(bundledLanguages, language))
        unknown.add(`${extension} → ${language}`);
    }
    expect([...unknown]).toEqual([]);
  });
});

/**
 * 测试里单独抄一份扩展名清单，是刻意的：它让「表被误删一项」也变成红。
 * 与 file-language.ts 的 CODE_LANGUAGES 同源，两边都要能过上面那条断言。
 */
const CODE_EXTENSIONS_IN_TEST = [
  "ts",
  "mts",
  "cts",
  "tsx",
  "js",
  "mjs",
  "cjs",
  "jsx",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "kts",
  "cs",
  "php",
  "swift",
  "scala",
  "dart",
  "c",
  "h",
  "cpp",
  "cc",
  "cxx",
  "hpp",
  "hh",
  "m",
  "mm",
  "lua",
  "r",
  "jl",
  "pl",
  "pm",
  "ex",
  "exs",
  "erl",
  "hs",
  "clj",
  "cljs",
  "zig",
  "nim",
  "sol",
  "proto",
  "graphql",
  "gql",
  "elm",
  "fs",
  "vb",
  "coffee",
  "sh",
  "bash",
  "zsh",
  "fish",
  "ps1",
  "bat",
  "cmd",
  "awk",
  "sql",
  "json",
  "jsonc",
  "json5",
  "yaml",
  "yml",
  "toml",
  "ini",
  "properties",
  "xml",
  "svg",
  "hcl",
  "tf",
  "nix",
  "cmake",
  "html",
  "htm",
  "css",
  "scss",
  "less",
  "vue",
  "svelte",
  "astro",
  "pug",
  "tex",
  "dockerfile",
  "makefile",
  "groovy",
  "gradle",
  "diff",
  "patch",
];
