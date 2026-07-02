import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { PreviewWindow } from "./components/PreviewWindow";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./index.css";

// 导入并等待 i18n 模块加载（同步导入会阻塞，确保 i18n 先初始化）
import "./i18n";

// 按 URL 参数分发窗口角色:
//   ?view=preview&path=<文件路径>  -> 文件预览窗口
//   其它                          -> 主应用窗口
const params = new URLSearchParams(window.location.search);
const view = params.get("view");
const previewPath = params.get("path") ?? "";

// 获取 root 元素
const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error(
    "致命错误：找不到 id='root' 的 DOM 元素。请检查 index.html 文件。",
  );
}

// 创建 React root 并渲染应用
const root = ReactDOM.createRoot(rootElement);

root.render(
  <React.StrictMode>
    <ErrorBoundary>
      {view === "preview" ? (
        <PreviewWindow filePath={previewPath} />
      ) : (
        <App />
      )}
    </ErrorBoundary>
  </React.StrictMode>,
);
