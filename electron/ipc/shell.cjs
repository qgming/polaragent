// IPC：shell 命令执行（供 run_bash 工具使用）
// electron/ipc/shell.cjs
//
// 四级安全模式：
// - readonly: 不允许执行命令
// - safe: 系统阻止危险命令
// - ai_review: AI 自主评估风险（默认）
// - full: 无限制
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const { validateShellCommand } = require("../lib/security.cjs");

// 输出截断上限（字符）
const MAX_OUTPUT_CHARS = 30_000;
// 超时默认值与边界（毫秒）
const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 120_000;

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

  // 安全策略校验（支持四级模式）
  const validation = validateShellCommand(command);
  if (!validation.allowed) {
    return { 
      success: false, 
      error: validation.reason, 
      blocked: true, 
      exitCode: null, 
      stdout: "", 
      stderr: "", 
      timedOut: false, 
      truncated: false 
    };
  }

  // ai_review 模式：如果标记为需要审查，在输出中附加警告信息
  let aiReviewWarning = "";
  if (validation.aiReview) {
    aiReviewWarning = `⚠️ AI 审查模式：${validation.reason}\n`;
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
      
      // 如果有 AI 审查警告，添加到 stderr 开头
      const finalStderr = aiReviewWarning ? aiReviewWarning + errTrunc.text : errTrunc.text;
      
      resolve({
        success: !timedOut && exitCode === 0,
        exitCode: timedOut ? null : exitCode,
        stdout: outTrunc.text,
        stderr: finalStderr,
        timedOut,
        truncated: outTrunc.truncated || errTrunc.truncated,
        aiReview: validation.aiReview || false,
        riskLevel: validation.riskLevel,
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
