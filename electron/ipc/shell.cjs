// IPC：shell 命令执行（供 run_bash 工具使用）
// electron/ipc/shell.cjs
//
// 安全最后防线：渲染进程不可信，命令的黑名单校验在此处再做一遍。
// 在指定工作目录下用 spawn 执行命令，合并 stdout/stderr，超时则 kill，长输出截断。
const { spawn } = require("node:child_process");
const fs = require("node:fs");

// 输出截断上限（字符）
const MAX_OUTPUT_CHARS = 30_000;
// 超时默认值与边界（毫秒）
const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 120_000;

// 高危命令黑名单：匹配到任一模式即拒绝执行。
// 这是「防误操作」护栏，不是「防恶意绕过」沙箱（命令拼接/编码无法穷尽）。
// ⚠️ 重要：此黑名单必须与 src/ai/tools/bash.ts 中的 BLOCKED_PATTERNS 保持同步
const BLOCKED_PATTERNS = [
  // 递归强删根目录或家目录
  { test: /\brm\s+(-[a-z]*\s+)*(-[a-z]*r[a-z]*|--recursive)\b[^|;&]*\s(\/|~|\$HOME)(\s|$)/i, reason: "检测到删除根目录或家目录的高危操作" },
  { test: /\brm\s+(-[a-z]*\s+)*-[a-z]*r[a-z]*f[a-z]*\s+(\/|~)(\s|$)/i, reason: "检测到强制递归删除根目录的高危操作" },
  // 关机/重启
  { test: /\b(shutdown|reboot|halt|poweroff)\b/i, reason: "检测到关机/重启命令" },
  // 磁盘格式化
  { test: /\b(mkfs(\.\w+)?|diskpart)\b/i, reason: "检测到磁盘格式化命令" },
  { test: /\bformat\s+[a-z]:/i, reason: "检测到磁盘格式化命令" },
  // 直接写裸磁盘设备
  { test: /\bdd\b[^|;&]*\bof=\/dev\/(sd|hd|nvme|disk|vd)/i, reason: "检测到覆写磁盘设备的高危操作" },
  { test: />\s*\/dev\/(sd|hd|nvme|disk|vd)/i, reason: "检测到向裸磁盘设备重定向写入" },
  // fork 炸弹
  { test: /:\s*\(\s*\)\s*\{.*:.*\}/i, reason: "检测到 fork 炸弹模式" },
  // 递归改根目录权限/属主
  { test: /\bchmod\s+(-[a-z]*\s+)*-[a-z]*r[a-z]*\b[^|;&]*\s\/(\s|$)/i, reason: "检测到递归修改根目录权限" },
  { test: /\bchown\s+(-[a-z]*\s+)*-[a-z]*r[a-z]*\b[^|;&]*\s\/(\s|$)/i, reason: "检测到递归修改根目录属主" },
];

// 命中黑名单返回拒绝原因，否则返回 null
function checkBlocked(command) {
  for (const { test, reason } of BLOCKED_PATTERNS) {
    if (test.test(command)) return reason;
  }
  return null;
}

// 探测可用的 shell。优先 bash（项目脚本与环境均为 Unix 风格），无 bash 时回退。
// 返回 { file, args }，其中 args 末尾应接命令字符串。
function resolveShell() {
  // 显式 SHELL 环境变量优先（git-bash / WSL 通常会设）
  const envShell = process.env.SHELL;
  if (envShell && fs.existsSync(envShell)) {
    return { file: envShell, prefix: ["-c"] };
  }

  if (process.platform === "win32") {
    // 常见 git-bash 安装位置
    const gitBashCandidates = [
      "C:\\Program Files\\Git\\bin\\bash.exe",
      "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
    ];
    const gitBash = gitBashCandidates.find((p) => fs.existsSync(p));
    if (gitBash) return { file: gitBash, prefix: ["-c"] };
    // 兜底用 cmd
    return { file: process.env.ComSpec || "cmd.exe", prefix: ["/d", "/s", "/c"] };
  }

  // Unix：优先 bash，回退 sh
  if (fs.existsSync("/bin/bash")) return { file: "/bin/bash", prefix: ["-c"] };
  return { file: "/bin/sh", prefix: ["-c"] };
}

// 把字符串截断到上限，并标记是否被截断
function truncateOutput(value) {
  if (value.length <= MAX_OUTPUT_CHARS) return { text: value, truncated: false };
  return { text: value.slice(0, MAX_OUTPUT_CHARS), truncated: true };
}

// 执行一条命令。请求形如 { command, cwd, timeoutMs }
async function execShell(request) {
  const command = String(request?.command ?? "").trim();
  if (!command) {
    return { success: false, error: "命令不能为空", exitCode: null, stdout: "", stderr: "", timedOut: false, truncated: false };
  }

  // 黑名单（主进程二次校验）
  const blockedReason = checkBlocked(command);
  if (blockedReason) {
    return { success: false, error: `命令被安全策略拦截：${blockedReason}`, blocked: true, exitCode: null, stdout: "", stderr: "", timedOut: false, truncated: false };
  }

  // 工作目录校验：必须存在且为目录
  const cwd = String(request?.cwd ?? "").trim();
  if (!cwd) {
    return { success: false, error: "未提供工作目录", exitCode: null, stdout: "", stderr: "", timedOut: false, truncated: false };
  }
  try {
    if (!fs.statSync(cwd).isDirectory()) {
      return { success: false, error: `工作目录不是有效目录：${cwd}`, exitCode: null, stdout: "", stderr: "", timedOut: false, truncated: false };
    }
  } catch {
    return { success: false, error: `工作目录不存在：${cwd}`, exitCode: null, stdout: "", stderr: "", timedOut: false, truncated: false };
  }

  const timeoutMs = Math.min(
    Math.max(Number(request?.timeoutMs) || DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS),
    MAX_TIMEOUT_MS,
  );
  const shell = resolveShell();

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const child = spawn(shell.file, [...shell.prefix, command], {
      cwd,
      env: process.env,
      windowsHide: true,
    });

    // 设置编码,避免 Buffer 边界截断多字节字符产生乱码
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");

    // 超时 kill:先 SIGTERM 优雅退出,3s 后仍未退出再 SIGKILL 强杀
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, 3000);
    }, timeoutMs);

    // 累积输出时即做软上限，避免超大输出撑爆内存
    const cap = MAX_OUTPUT_CHARS * 2;
    child.stdout?.on("data", (chunk) => {
      if (stdout.length < cap) stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < cap) stderr += chunk;
    });

    const finish = (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const outTrunc = truncateOutput(stdout);
      const errTrunc = truncateOutput(stderr);
      resolve({
        success: !timedOut && exitCode === 0,
        exitCode: timedOut ? null : exitCode,
        stdout: outTrunc.text,
        stderr: errTrunc.text,
        timedOut,
        truncated: outTrunc.truncated || errTrunc.truncated,
      });
    };

    child.on("close", (code) => finish(code));
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ success: false, error: `命令执行失败：${err.message}`, exitCode: null, stdout, stderr, timedOut, truncated: false });
    });
  });
}

function register(ipcMain) {
  ipcMain.handle("shell:exec", (_event, { request }) => execShell(request));
}

module.exports = { register };
