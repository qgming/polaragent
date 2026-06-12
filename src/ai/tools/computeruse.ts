// Computer Use 工具 - Windows 桌面应用控制
// src/ai/tools/computeruse.ts
//
// 基于 Windows UI Automation 实现桌面应用的观察与操作

import { Type, type Static } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";

import { useConfigStore } from "@/stores/config-store";
import { text, type ToolContext } from "./tool-context";

function computerUseDefaults() {
  return useConfigStore.getState().settings.automation?.computerUse;
}

function hasPointOrElement(params: { x?: number; y?: number; elementId?: string }) {
  return params.elementId || (params.x != null && params.y != null);
}

// Windows Computer Use 快照参数
const snapshotParams = Type.Object({
  scope: Type.Optional(
    Type.Union([Type.Literal("active_window"), Type.Literal("desktop")], {
      description: "范围：active_window(活动窗口) 或 desktop(整个桌面)",
      default: "active_window",
    }),
  ),
  maxDepth: Type.Optional(
    Type.Number({
      description: "UI 树最大深度，0-12",
      minimum: 0,
      maximum: 12,
      default: 5,
    }),
  ),
  maxNodes: Type.Optional(
    Type.Number({
      description: "UI 树最大节点数，1-2000",
      minimum: 1,
      maximum: 2000,
      default: 250,
    }),
  ),
  includeScreenshot: Type.Optional(Type.Boolean({ description: "是否包含截图" })),
  screenshotMode: Type.Optional(
    Type.Union([Type.Literal("path"), Type.Literal("base64")], {
      description: "截图返回方式：path 只返回文件路径，base64 返回完整图片数据",
      default: "path",
    }),
  ),
  viewMode: Type.Optional(
    Type.Union([Type.Literal("control"), Type.Literal("content"), Type.Literal("raw")], {
      description: "UIA 树视图模式",
      default: "control",
    }),
  ),
  includeOffscreen: Type.Optional(Type.Boolean({ description: "是否包含屏幕外元素", default: false })),
  detailLevel: Type.Optional(
    Type.Union([Type.Literal("compact"), Type.Literal("full")], {
      description: "元素详情级别",
      default: "compact",
    }),
  ),
  windowTitle: Type.Optional(Type.String({ description: "目标窗口标题关键字" })),
  processId: Type.Optional(Type.Number({ description: "目标窗口进程 ID" })),
  nativeWindowHandle: Type.Optional(Type.Number({ description: "目标窗口句柄 HWND" })),
  activate: Type.Optional(Type.Boolean({ description: "操作前激活目标窗口", default: false })),
});

// 点击参数
const clickParams = Type.Object({
  x: Type.Optional(Type.Number({ description: "屏幕 X 坐标" })),
  y: Type.Optional(Type.Number({ description: "屏幕 Y 坐标" })),
  elementId: Type.Optional(Type.String({ description: "UI 元素 ID（如 uia:active.0.2）" })),
  button: Type.Optional(
    Type.Union([Type.Literal("left"), Type.Literal("right"), Type.Literal("middle")], {
      description: "鼠标按钮",
      default: "left",
    }),
  ),
  windowTitle: Type.Optional(Type.String({ description: "目标窗口标题关键字" })),
  processId: Type.Optional(Type.Number({ description: "目标窗口进程 ID" })),
  nativeWindowHandle: Type.Optional(Type.Number({ description: "目标窗口句柄 HWND" })),
  activate: Type.Optional(Type.Boolean({ description: "点击前激活目标窗口", default: false })),
  viewMode: Type.Optional(
    Type.Union([Type.Literal("control"), Type.Literal("content"), Type.Literal("raw")], {
      description: "解析 elementId 时使用的 UIA 视图模式",
      default: "control",
    }),
  ),
  includeOffscreen: Type.Optional(Type.Boolean({ description: "解析 elementId 时是否包含屏幕外元素", default: false })),
});

// 输入文本参数
const typeTextParams = Type.Object({
  text: Type.String({ description: "要输入的文本" }),
  restoreClipboard: Type.Optional(Type.Boolean({ description: "输入后恢复剪贴板内容" })),
  windowTitle: Type.Optional(Type.String({ description: "目标窗口标题关键字" })),
  processId: Type.Optional(Type.Number({ description: "目标窗口进程 ID" })),
  nativeWindowHandle: Type.Optional(Type.Number({ description: "目标窗口句柄 HWND" })),
  activate: Type.Optional(Type.Boolean({ description: "输入前激活目标窗口", default: false })),
});

// 按键参数
const keypressParams = Type.Object({
  keys: Type.Array(Type.String(), {
    description: "按键序列，如 ['Ctrl', 'C']",
  }),
  windowTitle: Type.Optional(Type.String({ description: "目标窗口标题关键字" })),
  processId: Type.Optional(Type.Number({ description: "目标窗口进程 ID" })),
  nativeWindowHandle: Type.Optional(Type.Number({ description: "目标窗口句柄 HWND" })),
  activate: Type.Optional(Type.Boolean({ description: "按键前激活目标窗口", default: false })),
});

// 查找元素参数
const findParams = Type.Object({
  query: Type.String({ description: "查询字符串（匹配元素名称、ID、类名）" }),
  scope: Type.Optional(
    Type.Union([Type.Literal("active_window"), Type.Literal("desktop")], {
      description: "范围：active_window 或 desktop",
      default: "active_window",
    }),
  ),
  controlType: Type.Optional(Type.String({ description: "控件类型过滤，如 Button/Edit/Text" })),
  viewMode: Type.Optional(
    Type.Union([Type.Literal("control"), Type.Literal("content"), Type.Literal("raw")], {
      description: "UIA 树视图模式",
      default: "control",
    }),
  ),
  includeOffscreen: Type.Optional(Type.Boolean({ description: "是否包含屏幕外元素", default: false })),
  maxDepth: Type.Optional(Type.Number({ description: "扫描深度", minimum: 0, maximum: 12 })),
  maxNodes: Type.Optional(Type.Number({ description: "扫描节点上限", minimum: 1, maximum: 3000 })),
  windowTitle: Type.Optional(Type.String({ description: "目标窗口标题关键字" })),
  processId: Type.Optional(Type.Number({ description: "目标窗口进程 ID" })),
  nativeWindowHandle: Type.Optional(Type.Number({ description: "目标窗口句柄 HWND" })),
  activate: Type.Optional(Type.Boolean({ description: "查找前激活目标窗口", default: false })),
  maxResults: Type.Optional(
    Type.Number({
      description: "最大结果数，1-200",
      minimum: 1,
      maximum: 200,
      default: 25,
    }),
  ),
});

// 滚动参数
const scrollParams = Type.Object({
  x: Type.Optional(Type.Number({ description: "屏幕 X 坐标" })),
  y: Type.Optional(Type.Number({ description: "屏幕 Y 坐标" })),
  elementId: Type.Optional(Type.String({ description: "UI 元素 ID" })),
  deltaY: Type.Optional(
    Type.Number({
      description: "垂直滚动距离（正数向下，负数向上）",
      default: 480,
    }),
  ),
  deltaX: Type.Optional(Type.Number({ description: "水平滚动距离", default: 0 })),
  windowTitle: Type.Optional(Type.String({ description: "目标窗口标题关键字" })),
  processId: Type.Optional(Type.Number({ description: "目标窗口进程 ID" })),
  nativeWindowHandle: Type.Optional(Type.Number({ description: "目标窗口句柄 HWND" })),
  activate: Type.Optional(Type.Boolean({ description: "滚动前激活目标窗口", default: false })),
  viewMode: Type.Optional(
    Type.Union([Type.Literal("control"), Type.Literal("content"), Type.Literal("raw")], {
      description: "解析 elementId 时使用的 UIA 视图模式",
      default: "control",
    }),
  ),
  includeOffscreen: Type.Optional(Type.Boolean({ description: "解析 elementId 时是否包含屏幕外元素", default: false })),
});

// 双击参数（与点击相同）
const doubleClickParams = clickParams;

// 移动鼠标参数
const moveParams = Type.Object({
  x: Type.Optional(Type.Number({ description: "屏幕 X 坐标" })),
  y: Type.Optional(Type.Number({ description: "屏幕 Y 坐标" })),
  elementId: Type.Optional(Type.String({ description: "UI 元素 ID" })),
  windowTitle: Type.Optional(Type.String({ description: "目标窗口标题关键字" })),
  processId: Type.Optional(Type.Number({ description: "目标窗口进程 ID" })),
  nativeWindowHandle: Type.Optional(Type.Number({ description: "目标窗口句柄 HWND" })),
  activate: Type.Optional(Type.Boolean({ description: "移动前激活目标窗口", default: false })),
  viewMode: Type.Optional(
    Type.Union([Type.Literal("control"), Type.Literal("content"), Type.Literal("raw")], {
      description: "解析 elementId 时使用的 UIA 视图模式",
      default: "control",
    }),
  ),
  includeOffscreen: Type.Optional(Type.Boolean({ description: "解析 elementId 时是否包含屏幕外元素", default: false })),
});

// 列出窗口参数
const listWindowsParams = Type.Object({
  maxWindows: Type.Optional(
    Type.Number({
      description: "最大窗口数，1-200",
      minimum: 1,
      maximum: 200,
      default: 50,
    }),
  ),
});

// 获取可访问性树参数
const accessibilityTreeParams = Type.Object({
  scope: Type.Optional(
    Type.Union([Type.Literal("active_window"), Type.Literal("desktop")], {
      description: "范围：active_window 或 desktop",
      default: "active_window",
    }),
  ),
  maxDepth: Type.Optional(
    Type.Number({
      description: "UI 树最大深度",
      minimum: 0,
      maximum: 12,
      default: 6,
    }),
  ),
  maxNodes: Type.Optional(
    Type.Number({
      description: "UI 树最大节点数",
      minimum: 1,
      maximum: 3000,
      default: 500,
    }),
  ),
  viewMode: Type.Optional(
    Type.Union([Type.Literal("control"), Type.Literal("content"), Type.Literal("raw")], {
      description: "UIA 树视图模式",
      default: "control",
    }),
  ),
  includeOffscreen: Type.Optional(Type.Boolean({ description: "是否包含屏幕外元素", default: false })),
  detailLevel: Type.Optional(
    Type.Union([Type.Literal("compact"), Type.Literal("full")], {
      description: "元素详情级别",
      default: "compact",
    }),
  ),
  windowTitle: Type.Optional(Type.String({ description: "目标窗口标题关键字" })),
  processId: Type.Optional(Type.Number({ description: "目标窗口进程 ID" })),
  nativeWindowHandle: Type.Optional(Type.Number({ description: "目标窗口句柄 HWND" })),
  activate: Type.Optional(Type.Boolean({ description: "读取前激活目标窗口", default: false })),
});

const elementInfoParams = Type.Object({
  elementId: Type.Optional(Type.String({ description: "UI 元素 ID" })),
  x: Type.Optional(Type.Number({ description: "屏幕 X 坐标" })),
  y: Type.Optional(Type.Number({ description: "屏幕 Y 坐标" })),
  windowTitle: Type.Optional(Type.String({ description: "目标窗口标题关键字" })),
  processId: Type.Optional(Type.Number({ description: "目标窗口进程 ID" })),
  nativeWindowHandle: Type.Optional(Type.Number({ description: "目标窗口句柄 HWND" })),
  activate: Type.Optional(Type.Boolean({ description: "查询前激活目标窗口", default: false })),
  viewMode: Type.Optional(
    Type.Union([Type.Literal("control"), Type.Literal("content"), Type.Literal("raw")], {
      description: "解析 elementId 时使用的 UIA 视图模式",
      default: "control",
    }),
  ),
  includeOffscreen: Type.Optional(Type.Boolean({ description: "解析 elementId 时是否包含屏幕外元素", default: false })),
});

const focusParams = Type.Object({
  elementId: Type.String({ description: "UI 元素 ID" }),
  windowTitle: Type.Optional(Type.String({ description: "目标窗口标题关键字" })),
  processId: Type.Optional(Type.Number({ description: "目标窗口进程 ID" })),
  nativeWindowHandle: Type.Optional(Type.Number({ description: "目标窗口句柄 HWND" })),
  activate: Type.Optional(Type.Boolean({ description: "聚焦前激活目标窗口", default: false })),
  viewMode: Type.Optional(
    Type.Union([Type.Literal("control"), Type.Literal("content"), Type.Literal("raw")], {
      description: "解析 elementId 时使用的 UIA 视图模式",
      default: "control",
    }),
  ),
  includeOffscreen: Type.Optional(Type.Boolean({ description: "解析 elementId 时是否包含屏幕外元素", default: false })),
});

const invokeParams = Type.Object({
  elementId: Type.String({ description: "UI 元素 ID" }),
  fallbackClick: Type.Optional(Type.Boolean({ description: "无 UIA Invoke/Toggle 等模式时回退为点击", default: true })),
  windowTitle: Type.Optional(Type.String({ description: "目标窗口标题关键字" })),
  processId: Type.Optional(Type.Number({ description: "目标窗口进程 ID" })),
  nativeWindowHandle: Type.Optional(Type.Number({ description: "目标窗口句柄 HWND" })),
  activate: Type.Optional(Type.Boolean({ description: "调用前激活目标窗口", default: false })),
  viewMode: Type.Optional(
    Type.Union([Type.Literal("control"), Type.Literal("content"), Type.Literal("raw")], {
      description: "解析 elementId 时使用的 UIA 视图模式",
      default: "control",
    }),
  ),
  includeOffscreen: Type.Optional(Type.Boolean({ description: "解析 elementId 时是否包含屏幕外元素", default: false })),
});

const setValueParams = Type.Object({
  elementId: Type.String({ description: "UI 元素 ID" }),
  value: Type.String({ description: "要设置的值" }),
  fallbackType: Type.Optional(Type.Boolean({ description: "无 ValuePattern 时回退为聚焦后输入", default: true })),
  restoreClipboard: Type.Optional(Type.Boolean({ description: "回退输入后恢复剪贴板" })),
  windowTitle: Type.Optional(Type.String({ description: "目标窗口标题关键字" })),
  processId: Type.Optional(Type.Number({ description: "目标窗口进程 ID" })),
  nativeWindowHandle: Type.Optional(Type.Number({ description: "目标窗口句柄 HWND" })),
  activate: Type.Optional(Type.Boolean({ description: "设置前激活目标窗口", default: false })),
  viewMode: Type.Optional(
    Type.Union([Type.Literal("control"), Type.Literal("content"), Type.Literal("raw")], {
      description: "解析 elementId 时使用的 UIA 视图模式",
      default: "control",
    }),
  ),
  includeOffscreen: Type.Optional(Type.Boolean({ description: "解析 elementId 时是否包含屏幕外元素", default: false })),
});

const activateWindowParams = Type.Object({
  windowTitle: Type.Optional(Type.String({ description: "目标窗口标题关键字" })),
  processId: Type.Optional(Type.Number({ description: "目标窗口进程 ID" })),
  nativeWindowHandle: Type.Optional(Type.Number({ description: "目标窗口句柄 HWND" })),
});

const waitParams = Type.Object({
  milliseconds: Type.Optional(Type.Number({ description: "等待毫秒数", default: 500 })),
});

const dragParams = Type.Object({
  path: Type.Array(Type.Object({ x: Type.Number(), y: Type.Number() }), {
    description: "拖拽路径，至少两个点",
  }),
  button: Type.Optional(
    Type.Union([Type.Literal("left"), Type.Literal("right"), Type.Literal("middle")], {
      description: "鼠标按钮",
      default: "left",
    }),
  ),
  windowTitle: Type.Optional(Type.String({ description: "目标窗口标题关键字" })),
  processId: Type.Optional(Type.Number({ description: "目标窗口进程 ID" })),
  nativeWindowHandle: Type.Optional(Type.Number({ description: "目标窗口句柄 HWND" })),
  activate: Type.Optional(Type.Boolean({ description: "拖拽前激活目标窗口", default: false })),
});

const batchParams = Type.Object({
  actions: Type.Array(
    Type.Object({
      action: Type.Union([
        Type.Literal("activate_window"),
        Type.Literal("find"),
        Type.Literal("tree"),
        Type.Literal("snapshot"),
        Type.Literal("element_info"),
        Type.Literal("focus"),
        Type.Literal("invoke"),
        Type.Literal("set_value"),
        Type.Literal("click"),
        Type.Literal("double_click"),
        Type.Literal("move"),
        Type.Literal("drag"),
        Type.Literal("scroll"),
        Type.Literal("type_text"),
        Type.Literal("keypress"),
        Type.Literal("wait"),
      ], { description: "要执行的 Computer Use 底层动作" }),
      args: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "该动作的参数" })),
    }),
    {
      description: "按顺序执行的动作列表，建议 2-8 个",
      minItems: 1,
      maxItems: 12,
    },
  ),
  stopOnError: Type.Optional(Type.Boolean({ description: "遇到失败时停止后续动作", default: true })),
});

export function windowsSnapshotTool(_ctx: ToolContext): AgentTool<typeof snapshotParams> {
  return {
    name: "windows_snapshot",
    label: "Windows 截图",
    description:
      "获取 Windows 活动窗口或桌面的截图和 UI 树结构。" +
      "返回可点击元素的位置、名称、类型、ID 等信息，以及 Base64 格式的屏幕截图。" +
      "使用获取的 elementId 可以直接操作 UI 元素。" +
      "建议先调用此工具获取窗口状态，再使用其他 Computer Use 工具进行操作。",
    parameters: snapshotParams,
    execute: async (_id, params: Static<typeof snapshotParams>) => {
      try {
        const defaults = computerUseDefaults();
        const result = await window.polaragent.computeruse.snapshot({
          scope: params.scope || "active_window",
          maxDepth: params.maxDepth ?? defaults?.defaultMaxDepth ?? 5,
          maxNodes: params.maxNodes ?? defaults?.defaultMaxNodes ?? 250,
          includeScreenshot: params.includeScreenshot ?? defaults?.includeScreenshotByDefault ?? true,
          screenshotMode: params.screenshotMode ?? defaults?.screenshotMode ?? "path",
          viewMode: params.viewMode,
          includeOffscreen: params.includeOffscreen,
          detailLevel: params.detailLevel,
          windowTitle: params.windowTitle,
          processId: params.processId,
          nativeWindowHandle: params.nativeWindowHandle,
          activate: params.activate,
        });

        if (!result.ok) {
          return {
            content: text(`截图失败：${result.error || "未知错误"}`),
            details: { error: result.error },
          };
        }

        // 构建 UI 树摘要
        const treeSummary = buildTreeSummary(result.tree);
        const screenshot = result.screenshot?.base64
          ? `\n\n[截图已获取: ${Math.round(result.screenshot.base64.length / 1024)}KB]`
          : result.screenshot?.path
            ? `\n\n[截图已保存: ${result.screenshot.path}]`
          : "";

        return {
          content: text(
            `获取 Windows 窗口成功\n\n` +
            `范围: ${result.scope}\n` +
            `根元素: ${result.tree.name} [${result.tree.controlType}]\n\n` +
            `UI 树结构：\n${treeSummary}${screenshot}\n\n` +
            `提示: 使用元素 ID (如 ${result.tree.id}) 可以直接点击或操作该元素。`
          ),
          details: {
            tree: result.tree,
            screenshot: result.screenshot,
            scope: result.scope,
          },
        };
      } catch (error) {
        return {
          content: text(`截图异常：${error instanceof Error ? error.message : String(error)}`),
          details: { error: String(error) },
        };
      }
    },
  };
}

export function windowsClickTool(_ctx: ToolContext): AgentTool<typeof clickParams> {
  return {
    name: "windows_click",
    label: "Windows 点击",
    description:
      "在 Windows 应用中点击指定坐标或 UI 元素。可以通过屏幕坐标 (x, y) 或通过 windows_snapshot 获取的元素 ID 来定位。",
    parameters: clickParams,
    execute: async (_id, params: Static<typeof clickParams>) => {
      if (!hasPointOrElement(params)) {
        return {
          content: text("必须提供坐标 (x, y) 或元素 ID (elementId)"),
          details: { error: "缺少参数" },
        };
      }

      try {
        const result = await window.polaragent.computeruse.click({
          x: params.x,
          y: params.y,
          elementId: params.elementId,
          button: params.button || "left",
          windowTitle: params.windowTitle,
          processId: params.processId,
          nativeWindowHandle: params.nativeWindowHandle,
          activate: params.activate,
          viewMode: params.viewMode,
          includeOffscreen: params.includeOffscreen,
        });

        if (!result.ok) {
          return {
            content: text(`点击失败：${result.error || "未知错误"}`),
            details: { error: result.error },
          };
        }

        const target = params.elementId
          ? `元素 ${params.elementId}`
          : `坐标 (${params.x}, ${params.y})`;

        return {
          content: text(`✅ 点击成功：${target}`),
          details: result,
        };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);

        // 检测元素失效错误
        if (errorMsg.includes("失效") || errorMsg.includes("stale")) {
          return {
            content: text(
              `❌ 点击失败：元素 ID 已失效\n\n` +
              `原因：窗口内容已变化，之前获取的元素 ID 不再有效。\n\n` +
              `解决方案：\n` +
              `1. 重新调用 windows_snapshot 获取最新窗口状态\n` +
              `2. 或使用 windows_find 重新查找元素\n` +
              `3. 获取新的 elementId 后再点击`
            ),
            details: { error: errorMsg, elementId: params.elementId },
          };
        }

        return {
          content: text(`点击异常：${errorMsg}`),
          details: { error: errorMsg },
        };
      }
    },
  };
}

export function windowsTypeTool(_ctx: ToolContext): AgentTool<typeof typeTextParams> {
  return {
    name: "windows_type",
    label: "Windows 输入",
    description:
      "在 Windows 应用的当前焦点控件中输入文本。会自动保存并恢复剪贴板内容，支持 Unicode 字符。",
    parameters: typeTextParams,
    execute: async (_id, params: Static<typeof typeTextParams>) => {
      try {
        const result = await window.polaragent.computeruse.type({
          text: params.text,
          restoreClipboard: params.restoreClipboard ?? computerUseDefaults()?.restoreClipboard ?? true,
          windowTitle: params.windowTitle,
          processId: params.processId,
          nativeWindowHandle: params.nativeWindowHandle,
          activate: params.activate,
        });

        if (!result.ok) {
          return {
            content: text(`输入失败：${result.error || "未知错误"}`),
            details: { error: result.error },
          };
        }

        return {
          content: text(`输入成功：${params.text.length} 个字符`),
          details: result,
        };
      } catch (error) {
        return {
          content: text(`输入异常：${error instanceof Error ? error.message : String(error)}`),
          details: { error: String(error) },
        };
      }
    },
  };
}

export function windowsKeypressTool(_ctx: ToolContext): AgentTool<typeof keypressParams> {
  return {
    name: "windows_keypress",
    label: "Windows 按键",
    description:
      "在 Windows 应用中按下键盘按键或组合键。" +
      "支持修饰键（Ctrl、Alt、Shift）和功能键（F1-F12、Enter、Tab、Esc 等）。" +
      "常用组合键: Ctrl+C (复制), Ctrl+V (粘贴), Ctrl+S (保存), Alt+F4 (关闭窗口)。" +
      "⚠️ 不支持 Windows 键（Win）。使用 Ctrl+Esc 打开开始菜单，Alt+Tab 切换窗口。",
    parameters: keypressParams,
    execute: async (_id, params: Static<typeof keypressParams>) => {
      // 前置检查：拦截 Windows 键
      const hasWindowsKey = params.keys.some(
        key => {
          const k = String(key).toLowerCase();
          return k === 'win' || k === 'windows' || k === 'winkey' || k === 'meta';
        }
      );

      if (hasWindowsKey) {
        return {
          content: text(
            `❌ 按键失败: Windows 键不受支持\n\n` +
            `替代方案:\n` +
            `• 打开开始菜单 → 使用 Ctrl+Esc\n` +
            `• 切换窗口 → 使用 Alt+Tab\n` +
            `• 打开运行 → 使用 Ctrl+Shift+Esc 然后输入命令\n\n` +
            `你尝试的按键: ${params.keys.join("+")}`
          ),
          details: { error: "Windows 键不受支持", keys: params.keys },
        };
      }

      try {
        const result = await window.polaragent.computeruse.keypress({
          keys: params.keys,
          windowTitle: params.windowTitle,
          processId: params.processId,
          nativeWindowHandle: params.nativeWindowHandle,
          activate: params.activate,
        });

        if (!result.ok) {
          const errorMsg = result.error || "未知错误";
          // 友好的错误提示
          if (errorMsg.includes("Windows key")) {
            return {
              content: text(
                `❌ 按键失败: Windows 键不受支持\n\n` +
                `建议使用:\n` +
                `• Ctrl+Esc 打开开始菜单\n` +
                `• Alt+Tab 切换窗口`
              ),
              details: { error: errorMsg },
            };
          }
          return {
            content: text(`按键失败：${errorMsg}`),
            details: { error: errorMsg },
          };
        }

        return {
          content: text(`✅ 按键成功：${params.keys.join("+")}`),
          details: result,
        };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);

        // 捕获底层 Windows 键错误
        if (errorMsg.includes("Windows key")) {
          return {
            content: text(
              `❌ 按键失败: Windows 键不受支持\n\n` +
              `请使用 Ctrl+Esc 或 Alt+Tab 作为替代`
            ),
            details: { error: errorMsg },
          };
        }

        return {
          content: text(`按键异常：${errorMsg}`),
          details: { error: errorMsg },
        };
      }
    },
  };
}

export function windowsFindTool(_ctx: ToolContext): AgentTool<typeof findParams> {
  return {
    name: "windows_find",
    label: "Windows 查找",
    description:
      "在 Windows 应用中查找 UI 元素。根据名称、自动化 ID、类名或控件类型进行模糊匹配，返回匹配的元素列表。",
    parameters: findParams,
    execute: async (_id, params: Static<typeof findParams>) => {
      try {
        const defaults = computerUseDefaults();
        const result = await window.polaragent.computeruse.find({
          query: params.query,
          scope: params.scope,
          controlType: params.controlType,
          viewMode: params.viewMode,
          includeOffscreen: params.includeOffscreen,
          maxDepth: params.maxDepth ?? defaults?.defaultMaxDepth,
          maxNodes: params.maxNodes ?? defaults?.defaultMaxNodes,
          windowTitle: params.windowTitle,
          processId: params.processId,
          nativeWindowHandle: params.nativeWindowHandle,
          activate: params.activate,
          maxResults: params.maxResults || 25,
        });

        if (!result.ok) {
          return {
            content: text(`查找失败：${result.error || "未知错误"}`),
            details: { error: result.error },
          };
        }

        const count = result.count ?? result.results?.length ?? 0;
        if (count === 0) {
          return {
            content: text(`未找到匹配的元素："${params.query}"`),
            details: { count: 0, results: [] },
          };
        }

        const summary = result.results
          .map(
            (el) =>
              `- ${el.name || "(无名称)"} [${el.controlType}] ID: ${el.id}` +
              (el.boundingBox ? ` 位置: (${el.boundingBox.x}, ${el.boundingBox.y})` : ""),
          )
          .join("\n");

        return {
          content: text(`找到 ${count} 个元素：\n\n${summary}`),
          details: result,
        };
      } catch (error) {
        return {
          content: text(`查找异常：${error instanceof Error ? error.message : String(error)}`),
          details: { error: String(error) },
        };
      }
    },
  };
}

export function windowsScrollTool(_ctx: ToolContext): AgentTool<typeof scrollParams> {
  return {
    name: "windows_scroll",
    label: "Windows 滚动",
    description:
      "在 Windows 应用中滚动内容。可以在指定坐标或元素上执行滚动操作，正数向下滚动，负数向上滚动。",
    parameters: scrollParams,
    execute: async (_id, params: Static<typeof scrollParams>) => {
      if (!hasPointOrElement(params)) {
        return {
          content: text("必须提供坐标 (x, y) 或元素 ID (elementId)"),
          details: { error: "缺少参数" },
        };
      }

      try {
        const result = await window.polaragent.computeruse.scroll({
          x: params.x,
          y: params.y,
          elementId: params.elementId,
          deltaY: params.deltaY || 480,
          deltaX: params.deltaX || 0,
          windowTitle: params.windowTitle,
          processId: params.processId,
          nativeWindowHandle: params.nativeWindowHandle,
          activate: params.activate,
          viewMode: params.viewMode,
          includeOffscreen: params.includeOffscreen,
        });

        if (!result.ok) {
          return {
            content: text(`滚动失败：${result.error || "未知错误"}`),
            details: { error: result.error },
          };
        }

        const direction = (params.deltaY || 480) > 0 ? "向下" : "向上";
        return {
          content: text(`滚动成功：${direction} ${Math.abs(params.deltaY || 480)} 像素`),
          details: result,
        };
      } catch (error) {
        return {
          content: text(`滚动异常：${error instanceof Error ? error.message : String(error)}`),
          details: { error: String(error) },
        };
      }
    },
  };
}

export function windowsDoubleClickTool(_ctx: ToolContext): AgentTool<typeof doubleClickParams> {
  return {
    name: "windows_double_click",
    label: "Windows 双击",
    description: "在 Windows 应用中双击指定坐标或 UI 元素。用于打开文件、展开树节点等需要双击的操作。",
    parameters: doubleClickParams,
    execute: async (_id, params: Static<typeof doubleClickParams>) => {
      if (!hasPointOrElement(params)) {
        return {
          content: text("必须提供坐标 (x, y) 或元素 ID (elementId)"),
          details: { error: "缺少参数" },
        };
      }

      try {
        const result = await window.polaragent.computeruse.doubleClick({
          x: params.x,
          y: params.y,
          elementId: params.elementId,
          button: params.button || "left",
          windowTitle: params.windowTitle,
          processId: params.processId,
          nativeWindowHandle: params.nativeWindowHandle,
          activate: params.activate,
          viewMode: params.viewMode,
          includeOffscreen: params.includeOffscreen,
        });

        if (!result.ok) {
          return {
            content: text(`双击失败：${result.error || "未知错误"}`),
            details: { error: result.error },
          };
        }

        const target = params.elementId
          ? `元素 ${params.elementId}`
          : `坐标 (${params.x}, ${params.y})`;

        return {
          content: text(`双击成功：${target}`),
          details: result,
        };
      } catch (error) {
        return {
          content: text(`双击异常：${error instanceof Error ? error.message : String(error)}`),
          details: { error: String(error) },
        };
      }
    },
  };
}

export function windowsMoveTool(_ctx: ToolContext): AgentTool<typeof moveParams> {
  return {
    name: "windows_move",
    label: "Windows 移动鼠标",
    description: "移动鼠标指针到指定坐标或 UI 元素中心。用于悬停触发提示或准备点击操作。",
    parameters: moveParams,
    execute: async (_id, params: Static<typeof moveParams>) => {
      if (!hasPointOrElement(params)) {
        return {
          content: text("必须提供坐标 (x, y) 或元素 ID (elementId)"),
          details: { error: "缺少参数" },
        };
      }

      try {
        const result = await window.polaragent.computeruse.move({
          x: params.x,
          y: params.y,
          elementId: params.elementId,
          windowTitle: params.windowTitle,
          processId: params.processId,
          nativeWindowHandle: params.nativeWindowHandle,
          activate: params.activate,
          viewMode: params.viewMode,
          includeOffscreen: params.includeOffscreen,
        });

        if (!result.ok) {
          return {
            content: text(`移动鼠标失败：${result.error || "未知错误"}`),
            details: { error: result.error },
          };
        }

        const target = params.elementId
          ? `元素 ${params.elementId}`
          : `坐标 (${params.x}, ${params.y})`;

        return {
          content: text(`移动鼠标成功：${target}`),
          details: result,
        };
      } catch (error) {
        return {
          content: text(`移动鼠标异常：${error instanceof Error ? error.message : String(error)}`),
          details: { error: String(error) },
        };
      }
    },
  };
}

export function windowsListWindowsTool(_ctx: ToolContext): AgentTool<typeof listWindowsParams> {
  return {
    name: "windows_list_windows",
    label: "列出窗口",
    description:
      "列出所有顶级桌面窗口。返回窗口标题、进程ID、窗口句柄等信息，用于选择目标窗口。",
    parameters: listWindowsParams,
    execute: async (_id, params: Static<typeof listWindowsParams>) => {
      try {
        const result = await window.polaragent.computeruse.listWindows({
          maxWindows: params.maxWindows || 50,
        });

        if (!result.ok) {
          return {
            content: text(`列出窗口失败：${result.error || "未知错误"}`),
            details: { error: result.error },
          };
        }

        const count = result.count ?? result.windows?.length ?? 0;
        if (count === 0) {
          return {
            content: text("未找到任何窗口"),
            details: { count: 0, windows: [] },
          };
        }

        const summary = result.windows
          .map(
            (w) =>
              `- ${w.name || "(无标题)"} (PID: ${w.processId}, HWND: ${w.nativeWindowHandle})`,
          )
          .join("\n");

        return {
          content: text(`找到 ${count} 个窗口：\n\n${summary}`),
          details: result,
        };
      } catch (error) {
        return {
          content: text(`列出窗口异常：${error instanceof Error ? error.message : String(error)}`),
          details: { error: String(error) },
        };
      }
    },
  };
}

export function windowsAccessibilityTreeTool(
  _ctx: ToolContext,
): AgentTool<typeof accessibilityTreeParams> {
  return {
    name: "windows_accessibility_tree",
    label: "获取可访问性树",
    description:
      "获取 UI Automation 树结构，不包含截图。比 snapshot 更快，适合频繁读取 UI 状态的场景。",
    parameters: accessibilityTreeParams,
    execute: async (_id, params: Static<typeof accessibilityTreeParams>) => {
      try {
        const defaults = computerUseDefaults();
        const result = await window.polaragent.computeruse.tree({
          scope: params.scope || "active_window",
          maxDepth: params.maxDepth ?? defaults?.defaultMaxDepth ?? 6,
          maxNodes: params.maxNodes ?? defaults?.defaultMaxNodes ?? 500,
          viewMode: params.viewMode,
          includeOffscreen: params.includeOffscreen,
          detailLevel: params.detailLevel,
          windowTitle: params.windowTitle,
          processId: params.processId,
          nativeWindowHandle: params.nativeWindowHandle,
          activate: params.activate,
        });

        if (!result.ok) {
          return {
            content: text(`获取 UI 树失败：${result.error || "未知错误"}`),
            details: { error: result.error },
          };
        }

        const treeSummary = buildTreeSummary(result.tree);

        return {
          content: text(
            `获取 UI 树成功\n\n` +
            `范围: ${result.scope}\n` +
            `根元素: ${result.tree.name} [${result.tree.controlType}]\n\n` +
            `UI 树结构：\n${treeSummary}`,
          ),
          details: result,
        };
      } catch (error) {
        return {
          content: text(`获取 UI 树异常：${error instanceof Error ? error.message : String(error)}`),
          details: { error: String(error) },
        };
      }
    },
  };
}

export function windowsElementInfoTool(_ctx: ToolContext): AgentTool<typeof elementInfoParams> {
  return {
    name: "windows_element_info",
    label: "元素信息",
    description: "获取指定 UI 元素或屏幕坐标处元素的详细信息，用于校验元素是否仍然有效。",
    parameters: elementInfoParams,
    execute: async (_id, params: Static<typeof elementInfoParams>) => {
      if (!hasPointOrElement(params)) {
        return {
          content: text("必须提供坐标 (x, y) 或元素 ID (elementId)"),
          details: { error: "缺少参数" },
        };
      }
      try {
        const result = await window.polaragent.computeruse.elementInfo(params);
        if (!result.ok) {
          return { content: text(`获取元素信息失败：${result.error || "未知错误"}`), details: result };
        }
        return {
          content: text(`元素信息：\n${JSON.stringify(result.element, null, 2)}`),
          details: result,
        };
      } catch (error) {
        return {
          content: text(`获取元素信息异常：${error instanceof Error ? error.message : String(error)}`),
          details: { error: String(error) },
        };
      }
    },
  };
}

export function windowsFocusTool(_ctx: ToolContext): AgentTool<typeof focusParams> {
  return {
    name: "windows_focus",
    label: "聚焦元素",
    description: "使用 UI Automation 将焦点移动到指定元素。适合输入前准备焦点。",
    parameters: focusParams,
    execute: async (_id, params: Static<typeof focusParams>) => {
      try {
        const result = await window.polaragent.computeruse.focus(params);
        if (!result.ok) return { content: text(`聚焦失败：${result.error || "未知错误"}`), details: result };
        return { content: text(`已聚焦元素：${params.elementId}`), details: result };
      } catch (error) {
        return {
          content: text(`聚焦异常：${error instanceof Error ? error.message : String(error)}`),
          details: { error: String(error) },
        };
      }
    },
  };
}

export function windowsInvokeTool(_ctx: ToolContext): AgentTool<typeof invokeParams> {
  return {
    name: "windows_invoke",
    label: "调用元素",
    description: "优先使用 UIA Invoke/Toggle/SelectionItem/ExpandCollapse 模式操作元素，必要时可回退点击。",
    parameters: invokeParams,
    execute: async (_id, params: Static<typeof invokeParams>) => {
      try {
        const result = await window.polaragent.computeruse.invoke({
          fallbackClick: true,
          ...params,
        });
        if (!result.ok) return { content: text(`调用失败：${result.error || "未知错误"}`), details: result };
        return { content: text(`调用成功：${params.elementId} (${result.method || "Pattern"})`), details: result };
      } catch (error) {
        return {
          content: text(`调用异常：${error instanceof Error ? error.message : String(error)}`),
          details: { error: String(error) },
        };
      }
    },
  };
}

export function windowsSetValueTool(_ctx: ToolContext): AgentTool<typeof setValueParams> {
  return {
    name: "windows_set_value",
    label: "设置元素值",
    description: "优先使用 UIA ValuePattern 设置输入框值，无 ValuePattern 时可回退为聚焦后输入。",
    parameters: setValueParams,
    execute: async (_id, params: Static<typeof setValueParams>) => {
      try {
        const result = await window.polaragent.computeruse.setValue({
          fallbackType: true,
          restoreClipboard: params.restoreClipboard ?? computerUseDefaults()?.restoreClipboard ?? true,
          ...params,
        });
        if (!result.ok) return { content: text(`设置值失败：${result.error || "未知错误"}`), details: result };
        return { content: text(`设置值成功：${params.elementId} (${params.value.length} 个字符)`), details: result };
      } catch (error) {
        return {
          content: text(`设置值异常：${error instanceof Error ? error.message : String(error)}`),
          details: { error: String(error) },
        };
      }
    },
  };
}

export function windowsActivateWindowTool(_ctx: ToolContext): AgentTool<typeof activateWindowParams> {
  return {
    name: "windows_activate_window",
    label: "激活窗口",
    description: "按窗口标题、进程 ID 或 HWND 激活目标窗口，便于后续桌面操作。",
    parameters: activateWindowParams,
    execute: async (_id, params: Static<typeof activateWindowParams>) => {
      if (!params.windowTitle && params.processId == null && params.nativeWindowHandle == null) {
        return { content: text("必须提供 windowTitle、processId 或 nativeWindowHandle"), details: { error: "缺少参数" } };
      }
      try {
        const result = await window.polaragent.computeruse.activateWindow(params);
        if (!result.ok) return { content: text(`激活窗口失败：${result.error || "未知错误"}`), details: result };
        return { content: text("窗口已激活"), details: result };
      } catch (error) {
        return {
          content: text(`激活窗口异常：${error instanceof Error ? error.message : String(error)}`),
          details: { error: String(error) },
        };
      }
    },
  };
}

export function windowsWaitTool(_ctx: ToolContext): AgentTool<typeof waitParams> {
  return {
    name: "windows_wait",
    label: "等待",
    description: "等待指定毫秒数，用于窗口动画、加载或焦点切换后再继续观察。",
    parameters: waitParams,
    execute: async (_id, params: Static<typeof waitParams>) => {
      try {
        const result = await window.polaragent.computeruse.wait({
          milliseconds: params.milliseconds ?? 500,
        });
        if (!result.ok) return { content: text(`等待失败：${result.error || "未知错误"}`), details: result };
        return { content: text(`已等待 ${(result as any).milliseconds ?? params.milliseconds ?? 500}ms`), details: result };
      } catch (error) {
        return {
          content: text(`等待异常：${error instanceof Error ? error.message : String(error)}`),
          details: { error: String(error) },
        };
      }
    },
  };
}

export function windowsDragTool(_ctx: ToolContext): AgentTool<typeof dragParams> {
  return {
    name: "windows_drag",
    label: "Windows 拖拽",
    description: "按路径执行鼠标拖拽，适合拖动文件、滑块或调整窗口大小。",
    parameters: dragParams,
    execute: async (_id, params: Static<typeof dragParams>) => {
      if (params.path.length < 2) {
        return { content: text("拖拽路径至少需要两个点"), details: { error: "路径过短" } };
      }
      try {
        const result = await window.polaragent.computeruse.drag({
          ...params,
          button: params.button || "left",
        });
        if (!result.ok) return { content: text(`拖拽失败：${result.error || "未知错误"}`), details: result };
        return { content: text(`拖拽成功：${params.path.length} 个路径点`), details: result };
      } catch (error) {
        return {
          content: text(`拖拽异常：${error instanceof Error ? error.message : String(error)}`),
          details: { error: String(error) },
        };
      }
    },
  };
}

export function windowsBatchTool(_ctx: ToolContext): AgentTool<typeof batchParams> {
  return {
    name: "windows_batch",
    label: "Windows 批量操作",
    description:
      "按顺序执行多个 Computer Use 动作，复用常驻 Worker，减少多轮工具调用开销。适合连续的聚焦、设置值、调用、等待、再观察流程。",
    parameters: batchParams,
    execute: async (_id, params: Static<typeof batchParams>) => {
      if (!params.actions.length) {
        return { content: text("至少需要 1 个批量动作"), details: { error: "缺少 actions" } };
      }
      try {
        const result = await window.polaragent.computeruse.batch({
          actions: params.actions,
          stopOnError: params.stopOnError ?? true,
        });
        const summary = result.results
          .map((item, index) => `${index + 1}. ${item.action}: ${item.ok ? "成功" : `失败 - ${item.error || "未知错误"}`}`)
          .join("\n");
        return {
          content: text(`${result.ok ? "批量操作完成" : "批量操作中断"}（${result.count} 个动作）\n${summary}`),
          details: result,
        };
      } catch (error) {
        return {
          content: text(`批量操作异常：${error instanceof Error ? error.message : String(error)}`),
          details: { error: String(error) },
        };
      }
    },
  };
}

// 构建 UI 树摘要（递归遍历，限制深度）
function buildTreeSummary(node: any, depth = 0, maxDepth = 3): string {
  if (depth >= maxDepth) return "";

  const indent = "  ".repeat(depth);
  const name = node.name || "(无名称)";
  const type = node.controlType || "Unknown";
  const id = node.id || "";
  const bbox = node.boundingBox
    ? ` @ (${node.boundingBox.x},${node.boundingBox.y})`
    : "";

  let result = `${indent}- ${name} [${type}] ${id}${bbox}\n`;

  if (node.children && node.children.length > 0) {
    const childrenToShow = node.children.slice(0, 10); // 只显示前 10 个子元素
    for (const child of childrenToShow) {
      result += buildTreeSummary(child, depth + 1, maxDepth);
    }
    if (node.children.length > 10) {
      result += `${indent}  ... (还有 ${node.children.length - 10} 个子元素)\n`;
    }
  }

  return result;
}
