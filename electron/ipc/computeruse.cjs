// IPC：Computer Use - Windows 桌面应用控制（UI Automation）
const { spawn } = require("node:child_process");
const path = require("node:path");
const { app } = require("electron");

// 获取 PowerShell 后端脚本路径
function getBackendPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "resources", "builtin", "computeruse", "windows-uia.ps1");
  }
  return path.join(__dirname, "..", "..", "resources", "builtin", "computeruse", "windows-uia.ps1");
}

// 执行 PowerShell 动作
async function runPowerShell(action, args = {}, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const backendPath = getBackendPath();
    const child = spawn(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-Sta", "-ExecutionPolicy", "Bypass", "-File", backendPath, "-Action", action],
      {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: {
          ...process.env,
          // 强制 UTF-8 输出编码
          PYTHONIOENCODING: "utf-8",
        },
      },
    );

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Computer Use 操作超时 (${timeoutMs}ms): ${action}`));
    }, timeoutMs);

    // 使用 UTF-8 编码读取输出
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`PowerShell 启动失败: ${error.message}`));
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const errorMsg = stderr.trim() || stdout.trim() || "未知错误";
        reject(new Error(`Computer Use 执行失败 (退出码 ${code}): ${errorMsg.slice(0, 500)}`));
      } else {
        try {
          const result = JSON.parse(stdout.trim());
          if (result.ok === false) {
            // 友好的错误提示
            const errorHint = getErrorHint(result.error);
            reject(new Error(errorHint || `操作失败: ${result.error || "未知错误"}`));
          } else {
            resolve(result);
          }
        } catch (e) {
          reject(new Error(`JSON 解析失败: ${stdout.slice(0, 500)}`));
        }
      }
    });

    // 通过 stdin 传递参数
    child.stdin.end(JSON.stringify(args || {}));
  });
}

// 获取友好的错误提示
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

function register(ipcMain) {
  // 健康检查
  ipcMain.handle("cu:health", () => runPowerShell("health"));

  // 截图 + UI 树
  ipcMain.handle("cu:snapshot", (_, opts) => runPowerShell("snapshot", opts, 45000));

  // UI 树（无截图）
  ipcMain.handle("cu:tree", (_, opts) => runPowerShell("tree", opts, 45000));

  // 列出窗口
  ipcMain.handle("cu:list-windows", (_, opts) => runPowerShell("list_windows", opts));

  // 查找元素
  ipcMain.handle("cu:find", (_, opts) => runPowerShell("find", opts, 45000));

  // 元素信息
  ipcMain.handle("cu:element-info", (_, opts) => runPowerShell("element_info", opts));

  // 鼠标操作
  ipcMain.handle("cu:click", (_, opts) => runPowerShell("click", opts));
  ipcMain.handle("cu:double-click", (_, opts) => runPowerShell("double_click", opts));
  ipcMain.handle("cu:move", (_, opts) => runPowerShell("move", opts));
  ipcMain.handle("cu:drag", (_, opts) => runPowerShell("drag", opts));
  ipcMain.handle("cu:scroll", (_, opts) => runPowerShell("scroll", opts));

  // 键盘操作
  ipcMain.handle("cu:type", (_, opts) => runPowerShell("type_text", opts));
  ipcMain.handle("cu:keypress", (_, opts) => runPowerShell("keypress", opts));

  // UI Automation 操作
  ipcMain.handle("cu:focus", (_, opts) => runPowerShell("focus", opts));
  ipcMain.handle("cu:invoke", (_, opts) => runPowerShell("invoke", opts));
  ipcMain.handle("cu:set-value", (_, opts) => runPowerShell("set_value", opts));

  // 窗口管理
  ipcMain.handle("cu:activate-window", (_, opts) => runPowerShell("activate_window", opts));
  ipcMain.handle("cu:wait", (_, opts) => {
    const ms = opts?.milliseconds || 500;
    return runPowerShell("wait", opts, Math.max(31000, ms + 1000));
  });
}

module.exports = { register };
