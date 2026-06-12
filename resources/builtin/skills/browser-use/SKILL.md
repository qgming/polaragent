---
name: browser-use
description: 浏览器控制与网页自动化，操作真实 Chrome 会话保留登录态
---

# Browser Use - 浏览器控制

通过 Chrome 扩展控制用户的真实浏览器会话，实现网页自动化操作，保留登录态和 Cookie。

## 核心能力

- 🌐 **标签页管理** - 列出、打开、关闭浏览器标签页
- 📄 **页面内容读取** - 提取页面文本或完整 HTML
- 🎯 **智能元素定位** - 自动识别可操作元素，生成 @e 引用
- 🖱️ **交互操作** - 点击按钮、填充表单、执行脚本
- 📸 **页面截图** - 捕获可视区域或完整页面，自动保存
- 🔍 **网络监控** - 监听 HTTP 请求和响应

## 前置条件

### 需要用户完成的准备工作

**安装 Chrome 扩展**（用户操作）：
1. 打开 Chrome 浏览器，访问 `chrome://extensions/`
2. 开启右上角的"开发者模式"
3. 点击"加载已解压的扩展程序"
4. 选择 PolarAgent 项目根目录下的 `chrome-extension` 文件夹

**使用前检查**：
- Chrome 至少需要打开一个普通网页（不能是 `about:blank` 或 `chrome://` 页面）
- 点击扩展图标确认连接状态：🟢 已连接 / 🔴 未连接
- 如果未连接，提醒用户检查 Chrome 和 PolarAgent 应用状态

**建议提示语**：
> "我需要使用浏览器工具，请确保已安装 Chrome 扩展并保持 Chrome 打开"

---

## 工具清单

### 1. browser_tabs - 列出标签页

**功能**：列出当前所有浏览器标签页

**参数**：无

**返回**：标签页数组，包含 id、url、title、active

**示例**：
```typescript
browser_tabs()

// 返回：
// 找到 3 个标签页:
// [
//   { id: 123, url: "https://example.com", title: "Example", active: true },
//   { id: 124, url: "https://github.com", title: "GitHub", active: false }
// ]
```

**使用场景**：
- 查看用户当前打开的网页
- 获取特定标签页的 ID
- 查找包含关键词的标签页

---

### 2. browser_open - 打开新标签页

**功能**：打开新的浏览器标签页访问指定 URL

**参数**：
- `url` (必需) - 要打开的网址

**返回**：新标签页的 ID

**示例**：
```typescript
browser_open({ url: "https://example.com" })
// 返回：已打开标签页: 681882954

browser_open({ url: "https://github.com/search?q=polaragent" })
```

**使用场景**：
- 打开指定网页开始自动化流程
- 批量打开多个链接
- 在新标签页中进行操作

---

### 3. browser_close - 关闭标签页

**功能**：关闭指定的浏览器标签页

**参数**：
- `tabId` (必需) - 标签页 ID（从 browser_tabs 获取）

**示例**：
```typescript
browser_close({ tabId: 123 })
// 返回：已关闭标签页 123
```

**使用场景**：
- 完成任务后清理标签页
- 批量关闭不需要的标签页

---

### 4. browser_scan - 扫描页面内容

**功能**：扫描页面内容，获取纯文本或完整 HTML

**参数**：
- `tabId` (可选) - 标签页 ID，不指定则使用当前活动标签
- `textOnly` (可选) - 是否仅返回纯文本，默认 true

**返回**：页面文本内容或 HTML 代码

**示例**：
```typescript
// 提取纯文本
browser_scan({ tabId: 123, textOnly: true })
// 返回：页面的主要文本内容...

// 获取完整 HTML
browser_scan({ tabId: 123, textOnly: false })
// 返回：<html>...</html>
```

**使用场景**：
- 提取网页正文内容
- 读取文章、评论、列表数据
- 分析页面结构

---

### 5. browser_snapshot - 页面快照

**功能**：获取页面可操作元素快照，生成 @e 引用

**参数**：
- `tabId` (可选) - 标签页 ID
- `limit` (可选) - 最大元素数，默认 200
- `offset` (可选) - 偏移量，用于翻页，默认 0

**返回**：可操作元素列表，每个元素分配一个 @e 引用

**示例**：
```typescript
browser_snapshot({ tabId: 123, limit: 200 })

// 返回：
// 快照生成成功 (session: 123_1718181234567, 共 15 个元素):
// @e1: button - 登录
// @e2: input - 用户名
// @e3: input - 密码
// @e4: a - 忘记密码
// @e5: a - 注册账号
// ...

// 查看下一页元素
browser_snapshot({ tabId: 123, limit: 200, offset: 200 })
```

**识别的元素类型**：
- 链接 (`<a>`)
- 按钮 (`<button>`)
- 输入框 (`<input>`, `<textarea>`)
- 下拉框 (`<select>`)
- 可点击元素（`[onclick]`, `[role="button"]`）

**使用场景**：
- 定位页面上的按钮、输入框、链接
- 在不知道准确选择器的情况下操作元素
- 生成可操作元素列表供选择

**重要提示**：
- @e 引用仅在当前快照会话内有效
- 页面内容变化后需重新调用 snapshot
- 建议每次点击/填充前先生成快照

---

### 6. browser_click - 点击元素

**功能**：点击页面元素

**参数**：
- `tabId` (可选) - 标签页 ID
- `target` (必需) - 目标元素
  - CSS 选择器：`button[type="submit"]`, `#login-btn`, `.button-primary`
  - @e 引用：`@e1`, `@e2`（需先调用 browser_snapshot）

**示例**：
```typescript
// 使用 CSS 选择器
browser_click({ tabId: 123, target: "button.login-btn" })
browser_click({ tabId: 123, target: "#submit" })

// 使用 @e 引用（推荐）
browser_snapshot({ tabId: 123 })  // 先生成快照
browser_click({ tabId: 123, target: "@e1" })
```

**使用场景**：
- 点击按钮提交表单
- 点击链接跳转页面
- 触发下拉菜单、模态框

**选择器策略建议**：
1. 如果知道准确的 CSS 选择器，直接使用
2. 如果不确定，先 snapshot 生成 @e 引用
3. 复杂场景使用 browser_execute 执行脚本

---

### 7. browser_fill - 填充表单

**功能**：填充表单输入框

**参数**：
- `tabId` (可选) - 标签页 ID
- `target` (必需) - 目标元素（CSS 选择器或 @e 引用）
- `value` (必需) - 要填充的文本
- `clear` (可选) - 填充前清空，默认 false
- `append` (可选) - 追加模式，默认 false

**示例**：
```typescript
// 基础填充
browser_fill({ 
  tabId: 123, 
  target: "@e2", 
  value: "myusername" 
})

// 清空后填充
browser_fill({ 
  tabId: 123, 
  target: "input[name='email']", 
  value: "user@example.com",
  clear: true 
})

// 追加内容
browser_fill({ 
  tabId: 123, 
  target: "textarea", 
  value: "\n更多内容",
  append: true 
})
```

**使用场景**：
- 填写登录表单
- 填写搜索框
- 填写多行文本框
- 修改已有内容

---

### 8. browser_execute - 执行 JavaScript

**功能**：在页面中执行自定义 JavaScript 代码

**参数**：
- `tabId` (可选) - 标签页 ID
- `script` (必需) - JavaScript 代码

**返回**：脚本执行结果

**示例**：
```typescript
// 获取页面标题
browser_execute({ 
  tabId: 123, 
  script: "document.title" 
})

// 滚动到底部
browser_execute({ 
  tabId: 123, 
  script: "window.scrollTo(0, document.body.scrollHeight)" 
})

// 获取所有链接
browser_execute({ 
  tabId: 123, 
  script: "Array.from(document.querySelectorAll('a')).map(a => a.href)" 
})

// 提取结构化数据
browser_execute({ 
  tabId: 123, 
  script: `
    Array.from(document.querySelectorAll('.item')).map(el => ({
      title: el.querySelector('.title')?.textContent,
      price: el.querySelector('.price')?.textContent
    }))
  `
})
```

**使用场景**：
- 获取页面动态数据
- 修改页面 DOM
- 触发自定义事件
- 执行复杂的页面操作
- 数据采集和提取

---

### 9. browser_screenshot - 页面截图

**功能**：截取页面截图，自动保存到会话工作目录

**参数**：
- `tabId` (可选) - 标签页 ID
- `fullPage` (可选) - 全页截图，默认 false
- `target` (可选) - 目标元素（CSS 选择器或 @e 引用）

**返回**：截图文件路径和文件名

**示例**：
```typescript
// 当前视口截图
browser_screenshot({ tabId: 123 })

// 全页截图
browser_screenshot({ tabId: 123, fullPage: true })

// 截取特定元素
browser_screenshot({ tabId: 123, target: "@e5" })

// 返回：
// 截图已保存到: D:/dev/polaragent/sessions/20240612/browser-screenshot-1718181234567.png
// 文件名: browser-screenshot-1718181234567.png
```

**使用场景**：
- 验证操作结果
- 保存页面状态
- 记录错误现场
- 生成报告截图

**说明**：
- 截图自动保存到当前会话的工作目录
- 文件名格式：`browser-screenshot-{timestamp}.png`
- 可直接在文件管理器中查看

---

### 10. browser_network - 网络监控

**功能**：监控页面的网络请求和响应

**参数**：
- `tabId` (必需) - 标签页 ID
- `action` (必需) - 操作类型
  - `start` - 开始监控
  - `list` - 列出请求
  - `stop` - 停止监控

**返回**：网络请求列表（action 为 list 时）

**示例**：
```typescript
// 1. 开始监控
browser_network({ tabId: 123, action: "start" })

// 2. 执行页面操作（触发网络请求）
browser_click({ tabId: 123, target: "button.load-more" })

// 3. 列出捕获的请求
browser_network({ tabId: 123, action: "list" })
// 返回：
// [
//   { url: "https://api.example.com/users", method: "GET", status: 200 },
//   { url: "https://api.example.com/posts", method: "POST", status: 201 }
// ]

// 4. 停止监控
browser_network({ tabId: 123, action: "stop" })
```

**使用场景**：
- 分析 API 调用
- 调试网络问题
- 监听 AJAX 请求
- 提取接口数据

---

## 典型使用场景

### 场景 1：登录网站

```typescript
// 1. 打开登录页
browser_open({ url: "https://example.com/login" })

// 2. 生成可操作元素快照
browser_snapshot({ limit: 200 })
// 输出: @e1: input - 用户名, @e2: input - 密码, @e3: button - 登录

// 3. 填写表单
browser_fill({ target: "@e1", value: "myuser" })
browser_fill({ target: "@e2", value: "mypass" })

// 4. 提交登录
browser_click({ target: "@e3" })

// 5. 等待跳转，截图验证
browser_screenshot()
```

---

### 场景 2：数据采集

```typescript
// 1. 打开目标页面
browser_open({ url: "https://example.com/products" })

// 2. 扫描页面文本
browser_scan({ textOnly: true })

// 3. 执行脚本提取结构化数据
browser_execute({ 
  script: `
    Array.from(document.querySelectorAll('.product')).map(el => ({
      name: el.querySelector('.name')?.textContent,
      price: el.querySelector('.price')?.textContent,
      link: el.querySelector('a')?.href
    }))
  `
})

// 4. 截图保存
browser_screenshot({ fullPage: true })
```

---

### 场景 3：搜索和导航

```typescript
// 1. 打开搜索引擎
browser_open({ url: "https://www.google.com" })

// 2. 定位搜索框
browser_snapshot()
// 找到 @e1: input - 搜索框

// 3. 输入搜索关键词
browser_fill({ target: "@e1", value: "PolarAgent AI assistant" })

// 4. 点击搜索按钮或回车
browser_execute({ script: "document.querySelector('input[name=q]').form.submit()" })

// 5. 等待结果，提取链接
browser_execute({ 
  script: "Array.from(document.querySelectorAll('h3')).map(h => h.textContent)" 
})
```

---

### 场景 4：表单批量填写

```typescript
// 1. 打开表单页面
browser_open({ url: "https://example.com/form" })

// 2. 生成快照
browser_snapshot()

// 3. 批量填写多个字段
const formData = {
  "@e1": "张三",
  "@e2": "zhangsan@example.com",
  "@e3": "13800138000",
  "@e4": "北京市朝阳区"
};

for (const [target, value] of Object.entries(formData)) {
  browser_fill({ target, value, clear: true });
}

// 4. 提交表单
browser_click({ target: "@e10" })  // 提交按钮

// 5. 截图保存结果
browser_screenshot()
```

---

### 场景 5：监控接口请求

```typescript
// 1. 打开目标页面并开始监控
browser_open({ url: "https://example.com/dashboard" })
browser_network({ tabId: 123, action: "start" })

// 2. 触发数据加载
browser_click({ target: "button.refresh" })

// 3. 等待请求完成
// （可以使用 browser_execute 检查加载状态）

// 4. 查看网络请求
browser_network({ tabId: 123, action: "list" })

// 5. 停止监控
browser_network({ tabId: 123, action: "stop" })
```

---

## 使用技巧

### 1. @e 引用最佳实践

**推荐做法**：
```typescript
// 每次操作前重新生成快照
browser_snapshot()
browser_click({ target: "@e1" })

browser_snapshot()  // 页面可能有变化，重新快照
browser_fill({ target: "@e2", value: "data" })
```

**避免**：
```typescript
// ❌ 一次快照，多次使用（页面变化后 @e 引用失效）
browser_snapshot()
browser_click({ target: "@e1" })
// ... 页面发生跳转或刷新
browser_click({ target: "@e2" })  // ❌ 可能失败
```

---

### 2. 选择器策略

**优先级**：
1. **已知 ID** - 最可靠：`#submit-button`
2. **稳定的 class** - 次之：`.primary-button`
3. **@e 引用** - 不确定时：先 snapshot，再使用 @e
4. **JavaScript** - 复杂场景：browser_execute 直接操作

**示例**：
```typescript
// 方式 1: 使用 ID（最可靠）
browser_click({ target: "#login-btn" })

// 方式 2: 使用 @e 引用（不知道选择器时）
browser_snapshot()
browser_click({ target: "@e1" })

// 方式 3: 使用 JavaScript（复杂场景）
browser_execute({ 
  script: "document.querySelector('.modal .confirm-button').click()" 
})
```

---

### 3. 等待页面加载

**方式 1: 使用 execute 检查**
```typescript
// 等待特定元素出现
browser_execute({ 
  script: `
    new Promise(resolve => {
      const check = () => {
        if (document.querySelector('.result')) {
          resolve(true);
        } else {
          setTimeout(check, 100);
        }
      };
      check();
    })
  `
})
```

**方式 2: 扫描内容验证**
```typescript
// 执行操作后，扫描页面检查结果
browser_click({ target: "@e1" })
const content = browser_scan({ textOnly: true })
// 检查 content 中是否包含预期内容
```

---

### 4. 错误处理

**检查元素是否存在**：
```typescript
// 先检查元素
const exists = browser_execute({
  script: "!!document.querySelector('#target-element')"
})

if (exists) {
  browser_click({ target: "#target-element" })
} else {
  // 提示用户或尝试其他方法
}
```

**截图保存错误现场**：
```typescript
try {
  browser_click({ target: "@e1" })
} catch (error) {
  // 操作失败时截图
  browser_screenshot({ fullPage: true })
  // 告知用户
}
```

---

### 5. 性能优化

**批量操作多个标签页**：
```typescript
// 先打开所有标签页
const urls = ["https://site1.com", "https://site2.com", "https://site3.com"];
urls.forEach(url => browser_open({ url }));

// 获取所有标签页 ID
const tabs = browser_tabs();

// 对每个标签页执行操作
tabs.forEach(tab => {
  browser_scan({ tabId: tab.id, textOnly: true });
  browser_screenshot({ tabId: tab.id });
});
```

**缓存快照结果**：
```typescript
// 如果页面不变，可以复用 @e 引用
browser_snapshot()
// @e1, @e2, @e3...

// 多次使用相同的 @e 引用（页面未变化）
browser_click({ target: "@e1" })
browser_fill({ target: "@e2", value: "data" })
browser_click({ target: "@e3" })
```

---

## 注意事项

### 1. 扩展连接

**检查连接状态**：
- 使用前提醒用户确认扩展已安装
- 点击扩展图标查看连接状态（🟢 已连接 / 🔴 未连接）
- 如果工具调用失败，建议用户检查：
  - Chrome 是否已打开
  - 扩展是否已加载
  - 是否有正常网页标签页打开
  - PolarAgent 应用是否运行

### 2. @e 引用有效期

- 仅在当前快照会话内有效
- 页面发生变化（AJAX 加载、路由跳转）后需重新 snapshot
- 建议每次点击/填充前先生成新快照

### 3. 敏感信息保护

- 填写密码时注意日志安全
- 避免在返回内容中暴露敏感数据
- 提醒用户不要在不可信环境使用

### 4. 操作速度

- 页面操作需要时间，不要连续快速调用
- 点击、填充后可能需要等待页面响应
- 使用 execute 检查加载状态或添加适当延迟

### 5. 截图文件

- 截图自动保存到会话工作目录
- 文件名包含时间戳，不会覆盖
- 告知用户截图保存位置

---

## 故障排查

### 问题：工具调用报错"扩展未连接"

**排查步骤**：
1. 确认扩展是否已加载：访问 `chrome://extensions/`
2. 点击扩展图标查看连接状态
3. 确保有普通网页标签页打开（不是 chrome:// 或 about:blank）
4. 重启 PolarAgent 应用
5. 重新加载扩展

### 问题：@e 引用点击/填充无效

**排查步骤**：
1. 检查页面是否发生变化
2. 重新调用 browser_snapshot 生成新快照
3. 确认引用编号是否正确（从 @e1 开始）
4. 尝试使用 CSS 选择器代替

### 问题：页面内容读取为空

**排查步骤**：
1. 确认页面是否完全加载
2. 使用 browser_execute 检查 DOM 状态
3. 尝试使用 fullPage 截图查看实际页面内容
4. 检查是否是动态加载内容（需要等待）

---

## 提示用户的建议语

**首次使用**：
> "我需要使用浏览器工具来完成这个任务。请确保：
> 1. 已安装 PolarAgent 的 Chrome 扩展
> 2. Chrome 浏览器已打开，并至少有一个普通网页标签
> 3. 点击扩展图标确认连接状态为 🟢 已连接
> 
> 扩展安装位置：项目根目录的 `chrome-extension` 文件夹"

**工具调用失败**：
> "浏览器工具调用失败，请检查：
> 1. Chrome 扩展是否已连接（点击扩展图标查看状态）
> 2. Chrome 是否已打开正常网页（不能是 chrome:// 或空白页）
> 3. PolarAgent 应用是否正在运行"

**操作完成**：
> "操作已完成，截图已保存到会话工作目录：{文件路径}"
