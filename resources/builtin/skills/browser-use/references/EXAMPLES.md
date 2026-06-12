# 使用场景示例

## 场景 1：登录网站

```typescript
// 1. 打开登录页
browser_open({ url: "https://example.com/login" })

// 2. 生成可操作元素快照
const snap = browser_snapshot({ limit: 200 })
// 输出: @e1: input - 用户名, @e2: input - 密码, @e3: button - 登录

// 3. 填写表单
browser_fill({ target: "@e1", value: "myuser", snapshotId: snap.snapshotId })
browser_fill({ target: "@e2", value: "mypass", snapshotId: snap.snapshotId })

// 4. 提交登录
browser_click({ target: "@e3", snapshotId: snap.snapshotId })

// 5. 等待跳转，截图验证
browser_screenshot()
```

## 场景 2：数据采集

```typescript
// 1. 打开目标页面
browser_open({ url: "https://example.com/products" })

// 2. 扫描页面文本
const text = browser_scan({ textOnly: true })

// 3. 执行脚本提取结构化数据
const products = browser_execute({ 
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

## 场景 3：搜索和导航

```typescript
// 1. 打开搜索引擎
browser_open({ url: "https://www.google.com" })

// 2. 定位搜索框
const snap = browser_snapshot()
// 找到 @e1: input - 搜索框

// 3. 输入搜索关键词
browser_fill({ target: "@e1", value: "PolarAgent AI assistant", snapshotId: snap.snapshotId })

// 4. 提交搜索
browser_execute({ script: "document.querySelector('input[name=q]').form.submit()" })

// 5. 等待结果，提取链接
const titles = browser_execute({ 
  script: "Array.from(document.querySelectorAll('h3')).map(h => h.textContent)" 
})
```

## 场景 4：表单批量填写

```typescript
// 1. 打开表单页面
browser_open({ url: "https://example.com/form" })

// 2. 生成快照
const snap = browser_snapshot()

// 3. 批量填写多个字段
const formData = {
  "@e1": "张三",
  "@e2": "zhangsan@example.com",
  "@e3": "13800138000",
  "@e4": "北京市朝阳区"
};

for (const [target, value] of Object.entries(formData)) {
  browser_fill({ target, value, clear: true, snapshotId: snap.snapshotId });
}

// 4. 提交表单
browser_click({ target: "@e10", snapshotId: snap.snapshotId })

// 5. 截图保存结果
browser_screenshot()
```

## 场景 5：监控接口请求

```typescript
// 1. 获取当前标签页
const tabs = browser_tabs()
const tabId = tabs.find(t => t.active)?.id

// 2. 打开目标页面并开始监控
browser_open({ url: "https://example.com/dashboard" })
browser_network({ tabId, action: "start" })

// 3. 触发数据加载
const snap = browser_snapshot({ tabId })
browser_click({ target: "button.refresh", tabId, snapshotId: snap.snapshotId })

// 4. 等待请求完成（可使用 execute 检查）
browser_execute({ 
  tabId,
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

// 5. 查看网络请求
const requests = browser_network({ tabId, action: "list" })

// 6. 停止监控
browser_network({ tabId, action: "stop" })
```

## 场景 6：多标签页操作

```typescript
// 1. 批量打开多个页面
const urls = [
  "https://site1.com",
  "https://site2.com",
  "https://site3.com"
];

const tabIds = urls.map(url => {
  const result = browser_open({ url });
  return result.tabId;
});

// 2. 等待所有页面加载完成
// （可以使用 execute 检查每个标签页的加载状态）

// 3. 对每个标签页执行操作
tabIds.forEach(tabId => {
  const text = browser_scan({ tabId, textOnly: true });
  browser_screenshot({ tabId });
});

// 4. 清理标签页
tabIds.forEach(tabId => {
  browser_close({ tabId });
});
```

## 场景 7：处理动态内容

```typescript
// 1. 打开页面
browser_open({ url: "https://example.com/infinite-scroll" })

// 2. 滚动加载更多内容
for (let i = 0; i < 5; i++) {
  // 滚动到底部
  browser_execute({ 
    script: "window.scrollTo(0, document.body.scrollHeight)" 
  })
  
  // 等待内容加载
  browser_execute({ 
    script: `
      new Promise(resolve => setTimeout(resolve, 1000))
    `
  })
}

// 3. 提取所有加载的内容
const items = browser_execute({ 
  script: `
    Array.from(document.querySelectorAll('.item')).map(el => ({
      title: el.querySelector('.title')?.textContent,
      content: el.querySelector('.content')?.textContent
    }))
  `
})
```

## 场景 8：文件上传

```typescript
// 1. 打开上传页面
browser_open({ url: "https://example.com/upload" })

// 2. 使用 execute 模拟文件上传（DataTransfer API）
browser_execute({ 
  script: `
    const input = document.querySelector('input[type=file]');
    const file = new File(['文件内容'], 'demo.txt', { type: 'text/plain' });
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return input.files.length;
  `
})

// 3. 点击上传按钮
const snap = browser_snapshot()
browser_click({ target: "@e5", snapshotId: snap.snapshotId })
```

## 场景 9：处理模态框

```typescript
// 1. 触发模态框
const snap1 = browser_snapshot()
browser_click({ target: "@e3", snapshotId: snap1.snapshotId })

// 2. 等待模态框出现
browser_execute({ 
  script: `
    new Promise(resolve => {
      const check = () => {
        if (document.querySelector('.modal')) {
          resolve(true);
        } else {
          setTimeout(check, 100);
        }
      };
      check();
    })
  `
})

// 3. 重新快照获取模态框内的元素
const snap2 = browser_snapshot()

// 4. 操作模态框内的元素
browser_fill({ target: "@e1", value: "modal input", snapshotId: snap2.snapshotId })
browser_click({ target: "@e2", snapshotId: snap2.snapshotId })
```

## 场景 10：错误处理和重试

```typescript
function clickWithRetry(target, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      // 生成新快照
      const snap = browser_snapshot();
      
      // 尝试点击
      browser_click({ target, snapshotId: snap.snapshotId });
      
      // 验证点击成功
      const result = browser_execute({
        script: `document.querySelector('${target}') !== null`
      });
      
      if (result) {
        return { success: true };
      }
    } catch (error) {
      if (i === maxRetries - 1) {
        // 最后一次失败，截图记录
        browser_screenshot({ fullPage: true });
        return { success: false, error: error.message };
      }
      // 等待后重试
      browser_execute({ 
        script: `new Promise(resolve => setTimeout(resolve, 1000))` 
      });
    }
  }
}

// 使用
const result = clickWithRetry("button.submit");
```
