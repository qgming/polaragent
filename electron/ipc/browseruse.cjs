// IPC：Browser Use - 浏览器控制（Chrome扩展桥接）
const WebSocket = require("ws");
const http = require("http");
const { app } = require("electron");

// 配置
const EXTENSION_PORT = 18765; // Chrome 扩展连接端口
const API_PORT = 18767; // HTTP API 端口

// 状态管理
let wss = null; // WebSocket 服务器
let apiServer = null; // HTTP API 服务器
let extensionWs = null; // 扩展连接
let requestId = 0; // 请求 ID 计数器
let pendingRequests = new Map(); // 待处理请求
let snapshotCache = new Map(); // @e 引用缓存

// 启动服务
function startServices() {
  if (wss) return;

  // WebSocket 服务器（扩展连接）
  wss = new WebSocket.Server({ port: EXTENSION_PORT });
  wss.on("connection", (ws) => {
    console.log("[BrowserUse] Extension connected");
    extensionWs = ws;

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data);
        console.log("[BrowserUse] Received message:", msg.type || msg.action, msg.error ? `ERROR: ${msg.error}` : "");

        // 处理扩展的 ext_ready 消息
        if (msg.type === "ext_ready") {
          console.log("[BrowserUse] Extension ready with", msg.tabs?.length || 0, "tabs");
          return;
        }

        // 忽略 ping 和 tabs_update 消息
        if (msg.type === "ping" || msg.type === "tabs_update") {
          return;
        }

        // 处理命令响应: { type: 'result'/'error', id, result, error }
        if (msg.id && pendingRequests.has(Number(msg.id))) {
          const { resolve } = pendingRequests.get(Number(msg.id));
          pendingRequests.delete(Number(msg.id));
          resolve(msg);
        }
      } catch (e) {
        console.error("[BrowserUse] WebSocket 消息解析失败:", e);
      }
    });

    ws.on("close", () => {
      console.log("[BrowserUse] Extension disconnected");
      extensionWs = null;
    });

    ws.on("error", (err) => {
      console.error("[BrowserUse] WebSocket error:", err);
    });
  });

  // HTTP API 服务器（工具调用）
  apiServer = http.createServer(async (req, res) => {
    if (req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        try {
          const params = JSON.parse(body);
          const result = await handleCommand(params);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, result }));
        } catch (error) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: error.message }));
        }
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  apiServer.listen(API_PORT);
}

// 停止服务
function stopServices() {
  if (wss) {
    wss.close();
    wss = null;
  }
  if (apiServer) {
    apiServer.close();
    apiServer = null;
  }
  extensionWs = null;
  pendingRequests.clear();
  snapshotCache.clear();
}

// 发送命令到扩展
async function sendToExtension(action, params = {}, timeout = 30000) {
  if (!extensionWs || extensionWs.readyState !== WebSocket.OPEN) {
    throw new Error("Chrome 扩展未连接，请确保已加载扩展并打开网页");
  }

  return new Promise((resolve, reject) => {
    const id = ++requestId;
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`操作超时 (${timeout}ms): ${action}`));
    }, timeout);

    pendingRequests.set(id, {
      resolve: (msg) => {
        clearTimeout(timer);
        if (msg.type === "error") {
          reject(new Error(msg.error || "未知错误"));
        } else {
          resolve(msg.result || msg);
        }
      },
    });

    // 扩展期望的消息格式: { id, code: { cmd, ...params } }
    extensionWs.send(
      JSON.stringify({
        id: String(id),
        code: { cmd: action, ...params },
      })
    );
  });
}

// 命令处理
async function handleCommand(params) {
  const { command, ...args } = params;

  switch (command) {
    case "tabs":
      return await getTabs(args);
    case "open":
      return await openTab(args);
    case "close":
      return await closeTab(args);
    case "scan":
      return await scanPage(args);
    case "snapshot":
      return await snapshot(args);
    case "click":
      return await click(args);
    case "fill":
      return await fill(args);
    case "exec":
      return await executeScript(args);
    case "screenshot":
      return await screenshot(args);
    case "network":
      return await networkMonitor(args);
    default:
      throw new Error(`未知命令: ${command}`);
  }
}

// 获取标签页列表
async function getTabs(args) {
  const resp = await sendToExtension("tabs", args);
  console.log("[BrowserUse] getTabs response:", JSON.stringify(resp, null, 2));
  // 响应直接就是数组
  return Array.isArray(resp) ? resp : (resp.data || resp.result?.data || []);
}

// 打开新标签页
async function openTab(args) {
  const { url, profile } = args;
  const resp = await sendToExtension("openTab", { url, profile });
  console.log("[BrowserUse] openTab response:", JSON.stringify(resp, null, 2));
  // 响应直接就是对象，id 字段就是 tabId
  return { tabId: resp.id || resp.data?.id || resp.result?.data?.id };
}

// 关闭标签页
async function closeTab(args) {
  const { tabId } = args;
  const resp = await sendToExtension("closeTab", { tabId });
  return resp.data || resp.result?.data || { closed: true };
}

// 扫描页面内容
async function scanPage(args) {
  const { tabId, textOnly } = args;
  // 使用 CDP 执行脚本获取页面内容
  const script = textOnly
    ? "document.body.innerText"
    : "document.documentElement.outerHTML";
  const resp = await sendToExtension("cdp", {
    tabId,
    method: "Runtime.evaluate",
    params: { expression: script, returnByValue: true },
  });
  console.log("[BrowserUse] scanPage response:", JSON.stringify(resp, null, 2).slice(0, 500));
  return resp.result?.value || resp.value || "";
}

// 获取页面快照（生成 @e 引用）
async function snapshot(args) {
  const { tabId, limit = 200, offset = 0 } = args;
  // 执行脚本获取可交互元素
  const script = `
    (() => {
      const elements = [];
      const selectors = 'a, button, input, textarea, select, [onclick], [role="button"]';
      const nodes = document.querySelectorAll(selectors);
      for (let i = ${offset}; i < Math.min(nodes.length, ${offset + limit}); i++) {
        const el = nodes[i];
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          elements.push({
            type: el.tagName.toLowerCase(),
            text: (el.textContent || el.value || el.placeholder || '').trim().slice(0, 50),
            selector: el.id ? '#' + el.id : el.className ? '.' + el.className.split(' ')[0] : el.tagName
          });
        }
      }
      return elements;
    })()
  `;
  const resp = await sendToExtension("cdp", {
    tabId,
    method: "Runtime.evaluate",
    params: { expression: script, returnByValue: true },
  });
  const elements = resp.result?.value || [];

  // 缓存元素引用
  const sessionKey = `${tabId}_${Date.now()}`;
  snapshotCache.set(sessionKey, elements);

  return { sessionKey, elements, count: elements.length };
}

// 点击元素
async function click(args) {
  const { tabId, target } = args;

  // 解析 @e 引用
  let selector = target;
  if (target.startsWith("@e")) {
    const index = parseInt(target.slice(2)) - 1;
    const elements = Array.from(snapshotCache.values()).flat();
    if (elements[index]) {
      selector = elements[index].selector;
    }
  }

  const script = `document.querySelector('${selector}').click()`;
  await sendToExtension("cdp", {
    tabId,
    method: "Runtime.evaluate",
    params: { expression: script },
  });
  return { clicked: true };
}

// 填充表单
async function fill(args) {
  const { tabId, target, value, clear, append } = args;

  let selector = target;
  if (target.startsWith("@e")) {
    const index = parseInt(target.slice(2)) - 1;
    const elements = Array.from(snapshotCache.values()).flat();
    if (elements[index]) {
      selector = elements[index].selector;
    }
  }

  const clearScript = clear ? `el.value = '';` : "";
  const appendScript = append ? `el.value += '${value.replace(/'/g, "\\'")}';` : `el.value = '${value.replace(/'/g, "\\'")}';`;
  const script = `
    (() => {
      const el = document.querySelector('${selector}');
      ${clearScript}
      ${appendScript}
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    })()
  `;
  await sendToExtension("cdp", {
    tabId,
    method: "Runtime.evaluate",
    params: { expression: script },
  });
  return { filled: true };
}

// 执行 JavaScript
async function executeScript(args) {
  const { tabId, script } = args;
  const resp = await sendToExtension("cdp", {
    tabId,
    method: "Runtime.evaluate",
    params: { expression: script, returnByValue: true },
  });
  return resp.result?.value || resp.result;
}

// 截图
async function screenshot(args) {
  const { tabId, fullPage, target } = args;
  const resp = await sendToExtension("cdp", {
    tabId,
    method: "Page.captureScreenshot",
    params: { format: "png", fromSurface: true },
  });
  console.log("[BrowserUse] screenshot response keys:", Object.keys(resp));
  const base64Data = resp.data || resp.result || resp;

  // 保存截图到文件
  const fs = require("fs");
  const path = require("path");
  const timestamp = Date.now();
  const filename = `browser-screenshot-${timestamp}.png`;

  // 获取工作目录（从会话传入，或使用临时目录）
  const workDir = args.workDir || require("os").tmpdir();
  const filepath = path.join(workDir, filename);

  // 将 base64 数据写入文件
  const buffer = Buffer.from(base64Data, "base64");
  fs.writeFileSync(filepath, buffer);

  console.log("[BrowserUse] Screenshot saved to:", filepath);

  return {
    dataUrl: "data:image/png;base64," + base64Data,
    path: filepath,
    filename: filename
  };
}

// 网络监控
async function networkMonitor(args) {
  const { tabId, action } = args;
  if (action === "start") {
    await sendToExtension("networkStart", { tabId });
  } else if (action === "list") {
    const resp = await sendToExtension("networkList", { tabId });
    return resp.data || [];
  } else if (action === "stop") {
    await sendToExtension("networkStop", { tabId });
  }
  return { action };
}

// IPC 处理器
function register(ipcMain) {
  startServices();

  ipcMain.handle("browser-use:call", async (event, params) => {
    try {
      const result = await handleCommand(params);
      return { ok: true, result };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle("browser-use:status", async () => {
    return {
      ok: true,
      connected: extensionWs?.readyState === WebSocket.OPEN,
      ports: { extension: EXTENSION_PORT, api: API_PORT },
    };
  });
}

// 清理
app.on("will-quit", () => {
  stopServices();
});

module.exports = { register };
