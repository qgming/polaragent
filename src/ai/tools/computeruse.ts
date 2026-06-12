// Computer Use 工具 - Windows 桌面应用控制
// src/ai/tools/computeruse.ts
//
// 基于 Windows UI Automation 实现桌面应用的观察与操作

import { Type, type Static } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";

import { text, type ToolContext } from "./tool-context";

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
});

// 输入文本参数
const typeTextParams = Type.Object({
  text: Type.String({ description: "要输入的文本" }),
});

// 按键参数
const keypressParams = Type.Object({
  keys: Type.Array(Type.String(), {
    description: "按键序列，如 ['Ctrl', 'C']",
  }),
});

// 查找元素参数
const findParams = Type.Object({
  query: Type.String({ description: "查询字符串（匹配元素名称、ID、类名）" }),
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
});

// 双击参数（与点击相同）
const doubleClickParams = clickParams;

// 移动鼠标参数
const moveParams = Type.Object({
  x: Type.Optional(Type.Number({ description: "屏幕 X 坐标" })),
  y: Type.Optional(Type.Number({ description: "屏幕 Y 坐标" })),
  elementId: Type.Optional(Type.String({ description: "UI 元素 ID" })),
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
        const result = await window.polaragent.computeruse.snapshot({
          scope: params.scope || "active_window",
          maxDepth: params.maxDepth || 5,
          maxNodes: params.maxNodes || 250,
          includeScreenshot: true,
        });

        if (!result.ok) {
          return {
            content: text(`截图失败：${result.error || "未知错误"}`),
            details: { error: result.error },
          };
        }

        // 构建 UI 树摘要
        const treeSummary = buildTreeSummary(result.tree);
        const screenshot = result.screenshot
          ? `\n\n[截图已获取: ${Math.round(result.screenshot.base64.length / 1024)}KB]`
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
      if (!params.x && !params.y && !params.elementId) {
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
          restoreClipboard: true,
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
        const result = await window.polaragent.computeruse.find({
          query: params.query,
          maxResults: params.maxResults || 25,
        });

        if (!result.ok) {
          return {
            content: text(`查找失败：${result.error || "未知错误"}`),
            details: { error: result.error },
          };
        }

        if (result.count === 0) {
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
          content: text(`找到 ${result.count} 个元素：\n\n${summary}`),
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
      if (!params.x && !params.y && !params.elementId) {
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
      if (!params.x && !params.y && !params.elementId) {
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
      if (!params.x && !params.y && !params.elementId) {
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

        if (result.count === 0) {
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
          content: text(`找到 ${result.count} 个窗口：\n\n${summary}`),
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
        const result = await window.polaragent.computeruse.tree({
          scope: params.scope || "active_window",
          maxDepth: params.maxDepth || 6,
          maxNodes: params.maxNodes || 500,
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
