# 故障排查指南

## 快速诊断流程

遇到问题时，按以下顺序排查：

1. **确认扩展已安装并连接** - 点击扩展图标查看状态
2. **确认有普通网页打开** - 不能是 chrome:// 或 about:blank
3. **重新加载扩展** - chrome://extensions/ → 刷新按钮
4. **检查工具调用参数** - tabId、target、snapshotId 是否正确
5. **截图保存现场** - 用于分析问题

---

## 常见问题及解决方案

### 问题 1：扩展未连接

**症状**：
- 工具调用报错 "Chrome 扩展未连接"
- 扩展图标显示 🔴 未连接
- browser_tabs 返回空数组

**排查步骤**：

1. **检查扩展是否已安装**
   ```
   1. 打开 chrome://extensions/
   2. 搜索 "PolarAgent BrowserUse"
   3. 确认扩展已启用（开关为蓝色）
   ```

2. **检查是否有普通网页**
   ```
   - 打开任意网站（如 https://www.google.com）
   - 不能是 chrome:// 或 about:blank 页面
   - 扩展在特殊页面上无法运行
   ```

3. **重新加载扩展**
   ```
   1. 在 chrome://extensions/ 页面
   2. 找到 PolarAgent BrowserUse 扩展
   3. 点击刷新图标（圆形箭头）
   4. 刷新网页标签页
   ```

4. **检查 WebSocket 端口**
   ```
   - 默认端口：127.0.0.1:18765
   - 确认 PolarAgent 应用正在运行
   - 检查防火墙是否阻止连接
   ```

5. **重启 PolarAgent 应用**
   ```
   - 完全关闭 PolarAgent
   - 重新启动
   - 等待扩展自动连接
   ```

---

### 问题 2：@e 引用无效

**症状**：
- browser_click 报错 "未找到元素: @e1"
- browser_fill 无效果

**原因**：
- @e 引用已过期（页面内容变化）
- snapshotId 不匹配
- 引用编号错误

**解决方案**：

```typescript
// ❌ 错误用法：@e 引用过期
browser_snapshot()
browser_click({ target: "@e1" })
// ... 页面发生变化
browser_click({ target: "@e2" })  // 失败！

// ✅ 正确用法：每次操作前重新 snapshot
browser_snapshot()
browser_click({ target: "@e1" })

browser_snapshot()  // 重新生成快照
browser_click({ target: "@e2" })

// ✅ 或者传入 snapshotId
const snap = browser_snapshot()
browser_click({ target: "@e1", snapshotId: snap.snapshotId })
browser_fill({ target: "@e2", value: "data", snapshotId: snap.snapshotId })
```

**检查引用是否有效**：
```typescript
// 查看快照内容
const snap = browser_snapshot()
console.log("可用的 @e 引用:", snap.elements.map(el => el.ref))

// 尝试使用 CSS 选择器代替
browser_click({ target: "button.submit" })
```

---

### 问题 3：元素找不到

**症状**：
- browser_click 报错 "未找到元素"
- CSS 选择器无法定位元素

**排查步骤**：

1. **验证选择器**
   ```typescript
   // 使用 execute 检查元素是否存在
   const exists = browser_execute({
     script: "!!document.querySelector('#target-element')"
   })
   
   if (!exists) {
     console.log("元素不存在，可能：")
     console.log("1. 选择器错误")
     console.log("2. 元素未加载")
     console.log("3. 元素在 iframe 或 Shadow DOM 内")
   }
   ```

2. **等待元素加载**
   ```typescript
   // 等待元素出现
   browser_execute({
     script: `
       new Promise(resolve => {
         const check = () => {
           if (document.querySelector('#target')) {
             resolve(true);
           } else {
             setTimeout(check, 100);
           }
         };
         check();
       })
     `
   })
   
   // 然后再点击
   browser_click({ target: "#target" })
   ```

3. **使用 snapshot 查看所有元素**
   ```typescript
   // 列出所有可操作元素
   const snap = browser_snapshot({ limit: 200 })
   
   // 查看元素列表，找到目标元素的 @e 引用
   console.log(snap.elements)
   ```

4. **检查元素是否在 iframe 内**
   ```typescript
   // 优先使用 @e 引用（会自动穿透同源 iframe）
   const snap = browser_snapshot()
   browser_click({ target: "@e5", snapshotId: snap.snapshotId })
   
   // 或使用 execute 手动进入 iframe
   browser_execute({
     script: `
       const iframe = document.querySelector('iframe');
       const button = iframe.contentDocument.querySelector('button');
       button.click();
     `
   })
   ```

---

### 问题 4：点击无效果

**症状**：
- browser_click 执行成功但页面无变化
- 按钮未触发预期动作

**可能原因**：

1. **元素被遮挡**
   ```typescript
   // 先滚动元素到可见区域
   browser_execute({
     script: `
       const element = document.querySelector('#target');
       element.scrollIntoView({ block: 'center', behavior: 'smooth' });
     `
   })
   
   // 等待滚动完成
   browser_execute({
     script: "new Promise(resolve => setTimeout(resolve, 500))"
   })
   
   // 再点击
   browser_click({ target: "#target" })
   ```

2. **需要等待页面响应**
   ```typescript
   browser_click({ target: "button.submit" })
   
   // 等待页面变化
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

3. **元素需要特定事件**
   ```typescript
   // 使用 execute 手动触发事件
   browser_execute({
     script: `
       const element = document.querySelector('#target');
       element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
       element.click();
       element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
     `
   })
   ```

4. **元素被禁用**
   ```typescript
   // 检查元素状态
   const status = browser_execute({
     script: `
       const el = document.querySelector('#target');
       return {
         disabled: el.disabled,
         readonly: el.readOnly,
         hidden: el.hidden,
         display: window.getComputedStyle(el).display
       }
     `
   })
   
   console.log("元素状态:", status)
   ```

---

### 问题 5：填充无效果

**症状**：
- browser_fill 执行后输入框内容未变化
- 填充的值被清空

**解决方案**：

1. **使用 clear 参数**
   ```typescript
   // 先清空再填充
   browser_fill({ 
     target: "input#email", 
     value: "new@example.com",
     clear: true 
   })
   ```

2. **触发事件**
   ```typescript
   browser_execute({
     script: `
       const input = document.querySelector('input#email');
       input.value = 'new@example.com';
       input.dispatchEvent(new Event('input', { bubbles: true }));
       input.dispatchEvent(new Event('change', { bubbles: true }));
       input.dispatchEvent(new Event('blur', { bubbles: true }));
     `
   })
   ```

3. **等待输入框激活**
   ```typescript
   // 先点击输入框
   browser_click({ target: "input#email" })
   
   // 等待聚焦
   browser_execute({
     script: "new Promise(resolve => setTimeout(resolve, 200))"
   })
   
   // 再填充
   browser_fill({ target: "input#email", value: "new@example.com" })
   ```

---

### 问题 6：页面内容读取为空

**症状**：
- browser_scan 返回空字符串或很少内容
- 页面明明有内容但读不到

**排查步骤**：

1. **等待页面完全加载**
   ```typescript
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
   
   // 然后再扫描
   browser_scan({ textOnly: true })
   ```

2. **检查是否是动态加载内容**
   ```typescript
   // 等待特定元素出现
   browser_execute({
     script: `
       new Promise(resolve => {
         const check = () => {
           if (document.querySelector('.content')) {
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

3. **使用 execute 检查 DOM 状态**
   ```typescript
   const info = browser_execute({
     script: `
       return {
         readyState: document.readyState,
         bodyLength: document.body?.innerHTML?.length || 0,
         hasContent: !!document.querySelector('.content')
       }
     `
   })
   
   console.log("页面状态:", info)
   ```

4. **截图查看实际内容**
   ```typescript
   browser_screenshot({ fullPage: true })
   // 检查截图确认页面是否真的加载了内容
   ```

---

### 问题 7：网络监控无效

**症状**：
- browser_network 捕获不到请求
- 请求列表为空

**解决方案**：

1. **先 start 再触发请求**
   ```typescript
   // ✅ 正确顺序
   browser_network({ tabId: 123, action: "start" })
   browser_click({ target: "button.load" })
   browser_network({ tabId: 123, action: "list" })
   
   // ❌ 错误顺序
   browser_click({ target: "button.load" })
   browser_network({ tabId: 123, action: "start" })  // 太晚了
   browser_network({ tabId: 123, action: "list" })   // 捕获不到
   ```

2. **重新加载扩展**
   ```
   修改或升级扩展后，network/console 监控可能失效
   需要用户重新加载扩展：
   1. 打开 chrome://extensions/
   2. 找到 PolarAgent BrowserUse
   3. 点击刷新按钮
   4. 刷新网页标签页
   ```

3. **检查是否有实际请求**
   ```typescript
   // 使用 execute 确认页面确实发送了请求
   browser_execute({
     script: `
       fetch('https://api.example.com/test')
         .then(r => r.json())
         .then(data => console.log('请求成功', data))
         .catch(err => console.error('请求失败', err))
     `
   })
   ```

---

### 问题 8：截图失败

**症状**：
- browser_screenshot 报错
- 截图文件未生成

**解决方案**：

1. **检查工作目录权限**
   ```typescript
   // 截图默认保存到会话工作目录
   // 确保目录存在且有写入权限
   ```

2. **等待页面完全渲染**
   ```typescript
   browser_execute({
     script: "new Promise(resolve => setTimeout(resolve, 1000))"
   })
   
   browser_screenshot()
   ```

3. **使用简单截图**
   ```typescript
   // 如果 fullPage 失败，试试默认截图
   browser_screenshot()
   
   // 如果 target 失败，试试不指定 target
   browser_screenshot({ fullPage: true })
   ```

---

## 调试技巧

### 1. 使用 execute 调试

```typescript
// 查看页面状态
browser_execute({
  script: `
    return {
      url: window.location.href,
      title: document.title,
      readyState: document.readyState,
      bodyLength: document.body.innerHTML.length,
      hasContent: document.body.innerText.length > 0
    }
  `
})
```

### 2. 截图保存现场

```typescript
try {
  browser_click({ target: "@e1" })
} catch (error) {
  // 失败时截图
  browser_screenshot({ fullPage: true })
  console.error("操作失败:", error.message)
}
```

### 3. 分步验证

```typescript
// 1. 验证元素存在
const exists = browser_execute({
  script: "!!document.querySelector('button.submit')"
})
console.log("元素存在:", exists)

// 2. 验证元素可见
const visible = browser_execute({
  script: `
    const el = document.querySelector('button.submit');
    const style = window.getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden';
  `
})
console.log("元素可见:", visible)

// 3. 验证元素可点击
const clickable = browser_execute({
  script: `
    const el = document.querySelector('button.submit');
    return !el.disabled;
  `
})
console.log("元素可点击:", clickable)

// 4. 执行点击
if (exists && visible && clickable) {
  browser_click({ target: "button.submit" })
}
```

---

## 最佳实践

### 1. 防御式编程

```typescript
function safeClick(target, options = {}) {
  const { waitFor, timeout = 10000, retries = 3 } = options;
  
  for (let i = 0; i < retries; i++) {
    try {
      // 等待条件
      if (waitFor) {
        browser_execute({
          script: `
            new Promise((resolve, reject) => {
              const startTime = Date.now();
              const check = () => {
                if (${waitFor}) {
                  resolve(true);
                } else if (Date.now() - startTime > ${timeout}) {
                  reject(new Error('等待超时'));
                } else {
                  setTimeout(check, 100);
                }
              };
              check();
            })
          `
        });
      }
      
      // 执行点击
      browser_click({ target });
      return { success: true };
      
    } catch (error) {
      if (i === retries - 1) {
        // 最后一次失败，截图保存
        browser_screenshot({ fullPage: true });
        return { success: false, error: error.message };
      }
      
      // 等待后重试
      browser_execute({
        script: "new Promise(resolve => setTimeout(resolve, 1000))"
      });
    }
  }
}
```

### 2. 详细日志

```typescript
function logOperation(operation, details) {
  console.log(`[BrowserUse] ${operation}`, {
    timestamp: new Date().toISOString(),
    ...details
  });
}

// 使用
logOperation("点击按钮", { target: "@e1" });
browser_click({ target: "@e1" });
logOperation("点击完成", { success: true });
```

### 3. 错误恢复

```typescript
function clickWithFallback(target) {
  try {
    // 尝试直接点击
    browser_click({ target });
    return { success: true, method: "direct" };
  } catch (error) {
    // 回退到 snapshot + @e
    try {
      const snap = browser_snapshot();
      const element = snap.elements[0]; // 假设第一个元素是目标
      browser_click({ target: element.ref, snapshotId: snap.snapshotId });
      return { success: true, method: "snapshot" };
    } catch (error2) {
      // 最后使用 execute
      try {
        browser_execute({
          script: `document.querySelector('${target}').click()`
        });
        return { success: true, method: "execute" };
      } catch (error3) {
        return { success: false, error: error3.message };
      }
    }
  }
}
```

---

## 获取帮助

如果以上方法都无法解决问题：

1. **截图保存现场** - 包括完整页面和错误信息
2. **记录操作步骤** - 详细列出每一步操作
3. **检查扩展状态** - 提供扩展连接状态和版本信息
4. **提供完整错误信息** - 包括工具返回的完整错误消息

**常见信息收集**：
```typescript
// 收集调试信息
const debugInfo = {
  // 标签页信息
  tabs: browser_tabs(),
  
  // 页面状态
  pageState: browser_execute({
    script: `
      return {
        url: window.location.href,
        title: document.title,
        readyState: document.readyState,
        bodyLength: document.body.innerHTML.length
      }
    `
  }),
  
  // 扩展状态
  // 通过点击扩展图标查看
};

console.log("调试信息:", debugInfo);
browser_screenshot({ fullPage: true });
```
