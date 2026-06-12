# 选择器策略和最佳实践

## 选择器优先级

根据可靠性和性能，推荐使用顺序：

### 1. ID 选择器（最可靠）

**示例**：
```typescript
browser_click({ target: "#login-button" })
browser_fill({ target: "#username", value: "user123" })
```

**优点**：
- 最快速、最可靠
- ID 在页面中唯一
- 不受页面结构变化影响

**缺点**：
- 需要元素有 ID 属性
- 某些动态页面 ID 可能变化

---

### 2. 稳定的 Class 选择器

**示例**：
```typescript
browser_click({ target: ".primary-button" })
browser_fill({ target: ".search-input", value: "query" })
```

**优点**：
- 语义清晰
- 相对稳定

**缺点**：
- Class 可能不唯一
- 需要配合其他选择器精确定位

**改进技巧**：
```typescript
// 组合选择器提高精确度
browser_click({ target: "button.primary-button.submit" })
browser_click({ target: "form.login button[type='submit']" })
```

---

### 3. 属性选择器

**示例**：
```typescript
browser_click({ target: "button[type='submit']" })
browser_fill({ target: "input[name='email']", value: "user@example.com" })
browser_click({ target: "a[href='/dashboard']" })
```

**优点**：
- 语义明确
- 适合表单元素
- 不依赖 class 或 id

**常用属性**：
- `[type]` - 输入框类型
- `[name]` - 表单字段名
- `[href]` - 链接地址
- `[data-testid]` - 测试 ID
- `[aria-label]` - 无障碍标签

---

### 4. @e 引用（不确定时使用）

**使用场景**：
- 不知道元素的 ID、class 或属性
- 页面结构复杂，难以编写精确选择器
- 需要快速定位可交互元素

**示例**：
```typescript
// 1. 先生成快照
const snap = browser_snapshot({ limit: 200 })
// 输出: @e1: button - 登录, @e2: input - 用户名, @e3: input - 密码

// 2. 使用 @e 引用
browser_fill({ target: "@e2", value: "username", snapshotId: snap.snapshotId })
browser_fill({ target: "@e3", value: "password", snapshotId: snap.snapshotId })
browser_click({ target: "@e1", snapshotId: snap.snapshotId })
```

**重要提示**：
- @e 引用仅在当前 snapshotId 内有效
- 页面变化后需重新 snapshot
- 建议每次操作前生成新快照

---

### 5. 复杂选择器

**层级选择器**：
```typescript
browser_click({ target: ".modal .footer button.confirm" })
browser_fill({ target: "form#login input[name='username']", value: "user" })
```

**伪类选择器**：
```typescript
browser_click({ target: "ul.menu li:first-child a" })
browser_click({ target: "button:not([disabled])" })
```

**组合选择器**：
```typescript
browser_click({ target: "div.card > button.primary" })
browser_fill({ target: "form input[type='text']:nth-of-type(2)", value: "data" })
```

---

## 最佳实践

### 1. 优先使用稳定选择器

**推荐**：
```typescript
// 使用语义化属性
browser_click({ target: "[data-testid='submit-button']" })
browser_fill({ target: "[aria-label='Search']", value: "query" })

// 使用结构化选择器
browser_click({ target: "form.login button[type='submit']" })
```

**避免**：
```typescript
// ❌ 依赖动态 class
browser_click({ target: ".css-1234567-button" })

// ❌ 依赖位置
browser_click({ target: "div > div > div:nth-child(3) button" })
```

---

### 2. 先验证选择器

**使用 execute 检查元素是否存在**：
```typescript
const exists = browser_execute({
  script: "!!document.querySelector('#target-element')"
})

if (exists) {
  browser_click({ target: "#target-element" })
} else {
  // 回退到 snapshot + @e
  const snap = browser_snapshot()
  browser_click({ target: "@e1", snapshotId: snap.snapshotId })
}
```

---

### 3. 处理多个匹配元素

**使用更具体的选择器**：
```typescript
// ❌ 可能匹配多个按钮
browser_click({ target: "button" })

// ✅ 精确定位
browser_click({ target: "form.login button.submit" })
browser_click({ target: "button[type='submit'][form='login-form']" })
```

**或使用 execute 选择特定元素**：
```typescript
browser_execute({
  script: `
    const buttons = Array.from(document.querySelectorAll('button'));
    const submitBtn = buttons.find(btn => btn.textContent.includes('提交'));
    submitBtn?.click();
  `
})
```

---

### 4. 处理 Shadow DOM

**优先使用 @e 引用**（snapshot 会自动穿透开放 Shadow DOM）：
```typescript
const snap = browser_snapshot()
// @e 引用会包含 Shadow DOM 内的元素
browser_click({ target: "@e5", snapshotId: snap.snapshotId })
```

**或使用 execute 手动穿透**：
```typescript
browser_execute({
  script: `
    const host = document.querySelector('#shadow-host');
    const shadowRoot = host.shadowRoot;
    const button = shadowRoot.querySelector('button');
    button.click();
  `
})
```

---

### 5. 处理 iframe

**优先使用 @e 引用**（snapshot 会自动穿透同源 iframe）：
```typescript
const snap = browser_snapshot()
// @e 引用会包含 iframe 内的元素
browser_fill({ target: "@e3", value: "data", snapshotId: snap.snapshotId })
```

**或使用 execute 手动进入 iframe**：
```typescript
browser_execute({
  script: `
    const iframe = document.querySelector('iframe');
    const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
    const input = iframeDoc.querySelector('input[name="email"]');
    input.value = 'user@example.com';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  `
})
```

---

### 6. 动态内容选择器

**等待元素出现**：
```typescript
browser_execute({
  script: `
    new Promise(resolve => {
      const check = () => {
        const element = document.querySelector('.dynamic-content');
        if (element) {
          resolve(true);
        } else {
          setTimeout(check, 100);
        }
      };
      check();
    })
  `
})

// 元素出现后再操作
browser_click({ target: ".dynamic-content button" })
```

---

## 选择器调试技巧

### 1. 在浏览器控制台测试

```javascript
// 测试选择器是否有效
document.querySelector('button.submit')

// 查看匹配的元素数量
document.querySelectorAll('button').length

// 查看元素属性
Array.from(document.querySelectorAll('button')).map(btn => ({
  id: btn.id,
  class: btn.className,
  text: btn.textContent,
  type: btn.type
}))
```

### 2. 使用 snapshot 查看可操作元素

```typescript
// 查看页面所有可操作元素
const snap = browser_snapshot({ limit: 200 })

// 查看更多元素
browser_snapshot({ offset: 200, limit: 200 })
```

### 3. 使用 execute 检查元素状态

```typescript
// 检查元素是否可见
browser_execute({
  script: `
    const el = document.querySelector('#target');
    const style = window.getComputedStyle(el);
    return {
      display: style.display,
      visibility: style.visibility,
      opacity: style.opacity,
      offsetWidth: el.offsetWidth,
      offsetHeight: el.offsetHeight
    }
  `
})
```

---

## 常见问题

### Q: 选择器找不到元素？

**检查步骤**：
1. 元素是否已加载？使用 execute 等待
2. 选择器是否正确？在浏览器控制台测试
3. 元素是否在 iframe 或 Shadow DOM 内？改用 @e 或 execute
4. 元素是否被隐藏？检查 CSS display/visibility

### Q: 点击无效？

**可能原因**：
1. 元素被遮挡 - 先滚动元素到可见区域
2. 元素未加载完成 - 添加等待逻辑
3. 需要特定事件 - 使用 execute 触发

### Q: 什么时候用 @e，什么时候用 CSS 选择器？

**使用 CSS 选择器**：
- 知道准确的 ID、class、属性
- 需要高性能重复操作
- 选择器稳定不变

**使用 @e 引用**：
- 不确定选择器
- 页面结构复杂
- 快速原型开发
- 处理 iframe 或 Shadow DOM

**使用 execute**：
- 封装工具无法满足需求
- 需要复杂逻辑
- 批量操作多个元素
