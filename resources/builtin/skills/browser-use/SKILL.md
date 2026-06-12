---
name: browser-use
description: 使用 PolarAgent BrowserUse 进行浏览器感知与控制、页面交互、截图、网络监控和排障。
---

# Browser Use

控制用户真实 Chrome 浏览器。底层是 Electron IPC + Chrome 扩展桥，保留登录态和 Cookie；不是 Selenium/Playwright。

## 正常流程直接执行工具

每次开始浏览器任务，不要先做健康检查，直接执行最贴近目标的工具。工具会自动连接扩展；扩展未连接是正常状态，不是故障。

```typescript
browser_tabs()
browser_open({ url: "https://example.com" })
browser_scan({ textOnly: true })
browser_snapshot({ limit: 200 })
browser_click({ target: "@e1" })
browser_execute({ script: "document.title" })
```

只有工具调用失败、扩展明确提示未连接、用户明确要求排障时，才提示检查扩展连接状态。

## 前置条件

**用户需要完成**：
1. 在 PolarAgent 设置 → Browser Use → 安装浏览器扩展 → 导出扩展到文件夹
2. 打开 Chrome，访问 `chrome://extensions/`，开启"开发者模式"
3. 点击"加载已解压的扩展程序"，选择导出的文件夹
4. 打开任意网页（不能是 `chrome://` 或 `about:blank`）

**使用前检查**：
- Chrome 至少需要打开一个普通网页
- 点击扩展图标确认连接状态：🟢 已连接 / 🔴 未连接

## 常用工具优先级

先区分三个入口：

```text
scan：内容感知，适合看正文、列表、页面文本。
snapshot：操作定位，适合找按钮、链接、输入框并生成 @e 引用。
execute：逃生口，封装工具失效或特殊页面时回退。
```

基础感知和按需排障：

```typescript
browser_tabs()
browser_open({ url: "https://example.com" })
browser_close({ tabId: 123 })
browser_scan({ textOnly: true })
browser_scan({ tabId: 123, textOnly: false })
browser_snapshot({ limit: 200 })
browser_snapshot({ offset: 200, limit: 200 })
browser_click({ target: "button.submit" })
browser_click({ target: "@e1", snapshotId: "..." })
browser_fill({ target: "@e2", value: "hello" })
browser_fill({ target: "@e2", value: "", clear: true })
browser_fill({ target: "@e2", value: " world", append: true })
browser_execute({ script: "document.title" })
browser_screenshot()
browser_screenshot({ fullPage: true })
browser_screenshot({ target: "@e3" })
browser_network({ tabId: 123, action: "start" })
browser_network({ tabId: 123, action: "list" })
browser_network({ tabId: 123, action: "detail", requestId: "..." })
browser_network({ tabId: 123, action: "stop" })
browser_console({ tabId: 123, action: "start" })
browser_console({ tabId: 123, action: "list", level: "error" })
browser_console({ tabId: 123, action: "stop" })
```

推荐流程：

```text
看页面内容：scan / scan --text-only
selector 明确时：直接 click/fill selector
selector 不明确或页面复杂时：snapshot 生成 @e，再 click/fill @e
页面结构或内容变化后：重新 snapshot
封装工具失效或覆盖不到特殊页面时：回退 execute
```

## 工具参数说明

所有工具都支持 `tabId` 参数，不指定则使用当前活动标签页。`@e` 引用只在当前 snapshotId、当前 tabId 内有效。`@e` 只接受 `@e1` 这种带 `@` 的格式。

### browser_tabs

列出所有浏览器标签页。

**参数**：无

**返回**：标签页数组 `[{ id, url, title, active, windowId }]`

**示例**：
```typescript
browser_tabs()
// 返回：找到 3 个标签页
```

### browser_open

打开新标签页。

**参数**：
- `url` (必需) - 要打开的网址

**返回**：新标签页的 ID

**示例**：
```typescript
browser_open({ url: "https://example.com" })
// 返回：已打开标签页: 681882954
```

### browser_close

关闭标签页。

**参数**：
- `tabId` (必需) - 标签页 ID

**示例**：
```typescript
browser_close({ tabId: 123 })
```

### browser_scan

扫描页面内容，提取纯文本或完整 HTML。

**参数**：
- `tabId` (可选) - 标签页 ID
- `textOnly` (可选) - 是否仅返回纯文本，默认 true

**返回**：页面文本内容或 HTML

**示例**：
```typescript
browser_scan({ textOnly: true })
browser_scan({ tabId: 123, textOnly: false })
```

**使用场景**：
- 提取网页正文、文章、评论、列表
- 分析页面结构

### browser_snapshot

获取页面可操作元素快照，生成 @e 引用。

**参数**：
- `tabId` (可选) - 标签页 ID
- `limit` (可选) - 最大元素数，默认 200
- `offset` (可选) - 偏移量，用于翻页，默认 0

**返回**：可操作元素列表，每个元素分配一个 @e 引用

**示例**：
```typescript
browser_snapshot({ limit: 200 })
// 返回：
// 快照生成成功 (snapshotId: 123:1718181234567, 共 15 个元素):
// @e1: button - 登录
// @e2: input - 用户名
// @e3: input - 密码
// ...

// 查看下一页元素
browser_snapshot({ offset: 200, limit: 200 })
```

**识别的元素类型**：
- 链接 (`<a>`)
- 按钮 (`<button>`)
- 输入框 (`<input>`, `<textarea>`)
- 下拉框 (`<select>`)
- 可点击元素（`[onclick]`, `[role="button"]`）

**重要提示**：
- @e 引用仅在当前 snapshotId 内稳定
- 页面内容变化后需重新 snapshot
- 对嵌入在同源 iframe 或开放 Shadow DOM 里的控件，优先使用 @e 引用

### browser_click

点击页面元素。

**参数**：
- `tabId` (可选) - 标签页 ID
- `target` (必需) - CSS 选择器或 @e 引用
- `snapshotId` (可选) - 使用 @e 时建议传入

**示例**：
```typescript
browser_click({ target: "button.login-btn" })
browser_click({ target: "@e1", snapshotId: "..." })
```

**选择器策略建议**：
1. 如果知道准确的 CSS 选择器，直接使用
2. 如果不确定，先 snapshot 生成 @e 引用
3. 复杂场景使用 browser_execute

### browser_fill

填充表单输入框。

**参数**：
- `tabId` (可选) - 标签页 ID
- `target` (必需) - CSS 选择器或 @e 引用
- `value` (必需) - 要填充的文本
- `clear` (可选) - 填充前清空，默认 false
- `append` (可选) - 追加模式，默认 false
- `snapshotId` (可选) - 使用 @e 时建议传入

**示例**：
```typescript
browser_fill({ target: "@e2", value: "myusername" })
browser_fill({ target: "input[name='email']", value: "user@example.com", clear: true })
browser_fill({ target: "textarea", value: "\n更多内容", append: true })
```

### browser_execute

在页面中执行 JavaScript。

**参数**：
- `tabId` (可选) - 标签页 ID
- `script` (必需) - JavaScript 代码

**返回**：脚本执行结果

**示例**：
```typescript
browser_execute({ script: "document.title" })
browser_execute({ script: "window.scrollTo(0, document.body.scrollHeight)" })
browser_execute({ 
  script: "Array.from(document.querySelectorAll('a')).map(a => a.href)" 
})
```

### browser_screenshot

截取页面截图，自动保存到会话工作目录。

**参数**：
- `tabId` (可选) - 标签页 ID
- `fullPage` (可选) - 全页截图，默认 false
- `target` (可选) - CSS 选择器或 @e 引用
- `snapshotId` (可选) - 使用 @e 时建议传入

**返回**：截图文件路径和文件名

**示例**：
```typescript
browser_screenshot()
browser_screenshot({ fullPage: true })
browser_screenshot({ target: "@e5", snapshotId: "..." })
```

**说明**：
- 截图自动保存到当前会话的工作目录
- 文件名格式：`browser-screenshot-{timestamp}.png`

### browser_network

监控页面的网络请求和响应。

**参数**：
- `tabId` (必需) - 标签页 ID
- `action` (必需) - `start` / `list` / `detail` / `clear` / `stop`
- `requestId` (detail 时必需) - 请求 ID
- `filter` (list 时可选) - URL/状态/类型过滤

**示例**：
```typescript
browser_network({ tabId: 123, action: "start" })
browser_click({ target: "button.load-more" })
browser_network({ tabId: 123, action: "list" })
browser_network({ tabId: 123, action: "detail", requestId: "..." })
browser_network({ tabId: 123, action: "stop" })
```

**重要**：
- `network` / `console` 需要扩展持续监听 CDP 事件
- 修改或升级扩展后，必须先让用户重载 Chrome 插件
- `network detail` 会截断大响应体并标记 `base64Encoded`
- `stop` 会停止监听并清请求缓存

### browser_console

监听页面 console 日志与异常。

**参数**：
- `tabId` (可选) - 标签页 ID
- `action` (必需) - `start` / `list` / `clear` / `stop`
- `level` (可选) - 按 log、warning、error 等级过滤

**示例**：
```typescript
browser_console({ tabId: 123, action: "start" })
browser_click({ target: "button.refresh" })
browser_console({ tabId: 123, action: "list", level: "error" })
browser_console({ tabId: 123, action: "stop" })
```

## 典型使用场景

详见 `references/EXAMPLES.md`。

## 高级用法

详见以下参考文档：
- `references/SELECTORS.md` - 选择器策略和最佳实践
- `references/WAITING.md` - 页面加载等待策略
- `references/NETWORK.md` - 网络监控和调试
- `references/TROUBLESHOOTING.md` - 故障排查指南

## 注意事项

### 1. 扩展连接

- 使用前确认扩展已安装并连接
- 工具调用失败时，提示用户检查扩展状态

### 2. @e 引用有效期

- 仅在当前快照会话内有效
- 页面变化后需重新 snapshot
- 建议每次操作前先生成新快照

### 3. 敏感信息保护

- 填写密码时注意日志安全
- 避免在返回内容中暴露敏感数据

### 4. 操作速度

- 页面操作需要时间，不要连续快速调用
- 使用 execute 检查加载状态或添加适当延迟

### 5. 截图文件

- 截图自动保存到会话工作目录
- 文件名包含时间戳，不会覆盖

## 运维入口

- 工具调用失败、扩展未连接：看 `references/TROUBLESHOOTING.md`
- 扩展未连接但尚未执行目标工具：不要排障，直接继续执行工具
