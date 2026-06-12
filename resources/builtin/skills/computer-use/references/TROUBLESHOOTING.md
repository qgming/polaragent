# 问题排查指南

## 常见问题和解决方案

### 问题1: 元素找不到

**症状**
```
windows_find 返回 count: 0
```

**原因**
- 元素尚未加载
- 元素在视图外（offscreen）
- 查询字符串不匹配
- 使用了错误的 viewMode

**解决方案**

1. **等待加载**
```typescript
// 添加等待
await window.polaragent.computeruse.wait({ 
  milliseconds: 1000 
});
const result = await windows_find({ query: "按钮" });
```

2. **检查是否 offscreen**
```typescript
const result = await windows_find({ 
  query: "按钮",
  includeOffscreen: true  // 包含不可见元素
});
```

3. **尝试不同的查询**
```typescript
// 尝试部分匹配
await windows_find({ query: "确" });  // 而不是"确定"

// 或者查询控件类型
await windows_find({ 
  query: "Button",
  controlType: "Button" 
});
```

4. **使用 snapshot 查看完整树**
```typescript
const snapshot = await windows_snapshot({ 
  maxDepth: 8,
  maxNodes: 500 
});
// 检查树结构，找到正确的元素名称
```

### 问题2: 元素 ID 失效

**症状**
```
Error: Element path 'uia:active.0.2' is stale
```

**原因**
- UI 发生变化（动画、加载等）
- 窗口重绘
- 使用了旧的 snapshot

**解决方案**

1. **重新获取 snapshot**
```typescript
// 每次操作前重新获取
const snapshot = await windows_snapshot();
const elements = await windows_find({ query: "按钮" });
await windows_click({ elementId: elements.results[0].id });
```

2. **使用坐标作为备选**
```typescript
try {
  await windows_click({ elementId: oldId });
} catch (error) {
  // 备选：使用坐标
  await windows_click({ x: 100, y: 200 });
}
```

### 问题3: Windows 键错误

**症状**
```
Error: The Windows key is not supported
```

**原因**
- 尝试使用 Win 键

**解决方案**

使用替代方案：
```typescript
// ❌ 不要使用
await windows_keypress({ keys: ["Win", "R"] });

// ✅ 使用替代
await windows_keypress({ keys: ["Ctrl", "Esc"] });  // 开始菜单
await windows_keypress({ keys: ["Alt", "Tab"] });    // 切换窗口
```

### 问题4: 点击无效

**症状**
- 点击成功返回，但没有效果

**原因**
- 点击了错误的元素
- 元素被遮挡
- 需要先获得焦点
- 需要双击而不是单击

**解决方案**

1. **验证元素位置**
```typescript
const info = await window.polaragent.computeruse.elementInfo({
  elementId: element.id
});
console.log(info.element.boundingBox);  // 检查位置
```

2. **先移动鼠标再点击**
```typescript
await windows_move({ elementId: element.id });
await window.polaragent.computeruse.wait({ milliseconds: 200 });
await windows_click({ elementId: element.id });
```

3. **使用双击**
```typescript
await windows_double_click({ elementId: element.id });
```

4. **使用底层 invoke**
```typescript
await window.polaragent.computeruse.invoke({
  elementId: element.id
});
```

### 问题5: 输入文本失败

**症状**
- 文本没有输入到目标控件

**原因**
- 控件没有焦点
- 控件是只读的
- 需要先清空

**解决方案**

1. **先点击获得焦点**
```typescript
await windows_click({ elementId: inputBox.id });
await window.polaragent.computeruse.wait({ milliseconds: 100 });
await windows_type({ text: "内容" });
```

2. **先清空再输入**
```typescript
await windows_click({ elementId: inputBox.id });
await windows_keypress({ keys: ["Ctrl", "A"] });  // 全选
await windows_type({ text: "新内容" });
```

3. **使用 set_value（底层）**
```typescript
await window.polaragent.computeruse.setValue({
  elementId: inputBox.id,
  value: "内容"
});
```

### 问题6: 窗口切换失败

**症状**
- 窗口没有切换到前台

**原因**
- 窗口最小化
- 使用了错误的窗口标识

**解决方案**

1. **使用 nativeWindowHandle**
```typescript
const windows = await windows_list_windows();
const target = windows.windows.find(w => 
  w.name.includes("Chrome")
);

await window.polaragent.computeruse.activateWindow({
  nativeWindowHandle: target.nativeWindowHandle,
  activate: true
});
```

2. **多次尝试激活**
```typescript
for (let i = 0; i < 3; i++) {
  await window.polaragent.computeruse.activateWindow({
    windowTitle: "Chrome"
  });
  await window.polaragent.computeruse.wait({ 
    milliseconds: 500 
  });
}
```

### 问题7: 滚动无效

**症状**
- 滚动命令成功但界面没有滚动

**原因**
- 滚动了错误的元素
- 元素不可滚动
- 需要更大的 deltaY 值

**解决方案**

1. **增大滚动距离**
```typescript
await windows_scroll({
  elementId: element.id,
  deltaY: 1000  // 增大值
});
```

2. **滚动窗口而不是元素**
```typescript
const snapshot = await windows_snapshot();
await windows_scroll({
  elementId: snapshot.tree.id,  // 根元素
  deltaY: 480
});
```

3. **使用按键滚动**
```typescript
await windows_keypress({ keys: ["PageDown"] });
// 或
await windows_keypress({ keys: ["Down"] });
```

## 调试技巧

### 技巧1: 查看完整 UI 树

```typescript
const snapshot = await windows_snapshot({
  scope: "active_window",
  maxDepth: 10,
  maxNodes: 1000,
  detailLevel: "full"
});

console.log(JSON.stringify(snapshot.tree, null, 2));
```

### 技巧2: 使用截图辅助调试

```typescript
const snapshot = await windows_snapshot({
  includeScreenshot: true
});

// 截图 base64 可以保存为文件或在浏览器中查看
console.log(`data:image/png;base64,${snapshot.screenshot.base64}`);
```

### 技巧3: 记录操作步骤

```typescript
async function loggedOperation(name, operation) {
  console.log(`[${new Date().toISOString()}] 开始: ${name}`);
  try {
    const result = await operation();
    console.log(`[${new Date().toISOString()}] 成功: ${name}`);
    return result;
  } catch (error) {
    console.error(`[${new Date().toISOString()}] 失败: ${name}`, error);
    throw error;
  }
}

// 使用
await loggedOperation("点击按钮", async () => {
  await windows_click({ elementId: button.id });
});
```

### 技巧4: 健康检查

在开始操作前检查系统状态：

```typescript
const health = await window.polaragent.computeruse.health();
if (!health.ok) {
  throw new Error("Computer Use 不可用");
}
```

## 性能问题

### 问题: 操作很慢

**原因**
- 每次都获取完整截图
- maxNodes 设置过大
- maxDepth 设置过大

**解决方案**

1. **使用 accessibility_tree 而不是 snapshot**
```typescript
// 不需要截图时
const tree = await windows_accessibility_tree({
  maxDepth: 5,
  maxNodes: 200
});
```

2. **减少树的大小**
```typescript
const snapshot = await windows_snapshot({
  maxDepth: 3,    // 从 5 减少到 3
  maxNodes: 100   // 从 250 减少到 100
});
```

3. **使用 find 直接定位**
```typescript
// 而不是获取整个树后遍历
const result = await windows_find({ 
  query: "按钮",
  maxResults: 1 
});
```

## 兼容性问题

### 某些应用不支持 UI Automation

**不支持的应用类型**
- 某些游戏（使用 DirectX 自绘）
- 某些自定义 UI 框架
- Java Swing 应用（需要 Java Access Bridge）

**解决方案**
- 使用坐标点击而不是元素 ID
- 使用截图识别（需要额外工具）
- 使用应用的键盘快捷键

### 需要管理员权限的应用

**症状**
- 无法获取 UI 树
- 操作无效

**解决方案**
- 以管理员权限运行 PolarAgent
- 或者不操作需要管理员权限的窗口

## 错误代码速查

| 错误消息 | 原因 | 解决方案 |
|---------|------|---------|
| `Element path is stale` | 元素 ID 失效 | 重新获取 snapshot |
| `Windows key is not supported` | 使用了 Win 键 | 使用 Ctrl+Esc 等替代 |
| `No clickable bounding box` | 元素不可见或无边界 | 检查元素是否存在 |
| `No top-level window matched` | 窗口未找到 | 检查窗口标题或 PID |
| `Operation timed out` | 超时 | 增加 timeout 或检查系统负载 |

## 获取帮助

如果以上方法都无法解决问题：

1. 检查 `resources/builtin/computeruse/` 下的其他文档
2. 使用健康检查确认系统可用
3. 查看详细的错误堆栈
4. 尝试在不同的应用中测试相同操作
