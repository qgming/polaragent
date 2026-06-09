// 按文件扩展名/类型映射图标 —— 产物面板与工作区文件树共用
// src/lib/file-icons.tsx
//
// 提供 fileIconFor(name)：根据文件名后缀返回合适的 lucide 图标组件。
// 仅按格式区分图标字形，不做彩色处理——着色统一由调用处用中性灰。

import {
  File as FileIcon,
  FileAudio,
  FileCode,
  FileCog,
  FileImage,
  FileJson,
  FileText,
  FileType,
  type LucideIcon,
} from "lucide-react";

// 从文件名取小写扩展名（无扩展名返回空串）
function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

// 扩展名 -> 图标组件
const EXT_MAP: Record<string, LucideIcon> = {
  // Markdown / 纯文本 / 日志
  md: FileText,
  markdown: FileText,
  mdx: FileText,
  txt: FileText,
  log: FileText,
  csv: FileText,
  // 网页
  html: FileType,
  htm: FileType,
  xml: FileType,
  // 样式
  css: FileCode,
  scss: FileCode,
  less: FileCode,
  // 数据 / 配置
  json: FileJson,
  yaml: FileCog,
  yml: FileCog,
  toml: FileCog,
  ini: FileCog,
  // 代码
  js: FileCode,
  jsx: FileCode,
  ts: FileCode,
  tsx: FileCode,
  py: FileCode,
  rs: FileCode,
  go: FileCode,
  java: FileCode,
  c: FileCode,
  cpp: FileCode,
  h: FileCode,
  sh: FileCode,
  // 图片
  png: FileImage,
  jpg: FileImage,
  jpeg: FileImage,
  gif: FileImage,
  svg: FileImage,
  webp: FileImage,
  ico: FileImage,
  // 音频
  mp3: FileAudio,
  wav: FileAudio,
  ogg: FileAudio,
  webm: FileAudio,
  m4a: FileAudio,
  aac: FileAudio,
  flac: FileAudio,
  opus: FileAudio,
};

/** 根据文件名返回图标组件（未知类型回退通用文件图标） */
export function fileIconFor(name: string): LucideIcon {
  return EXT_MAP[extOf(name)] ?? FileIcon;
}
