import React from "react";
import ReactDOM from "react-dom/client";
import "./i18n"; // 必须在 App 之前导入，确保 i18next 在 react-i18next 之前就绪
import App from "./App";
import { PreviewWindow } from "./components/PreviewWindow";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./index.css";

// 按 URL 参数分发窗口角色：
//   ?view=preview&path=<文件路径>  -> 文件预览窗口
//   其它                          -> 主应用窗口
const params = new URLSearchParams(window.location.search);
const view = params.get("view");
const previewPath = params.get("path") ?? "";

const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);

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
