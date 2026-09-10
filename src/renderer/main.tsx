import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../index.css";
import { App } from "./app/App";
import "./i18n";

const container = document.getElementById("root");
if (!container) {
  throw new Error("未找到 #root 容器");
}

// i18n 通过副作用导入完成初始化，再挂载应用避免首帧缺翻译
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
