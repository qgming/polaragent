---
name: computer-use
description: 使用 Windows UI Automation 进行桌面应用控制、窗口操作、键鼠交互和排障。
---

# Computer Use

控制 Windows 桌面应用。底层是 PowerShell + UI Automation，支持键鼠模拟、元素定位、窗口管理。

## 正常流程直接执行工具

每次开始桌面操作任务，不要先做健康检查，直接执行最贴近目标的工具。工具会自动启动 worker；worker 未常驻是正常状态，不是故障。

```typescript
windows_snapshot()
windows_find({ query: "按钮" })
windows_click({ elementId: "uia:active.0.1" })
windows_type({ text: "Hello" })
windows_keypress({ keys: ["Ctrl", "S"] })
```

只有工具调用失败、明确提示 worker 异常、用户明确要求排障时，才进入状态检查。

## 常用工具优先级

先区分三个入口：

```text
snapshot：完整观察，获取截图 + UI 树，适合首次观察、操作后验证。
accessibility_tree：仅 UI 树，适合频繁读取、不需要截图时。
find：定位元素，适合查找特定控件。
```

基础感知和按需排障：

```typescript
windows_snapshot()
windows_snapshot({ scope: "desktop" })
windows_snapshot({ maxDepth: 8, maxNodes: 500 })
windows_accessibility_tree()
windows_list_windows()
windows_find({ query: "保存按钮" })
windows_find({ query: "Edit", controlType: "Edit", maxResults: 5 })
windows_element_info({ elementId: "uia:active.0.1" })
windows_element_info({ x: 100, y: 200 })
windows_click({ elementId: "uia:active.0.1" })
windows_click({ x: 100, y: 200 })
windows_double_click({ elementId: "uia:active.0.1" })
windows_type({ text: "Hello World" })
windows_keypress({ keys: ["Ctrl", "S"] })
windows_scroll({ elementId: "uia:active.0.1", deltaY: -100 })
windows_invoke({ elementId: "uia:active.0.1" })
windows_set_value({ elementId: "uia:active.0.2", value: "新内容" })
windows_focus({ elementId: "uia:active.0.3" })
windows_activate_window({ windowTitle: "Chrome" })
windows_wait({ milliseconds: 1000 })
windows_batch({ actions: [...] })
```

推荐流程：

```text
首次观察：snapshot 获取完整状态
定位元素：find 或使用 snapshot 返回的 elementId
操作元素：click / invoke / set_value / type / keypress
验证结果：再次 snapshot 或 accessibility_tree
```

## 工作流程

### 标准操作流程

```
1. 观察 → windows_snapshot / windows_accessibility_tree
2. 定位 → windows_find / 使用 snapshot 返回的 elementId
3. 操作 → click / invoke / set_value / type / keypress
4. 验证 → 再次观察确认结果
```

### 最佳实践

1. **总是先观察** - 在操作前先调用 `windows_snapshot` 了解当前状态
2. **使用元素 ID** - elementId 比坐标更可靠
3. **优先 UIA 操作** - 对按钮用 `invoke`，对输入框用 `set_value`
4. **验证结果** - 重要操作后再次观察确认成功
5. **批量操作** - 连续动作使用 `windows_batch` 合并
6. **截图模式** - 默认 `path` 模式只返回路径，避免 base64 大数据

## 核心能力

1. **观察窗口** - 获取截图、UI 树、窗口列表
2. **定位元素** - 查找按钮、输入框、菜单等 UI 元素
3. **鼠标操作** - 点击、双击、移动、拖拽、滚动
4. **键盘输入** - 输入文本、按键组合
5. **UIA 操作** - invoke、set_value、focus（原生控件交互）
6. **窗口管理** - 切换窗口、激活应用
7. **批量动作** - 合并连续操作，减少开销

## 工具参数说明

### windows_snapshot

获取窗口截图和 UI 树。

**参数**：
- `scope` (可选) - `active_window`（默认）或 `desktop`
- `maxDepth` (可选) - UI 树深度，默认 5，范围 0-12
- `maxNodes` (可选) - 最大节点数，默认 250，范围 1-2000
- `includeScreenshot` (可选) - 是否包含截图，默认 true
- `screenshotMode` (可选) - `path`（默认，只返回路径）或 `base64`
- `viewMode` (可选) - `control`（默认）/ `content` / `raw`
- `includeOffscreen` (可选) - 是否包含屏幕外元素，默认 false
- `detailLevel` (可选) - `compact`（默认）或 `full`
- `windowTitle` / `processId` / `nativeWindowHandle` (可选) - 指定目标窗口
- `activate` (可选) - 操作前激活窗口，默认 false

**返回**：
- `tree` - UI 树结构
- `screenshot.path` - 截图文件路径
- `screenshot.base64` - Base64 图片数据（仅 base64 模式）

**示例**：
```typescript
// 活动窗口快照
windows_snapshot()

// 整个桌面快照
windows_snapshot({ scope: "desktop" })

// 深度扫描
windows_snapshot({ maxDepth: 8, maxNodes: 500 })

// 只返回截图路径
windows_snapshot({ screenshotMode: "path" })
```

### windows_accessibility_tree

仅获取 UI 树，不截图（更快）。

**参数**：同 snapshot，但无 `includeScreenshot` 和 `screenshotMode`

**返回**：UI 树结构

**使用场景**：
- 频繁读取 UI 状态
- 不需要截图时
- 性能敏感场景

### windows_find

查找 UI 元素。

**参数**：
- `query` (必需) - 查询字符串（匹配 name、automationId、className）
- `controlType` (可选) - 控件类型过滤（如 "Button"、"Edit"）
- `maxResults` (可选) - 最大结果数，默认 10
- `maxDepth` / `maxNodes` / `scope` / `windowTitle` 等同 snapshot

**返回**：匹配元素数组

**示例**：
```typescript
// 查找按钮
windows_find({ query: "保存" })

// 查找输入框
windows_find({ query: "用户名", controlType: "Edit" })

// 查找更多结果
windows_find({ query: "按钮", maxResults: 20 })
```

### windows_element_info

获取元素或坐标处控件的详细信息。

**参数**：
- `elementId` 或 `x`, `y` - 二选一
- 其他参数同 snapshot

**返回**：元素详细信息

### windows_click / windows_double_click

点击元素。

**参数**：
- `elementId` 或 `x`, `y` - 二选一
- `button` (可选) - `left`（默认）/ `right` / `middle`
- 其他参数同 snapshot

**示例**：
```typescript
// 使用元素 ID
windows_click({ elementId: "uia:active.0.1" })

// 使用坐标
windows_click({ x: 100, y: 200 })

// 右键点击
windows_click({ elementId: "uia:active.0.1", button: "right" })
```

### windows_type

输入文本。

**参数**：
- `text` (必需) - 要输入的文本
- `restoreClipboard` (可选) - 恢复剪贴板，默认 true
- 其他参数同 snapshot

**示例**：
```typescript
windows_type({ text: "Hello World" })
windows_type({ text: "测试文本", restoreClipboard: false })
```

### windows_keypress

按键组合。

**参数**：
- `keys` (必需) - 按键数组，如 `["Ctrl", "S"]`
- 其他参数同 snapshot

**示例**：
```typescript
// 保存
windows_keypress({ keys: ["Ctrl", "S"] })

// 复制
windows_keypress({ keys: ["Ctrl", "C"] })

// 多键组合
windows_keypress({ keys: ["Ctrl", "Shift", "T"] })
```

**⚠️ Windows 键限制**：
- 不支持 Windows 键（Win）
- 替代方案：
  - 开始菜单：`Ctrl+Esc`
  - 切换窗口：`Alt+Tab`
  - 任务视图：`Ctrl+Alt+Tab`

### windows_scroll

滚动元素。

**参数**：
- `elementId` 或 `x`, `y` - 二选一
- `deltaY` (可选) - 垂直滚动量，正数向下
- `deltaX` (可选) - 水平滚动量，正数向右

**示例**：
```typescript
// 向下滚动
windows_scroll({ elementId: "uia:active.0.1", deltaY: -100 })

// 向右滚动
windows_scroll({ x: 500, y: 300, deltaX: 50 })
```

### windows_invoke

使用 UIA Pattern 操作元素（推荐用于按钮、复选框、菜单项）。

**参数**：
- `elementId` (必需) - 元素 ID
- `fallbackClick` (可选) - Pattern 不可用时回退到点击，默认 true
- 其他参数同 snapshot

**使用场景**：
- 点击按钮
- 切换复选框
- 选择单选按钮
- 展开/折叠树节点

### windows_set_value

使用 ValuePattern 设置输入框内容（推荐用于输入框）。

**参数**：
- `elementId` (必需) - 元素 ID
- `value` (必需) - 要设置的值
- `fallbackType` (可选) - Pattern 不可用时回退到键盘输入，默认 true
- `restoreClipboard` (可选) - 恢复剪贴板，默认 true

**使用场景**：
- 填写输入框
- 修改文本框内容

### windows_focus

聚焦元素。

**参数**：
- `elementId` (必需) - 元素 ID

### windows_activate_window

激活窗口。

**参数**：
- `windowTitle` / `processId` / `nativeWindowHandle` - 至少一个

**示例**：
```typescript
windows_activate_window({ windowTitle: "Chrome" })
windows_activate_window({ processId: 12345 })
```

### windows_wait

等待指定时间。

**参数**：
- `milliseconds` (可选) - 等待毫秒数，默认 500

### windows_batch

批量执行动作。

**参数**：
- `actions` (必需) - 动作数组
- `stopOnError` (可选) - 遇到错误停止，默认 true
- `maxActions` (可选) - 最大动作数，默认 50

**示例**：
```typescript
windows_batch({
  actions: [
    { action: "focus", args: { elementId: "uia:active.0.1" } },
    { action: "setValue", args: { elementId: "uia:active.0.1", value: "新内容" } },
    { action: "invoke", args: { elementId: "uia:active.0.2" } },
    { action: "wait", args: { milliseconds: 500 } }
  ]
})
```

### windows_list_windows

列出所有窗口。

**参数**：
- `includeInvisible` (可选) - 包含隐藏窗口，默认 false
- `maxWindows` (可选) - 最大窗口数，默认 50

**返回**：窗口数组

## 高级用法

详见以下参考文档：
- `references/EXAMPLES.md` - 使用场景示例
- `references/PATTERNS.md` - 常见操作模式
- `references/SHORTCUTS.md` - 快捷键大全
- `references/TROUBLESHOOTING.md` - 故障排查

## 重要提示

### 💡 最佳实践

1. **优先使用元素 ID** - 比坐标更可靠
2. **优先 UIA 操作** - `invoke` 和 `set_value` 比模拟点击/输入更稳定
3. **批量操作** - 连续 2+ 动作用 `windows_batch` 合并
4. **截图模式** - 默认 `path` 模式避免大块 Base64
5. **等待动画** - 操作后使用 `windows_wait` 等待 UI 更新
6. **验证结果** - 重要操作后再次观察

### ⚠️ 限制

- 不支持 Windows 键（Win）
- 某些游戏和全屏应用可能无法控制
- 部分自绘 UI 可能无法通过 UIA 访问

### 🔍 调试技巧

- 使用 snapshot 查看完整 UI 树
- 查看元素的 controlType 和 name 属性
- 如果元素 ID 失效，重新获取 snapshot
- 使用 `detailLevel: "full"` 获取更多元素信息

## 运维入口

- 工具调用失败、worker 异常：看 `references/TROUBLESHOOTING.md`
- worker 未运行但尚未执行目标工具：不要排障，直接继续执行工具
