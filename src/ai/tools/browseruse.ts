// Browser Use 工具 - 浏览器控制
// src/ai/tools/browseruse.ts
//
// 基于 Chrome 扩展桥接实现浏览器的观察与操作

import { Type, type Static } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";

import { text, type ToolContext } from "./tool-context";

// 调用浏览器服务
async function callBrowserUse(command: string, args: Record<string, any> = {}) {
  const result = await window.polaragent.browseruse.call({ command, ...args });
  if (!result.ok) throw new Error(result.error);
  return result.result;
}

// 列出标签页
const tabsParams = Type.Object({
  profile: Type.Optional(Type.String({ description: "Chrome Profile ID 或 label" })),
});

export function browserTabsTool(_ctx: ToolContext): AgentTool<typeof tabsParams> {
  return {
    name: "browser_tabs",
    label: "列出标签页",
    description: "列出当前所有浏览器标签页",
    parameters: tabsParams,
    execute: async (_toolCallId, params: Static<typeof tabsParams>) => {
      const tabs = await callBrowserUse("tabs", params);
      return {
        content: text(`找到 ${tabs.length} 个标签页:\n${JSON.stringify(tabs, null, 2)}`),
        details: { count: tabs.length },
      };
    },
  };
}

// 打开新标签页
const openParams = Type.Object({
  url: Type.String({ description: "要打开的 URL" }),
  profile: Type.Optional(Type.String({ description: "Chrome Profile ID 或 label" })),
});

export function browserOpenTool(_ctx: ToolContext): AgentTool<typeof openParams> {
  return {
    name: "browser_open",
    label: "打开标签页",
    description: "打开新的浏览器标签页",
    parameters: openParams,
    execute: async (_toolCallId, params: Static<typeof openParams>) => {
      const result = await callBrowserUse("open", params);
      return {
        content: text(`已打开标签页: ${result.tabId}`),
        details: { tabId: result.tabId },
      };
    },
  };
}

// 关闭标签页
const closeParams = Type.Object({
  tabId: Type.Number({ description: "标签页 ID" }),
});

export function browserCloseTool(_ctx: ToolContext): AgentTool<typeof closeParams> {
  return {
    name: "browser_close",
    label: "关闭标签页",
    description: "关闭指定的浏览器标签页",
    parameters: closeParams,
    execute: async (_toolCallId, params: Static<typeof closeParams>) => {
      await callBrowserUse("close", params);
      return {
        content: text(`已关闭标签页 ${params.tabId}`),
        details: { tabId: params.tabId },
      };
    },
  };
}

// 扫描页面内容
const scanParams = Type.Object({
  tabId: Type.Optional(Type.Number({ description: "标签页 ID" })),
  textOnly: Type.Optional(Type.Boolean({ description: "仅返回纯文本", default: true })),
});

export function browserScanTool(_ctx: ToolContext): AgentTool<typeof scanParams> {
  return {
    name: "browser_scan",
    label: "扫描页面",
    description: "扫描页面内容,获取文本或结构化信息",
    parameters: scanParams,
    execute: async (_toolCallId, params: Static<typeof scanParams>) => {
      const result = await callBrowserUse("scan", params);
      return {
        content: text(typeof result === "string" ? result : JSON.stringify(result, null, 2)),
        details: { tabId: params.tabId },
      };
    },
  };
}

// 获取页面快照
const snapshotParams = Type.Object({
  tabId: Type.Optional(Type.Number({ description: "标签页 ID" })),
  limit: Type.Optional(Type.Number({ description: "最大元素数", default: 200 })),
  offset: Type.Optional(Type.Number({ description: "偏移量", default: 0 })),
});

export function browserSnapshotTool(_ctx: ToolContext): AgentTool<typeof snapshotParams> {
  return {
    name: "browser_snapshot",
    label: "页面快照",
    description: "获取页面可操作元素快照,生成 @e 引用用于后续点击或填充",
    parameters: snapshotParams,
    execute: async (_toolCallId, params: Static<typeof snapshotParams>) => {
      const result = await callBrowserUse("snapshot", params);
      const elements = result.elements.map((el: any, i: number) => `@e${i + 1}: ${el.type} - ${el.text || el.selector}`).join("\n");
      return {
        content: text(`快照生成成功 (session: ${result.sessionKey}, 共 ${result.count} 个元素):\n${elements}`),
        details: { sessionKey: result.sessionKey, count: result.count },
      };
    },
  };
}

// 点击元素
const clickParams = Type.Object({
  tabId: Type.Optional(Type.Number({ description: "标签页 ID" })),
  target: Type.String({ description: "目标元素: CSS 选择器或 @e 引用 (如 @e1)" }),
});

export function browserClickTool(_ctx: ToolContext): AgentTool<typeof clickParams> {
  return {
    name: "browser_click",
    label: "点击元素",
    description: "点击页面元素,支持 CSS 选择器或 @e 引用",
    parameters: clickParams,
    execute: async (_toolCallId, params: Static<typeof clickParams>) => {
      await callBrowserUse("click", params);
      return {
        content: text(`已点击元素: ${params.target}`),
        details: { target: params.target },
      };
    },
  };
}

// 填充表单
const fillParams = Type.Object({
  tabId: Type.Optional(Type.Number({ description: "标签页 ID" })),
  target: Type.String({ description: "目标元素: CSS 选择器或 @e 引用" }),
  value: Type.String({ description: "要填充的文本" }),
  clear: Type.Optional(Type.Boolean({ description: "填充前清空", default: false })),
  append: Type.Optional(Type.Boolean({ description: "追加模式", default: false })),
});

export function browserFillTool(_ctx: ToolContext): AgentTool<typeof fillParams> {
  return {
    name: "browser_fill",
    label: "填充表单",
    description: "填充表单输入框",
    parameters: fillParams,
    execute: async (_toolCallId, params: Static<typeof fillParams>) => {
      await callBrowserUse("fill", params);
      return {
        content: text(`已填充 ${params.target}: ${params.value}`),
        details: { target: params.target },
      };
    },
  };
}

// 执行 JavaScript
const executeParams = Type.Object({
  tabId: Type.Optional(Type.Number({ description: "标签页 ID" })),
  script: Type.String({ description: "要执行的 JavaScript 代码" }),
});

export function browserExecuteTool(_ctx: ToolContext): AgentTool<typeof executeParams> {
  return {
    name: "browser_execute",
    label: "执行脚本",
    description: "在页面中执行 JavaScript 代码",
    parameters: executeParams,
    execute: async (_toolCallId, params: Static<typeof executeParams>) => {
      const result = await callBrowserUse("exec", params);
      return {
        content: text(`执行结果:\n${JSON.stringify(result, null, 2)}`),
        details: { result },
      };
    },
  };
}

// 截图
const screenshotParams = Type.Object({
  tabId: Type.Optional(Type.Number({ description: "标签页 ID" })),
  fullPage: Type.Optional(Type.Boolean({ description: "全页截图", default: false })),
  target: Type.Optional(Type.String({ description: "目标元素: CSS 选择器或 @e 引用" })),
});

export function browserScreenshotTool(ctx: ToolContext): AgentTool<typeof screenshotParams> {
  return {
    name: "browser_screenshot",
    label: "浏览器截图",
    description: "截取页面截图",
    parameters: screenshotParams,
    execute: async (_toolCallId, params: Static<typeof screenshotParams>) => {
      const result = await callBrowserUse("screenshot", { ...params, workDir: ctx.workingDir });
      return {
        content: text(`截图已保存到: ${result.path}\n文件名: ${result.filename}`),
        details: { path: result.path, filename: result.filename },
      };
    },
  };
}

// 网络监控
const networkParams = Type.Object({
  tabId: Type.Number({ description: "标签页 ID" }),
  action: Type.Union([Type.Literal("start"), Type.Literal("list"), Type.Literal("stop")], {
    description: "操作: start(开始监控) list(列出请求) stop(停止监控)",
  }),
});

export function browserNetworkTool(_ctx: ToolContext): AgentTool<typeof networkParams> {
  return {
    name: "browser_network",
    label: "网络监控",
    description: "监控网络请求",
    parameters: networkParams,
    execute: async (_toolCallId, params: Static<typeof networkParams>) => {
      const result = await callBrowserUse("network", params);
      return {
        content: text(JSON.stringify(result, null, 2)),
        details: { action: params.action },
      };
    },
  };
}
