# Computer Use Skill

控制 Windows 桌面应用程序的完整技能包。

## 核心能力

1. **观察窗口** - 获取截图、UI 树、窗口列表
2. **定位元素** - 查找按钮、输入框、菜单等 UI 元素
3. **鼠标操作** - 点击、双击、移动、滚动
4. **键盘输入** - 输入文本、按键组合
5. **窗口管理** - 切换窗口、激活应用

## 工作流程

### 标准操作流程

```
1. 观察 → windows_snapshot / windows_accessibility_tree
2. 定位 → windows_find / 使用 snapshot 返回的 elementId
3. 操作 → click / type / keypress / scroll
4. 验证 → 再次观察确认结果
```

### 最佳实践

1. **总是先观察** - 在操作前先调用 `windows_snapshot` 了解当前状态
2. **使用元素 ID** - snapshot 返回的 elementId 比坐标更可靠
3. **验证结果** - 重要操作后再次观察确认成功
4. **等待动画** - 操作后如有动画，使用 `cu:wait` 等待

## 可用工具

### 观察类
- `windows_snapshot` - 获取截图和 UI 树（推荐首选）
- `windows_accessibility_tree` - 仅获取 UI 树（更快）
- `windows_list_windows` - 列出所有窗口
- `windows_find` - 查找 UI 元素

### 鼠标操作
- `windows_click` - 单击
- `windows_double_click` - 双击
- `windows_move` - 移动鼠标
- `windows_scroll` - 滚动

### 键盘输入
- `windows_type` - 输入文本
- `windows_keypress` - 按键组合

## 使用示例

### 示例1: 在记事本输入文本

```typescript
// 1. 观察窗口
const snapshot = await windows_snapshot();

// 2. 查找编辑框
const elements = await windows_find({ query: "Edit" });

// 3. 点击获得焦点
await windows_click({ elementId: elements[0].id });

// 4. 输入文本
await windows_type({ text: "Hello World" });

// 5. 保存
await windows_keypress({ keys: ["Ctrl", "S"] });
```

### 示例2: 切换到特定窗口

```typescript
// 1. 列出所有窗口
const windows = await windows_list_windows();

// 2. 找到目标窗口（如 Chrome）
const chrome = windows.windows.find(w => w.name.includes("Chrome"));

// 3. 使用底层 IPC 激活
await window.polaragent.computeruse.activateWindow({
  nativeWindowHandle: chrome.nativeWindowHandle
});
```

### 示例3: 填写表单

```typescript
// 1. 获取窗口状态
const snapshot = await windows_snapshot();

// 2. 找到所有输入框
const inputs = await windows_find({ 
  query: "Edit",
  maxResults: 10 
});

// 3. 依次填写
for (const input of inputs) {
  await windows_click({ elementId: input.id });
  await windows_type({ text: "填写内容" });
}
```

## 重要提示

### ⚠️ Windows 键限制
- **不支持** Windows 键（Win）
- **替代方案**:
  - 开始菜单: `Ctrl+Esc`
  - 切换窗口: `Alt+Tab`
  - 任务视图: `Ctrl+Alt+Tab`

### 💡 最佳实践
- 优先使用元素 ID 而不是坐标
- 操作后等待 UI 更新再观察
- 大范围查找时增加 maxNodes 参数
- 频繁读取时使用 accessibility_tree 而不是 snapshot

### 🔍 调试技巧
- 使用 snapshot 查看完整 UI 树
- 查看元素的 controlType 和 name 属性
- 如果元素 ID 失效，重新获取 snapshot

## 参考文档

- `SHORTCUTS.md` - Windows 和常用软件快捷键大全
- `PATTERNS.md` - 常见操作模式和技巧
- `TROUBLESHOOTING.md` - 问题排查指南
