// 文件预览：类型判定/渲染分类 + 打开独立预览窗口
// src/lib/preview.ts
//
// 扩展名分类部分为纯函数、无副作用，可在主窗口与预览窗口安全引用；
// openPreviewWindow 含 Electron 窗口副作用，仅主窗口调用。

// 预览窗口的内容渲染类别
export type PreviewKind = "markdown" | "html" | "image" | "code" | "unsupported";

// 各类别对应的扩展名集合
const MARKDOWN_EXTS = new Set(["md", "markdown", "mdx"]);
const HTML_EXTS = new Set(["html", "htm"]);
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "ico", "bmp"]);
// 纯文本/代码：用代码高亮展示
const CODE_EXTS = new Set([
  "txt",
  "log",
  "csv",
  "json",
  "yaml",
  "yml",
  "toml",
  "ini",
  "xml",
  "css",
  "scss",
  "less",
  "js",
  "jsx",
  "ts",
  "tsx",
  "py",
  "rs",
  "go",
  "java",
  "c",
  "cpp",
  "h",
  "sh",
  "rb",
  "php",
  "sql",
  "env",
]);

// 从文件名/路径取小写扩展名（无扩展名返回空串）
export function extOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "";
  return base.slice(dot + 1).toLowerCase();
}

/** 根据文件名/路径返回预览渲染类别 */
export function previewKindOf(name: string): PreviewKind {
  const ext = extOf(name);
  if (MARKDOWN_EXTS.has(ext)) return "markdown";
  if (HTML_EXTS.has(ext)) return "html";
  if (IMAGE_EXTS.has(ext)) return "image";
  if (CODE_EXTS.has(ext)) return "code";
  return "unsupported";
}

/** 是否为可在预览窗口打开的文件类型 */
export function isPreviewable(name: string): boolean {
  return previewKindOf(name) !== "unsupported";
}

/** 类别对应的人类可读标签（标题栏右侧展示用） */
export function previewKindLabel(kind: PreviewKind, ext: string): string {
  switch (kind) {
    case "markdown":
      return "Markdown";
    case "html":
      return "HTML";
    case "image":
      return "Image";
    case "code":
      return ext ? ext.toUpperCase() : "Text";
    default:
      return "File";
  }
}

/**
 * 打开（或聚焦已存在的）文件预览窗口。
 * - 同一文件路径复用同一窗口：已存在则置顶聚焦，不重复创建。
 * - 路径经 URL 参数传入预览窗口的前端入口（main.tsx 据此分发渲染）。
 */
export async function openPreviewWindow(path: string): Promise<void> {
  if (!path || !window.polaragent) {
    return;
  }

  await window.polaragent.preview.open(path);
}
