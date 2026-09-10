import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { installIpcFetch } from "./lib/electron/electron-api";
import "./index.css";

// 渲染进程启动时把全局 fetch 替换为主进程 ipcFetch：
// openai / anthropic SDK 等直接调 globalThis.fetch，不走 options.fetch，
// 必须全局替换才能与「设置测试」一样经主进程出网，绕开 CORS。
installIpcFetch();

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error(
    "致命错误：找不到 id='root' 的 DOM 元素。请检查 index.html 文件。",
  );
}

const root = ReactDOM.createRoot(rootElement);

root.render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
