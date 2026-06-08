// Markdown 渲染组件映射 —— ChatPage 与 PreviewWindow 共用
// src/lib/markdown-components.tsx
//
// Tailwind Typography 负责基础排版；这里仅保留产品特化渲染。
// 块级代码复用 CodeBlock，流式 mermaid 暂按代码显示，表格外层可横向滚动。
// 工厂函数：streaming 时 mermaid 暂按代码块显示，生成完成后才渲染成图。

import type { Components } from "react-markdown";
import type { MouseEvent } from "react";
import { CodeBlock } from "@/components/markdown/CodeBlock";
import { MermaidDiagram } from "@/components/markdown/MermaidDiagram";
import { isElectronRuntime, openExternal } from "@/lib/electron/electron-api";

function isHttpUrl(href: string): boolean {
  return /^https?:\/\//i.test(href);
}

export function createMarkdownComponents(streaming: boolean): Components {
  return {
    pre({ children }) {
      return <>{children}</>;
    },
    // 块级代码走 CodeBlock（带复制按钮），行内代码用浅底胶囊样式
    code({ className, children, ...rest }) {
      const match = /language-(\w+)/.exec(className || "");
      const isBlock = Boolean(className);
      const code = String(children).replace(/\n$/, "");
      const language = match ? match[1] : "text";

      if (isBlock && code) {
        // mermaid 代码块：完成后渲染成图；流式过程中先按代码块显示原文
        if (language === "mermaid" && !streaming) {
          return <MermaidDiagram code={code} />;
        }
        return <CodeBlock code={code} language={language} />;
      }
      return (
        <code
          className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em] text-foreground"
          {...rest}
        >
          {children}
        </code>
      );
    },
    a: ({ children, href }) => {
      const handleClick = (e: MouseEvent<HTMLAnchorElement>) => {
        if (!href || !isElectronRuntime() || !isHttpUrl(href)) return;
        e.preventDefault();
        void openExternal(href);
      };

      return (
        <a
          href={href}
          onClick={handleClick}
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent-foreground underline-offset-2 hover:underline"
        >
          {children}
        </a>
      );
    },
    // GFM 表格：外层加横向滚动，避免宽表撑破布局
    table: ({ children }) => (
      <div className="app-scrollbar my-3 overflow-x-auto">
        <table>{children}</table>
      </div>
    ),
  };
}
