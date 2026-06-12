# 使用场景示例

## 场景 1：在记事本输入文本

```typescript
// 1. 观察当前窗口
const snapshot = windows_snapshot()

// 2. 查找编辑框
const elements = windows_find({ query: "Edit", controlType: "Edit" })

// 3. 使用 UIA 设置值（推荐）
windows_set_value({ 
  elementId: elements[0].id, 
  value: "Hello World\n这是第二行" 
})

// 或者：先聚焦再输入
windows_focus({ elementId: elements[0].id })
windows_type({ text: "Hello World" })

// 4. 保存文件
windows_keypress({ keys: ["Ctrl", "S"] })

// 5. 等待保存对话框
windows_wait({ milliseconds: 500 })

// 6. 验证
const result = windows_snapshot()
```

---

## 场景 2：打开开始菜单并启动应用

```typescript
// 1. 打开开始菜单（不能用 Win 键）
windows_keypress({ keys: ["Ctrl", "Esc"] })

// 2. 等待菜单出现
windows_wait({ milliseconds: 300 })

// 3. 输入应用名
windows_type({ text: "Chrome" })

// 4. 等待搜索结果
windows_wait({ milliseconds: 500 })

// 5. 按回车启动
windows_keypress({ keys: ["Enter"] })
```

---

## 场景 3：切换窗口

**方法 1：使用快捷键**
```typescript
// Alt+Tab 切换
windows_keypress({ keys: ["Alt", "Tab"] })
windows_wait({ milliseconds: 200 })
windows_keypress({ keys: ["Enter"] })
```

**方法 2：列出窗口并激活**
```typescript
// 1. 列出所有窗口
const windows = windows_list_windows()

// 2. 找到目标窗口（如 Chrome）
const chrome = windows.windows.find(w => w.name.includes("Chrome"))

// 3. 激活窗口
if (chrome) {
  windows_activate_window({ 
    nativeWindowHandle: chrome.nativeWindowHandle 
  })
}

// 4. 等待窗口激活
windows_wait({ milliseconds: 300 })
```

---

## 场景 4：填写表单

```typescript
// 1. 获取窗口状态
const snapshot = windows_snapshot()

// 2. 找到所有输入框
const inputs = windows_find({ 
  query: "",  // 空查询匹配所有
  controlType: "Edit",
  maxResults: 10 
})

// 3. 定义表单数据
const formData = [
  "张三",
  "zhangsan@example.com",
  "13800138000",
  "北京市朝阳区"
]

// 4. 使用 batch 批量填写
windows_batch({
  actions: inputs.slice(0, formData.length).flatMap((input, i) => [
    { action: "focus", args: { elementId: input.id } },
    { action: "setValue", args: { elementId: input.id, value: formData[i] } },
    { action: "wait", args: { milliseconds: 100 } }
  ])
})

// 5. 查找并点击提交按钮
const submitBtn = windows_find({ query: "提交" })
windows_invoke({ elementId: submitBtn[0].id })
```

---

## 场景 5：浏览器操作

```typescript
// 1. 激活 Chrome 窗口
windows_activate_window({ windowTitle: "Chrome" })
windows_wait({ milliseconds: 300 })

// 2. 打开新标签页
windows_keypress({ keys: ["Ctrl", "T"] })
windows_wait({ milliseconds: 200 })

// 3. 输入 URL
windows_type({ text: "https://example.com" })
windows_keypress({ keys: ["Enter"] })

// 4. 等待页面加载
windows_wait({ milliseconds: 2000 })

// 5. 截图验证
windows_snapshot()
```

---

## 场景 6：复制粘贴文本

```typescript
// 1. 选中文本（假设已有文本在输入框中）
windows_keypress({ keys: ["Ctrl", "A"] })

// 2. 复制
windows_keypress({ keys: ["Ctrl", "C"] })

// 3. 切换到另一个窗口
windows_activate_window({ windowTitle: "记事本" })
windows_wait({ milliseconds: 300 })

// 4. 粘贴
windows_keypress({ keys: ["Ctrl", "V"] })
```

---

## 场景 7：文件管理器操作

```typescript
// 1. 打开文件管理器
windows_keypress({ keys: ["Ctrl", "Esc"] })
windows_wait({ milliseconds: 300 })
windows_type({ text: "文件资源管理器" })
windows_keypress({ keys: ["Enter"] })
windows_wait({ milliseconds: 500 })

// 2. 导航到特定文件夹（使用地址栏）
windows_keypress({ keys: ["Alt", "D"] })  // 聚焦地址栏
windows_type({ text: "C:\\Users\\Documents" })
windows_keypress({ keys: ["Enter"] })
windows_wait({ milliseconds: 500 })

// 3. 创建新文件夹
windows_keypress({ keys: ["Ctrl", "Shift", "N"] })
windows_wait({ milliseconds: 300 })
windows_type({ text: "新文件夹" })
windows_keypress({ keys: ["Enter"] })
```

---

## 场景 8：右键菜单操作

```typescript
// 1. 获取快照找到目标元素
const snapshot = windows_snapshot()
const target = windows_find({ query: "文件名" })

// 2. 右键点击
windows_click({ 
  elementId: target[0].id, 
  button: "right" 
})

// 3. 等待菜单出现
windows_wait({ milliseconds: 200 })

// 4. 找到菜单项
const menuItem = windows_find({ query: "属性" })

// 5. 点击菜单项
windows_invoke({ elementId: menuItem[0].id })
```

---

## 场景 9：处理对话框

```typescript
// 1. 触发操作（如删除文件）
windows_keypress({ keys: ["Delete"] })

// 2. 等待确认对话框
windows_wait({ milliseconds: 300 })

// 3. 获取对话框状态
const dialog = windows_snapshot()

// 4. 查找确认按钮
const confirmBtn = windows_find({ query: "是" })

// 5. 点击确认
windows_invoke({ elementId: confirmBtn[0].id })
```

---

## 场景 10：滚动和查找元素

```typescript
// 1. 获取窗口状态
const snapshot = windows_snapshot()

// 2. 找到滚动区域
const scrollArea = windows_find({ 
  query: "列表", 
  controlType: "List" 
})

// 3. 滚动向下
windows_scroll({ 
  elementId: scrollArea[0].id, 
  deltaY: -100 
})

// 4. 等待内容加载
windows_wait({ milliseconds: 500 })

// 5. 再次查找目标元素
const target = windows_find({ query: "目标项" })

// 6. 如果找到就点击
if (target.length > 0) {
  windows_invoke({ elementId: target[0].id })
}
```

---

## 场景 11：批量操作多个窗口

```typescript
// 1. 列出所有窗口
const allWindows = windows_list_windows()

// 2. 过滤出特定应用的窗口
const chromeWindows = allWindows.windows.filter(w => 
  w.name.includes("Chrome")
)

// 3. 对每个窗口执行操作
for (const win of chromeWindows) {
  // 激活窗口
  windows_activate_window({ 
    nativeWindowHandle: win.nativeWindowHandle 
  })
  windows_wait({ milliseconds: 300 })
  
  // 关闭标签页
  windows_keypress({ keys: ["Ctrl", "W"] })
  windows_wait({ milliseconds: 200 })
}
```

---

## 场景 12：等待元素出现

```typescript
function waitForElement(query, maxRetries = 10) {
  for (let i = 0; i < maxRetries; i++) {
    const elements = windows_find({ query })
    
    if (elements.length > 0) {
      return { success: true, element: elements[0] }
    }
    
    // 等待 500ms 后重试
    windows_wait({ milliseconds: 500 })
  }
  
  return { success: false }
}

// 使用
const result = waitForElement("保存按钮")
if (result.success) {
  windows_invoke({ elementId: result.element.id })
}
```

---

## 场景 13：复杂表单填写（使用 batch）

```typescript
// 定义表单操作序列
const formActions = [
  // 填写用户名
  { action: "focus", args: { elementId: "uia:active.0.1" } },
  { action: "setValue", args: { elementId: "uia:active.0.1", value: "张三" } },
  { action: "wait", args: { milliseconds: 100 } },
  
  // 填写邮箱
  { action: "focus", args: { elementId: "uia:active.0.2" } },
  { action: "setValue", args: { elementId: "uia:active.0.2", value: "user@example.com" } },
  { action: "wait", args: { milliseconds: 100 } },
  
  // 填写电话
  { action: "focus", args: { elementId: "uia:active.0.3" } },
  { action: "setValue", args: { elementId: "uia:active.0.3", value: "13800138000" } },
  { action: "wait", args: { milliseconds: 100 } },
  
  // 勾选同意协议
  { action: "invoke", args: { elementId: "uia:active.0.4" } },
  { action: "wait", args: { milliseconds: 100 } },
  
  // 点击提交
  { action: "invoke", args: { elementId: "uia:active.0.5" } }
]

// 批量执行
windows_batch({ actions: formActions })

// 验证结果
windows_wait({ milliseconds: 500 })
windows_snapshot()
```

---

## 场景 14：截图和验证

```typescript
// 1. 执行操作前截图
const before = windows_snapshot({ 
  scope: "active_window",
  screenshotMode: "path" 
})

// 2. 执行操作
windows_click({ elementId: "uia:active.0.1" })
windows_wait({ milliseconds: 500 })

// 3. 操作后截图
const after = windows_snapshot({ 
  scope: "active_window",
  screenshotMode: "path" 
})

// 4. 对比截图路径
console.log("操作前:", before.screenshot.path)
console.log("操作后:", after.screenshot.path)
```

---

## 场景 15：桌面级操作

```typescript
// 1. 获取整个桌面状态
const desktop = windows_snapshot({ scope: "desktop" })

// 2. 找到桌面上的图标
const icons = windows_find({ 
  query: "Chrome",
  scope: "desktop",
  controlType: "Button"
})

// 3. 双击启动
if (icons.length > 0) {
  windows_double_click({ elementId: icons[0].id })
  windows_wait({ milliseconds: 1000 })
}
```

---

## 场景 16：处理多层嵌套 UI

```typescript
// 1. 深度扫描
const snapshot = windows_snapshot({ 
  maxDepth: 10,
  maxNodes: 1000 
})

// 2. 查找深层元素
const deepElement = windows_find({ 
  query: "目标控件",
  maxDepth: 10,
  maxNodes: 1000 
})

// 3. 操作元素
windows_invoke({ elementId: deepElement[0].id })
```

---

## 场景 17：错误恢复和重试

```typescript
function safeInvoke(elementId, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      windows_invoke({ elementId })
      return { success: true }
    } catch (error) {
      if (i === retries - 1) {
        // 最后一次失败，尝试点击
        try {
          windows_click({ elementId })
          return { success: true, method: "click" }
        } catch (clickError) {
          // 截图保存现场
          windows_snapshot()
          return { success: false, error: clickError.message }
        }
      }
      
      // 等待后重试
      windows_wait({ milliseconds: 500 })
      
      // 重新获取元素
      windows_snapshot()
    }
  }
}
```

---

## 场景 18：组合操作模式

```typescript
// 定义可复用的操作模式
function fillInput(elementId, value) {
  return [
    { action: "focus", args: { elementId } },
    { action: "setValue", args: { elementId, value } },
    { action: "wait", args: { milliseconds: 100 } }
  ]
}

function clickButton(elementId) {
  return [
    { action: "invoke", args: { elementId } },
    { action: "wait", args: { milliseconds: 200 } }
  ]
}

// 组合使用
const actions = [
  ...fillInput("uia:active.0.1", "用户名"),
  ...fillInput("uia:active.0.2", "密码"),
  ...clickButton("uia:active.0.3")
]

windows_batch({ actions })
```

---

## 场景 19：处理树形控件

```typescript
// 1. 找到树节点
const treeNode = windows_find({ 
  query: "文件夹",
  controlType: "TreeItem" 
})

// 2. 展开节点（invoke 会切换展开/折叠状态）
windows_invoke({ elementId: treeNode[0].id })
windows_wait({ milliseconds: 300 })

// 3. 重新扫描找子节点
windows_snapshot()
const childNodes = windows_find({ 
  query: "子文件夹",
  controlType: "TreeItem" 
})

// 4. 选择子节点
windows_invoke({ elementId: childNodes[0].id })
```

---

## 场景 20：多显示器支持

```typescript
// 1. 桌面级快照（覆盖所有显示器）
const desktop = windows_snapshot({ scope: "desktop" })

// 2. 使用坐标点击（可以跨显示器）
windows_click({ x: 2000, y: 500 })  // 第二个显示器的位置

// 3. 获取元素信息（含屏幕坐标）
const elementInfo = windows_element_info({ x: 2000, y: 500 })
console.log("元素位置:", elementInfo.element.boundingBox)
```
