// 文件预览窗口：从主窗口打开独立窗口预览/编辑文件
// src/lib/preview-window.ts

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
