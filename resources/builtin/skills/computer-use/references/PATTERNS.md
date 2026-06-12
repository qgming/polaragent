# 常见操作模式和技巧

## 基础模式

### 模式1: 观察-定位-操作

最常用的基本模式，适用于大多数场景。

```typescript
// 1. 观察
const snapshot = await windows_snapshot({
  scope: "active_window",
  maxDepth: 5
});

// 2. 定位
const button = await windows_find({
  query: "确定",
  maxResults: 1
});

// 3. 操作
await windows_click({
  elementId: button.results[0].id
});
```

### 模式2: 窗口切换-操作

需要在多个窗口间切换时。

```typescript
// 1. 列出窗口
const windows = await windows_list_windows();

// 2. 找到目标窗口
const target = windows.windows.find(w => 
  w.name.includes("Chrome")
);

// 3. 激活窗口
await window.polaragent.computeruse.activateWindow({
  nativeWindowHandle: target.nativeWindowHandle
});

// 4. 操作
await windows_snapshot();
```

### 模式3: 批量元素操作

处理多个相似元素。

```typescript
// 1. 查找所有元素
const elements = await windows_find({
  query: "CheckBox",
  maxResults: 20
});

// 2. 批量操作
for (const element of elements.results) {
  await windows_click({ elementId: element.id });
  // 可选：等待动画
  await window.polaragent.computeruse.wait({ 
    milliseconds: 200 
  });
}
```

## 高级模式

### 模式4: 等待元素出现

处理动态加载的内容。

```typescript
async function waitForElement(query, timeout = 10000) {
  const start = Date.now();
  
  while (Date.now() - start < timeout) {
    const result = await windows_find({ 
      query, 
      maxResults: 1 
    });
    
    if (result.count > 0) {
      return result.results[0];
    }
    
    // 等待 500ms 后重试
    await window.polaragent.computeruse.wait({ 
      milliseconds: 500 
    });
  }
  
  throw new Error(`元素未在 ${timeout}ms 内出现: ${query}`);
}

// 使用
const button = await waitForElement("提交");
await windows_click({ elementId: button.id });
```

### 模式5: 表单填写

自动填写复杂表单。

```typescript
const formData = {
  "用户名": "admin",
  "密码": "password123",
  "邮箱": "admin@example.com"
};

// 1. 获取窗口
const snapshot = await windows_snapshot();

// 2. 遍历表单字段
for (const [label, value] of Object.entries(formData)) {
  // 查找标签
  const labelElement = await windows_find({ 
    query: label, 
    maxResults: 1 
  });
  
  // 查找附近的输入框
  const inputs = await windows_find({ 
    query: "Edit",
    maxResults: 10 
  });
  
  // 点击第一个输入框
  await windows_click({ elementId: inputs.results[0].id });
  
  // 清空并输入
  await windows_keypress({ keys: ["Ctrl", "A"] });
  await windows_type({ text: value });
}

// 提交
const submit = await windows_find({ query: "提交" });
await windows_click({ elementId: submit.results[0].id });
```

### 模式6: 树形导航

展开和遍历树形结构。

```typescript
async function navigateTree(path) {
  // path = ["根节点", "子节点", "目标节点"]
  
  for (const nodeName of path) {
    // 查找节点
    const node = await windows_find({ 
      query: nodeName,
      maxResults: 1 
    });
    
    if (node.count === 0) {
      throw new Error(`节点未找到: ${nodeName}`);
    }
    
    // 双击展开（或单击选中）
    await windows_double_click({ 
      elementId: node.results[0].id 
    });
    
    // 等待展开动画
    await window.polaragent.computeruse.wait({ 
      milliseconds: 300 
    });
  }
}

// 使用
await navigateTree(["我的电脑", "C盘", "Users"]);
```

### 模式7: 滚动查找

在长列表中查找元素。

```typescript
async function scrollAndFind(query, maxAttempts = 10) {
  for (let i = 0; i < maxAttempts; i++) {
    // 尝试查找
    const result = await windows_find({ 
      query, 
      maxResults: 1 
    });
    
    if (result.count > 0) {
      return result.results[0];
    }
    
    // 向下滚动
    const snapshot = await windows_snapshot();
    await windows_scroll({
      elementId: snapshot.tree.id,
      deltaY: 480  // 向下滚动
    });
    
    // 等待内容加载
    await window.polaragent.computeruse.wait({ 
      milliseconds: 300 
    });
  }
  
  throw new Error(`滚动 ${maxAttempts} 次后仍未找到: ${query}`);
}

// 使用
const item = await scrollAndFind("目标项");
await windows_click({ elementId: item.id });
```

## 实用技巧

### 技巧1: 使用相对位置

当元素难以直接定位时，通过已知元素定位。

```typescript
// 1. 找到标签
const label = await windows_find({ 
  query: "用户名", 
  maxResults: 1 
});

// 2. 获取详细树结构
const tree = await windows_accessibility_tree({ 
  maxDepth: 8 
});

// 3. 在树中找到标签的兄弟节点（输入框）
// （需要遍历树结构，找到 label 的父节点，再找输入框子节点）
```

### 技巧2: 快速重试

失败时快速重试，提高成功率。

```typescript
async function retryOperation(operation, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await operation();
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      
      // 等待后重试
      await window.polaragent.computeruse.wait({ 
        milliseconds: 500 
      });
    }
  }
}

// 使用
await retryOperation(async () => {
  const button = await windows_find({ query: "确定" });
  await windows_click({ elementId: button.results[0].id });
});
```

### 技巧3: 截图对比

验证操作结果。

```typescript
// 操作前
const before = await windows_snapshot();

// 执行操作
await windows_click({ elementId: someButton.id });

// 等待
await window.polaragent.computeruse.wait({ 
  milliseconds: 500 
});

// 操作后
const after = await windows_snapshot();

// 对比（检查 UI 树是否变化）
const changed = JSON.stringify(before.tree) !== 
                JSON.stringify(after.tree);
```

### 技巧4: 键盘导航

使用键盘快速导航。

```typescript
// Tab 键在表单字段间切换
await windows_keypress({ keys: ["Tab"] });
await windows_type({ text: "值1" });

await windows_keypress({ keys: ["Tab"] });
await windows_type({ text: "值2" });

await windows_keypress({ keys: ["Tab"] });
await windows_type({ text: "值3" });

// Enter 提交
await windows_keypress({ keys: ["Enter"] });
```

### 技巧5: 复制粘贴数据

处理大量文本或特殊字符。

```typescript
// 对于长文本或特殊字符，使用复制粘贴
const longText = "很长的文本...";

// 1. 先复制到剪贴板（通过其他方式）
// 2. 然后粘贴
await windows_keypress({ keys: ["Ctrl", "V"] });

// 或者直接使用 type（已内置剪贴板支持）
await windows_type({ text: longText });
```

## 错误处理模式

### 模式8: 优雅降级

当首选方法失败时，尝试备选方法。

```typescript
async function clickElement(elementId) {
  try {
    // 首选：使用元素 ID
    await windows_click({ elementId });
  } catch (error) {
    // 备选：获取元素位置后点击坐标
    const info = await window.polaragent.computeruse.elementInfo({
      elementId
    });
    
    if (info.element.boundingBox) {
      await windows_click({
        x: info.element.boundingBox.centerX,
        y: info.element.boundingBox.centerY
      });
    } else {
      throw new Error("元素无法点击");
    }
  }
}
```

### 模式9: 状态检查

操作前检查状态，避免无效操作。

```typescript
async function ensureWindowActive(windowTitle) {
  const windows = await windows_list_windows();
  const target = windows.windows.find(w => 
    w.name.includes(windowTitle)
  );
  
  if (!target) {
    throw new Error(`窗口未找到: ${windowTitle}`);
  }
  
  // 激活窗口
  await window.polaragent.computeruse.activateWindow({
    nativeWindowHandle: target.nativeWindowHandle
  });
  
  // 验证
  const snapshot = await windows_snapshot();
  if (!snapshot.tree.name.includes(windowTitle)) {
    throw new Error("窗口激活失败");
  }
}
```

## 性能优化

### 1. 减少截图调用
```typescript
// ❌ 不好：频繁获取截图
for (let i = 0; i < 10; i++) {
  const snapshot = await windows_snapshot();
  // ...
}

// ✅ 好：使用 accessibility_tree
for (let i = 0; i < 10; i++) {
  const tree = await windows_accessibility_tree();
  // ...
}
```

### 2. 控制树的深度和节点数
```typescript
// ✅ 只需要基本信息时
await windows_snapshot({
  maxDepth: 3,  // 减少深度
  maxNodes: 100  // 减少节点数
});
```

### 3. 使用查找而不是遍历
```typescript
// ❌ 不好：获取整个树后遍历
const tree = await windows_snapshot({ maxNodes: 1000 });
// 手动遍历查找...

// ✅ 好：直接查找
const result = await windows_find({ query: "按钮" });
```
