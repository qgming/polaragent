// Markdown 工具
// src/lib/markdown.ts

/**
 * 把 markdown 文本转为纯文本：剥离常见 markdown 语法标记，只保留可读文字。
 * 用于「复制纯文本」按钮——粘贴到不支持 markdown 的地方时更干净。
 *
 * 处理范围（够用即可，非完整解析器）：
 *   - 代码围栏 ``` ``` 保留内部代码，去掉围栏与语言标注
 *   - 行内代码 `code` 去反引号
 *   - 标题 #、引用 >、列表符号 - * + / 有序号
 *   - 加粗/斜体/删除线 ** * __ _ ~~
 *   - 链接 [文本](url) -> 文本；图片 ![alt](url) -> alt
 *   - 表格分隔线 |---|，保留单元格文字、去管线
 *   - 多余空行压缩
 */
export function stripMarkdown(markdown: string): string {
  let text = markdown;

  // 代码围栏：去掉 ``` 行（含语言），保留中间内容
  text = text.replace(/^```[^\n]*\n?/gm, "").replace(/^```$/gm, "");

  // 图片 ![alt](url) -> alt（需在链接之前处理）
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  // 链接 [text](url) -> text
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");

  // 行内代码 `code` -> code
  text = text.replace(/`([^`]+)`/g, "$1");

  // 加粗/斜体/删除线
  text = text.replace(/(\*\*|__)(.*?)\1/g, "$2");
  text = text.replace(/(\*|_)(.*?)\1/g, "$2");
  text = text.replace(/~~(.*?)~~/g, "$1");

  // 处理逐行的块级标记
  text = text
    .split("\n")
    .map((line) => {
      let l = line;
      // 标题 #
      l = l.replace(/^\s{0,3}#{1,6}\s+/, "");
      // 引用 >
      l = l.replace(/^\s{0,3}>\s?/, "");
      // 无序列表 - * +
      l = l.replace(/^\s*[-*+]\s+/, "");
      // 有序列表 1. 2)
      l = l.replace(/^\s*\d+[.)]\s+/, "");
      // 表格行：去掉首尾管线，单元格用空格分隔
      if (/^\s*\|.*\|\s*$/.test(l)) {
        // 纯分隔行 |---|:---| 直接丢弃
        if (/^\s*\|[\s:|-]+\|\s*$/.test(l)) {
          return "";
        }
        l = l
          .replace(/^\s*\|/, "")
          .replace(/\|\s*$/, "")
          .split("|")
          .map((cell) => cell.trim())
          .join("  ");
      }
      return l;
    })
    .join("\n");

  // 水平分割线 --- *** ___ 整行丢弃
  text = text.replace(/^\s*([-*_])\1{2,}\s*$/gm, "");

  // 压缩 3 个以上连续换行为 2 个，并去首尾空白
  text = text.replace(/\n{3,}/g, "\n\n").trim();

  return text;
}
