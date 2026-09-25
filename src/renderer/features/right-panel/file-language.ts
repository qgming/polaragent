/**
 * 「这个文件在查看器里能怎么读」的判据：有没有渲染档、渲染档是哪一种、代码用什么语言高亮。
 *
 * 单独一个模块（而不是留在 `chat/turn-files.ts` 里）是因为它描述的是**文件类型**，
 * 不是某一轮的改动汇总，而现在有两个使用者 —— 单文件查看器与文件面板的预览。
 * 两处各写一份判据正是「同一个文件在两处长得不一样」的成因。
 *
 * 判据用扩展名而不是 MIME：`readFile` 只回路径与文本，不回 MIME；而且这里也不需要
 * 真正的类型探测 —— 判错的代价是「多一个点了没变化的切换按钮」或「少一次高亮」，
 * 不是读错文件。
 *
 * ## 渲染档是什么
 *
 *  - markdown 家族：渲染档 = 按文档排版（标题、表格、列表），源码档 = 原文；
 *  - 代码文件：渲染档 = **语法高亮**（只读），源码档 = 纯文本、可编辑；
 *  - 其余（.txt / .log / 无扩展名 / 未知扩展名）：只有源码一档。
 *
 * **纯文本刻意不进表**：给一个点了没变化的切换按钮比不给更糟（这条原则在本仓已有先例，
 * 见 job-tool-ui.test.tsx 的「不摆点了没反应的按钮」）。
 */

import { baseNameOf, extensionOf } from "@/renderer/features/chat/turn-files";

/** markdown 家族：这三者的渲染档都是「按文档排版」 */
const MARKDOWN_EXTENSIONS: ReadonlySet<string> = new Set(["md", "markdown", "mdx"]);

/**
 * 能语法高亮的扩展名 → shiki 语言 id。
 *
 * 值是**显式写死的 shiki 语言 id**，不是扩展名本身：两者常常不同（`tsx` → `tsx`，
 * 但 `h` → `c`、`m` → `objective-c`、`patch` → `diff`、`gradle` → `groovy`）。
 * 写错 id 不会报错，只会静默退回纯文本 —— 所以 file-language.test.ts 里有一条
 * 「每个值都必须是 shiki 认得的语言」的断言，专门拦这类笔误。
 *
 * 收录口径：开发工作区里常见的代码、配置与标记语言。数据文件（csv / tsv）不收 ——
 * 按表格上色对人没有帮助，那是「点了没变化」的另一种形态。
 */
const CODE_LANGUAGES: ReadonlyMap<string, string> = new Map([
  // JS / TS 家族
  ["ts", "typescript"],
  ["mts", "typescript"],
  ["cts", "typescript"],
  ["tsx", "tsx"],
  ["js", "javascript"],
  ["mjs", "javascript"],
  ["cjs", "javascript"],
  ["jsx", "jsx"],
  // 常见后端 / 系统语言
  ["py", "python"],
  ["rb", "ruby"],
  ["go", "go"],
  ["rs", "rust"],
  ["java", "java"],
  ["kt", "kotlin"],
  ["kts", "kotlin"],
  ["cs", "csharp"],
  ["php", "php"],
  ["swift", "swift"],
  ["scala", "scala"],
  ["dart", "dart"],
  ["c", "c"],
  ["h", "c"],
  ["cpp", "cpp"],
  ["cc", "cpp"],
  ["cxx", "cpp"],
  ["hpp", "cpp"],
  ["hh", "cpp"],
  ["m", "objective-c"],
  ["mm", "objective-c"],
  ["lua", "lua"],
  ["r", "r"],
  ["jl", "julia"],
  ["pl", "perl"],
  ["pm", "perl"],
  ["ex", "elixir"],
  ["exs", "elixir"],
  ["erl", "erlang"],
  ["hs", "haskell"],
  ["clj", "clojure"],
  ["cljs", "clojure"],
  ["zig", "zig"],
  ["nim", "nim"],
  ["sol", "solidity"],
  ["proto", "proto"],
  ["graphql", "graphql"],
  ["gql", "graphql"],
  ["elm", "elm"],
  ["fs", "fsharp"],
  ["vb", "vb"],
  ["coffee", "coffeescript"],
  // 脚本 / 终端
  ["sh", "bash"],
  ["bash", "bash"],
  ["zsh", "bash"],
  ["fish", "fish"],
  ["ps1", "powershell"],
  ["bat", "bat"],
  ["cmd", "bat"],
  ["awk", "awk"],
  // 配置与数据
  ["sql", "sql"],
  ["json", "json"],
  ["jsonc", "jsonc"],
  ["json5", "json5"],
  ["yaml", "yaml"],
  ["yml", "yaml"],
  ["toml", "toml"],
  ["ini", "ini"],
  ["properties", "properties"],
  ["xml", "xml"],
  ["svg", "xml"],
  ["hcl", "hcl"],
  ["tf", "terraform"],
  ["nix", "nix"],
  ["cmake", "cmake"],
  // 标记 / 样式 / 模板
  ["html", "html"],
  ["htm", "html"],
  ["css", "css"],
  ["scss", "scss"],
  ["less", "less"],
  ["vue", "vue"],
  ["svelte", "svelte"],
  ["astro", "astro"],
  ["pug", "pug"],
  ["tex", "tex"],
  // 构建 / 补丁 / 约定文件名
  ["dockerfile", "dockerfile"],
  ["makefile", "makefile"],
  ["groovy", "groovy"],
  ["gradle", "groovy"],
  ["diff", "diff"],
  ["patch", "diff"],
]);

/**
 * 没有扩展名的约定文件名 → shiki 语言 id。
 *
 * `Dockerfile` / `Makefile` 这类文件靠**名字本身**认，扩展名那一步（`extensionOf`）
 * 对它们返回空串。带扩展名的变体（`app.dockerfile`）走上面的表，两边都要有。
 */
const NAMED_FILES: ReadonlyMap<string, string> = new Map([
  ["dockerfile", "dockerfile"],
  ["makefile", "makefile"],
]);

/** 渲染档的两种形态 */
export type RenderedKind = "markdown" | "code";

/** 该文件的渲染档是哪一种；null = 没有渲染档（只有源码一档） */
export function renderedKindOf(path: string): RenderedKind | null {
  if (MARKDOWN_EXTENSIONS.has(extensionOf(path))) return "markdown";
  return languageOf(path) === null ? null : "code";
}

/**
 * 该文件高亮时该交给 shiki 的语言 id；不是已知的代码文件时为 null。
 *
 * 调用方不必再判 `renderedKindOf === "code"` —— 两者查的是同一张表。
 */
export function languageOf(path: string): string | null {
  return (
    CODE_LANGUAGES.get(extensionOf(path)) ?? NAMED_FILES.get(baseNameOf(path).toLowerCase()) ?? null
  );
}
