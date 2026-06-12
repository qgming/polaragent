# 页面加载等待策略

## 等待策略概览

浏览器操作的核心挑战之一是处理异步加载。页面内容、动态元素、网络请求都需要时间，过早操作会导致失败。

**推荐策略优先级**：
1. **等待特定条件** - 最可靠
2. **轮询检查** - 通用方案
3. **固定延迟** - 最后手段（不推荐）

---

## 策略 1：等待特定条件

### 等待元素出现

**使用 execute 等待 DOM 元素**：
```typescript
browser_execute({
  script: `
    new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('等待超时'));
      }, 10000);
      
      const check = () => {
        const element = document.querySelector('.target-element');
        if (element) {
          clearTimeout(timeout);
          resolve(true);
        } else {
          setTimeout(check, 100);
        }
      };
      check();
    })
  `
})

// 元素出现后继续操作
browser_click({ target: ".target-element" })
```

**等待多个元素**：
```typescript
browser_execute({
  script: `
    new Promise(resolve => {
      const check = () => {
        const el1 = document.querySelector('.element-1');
        const el2 = document.querySelector('.element-2');
        if (el1 && el2) {
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

---

### 等待文本内容

**等待页面包含特定文本**：
```typescript
browser_execute({
  script: `
    new Promise(resolve => {
      const check = () => {
        if (document.body.innerText.includes('加载完成')) {
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

**等待元素文本变化**：
```typescript
browser_execute({
  script: `
    new Promise(resolve => {
      const element = document.querySelector('.status');
      const check = () => {
        if (element.textContent.includes('完成')) {
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

---

### 等待网络请求完成

**等待 AJAX 请求**：
```typescript
browser_execute({
  script: `
    new Promise(resolve => {
      // 检查是否有正在进行的请求
      const check = () => {
        // 假设页面有一个 isLoading 状态
        if (window.isLoading === false) {
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

**使用 network 监控**：
```typescript
// 1. 开始监控
browser_network({ tabId: 123, action: "start" })

// 2. 触发操作
browser_click({ target: "button.load-data" })

// 3. 等待特定请求完成
browser_execute({
  script: `
    new Promise(resolve => {
      const check = () => {
        // 检查页面上的加载指示器
        const loader = document.querySelector('.loading-spinner');
        if (!loader || loader.style.display === 'none') {
          resolve(true);
        } else {
          setTimeout(check, 100);
        }
      };
      check();
    })
  `
})

// 4. 查看网络请求
browser_network({ tabId: 123, action: "list" })
```

---

### 等待页面导航

**等待 URL 变化**：
```typescript
// 记录当前 URL
const currentUrl = browser_execute({ script: "window.location.href" })

// 执行导航操作
browser_click({ target: "a.next-page" })

// 等待 URL 变化
browser_execute({
  script: `
    new Promise(resolve => {
      const originalUrl = '${currentUrl}';
      const check = () => {
        if (window.location.href !== originalUrl) {
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

**等待页面完全加载**：
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
```

---

## 策略 2：轮询检查

### 基础轮询模式

```typescript
function waitForCondition(condition, timeout = 10000, interval = 100) {
  const startTime = Date.now();
  
  const check = () => {
    const result = browser_execute({ script: condition });
    
    if (result) {
      return { success: true };
    }
    
    if (Date.now() - startTime > timeout) {
      return { success: false, error: '等待超时' };
    }
    
    // 短暂等待后重试
    browser_execute({ 
      script: `new Promise(resolve => setTimeout(resolve, ${interval}))` 
    });
    
    return check();
  };
  
  return check();
}

// 使用示例
waitForCondition("document.querySelector('.result') !== null")
```

---

### 轮询扫描内容

```typescript
function waitForText(expectedText, maxRetries = 10) {
  for (let i = 0; i < maxRetries; i++) {
    const content = browser_scan({ textOnly: true });
    
    if (content.includes(expectedText)) {
      return { success: true };
    }
    
    // 等待 500ms 后重试
    browser_execute({ 
      script: "new Promise(resolve => setTimeout(resolve, 500))" 
    });
  }
  
  return { success: false, error: '未找到预期文本' };
}

// 使用示例
browser_click({ target: "button.submit" })
waitForText("提交成功")
```

---

## 策略 3：组合等待

### 等待 + 验证模式

```typescript
// 1. 等待元素出现
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

// 2. 验证内容是否符合预期
const content = browser_scan({ textOnly: true })
if (content.includes('成功')) {
  // 继续下一步
} else {
  // 处理错误
}
```

---

### 多条件等待

```typescript
browser_execute({
  script: `
    new Promise(resolve => {
      const check = () => {
        const conditions = [
          document.querySelector('.content'),              // 元素存在
          !document.querySelector('.loading'),             // 加载完成
          document.body.innerText.includes('完成'),        // 包含文本
          document.readyState === 'complete'               // 页面加载完成
        ];
        
        if (conditions.every(c => c)) {
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

---

## 策略 4：使用 MutationObserver

### 监听 DOM 变化

```typescript
browser_execute({
  script: `
    new Promise(resolve => {
      const targetNode = document.querySelector('#container');
      
      const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
            // 检查是否添加了目标元素
            if (document.querySelector('.target-element')) {
              observer.disconnect();
              resolve(true);
            }
          }
        }
      });
      
      observer.observe(targetNode, {
        childList: true,
        subtree: true
      });
      
      // 设置超时
      setTimeout(() => {
        observer.disconnect();
        resolve(false);
      }, 10000);
    })
  `
})
```

---

## 常见场景处理

### 场景 1：表单提交后等待

```typescript
// 点击提交按钮
browser_click({ target: "button[type='submit']" })

// 等待页面跳转或成功提示
browser_execute({
  script: `
    new Promise(resolve => {
      const check = () => {
        // 检查成功提示
        if (document.querySelector('.success-message')) {
          resolve('success');
        }
        // 检查错误提示
        else if (document.querySelector('.error-message')) {
          resolve('error');
        }
        // 检查 URL 变化
        else if (window.location.pathname !== '/form') {
          resolve('redirect');
        }
        else {
          setTimeout(check, 100);
        }
      };
      check();
    })
  `
})
```

---

### 场景 2：无限滚动加载

```typescript
function loadAllContent(maxScrolls = 10) {
  for (let i = 0; i < maxScrolls; i++) {
    // 记录当前内容数量
    const beforeCount = browser_execute({
      script: "document.querySelectorAll('.item').length"
    });
    
    // 滚动到底部
    browser_execute({
      script: "window.scrollTo(0, document.body.scrollHeight)"
    });
    
    // 等待新内容加载
    browser_execute({
      script: `
        new Promise(resolve => {
          const initialCount = ${beforeCount};
          const check = () => {
            const currentCount = document.querySelectorAll('.item').length;
            if (currentCount > initialCount) {
              resolve(true);
            } else {
              setTimeout(check, 200);
            }
          };
          check();
        })
      `
    });
    
    // 检查是否到底
    const afterCount = browser_execute({
      script: "document.querySelectorAll('.item').length"
    });
    
    if (afterCount === beforeCount) {
      break; // 没有新内容，已到底
    }
  }
}
```

---

### 场景 3：单页应用路由跳转

```typescript
// 记录当前路由
const beforePath = browser_execute({ script: "window.location.pathname" })

// 点击导航链接
browser_click({ target: "a.nav-link" })

// 等待路由变化
browser_execute({
  script: `
    new Promise(resolve => {
      const originalPath = '${beforePath}';
      const check = () => {
        if (window.location.pathname !== originalPath) {
          resolve(true);
        } else {
          setTimeout(check, 100);
        }
      };
      check();
    })
  `
})

// 等待新页面内容加载
browser_execute({
  script: `
    new Promise(resolve => {
      const check = () => {
        // 检查页面特定标识元素
        if (document.querySelector('.page-loaded')) {
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

---

## 避免固定延迟

**❌ 不推荐**：
```typescript
// 固定等待 3 秒（太长或太短都不好）
browser_execute({ script: "new Promise(resolve => setTimeout(resolve, 3000))" })
```

**✅ 推荐**：
```typescript
// 等待特定条件
browser_execute({
  script: `
    new Promise(resolve => {
      const check = () => {
        if (document.querySelector('.loaded')) {
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

---

## 超时处理

### 设置合理的超时时间

```typescript
browser_execute({
  script: `
    new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('操作超时，页面可能加载失败'));
      }, 10000); // 10 秒超时
      
      const check = () => {
        if (document.querySelector('.target')) {
          clearTimeout(timeout);
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

---

## 最佳实践总结

1. **优先等待特定条件**，不要使用固定延迟
2. **设置合理的超时时间**，避免无限等待
3. **使用轮询检查**，间隔 100-200ms 较为合适
4. **检查多个条件**，确保页面真正加载完成
5. **捕获错误**，超时时截图保存现场
6. **记录日志**，方便调试和问题追踪

```typescript
// 完整示例
function safeClick(target, options = {}) {
  const { waitFor, timeout = 10000 } = options;
  
  try {
    // 1. 等待页面准备就绪
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
    
    // 2. 执行点击
    browser_click({ target });
    
    // 3. 验证操作成功
    return { success: true };
    
  } catch (error) {
    // 4. 失败时截图
    browser_screenshot({ fullPage: true });
    return { success: false, error: error.message };
  }
}

// 使用
safeClick("button.submit", {
  waitFor: "document.querySelector('button.submit') !== null",
  timeout: 5000
});
```
