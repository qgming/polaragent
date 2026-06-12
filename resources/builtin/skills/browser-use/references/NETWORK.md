# 网络监控和调试

## 网络监控基础

browser_network 工具可以捕获页面的 HTTP 请求和响应，用于分析 API 调用、调试网络问题、提取接口数据。

**重要前提**：
- 网络监控需要扩展持续监听 CDP 事件
- 修改或升级扩展后，必须先让用户重载 Chrome 插件
- 监控会占用内存，用完后记得停止

---

## 基本使用流程

### 完整监控流程

```typescript
// 1. 获取标签页 ID
const tabs = browser_tabs()
const tabId = tabs.find(t => t.active)?.id

// 2. 开始监控
browser_network({ tabId, action: "start" })

// 3. 执行触发网络请求的操作
browser_click({ target: "button.load-data" })

// 4. 等待请求完成
browser_execute({
  script: `
    new Promise(resolve => {
      const check = () => {
        if (!document.querySelector('.loading')) {
          resolve(true);
        } else {
          setTimeout(check, 100);
        }
      };
      check();
    })
  `
})

// 5. 列出捕获的请求
const requests = browser_network({ tabId, action: "list" })

// 6. 查看特定请求的详情
if (requests.length > 0) {
  const detail = browser_network({ 
    tabId, 
    action: "detail", 
    requestId: requests[0].id 
  })
}

// 7. 停止监控
browser_network({ tabId, action: "stop" })
```

---

## action 操作详解

### start - 开始监控

开始捕获当前标签页的网络请求。

```typescript
browser_network({ tabId: 123, action: "start" })
// 返回：开始监控标签页 123 的网络请求
```

**注意**：
- 只捕获 start 之后的请求
- 重复调用会清空之前的记录
- 监控会一直持续直到调用 stop

---

### list - 列出请求

列出已捕获的所有请求。

```typescript
browser_network({ tabId: 123, action: "list" })

// 返回示例：
// [
//   {
//     id: "request-1",
//     url: "https://api.example.com/users",
//     method: "GET",
//     status: 200,
//     statusText: "OK",
//     type: "xhr",
//     timestamp: 1718181234567
//   },
//   {
//     id: "request-2",
//     url: "https://api.example.com/posts",
//     method: "POST",
//     status: 201,
//     statusText: "Created",
//     type: "fetch",
//     timestamp: 1718181235678
//   }
// ]
```

**过滤请求**：
```typescript
// 按 URL 过滤
browser_network({ tabId: 123, action: "list", filter: "api" })

// 按状态码过滤
browser_network({ tabId: 123, action: "list", filter: "200" })

// 按类型过滤
browser_network({ tabId: 123, action: "list", filter: "xhr" })
```

---

### detail - 查看详情

获取单个请求的完整信息，包括请求头、响应头、响应体。

```typescript
browser_network({ 
  tabId: 123, 
  action: "detail", 
  requestId: "request-1" 
})

// 返回示例：
// {
//   id: "request-1",
//   url: "https://api.example.com/users",
//   method: "GET",
//   status: 200,
//   requestHeaders: {
//     "Content-Type": "application/json",
//     "Authorization": "Bearer token..."
//   },
//   responseHeaders: {
//     "Content-Type": "application/json",
//     "Content-Length": "1234"
//   },
//   responseBody: "[{...}, {...}]",  // 或 base64 编码
//   base64Encoded: false,
//   size: 1234,
//   timing: { ... }
// }
```

**重要**：
- 大响应体会被截断并标记 `base64Encoded`
- 不要把巨大的响应体粘贴到对话中
- 图片、文件等二进制内容会 base64 编码

---

### clear - 清空记录

清空当前捕获的所有请求记录，但继续监控。

```typescript
browser_network({ tabId: 123, action: "clear" })
// 返回：已清空标签页 123 的网络请求记录
```

**使用场景**：
- 已经处理完一批请求，想开始捕获新的请求
- 内存占用过高，需要清理
- 测试不同操作的网络请求

---

### stop - 停止监控

停止监控并清空所有记录。

```typescript
browser_network({ tabId: 123, action: "stop" })
// 返回：已停止监控标签页 123 的网络请求
```

**重要**：
- 会停止 CDP 监听，释放资源
- 会清空所有捕获的请求记录
- 下次需要监控时重新调用 start

---

## 典型使用场景

### 场景 1：分析 API 调用

```typescript
// 1. 打开页面并开始监控
browser_open({ url: "https://example.com" })
const tabs = browser_tabs()
const tabId = tabs[0].id

browser_network({ tabId, action: "start" })

// 2. 触发 API 调用
const snap = browser_snapshot({ tabId })
browser_click({ target: "@e5", tabId, snapshotId: snap.snapshotId })

// 3. 等待请求完成
browser_execute({
  tabId,
  script: `
    new Promise(resolve => {
      setTimeout(() => resolve(true), 2000);
    })
  `
})

// 4. 查看 API 请求
const requests = browser_network({ tabId, action: "list", filter: "api" })

// 5. 分析请求
for (const req of requests) {
  console.log(`${req.method} ${req.url} - ${req.status}`)
  
  // 查看详细信息
  const detail = browser_network({ 
    tabId, 
    action: "detail", 
    requestId: req.id 
  })
  
  console.log("响应数据:", detail.responseBody)
}

// 6. 停止监控
browser_network({ tabId, action: "stop" })
```

---

### 场景 2：调试失败的请求

```typescript
// 开始监控
browser_network({ tabId: 123, action: "start" })

// 执行操作
browser_click({ target: "button.submit" })

// 等待完成
browser_execute({
  script: `new Promise(resolve => setTimeout(resolve, 3000))`
})

// 找出失败的请求
const requests = browser_network({ tabId: 123, action: "list" })
const failedRequests = requests.filter(req => req.status >= 400)

if (failedRequests.length > 0) {
  console.log("发现失败的请求：")
  
  for (const req of failedRequests) {
    const detail = browser_network({ 
      tabId: 123, 
      action: "detail", 
      requestId: req.id 
    })
    
    console.log(`URL: ${detail.url}`)
    console.log(`状态: ${detail.status} ${detail.statusText}`)
    console.log(`请求头:`, detail.requestHeaders)
    console.log(`响应头:`, detail.responseHeaders)
    console.log(`响应体:`, detail.responseBody)
  }
}
```

---

### 场景 3：提取接口数据

```typescript
// 监控页面加载时的 API 调用
browser_network({ tabId: 123, action: "start" })

browser_open({ url: "https://example.com/products" })

// 等待页面加载完成
browser_execute({
  script: `
    new Promise(resolve => {
      if (document.readyState === 'complete') {
        resolve(true);
      } else {
        window.addEventListener('load', () => resolve(true));
      }
    })
  `
})

// 找到数据接口
const requests = browser_network({ tabId: 123, action: "list", filter: "api" })
const dataRequest = requests.find(req => 
  req.url.includes('/products') && req.method === 'GET'
)

if (dataRequest) {
  const detail = browser_network({ 
    tabId: 123, 
    action: "detail", 
    requestId: dataRequest.id 
  })
  
  // 解析 JSON 数据
  const products = JSON.parse(detail.responseBody)
  console.log("商品数据:", products)
}
```

---

### 场景 4：监控表单提交

```typescript
// 开始监控
browser_network({ tabId: 123, action: "start" })

// 填写表单
const snap = browser_snapshot({ tabId: 123 })
browser_fill({ target: "@e1", value: "username", snapshotId: snap.snapshotId })
browser_fill({ target: "@e2", value: "password", snapshotId: snap.snapshotId })
browser_click({ target: "@e3", snapshotId: snap.snapshotId })

// 等待提交完成
browser_execute({
  script: `
    new Promise(resolve => {
      const check = () => {
        if (document.querySelector('.success') || document.querySelector('.error')) {
          resolve(true);
        } else {
          setTimeout(check, 100);
        }
      };
      check();
    })
  `
})

// 查看提交的数据
const requests = browser_network({ tabId: 123, action: "list", filter: "POST" })
const submitRequest = requests[0]

if (submitRequest) {
  const detail = browser_network({ 
    tabId: 123, 
    action: "detail", 
    requestId: submitRequest.id 
  })
  
  console.log("提交的数据:", detail.requestBody)
  console.log("服务器响应:", detail.responseBody)
  console.log("响应状态:", detail.status)
}
```

---

## 高级技巧

### 1. 批量分析请求

```typescript
// 捕获所有请求
browser_network({ tabId: 123, action: "start" })

// 执行多个操作
browser_click({ target: "button.tab1" })
// 等待...
browser_click({ target: "button.tab2" })
// 等待...
browser_click({ target: "button.tab3" })

// 分析所有请求
const requests = browser_network({ tabId: 123, action: "list" })

const stats = {
  total: requests.length,
  success: requests.filter(r => r.status >= 200 && r.status < 300).length,
  redirect: requests.filter(r => r.status >= 300 && r.status < 400).length,
  clientError: requests.filter(r => r.status >= 400 && r.status < 500).length,
  serverError: requests.filter(r => r.status >= 500).length,
  byType: {}
}

for (const req of requests) {
  stats.byType[req.type] = (stats.byType[req.type] || 0) + 1
}

console.log("网络请求统计:", stats)
```

---

### 2. 性能分析

```typescript
// 分析请求耗时
const requests = browser_network({ tabId: 123, action: "list" })

const slowRequests = []

for (const req of requests) {
  const detail = browser_network({ 
    tabId: 123, 
    action: "detail", 
    requestId: req.id 
  })
  
  if (detail.timing && detail.timing.duration > 1000) {
    slowRequests.push({
      url: req.url,
      duration: detail.timing.duration,
      size: detail.size
    })
  }
}

console.log("慢请求 (>1s):", slowRequests)
```

---

### 3. 提取认证 Token

```typescript
// 监控登录请求
browser_network({ tabId: 123, action: "start" })

// 执行登录
browser_fill({ target: "#username", value: "user" })
browser_fill({ target: "#password", value: "pass" })
browser_click({ target: "button[type='submit']" })

// 等待登录完成
browser_execute({
  script: `new Promise(resolve => setTimeout(resolve, 2000))`
})

// 查找登录请求
const requests = browser_network({ tabId: 123, action: "list", filter: "login" })
const loginRequest = requests[0]

if (loginRequest) {
  const detail = browser_network({ 
    tabId: 123, 
    action: "detail", 
    requestId: loginRequest.id 
  })
  
  // 从响应中提取 token
  const response = JSON.parse(detail.responseBody)
  const token = response.token || response.access_token
  
  console.log("认证 Token:", token)
}
```

---

## 控制台监控

除了网络请求，还可以监控页面的 console 日志。

### 基本使用

```typescript
// 开始监控
browser_console({ tabId: 123, action: "start" })

// 执行操作
browser_click({ target: "button.test" })

// 查看日志
const logs = browser_console({ tabId: 123, action: "list" })

// 只看错误
const errors = browser_console({ tabId: 123, action: "list", level: "error" })

// 停止监控
browser_console({ tabId: 123, action: "stop" })
```

---

### 调试 JavaScript 错误

```typescript
// 监控控制台
browser_console({ tabId: 123, action: "start" })

// 执行可能出错的操作
browser_click({ target: "button.risky-action" })

// 等待
browser_execute({
  script: `new Promise(resolve => setTimeout(resolve, 1000))`
})

// 检查是否有错误
const errors = browser_console({ tabId: 123, action: "list", level: "error" })

if (errors.length > 0) {
  console.log("发现 JavaScript 错误：")
  errors.forEach(err => {
    console.log(`${err.level}: ${err.text}`)
    console.log(`来源: ${err.url}:${err.lineNumber}`)
  })
}
```

---

## 注意事项

### 1. 内存管理

网络监控会占用内存，特别是捕获大量请求时：

```typescript
// ✅ 及时清理
browser_network({ tabId: 123, action: "list" })
// 处理完后立即清空
browser_network({ tabId: 123, action: "clear" })

// ✅ 用完就停止
browser_network({ tabId: 123, action: "stop" })
```

---

### 2. 大响应体处理

```typescript
// ❌ 不要这样做
const detail = browser_network({ tabId: 123, action: "detail", requestId: "..." })
console.log(detail.responseBody) // 可能非常大

// ✅ 检查大小后再输出
const detail = browser_network({ tabId: 123, action: "detail", requestId: "..." })

if (detail.size > 100000) {
  console.log("响应体过大，已截断")
  console.log("大小:", detail.size, "字节")
} else {
  console.log(detail.responseBody)
}
```

---

### 3. 扩展重载

修改或升级扩展后，网络监控可能失效：

```typescript
// 提示用户重载扩展
// 1. 打开 chrome://extensions/
// 2. 找到 PolarAgent BrowserUse 扩展
// 3. 点击刷新图标
```

---

## 常见问题

### Q: 为什么捕获不到请求？

**可能原因**：
1. 在 start 之前的请求不会被捕获
2. 扩展未正确连接
3. 某些类型的请求可能被过滤（如 chrome:// 协议）

**解决方案**：
- 确保先 start 再触发请求
- 检查扩展连接状态
- 使用 execute 确认页面确实发送了请求

### Q: 响应体显示为 base64？

**原因**：
- 响应体过大
- 二进制内容（图片、文件）

**处理**：
- 不要输出大的 base64 内容到对话
- 只关注关键信息（URL、状态码、headers）

### Q: 如何过滤特定请求？

```typescript
// 按 URL 关键词过滤
const requests = browser_network({ tabId: 123, action: "list" })
const apiRequests = requests.filter(req => req.url.includes('/api/'))

// 按方法过滤
const postRequests = requests.filter(req => req.method === 'POST')

// 按状态码过滤
const errors = requests.filter(req => req.status >= 400)
```
