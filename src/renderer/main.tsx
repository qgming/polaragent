import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../index.css";
import { App } from "./app/App";
import "./i18n";
import { useChatStore } from "./stores/chat-store";

const container = document.getElementById("root");
if (!container) {
  throw new Error("未找到 #root 容器");
}

/**
 * dev 专用的 store 出口：只给 scripts/probe-*.mjs 这类探针在真实 Electron 里
 * 注入会话数据用（布局类断言需要界面先有内容才能量像素）。
 * `import.meta.env.DEV` 在生产构建里是常量 false，整块会被摇掉，不进产物。
 */
if (import.meta.env.DEV) {
  (window as unknown as { __ointChatStore?: unknown }).__ointChatStore = useChatStore;
}

// i18n 通过副作用导入完成初始化，再挂载应用避免首帧缺翻译
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
