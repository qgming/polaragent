// IPC: Computer Use - Windows desktop control via UI Automation.
const { spawn } = require("node:child_process");
const path = require("node:path");
const { app } = require("electron");
const { clampNumber } = require("../lib/utils.cjs");

const DEFAULT_CONFIG = {
  persistentWorker: true,
  actionTimeoutMs: 60000,
  workerIdleTimeoutMs: 10 * 60 * 1000,
};

const BATCH_ACTIONS = new Set([
  "health",
  "snapshot",
  "tree",
  "list_windows",
  "find",
  "element_info",
  "click",
  "double_click",
  "move",
  "drag",
  "scroll",
  "type_text",
  "keypress",
  "focus",
  "invoke",
  "set_value",
  "activate_window",
  "wait",
]);

let config = { ...DEFAULT_CONFIG };
let worker = null;
let workerQueue = Promise.resolve();
let currentWorkerRequest = null;
let workerStdoutBuffer = "";
let workerStderr = "";
let workerIdleTimer = null;
let workerStartedAt = 0;
let workerLastUsedAt = 0;
let workerLastError = null;
const elementCache = new Map();

function getBackendPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "resources", "builtin", "computeruse", "windows-uia.ps1");
  }
  return path.join(__dirname, "..", "..", "resources", "builtin", "computeruse", "windows-uia.ps1");
}

function normalizeConfig(next = {}) {
  return {
    persistentWorker: Boolean(next.persistentWorker ?? config.persistentWorker),
    actionTimeoutMs: clampNumber(next.actionTimeoutMs, config.actionTimeoutMs, 1000, 180000),
    workerIdleTimeoutMs: clampNumber(next.workerIdleTimeoutMs, config.workerIdleTimeoutMs, 30000, 30 * 60 * 1000),
  };
}

function spawnPowerShell(action) {
  return spawn(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-Sta", "-ExecutionPolicy", "Bypass", "-File", getBackendPath(), "-Action", action],
    {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
      },
    },
  );
}

async function runPowerShellOnce(action, args = {}, timeoutMs = config.actionTimeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawnPowerShell(action);
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Computer Use 操作超时 (${timeoutMs}ms): ${action}`));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`PowerShell 启动失败: ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const errorMsg = stderr.trim() || stdout.trim() || "未知错误";
        reject(new Error(`Computer Use 执行失败 (退出码 ${code}): ${errorMsg.slice(0, 500)}`));
        return;
      }
      settleJsonResult(stdout, action, resolve, reject);
    });

    child.stdin.end(JSON.stringify(args || {}));
  });
}

function settleJsonResult(raw, action, resolve, reject) {
  try {
    const trimmed = String(raw || "").trim();
    if (!trimmed) throw new Error("空输出");
    const result = JSON.parse(trimmed);
    if (result.ok === false) {
      const errorHint = getErrorHint(result.error);
      reject(new Error(errorHint || `操作失败: ${result.error || "未知错误"}`));
      return;
    }
    rememberElementsFromResult(result);
    resolve(result);
  } catch (error) {
    reject(new Error(`JSON 解析失败 (${action}): ${String(raw || "").slice(0, 500)}`));
  }
}

function startWorker() {
  if (worker && !worker.killed) return worker;

  clearTimeout(workerIdleTimer);
  workerStdoutBuffer = "";
  workerStderr = "";
  workerLastError = null;
  workerStartedAt = Date.now();
  workerLastUsedAt = Date.now();
  worker = spawnPowerShell("__worker");

  worker.stdout.setEncoding("utf8");
  worker.stderr.setEncoding("utf8");
  worker.stdout.on("data", onWorkerStdout);
  worker.stderr.on("data", (chunk) => {
    workerStderr += chunk;
    if (workerStderr.length > 5000) workerStderr = workerStderr.slice(-5000);
  });
  worker.on("error", (error) => {
    workerLastError = error.message;
    rejectCurrentWorkerRequest(new Error(`PowerShell Worker 启动失败: ${error.message}`));
  });
  worker.on("close", (code) => {
    const message = code === 0 ? "PowerShell Worker 已退出" : `PowerShell Worker 异常退出 (${code})`;
    workerLastError = code === 0 ? workerLastError : `${message}: ${workerStderr.trim().slice(0, 500)}`;
    rejectCurrentWorkerRequest(new Error(workerLastError || message));
    worker = null;
    workerStdoutBuffer = "";
  });

  return worker;
}

function onWorkerStdout(chunk) {
  workerStdoutBuffer += chunk;
  const lines = workerStdoutBuffer.split(/\r?\n/);
  workerStdoutBuffer = lines.pop() || "";

  for (const line of lines) {
    if (!line.trim()) continue;
    const request = currentWorkerRequest;
    if (!request) continue;
    clearTimeout(request.timer);
    currentWorkerRequest = null;
    settleJsonResult(line, request.action, request.resolve, request.reject);
  }
}

function rejectCurrentWorkerRequest(error) {
  if (!currentWorkerRequest) return;
  clearTimeout(currentWorkerRequest.timer);
  currentWorkerRequest.reject(error);
  currentWorkerRequest = null;
}

async function stopWorker(reason = "manual") {
  clearTimeout(workerIdleTimer);
  workerIdleTimer = null;
  if (!worker) return;
  workerLastError = reason === "idle" ? workerLastError : null;
  rejectCurrentWorkerRequest(new Error(`PowerShell Worker 已停止: ${reason}`));
  try { worker.kill(); } catch (_) {}
  worker = null;
}

function scheduleWorkerIdleStop() {
  clearTimeout(workerIdleTimer);
  if (!worker) return;
  workerIdleTimer = setTimeout(() => {
    void stopWorker("idle");
  }, config.workerIdleTimeoutMs);
}

function runPowerShellWorker(action, args = {}, timeoutMs = config.actionTimeoutMs) {
  workerQueue = workerQueue.then(
    () => executeWorkerCommand(action, args, timeoutMs),
    () => executeWorkerCommand(action, args, timeoutMs),
  );
  return workerQueue;
}

async function executeWorkerCommand(action, args, timeoutMs) {
  const child = startWorker();
  workerLastUsedAt = Date.now();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error(`Computer Use Worker 操作超时 (${timeoutMs}ms): ${action}`);
      workerLastError = error.message;
      rejectCurrentWorkerRequest(error);
      void stopWorker("timeout");
    }, timeoutMs);

    currentWorkerRequest = { action, resolve, reject, timer };

    try {
      child.stdin.write(`${JSON.stringify({ action, args: args || {} })}\n`, "utf8");
    } catch (error) {
      clearTimeout(timer);
      currentWorkerRequest = null;
      reject(error);
    }
  }).finally(() => {
    workerLastUsedAt = Date.now();
    scheduleWorkerIdleStop();
  });
}

async function runComputerUse(action, args = {}, timeoutMs = config.actionTimeoutMs, options = {}) {
  const run = async (nextArgs, allowWorker = config.persistentWorker) => {
    if (!allowWorker) return await runPowerShellOnce(action, nextArgs, timeoutMs);
    try {
      return await runPowerShellWorker(action, nextArgs, timeoutMs);
    } catch (error) {
      if (isWorkerInfrastructureError(error)) {
        workerLastError = error.message;
        return await runPowerShellOnce(action, nextArgs, timeoutMs);
      }
      throw error;
    }
  };

  try {
    const result = await run(args);
    return postProcessResult(action, args, result);
  } catch (error) {
    if (options.relocate !== false && args?.elementId && isStaleElementError(error)) {
      const relocated = await relocateElement(args.elementId, args);
      if (relocated?.id && relocated.id !== args.elementId) {
        const retryArgs = { ...args, elementId: relocated.id };
        const result = await run(retryArgs);
        return postProcessResult(action, retryArgs, result);
      }
    }
    throw error;
  }
}

function postProcessResult(action, args, result) {
  if (action === "snapshot" && args?.screenshotMode === "path" && result?.screenshot?.base64) {
    const { base64, ...rest } = result.screenshot;
    return {
      ...result,
      screenshot: {
        ...rest,
        base64Omitted: true,
      },
    };
  }
  return result;
}

function isWorkerInfrastructureError(error) {
  const message = String(error?.message || error).toLowerCase();
  return message.includes("worker") || message.includes("管道") || message.includes("pipe") || message.includes("启动失败");
}

function isStaleElementError(error) {
  const message = String(error?.message || error).toLowerCase();
  return message.includes("stale") || message.includes("out of range") || message.includes("元素 id 已失效");
}

async function relocateElement(elementId, args) {
  const cached = elementCache.get(elementId);
  if (!cached) return null;

  const query = cached.automationId || cached.name || cached.className || cached.controlType || "";
  if (!query) return null;

  try {
    const result = await runComputerUse("find", {
      query,
      controlType: cached.controlType || undefined,
      scope: args.scope || "active_window",
      maxDepth: args.maxDepth || 8,
      maxNodes: args.maxNodes || 1200,
      maxResults: 30,
      windowTitle: args.windowTitle,
      processId: args.processId,
      nativeWindowHandle: args.nativeWindowHandle,
      activate: args.activate,
      viewMode: args.viewMode,
      includeOffscreen: args.includeOffscreen,
    }, 45000, { relocate: false });
    const candidates = Array.isArray(result.results) ? result.results : [];
    return candidates
      .map((candidate) => ({ candidate, score: scoreRelocationCandidate(cached, candidate) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)[0]?.candidate || null;
  } catch (_) {
    return null;
  }
}

function scoreRelocationCandidate(source, candidate) {
  let score = 0;
  if (source.automationId && source.automationId === candidate.automationId) score += 8;
  if (source.name && source.name === candidate.name) score += 5;
  if (source.controlType && source.controlType === candidate.controlType) score += 4;
  if (source.className && source.className === candidate.className) score += 3;
  if (source.nativeWindowHandle && source.nativeWindowHandle === candidate.nativeWindowHandle) score += 2;
  if (source.boundingBox && candidate.boundingBox) {
    const dx = Math.abs((source.boundingBox.centerX ?? source.boundingBox.x) - (candidate.boundingBox.centerX ?? candidate.boundingBox.x));
    const dy = Math.abs((source.boundingBox.centerY ?? source.boundingBox.y) - (candidate.boundingBox.centerY ?? candidate.boundingBox.y));
    if (dx + dy < 80) score += 2;
  }
  return score;
}

function rememberElementsFromResult(result) {
  if (!result || typeof result !== "object") return;
  if (result.tree) rememberElementTree(result.tree);
  if (Array.isArray(result.results)) result.results.forEach(rememberElementTree);
  if (Array.isArray(result.windows)) result.windows.forEach(rememberElementTree);
  if (result.element) rememberElementTree(result.element);

  while (elementCache.size > 3000) {
    const oldest = elementCache.keys().next().value;
    if (!oldest) break;
    elementCache.delete(oldest);
  }
}

function rememberElementTree(node) {
  if (!node || typeof node !== "object") return;
  if (node.id) {
    elementCache.set(node.id, {
      id: node.id,
      runtimeId: node.runtimeId,
      automationId: node.automationId,
      name: node.name,
      controlType: node.controlType,
      className: node.className,
      boundingBox: node.boundingBox,
      processId: node.processId,
      nativeWindowHandle: node.nativeWindowHandle,
      cachedAt: Date.now(),
    });
  }
  if (Array.isArray(node.children)) node.children.forEach(rememberElementTree);
}

function getErrorHint(error) {
  if (!error) return null;
  const errorStr = String(error).toLowerCase();

  if (errorStr.includes("windows key") || errorStr.includes("win key")) {
    return "Windows 键不支持通过 SendKeys 发送，请使用其他按键组合";
  }
  if (errorStr.includes("stale") || errorStr.includes("out of range")) {
    return "元素 ID 已失效，窗口内容已变化。请重新调用 windows_snapshot 或 windows_find 获取最新的元素 ID";
  }
  if (errorStr.includes("no top-level window")) {
    return "未找到匹配的窗口，请检查窗口标题或进程ID";
  }
  if (errorStr.includes("no clickable bounding box")) {
    return "元素没有可点击的边界框，可能是隐藏或不可见的元素";
  }
  return null;
}

function timeoutForAction(action, args = {}) {
  if (action === "snapshot" || action === "tree" || action === "find") return 45000;
  if (action === "list_windows" || action === "activate_window" || action === "health") return 30000;
  if (action === "wait") {
    const ms = Number(args.milliseconds || 500);
    return Math.max(31000, ms + 1000);
  }
  return config.actionTimeoutMs;
}

function normalizeBatchAction(action) {
  const value = String(action || "").trim();
  const alias = {
    type: "type_text",
    doubleClick: "double_click",
    double_click: "double_click",
    setValue: "set_value",
    set_value: "set_value",
    activateWindow: "activate_window",
    activate_window: "activate_window",
    listWindows: "list_windows",
    list_windows: "list_windows",
    elementInfo: "element_info",
    element_info: "element_info",
  }[value] || value;
  if (!BATCH_ACTIONS.has(alias)) throw new Error(`不支持的批量动作: ${value}`);
  return alias;
}

async function runComputerUseBatch(payload = {}) {
  const actions = Array.isArray(payload.actions) ? payload.actions : [];
  const stopOnError = payload.stopOnError !== false;
  const maxActions = Math.max(1, Math.min(Number(payload.maxActions || 12), 20));
  if (actions.length === 0) throw new Error("actions 至少需要 1 个动作");
  if (actions.length > maxActions) throw new Error(`批量动作最多 ${maxActions} 个`);

  const results = [];
  for (let index = 0; index < actions.length; index++) {
    const item = actions[index] || {};
    const action = normalizeBatchAction(item.action);
    const args = item.args && typeof item.args === "object" ? item.args : {};
    try {
      const result = await runComputerUse(action, args, timeoutForAction(action, args), {
        relocate: !["snapshot", "tree", "find", "list_windows", "health", "activate_window", "wait"].includes(action),
      });
      results.push({ ok: true, action, result });
    } catch (error) {
      const entry = { ok: false, action, error: error.message || String(error) };
      results.push(entry);
      if (stopOnError) {
        return { ok: false, failedAt: index, results, count: results.length };
      }
    }
  }
  return { ok: results.every((item) => item.ok), results, count: results.length };
}

function workerStatus() {
  return {
    ok: true,
    enabled: config.persistentWorker,
    running: Boolean(worker && !worker.killed),
    busy: Boolean(currentWorkerRequest),
    startedAt: workerStartedAt || null,
    lastUsedAt: workerLastUsedAt || null,
    idleTimeoutMs: config.workerIdleTimeoutMs,
    elementCacheSize: elementCache.size,
    lastError: workerLastError,
  };
}

function register(ipcMain) {
  ipcMain.handle("cu:configure", async (_event, nextConfig) => {
    const previous = config;
    config = normalizeConfig(nextConfig || {});
    if (!config.persistentWorker && previous.persistentWorker) await stopWorker("disabled");
    return workerStatus();
  });

  ipcMain.handle("cu:worker-status", () => workerStatus());
  ipcMain.handle("cu:restart-worker", async () => {
    await stopWorker("restart");
    if (config.persistentWorker) startWorker();
    return workerStatus();
  });

  ipcMain.handle("cu:health", () => runComputerUse("health", {}, 30000, { relocate: false }));
  ipcMain.handle("cu:snapshot", (_, opts) => runComputerUse("snapshot", opts, 45000, { relocate: false }));
  ipcMain.handle("cu:tree", (_, opts) => runComputerUse("tree", opts, 45000, { relocate: false }));
  ipcMain.handle("cu:list-windows", (_, opts) => runComputerUse("list_windows", opts, 30000, { relocate: false }));
  ipcMain.handle("cu:find", (_, opts) => runComputerUse("find", opts, 45000, { relocate: false }));
  ipcMain.handle("cu:element-info", (_, opts) => runComputerUse("element_info", opts));

  ipcMain.handle("cu:click", (_, opts) => runComputerUse("click", opts));
  ipcMain.handle("cu:double-click", (_, opts) => runComputerUse("double_click", opts));
  ipcMain.handle("cu:move", (_, opts) => runComputerUse("move", opts));
  ipcMain.handle("cu:drag", (_, opts) => runComputerUse("drag", opts));
  ipcMain.handle("cu:scroll", (_, opts) => runComputerUse("scroll", opts));

  ipcMain.handle("cu:type", (_, opts) => runComputerUse("type_text", opts));
  ipcMain.handle("cu:keypress", (_, opts) => runComputerUse("keypress", opts));

  ipcMain.handle("cu:focus", (_, opts) => runComputerUse("focus", opts));
  ipcMain.handle("cu:invoke", (_, opts) => runComputerUse("invoke", opts));
  ipcMain.handle("cu:set-value", (_, opts) => runComputerUse("set_value", opts));

  ipcMain.handle("cu:activate-window", (_, opts) => runComputerUse("activate_window", opts, 30000, { relocate: false }));
  ipcMain.handle("cu:wait", (_, opts) => {
    const ms = opts?.milliseconds || 500;
    return runComputerUse("wait", opts, Math.max(31000, ms + 1000), { relocate: false });
  });
  ipcMain.handle("cu:batch", (_, opts) => runComputerUseBatch(opts));
}

app.on("will-quit", () => {
  void stopWorker("quit");
});

module.exports = { register };
