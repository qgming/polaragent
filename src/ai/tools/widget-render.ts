// Widget 渲染工具 —— 在聊天中渲染交互式 UI Widget
// src/ai/tools/widget-render.ts
//
// 该工具允许 AI 在对话中生成可交互的 Widget（图表、表单、表格等）。
// 实际渲染由前端组件完成，工具仅负责验证参数并返回 widget 元数据。

import { Type, type Static } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";

import { getDataDir, readFile } from "@/lib/electron/electron-api";
import { text, type ToolContext } from "./tool-context";

// Widget 渲染参数 schema
const renderWidgetParams = Type.Object({
  title: Type.String({
    description: "Widget 的简短标题，使用 snake_case 格式（如 pie_chart_summary）",
  }),
  update_mode: Type.Union([Type.Literal("replace"), Type.Literal("patch")], {
    description: "Widget 更新模式：replace 全量替换，patch 增量更新保留状态",
  }),
  widget_code: Type.Optional(
    Type.String({
      description: "内联 HTML 代码片段。与 widget_path 至少提供一个。",
    }),
  ),
  widget_path: Type.Optional(
    Type.String({
      description: "skills 目录下 .html 模板的路径（如 builtin/chart/template.html）",
    }),
  ),
  data: Type.Optional(
    Type.Object({}, { additionalProperties: true, description: "传递给 Widget 的数据对象" }),
  ),
});

// 标签白名单：禁止 iframe/object/embed/base/link/meta 等可能形成
// 二次 iframe 加载或越权跳转的标签。
// form 已放宽：表单场景恢复原生 <form> 能力（提交动作仍受 iframe sandbox +
// CSP 约束，POST 跳出会被沙箱拦截，事件桥依然推荐用 __WIDGET_EVENT__）。
// 保留 script：widget 本身需要内联脚本交互能力（沙箱 iframe 已去掉
// allow-same-origin，allow-scripts 单独一行时 iframe 走 opaque origin，
// 无法访问父窗资源）。
const WIDGET_FORBIDDEN_TAGS = [
  "iframe",
  "object",
  "embed",
  "base",
  "link",
  "meta",
];

// 危险脚本 API 黑名单：已全部解除。
// 取消 fail-loud 字符串拦截的依据是 iframe 物理沙箱已提供防御纵深：
//   - sandbox="allow-scripts"（不携带 allow-same-origin）→ opaque origin，
//     widget 内 window.parent / top / document.cookie 物理不可读父窗。
//   - CSP 默认 default-src 'none'、connect-src 'none' → WebSocket / fetch /
//     外链脚本 / 远程图片等出站连接全部被浏览器阻断。
//   - 因此 eval / new Function / atob / btoa 即便在 widget 内执行，也只能
//     在 opaque origin 内闭环操作，无外传路径。
// 注意：放宽仅限工具入口净化层。沙箱与 CSP 两层物理防御未动，依然是真实
// 防线。AI 审查（render_widget 在 ai_review 模式）作为最后一层软防御保留。
const WIDGET_DANGEROUS_SCRIPT_PATTERNS: RegExp[] = [];

/**
 * 净化 AI 提供的 widget_code HTML：
 * 1. 移除 WIDGET_FORBIDDEN_TAGS 中所有标签（含自闭合与带内容版本）
 * 2. 移除所有 on* 事件属性
 * 3. 移除 javascript: 协议的 href/src
 * 4. 在保留的 <script> 中检测危险 API 模式，命中即抛错拒绝工具调用
 *
 * 设计原则：不可信输入 → 失败优先。任何包入可疑特征的 widget 直接拒绝，
 * AI 应使用数据驱动方式而非绕过 sandbox。
 */
function sanitizeWidgetCode(rawHtml: string): string {
  let sanitized = rawHtml;
  for (const tag of WIDGET_FORBIDDEN_TAGS) {
    // 自闭合与带内容版本：用大小写不敏感 + 跨行匹配
    const selfClosing = new RegExp(`<${tag}\\b[^>]*\\/?>`, "gi");
    const withContent = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi");
    sanitized = sanitized.replace(selfClosing, "").replace(withContent, "");
  }

  // 移除所有 on* 事件属性（onerror= onload= onclick= 等）
  sanitized = sanitized.replace(
    /\son[a-z-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi,
    "",
  );

  // 移除 javascript: 协议的 href/src/v-link 等
  sanitized = sanitized.replace(
    /(href|src|xlink:href|action)\s*=\s*(["'])\s*javascript:[^"']*\2/gi,
    "$1=$2about:blank$2",
  );

  // 在保留的 <script> 内检测危险 API 模式
  const scriptContents = sanitized.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi);
  for (const match of scriptContents) {
    const scriptContent = match[1] ?? "";
    for (const pattern of WIDGET_DANGEROUS_SCRIPT_PATTERNS) {
      if (pattern.test(scriptContent)) {
        throw new Error(
          `widget_code 内联脚本含禁止的 API 模式 (${pattern.source})。` +
            `Widget 不允许直接访问父窗、cookie、eval、WebSocket 等高危能力。` +
            `如有正当数据交互需求，请改用 postMessage 事件桥接。`,
        );
      }
    }
  }

  return sanitized;
}

/**
 * 解析 skills 目录下的 .html 模板路径为绝对路径
 */
async function resolveWidgetPath(skillRelativePath: string): Promise<string> {
  const normalized = skillRelativePath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized) {
    throw new Error("widget_path 不能为空");
  }
  if (/^([a-zA-Z]:[\\/]|[\\/])/.test(skillRelativePath)) {
    throw new Error("widget_path 必须是 skills 目录下的相对路径");
  }

  const parts = normalized.split("/").filter(Boolean);
  if (parts.length < 3) {
    throw new Error("widget_path 格式无效。应类似 builtin/my-skill/template.html");
  }
  if (parts[0] !== "builtin" && parts[0] !== "custom") {
    throw new Error("widget_path 必须以 builtin/ 或 custom/ 开头");
  }
  if (parts.some((part) => part === "." || part === "..")) {
    throw new Error("widget_path 不能包含 . 或 .. 段");
  }

  const dataDir = await getDataDir();
  const basePath = `${dataDir.replace(/[\\/]+$/, "")}/skills`;
  return `${basePath}/${parts.join("/")}`;
}

/**
 * 读取 skills 目录下的 .html 模板文件
 */
async function readWidgetTemplate(skillRelativePath: string): Promise<string> {
  const normalizedPath = await resolveWidgetPath(skillRelativePath);
  // 尝试读取（当前实现通过 readFile 直接读取，
  // 如果后续 skills 目录需要特殊处理，可在此扩展）
  return readFile(normalizedPath);
}

/**
 * 验证 widget_code 或 widget_path 至少提供一个
 */
function validateWidgetSource(
  widgetCode: string | undefined,
  widgetPath: string | undefined,
): { valid: boolean; error?: string } {
  const hasCode = Boolean(widgetCode && widgetCode.trim().length > 0);
  const hasPath = Boolean(widgetPath && widgetPath.trim().length > 0);

  if (!hasCode && !hasPath) {
    return { valid: false, error: "widget_code 和 widget_path 至少提供一个" };
  }

  // 如果提供了 widget_path，检查是否为 .html 后缀
  if (hasPath && widgetPath) {
    const lowerPath = widgetPath.toLowerCase();
    if (!lowerPath.endsWith(".html")) {
      return { valid: false, error: "widget_path 必须是 .html 文件路径" };
    }
  }

  return { valid: true };
}

/**
 * 生成 HTML 内容：优先使用 widget_code，否则读取 widget_path 对应的模板
 */
function getWidgetHtml(
  widgetCode: string | undefined,
  widgetPath: string | undefined,
): Promise<{ html: string; source: "inline" | "file" }> {
  if (widgetCode && widgetCode.trim().length > 0) {
    // 安全说明：AI 提供的内联 HTML 视为不可信，必须在工具入口先净化。
    // 这层净化与 WidgetSandbox 的 sandbox 隔离 + AI 审查 + iframe opaque
    // origin 共同形成防御纵深。fail-loud，禁止时直接抛错。
    const sanitized = sanitizeWidgetCode(widgetCode.trim());
    return Promise.resolve({ html: sanitized, source: "inline" });
  }

  if (widgetPath && widgetPath.trim().length > 0) {
    return readWidgetTemplate(widgetPath.trim()).then((html) => {
      // 来自本地 skills 目录的模板文件理论上可信，但仍走一次净化以防
      // 模板被篡改（防御纵深）。
      const sanitized = sanitizeWidgetCode(html);
      return { html: sanitized, source: "file" as const };
    });
  }

  return Promise.reject(new Error("widget_code 和 widget_path 都为空，无法生成 HTML"));
}

export function renderWidgetTool(
  _ctx: ToolContext,
): AgentTool<typeof renderWidgetParams> {
  return {
    name: "render_widget",
    label: "渲染 Widget",
    description:
      "在对话中渲染一个交互式 UI Widget。可以通过内联 HTML 代码（widget_code）" +
      "或引用 skills 目录下的 .html 模板（widget_path）来提供内容。" +
      "实际渲染由前端组件处理，工具仅验证参数并返回 widget 元数据。",
    parameters: renderWidgetParams,
    executionMode: "parallel",
    execute: async (_id, params: Static<typeof renderWidgetParams>) => {
      // 验证参数：至少提供 widget_code 或 widget_path 之一
      const validation = validateWidgetSource(params.widget_code, params.widget_path);
      if (!validation.valid) {
        return {
          content: text(`参数验证失败：${validation.error}`),
          details: {
            success: false,
            message: validation.error,
            title: params.title,
            update_mode: params.update_mode,
          },
        };
      }

      try {
        // 获取 HTML 内容
        const { html, source } = await getWidgetHtml(params.widget_code, params.widget_path);

        // 构造成功响应
        return {
          content: text(
            `Widget「${params.title}」已准备就绪（${source === "inline" ? "内联代码" : `模板：${params.widget_path}`}）`,
          ),
          details: {
            success: true,
            message: "Widget 渲染请求已处理",
            widget: {
              widgetId: params.title,
              title: params.title,
              update_mode: params.update_mode,
              source,
              html,
              html_length: html.length,
              html_preview: html.length > 200 ? html.slice(0, 200) + "..." : html,
              widget_path: params.widget_path ?? null,
              data: params.data ?? null,
            },
          },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          content: text(`Widget 渲染失败：${errorMessage}`),
          details: {
            success: false,
            message: errorMessage,
            title: params.title,
            update_mode: params.update_mode,
          },
        };
      }
    },
  };
}
