---
name: widget-craft
description: PolarAgent 内置 Widget 技能。指导用 render_widget 工具在对话中渲染适配应用整体风格的交互式 Widget。该技能不再提供内置 HTML 模板，而是提供面向 widget_code 的设计规范、模式判断、安全契约、交互桥和风格令牌，默认采用 Matte Cupertino / Apple Utility Pro 风格语言。当用户要求在对话里展示卡片、统计指标、KPI、数据图表、表格、表单、任务时间线、看板、原型预览或任何交互式 UI 时使用。
license: MIT
allowed-tools: render_widget, write_file, create_directory, list_directory, read_file
metadata:
  author: PolarAgent Team
  version: "2.0.0"
  category: 创作
---

# Widget Craft

这项技能指导你用 PolarAgent 的 `render_widget` 工具在对话中渲染交互式 UI。目标是输出适配应用整体风格、安全可靠、可交互的 widget。这个技能现在是**纯规范型技能**：不再依赖内置 HTML 模板，而是通过 Markdown 文档约束你生成更通用、更一致的 `widget_code`。

## 何时使用

满足以下任一条件就启用本技能：

- 用户要求在对话中展示卡片、KPI、指标、数据图表、表格、表单、时间线、看板、原型。
- 用户描述的内容适合用交互式 UI 呈现，而不是纯 Markdown 文本。
- 需要展示结构化的数据可视化，让用户能点节点触发后续动作。
- 需要把一个微工具直接交互化，比如让用户在 widget 内填表再把结果回传给 AI。

不适用：

- 线性流程 / 关系图，优先 Markdown 的 Mermaid。
- 单纯展示一段文字或代码，直接 Markdown。
- 需要跨会话持久化的真实应用，widget 是会话内演示，不是桌面 app。

## 当前定位

`widget-craft` 现在提供的是四类能力：

1. **模式判断**：先决定是 chart / table / form / mockup / diagram / interactive 哪一类。
2. **设计规范**：统一走宿主 `--widget-*` 变量与 Matte Cupertino / Apple Utility Pro 风格。
3. **安全边界**：遵守 iframe sandbox、CSP 和 HTML 净化约束。
4. **交互桥协议**：统一用 `__WIDGET_EVENT__` 把交互上报给宿主。

## PolarAgent Widget 工作流

### 1. 先判断模式

参考 `references/WIDGET_PATTERNS.md`，先判断用户需求属于哪一类：

- `chart`
- `table`
- `form`
- `mockup`
- `diagram`
- `interactive`

### 2. 默认生成 `widget_code`

当前推荐路径：

- 优先使用 `widget_code` 现场生成完整 HTML。
- 只有在用户自己的 skill / 项目里已经维护了 `custom/...` 模板时，才考虑 `widget_path`。
- `builtin/widget-craft` 本身不再提供 `.html` 示例模板。

### 3. 套用风格令牌

所有颜色必须引用宿主注入的 `--widget-*` CSS 变量并带硬编码兜底，深浅色自动跟随 `prefers-color-scheme`。详见 `references/DESIGN_TOKENS.md`。

当前默认风格方向：

- **Matte Cupertino**：不透明表面、细边框、安静 hover。
- **Apple Utility Pro**：更像系统工具和专业工作台，而不是营销型卡片。
- **系统紫为主要强调色**：只在按钮、选中态、主图表系列、关键 hover 中使用。
- **不要玻璃态**：不使用毛玻璃、透明浮层、大面积模糊。

### 4. 遵守安全契约

- 不写 `<iframe>` `<object>` `<embed>` `<base>` `<link>` `<meta>`。
- 不写 `on*=` 行内事件属性，全用 `addEventListener`。
- 不引外链（CDN / 图片 / Web Font）。
- 完整规则见 `references/SECURITY_CONTRACT.md`。

### 5. 用事件桥上报交互

所有 widget -> 宿主的交互通过 `window.__WIDGET_EVENT__(type, payload)` 上报，`type` 用 `click` / `input` / `change` / `submit` / `custom`。详见 `references/INTERACTION_BRIDGE.md`。

### 6. 调用 render_widget

```text
render_widget:
  title: <snake_case 标题，唯一标识同 widget>
  update_mode: replace | patch
  widget_code: <完整 HTML>
  # 或在你自己的 skill 里使用 custom/... 模板
  data: { ... }
```

- 同一 widget 后续更新用相同 `title` + `update_mode: patch` 保留表单状态。
- 全新内容 / 切换布局用 `update_mode: replace`。

## 风格适配铁律

1. 必须用 `--widget-*` 变量作为颜色来源，并给每处带硬编码兜底。
2. 必须支持深浅色，`@media (prefers-color-scheme: dark)` 要覆盖模板自有强调色。
3. 默认风格是 **Matte Cupertino / Apple Utility Pro**，不是玻璃态、营销页、发光面板。
4. 字体统一走系统栈：`ui-sans-serif, system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif`。
5. 间距用 4/8 网格：4 / 8 / 12 / 16 / 24 / 32，不要 7 / 13 / 17 等野值。
6. 不要写死高度，让宿主自适应 `WIDGET_RESIZE`。
7. 不要把所有元素都堆成居中卡片，尽量做成安静、规整、可扫读的工具布局。
8. 系统紫是强调色，不是背景主色。大面积表面优先用 `--widget-card` / `--widget-surface`。

## 推荐输出策略

当用户没有指定具体布局时，优先这样思考：

- 单指标 -> 单卡，数字优先，辅助文字压低。
- 多指标 -> 两到四列紧凑网格。
- 数据表 -> 表头清晰、行 hover 克制、状态色低饱和。
- 表单 -> 清楚 label、紧凑操作区、可键盘访问。
- 时间线 / 看板 -> 工具型布局，不做海报式视觉。

## 质量检查清单

- [ ] 选型已对应到 6 类模式之一，并已检查 `references/WIDGET_PATTERNS.md`。
- [ ] 使用的是 `widget_code` 或用户自有 `custom/...` 模板，而不是依赖内置 HTML 示例。
- [ ] 颜色全部来自 `--widget-*` 或命名空间化 `--my-*`，带兜底色。
- [ ] 深色媒体查询已覆盖自有强调色。
- [ ] 4/8 网格，无野间距，无超过 12px 的圆角。
- [ ] 没有禁用标签、`on*=` 属性、外链。
- [ ] 用户交互均走 `__WIDGET_EVENT__`，输入事件带防抖。
- [ ] 表单元素带 `name` + `id`，支持 `patch` 状态恢复。
- [ ] 调用 `render_widget` 时 `title` 用 snake_case，`update_mode` 选择合理。
- [ ] 整体观感更像系统工具，而不是“AI 自动生成的彩色卡片”。

## 参考资源

- [设计令牌](references/DESIGN_TOKENS.md)：CSS 变量、字体、间距、深浅色规则。
- [安全契约](references/SECURITY_CONTRACT.md)：禁用清单、`widget_path` 与 `widget_code` 来源规则。
- [交互桥](references/INTERACTION_BRIDGE.md)：`__WIDGET_EVENT__` / `WIDGET_UPDATE` / patch 状态保留 / 高度自适应。
- [模式分类](references/WIDGET_PATTERNS.md)：6 类 widget、选型决策与推荐布局思路。
