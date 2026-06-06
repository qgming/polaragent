// IPC：stdio MCP server 客户端（列举工具、调用工具）
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { app } = require("electron");

const { APP_NAME, MCP_PROTOCOL_VERSION } = require("../lib/constants.cjs");
const { dataDir } = require("../lib/app-paths.cjs");

// 在 PATH 中查找可执行文件的绝对路径（Windows 专用）。
// 因为启动 .cmd 时我们指定了独立的 cwd（mcp/packages），若只给 "npx.cmd" 这种
// 裸文件名，cmd.exe 会先在 cwd 下找，导致 npx 误以为 npm 装在 cwd，
// 报 "Cannot find module ...\\npm\\bin\\npx-cli.js"。解析为绝对路径即可避免。
function resolveOnPath(fileName) {
  const dirs = String(process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const full = path.join(dir, fileName);
    try {
      if (fs.existsSync(full)) return full;
    } catch {
      // 忽略无权限/无效目录
    }
  }
  return null; // 未找到则回退到裸名，交由 PATH 解析
}

// 归一化启动命令：处理 Windows 下的 npx/npm、自动注入 -y、并安全地包裹 .cmd/.bat
// 说明：Windows 上 .cmd/.bat 需经 shell 执行。旧做法 spawn(exe, args, {shell:true})
// 会把 args 拼进命令行交给 shell 解析，触发 Node DEP0190（命令注入风险）。
// 这里改为显式用 `cmd.exe /d /s /c`，并通过 windowsVerbatimArguments:true 关闭
// Node 对参数的二次转义，由我们自行对每个参数加引号，既消除警告又避免注入。
function normalizeCommand(command, args) {
  const rawCommand = String(command || "").trim();
  if (!rawCommand) throw new Error("stdio MCP server 缺少 command");

  const name = path.basename(rawCommand).toLowerCase();
  let executable = process.platform === "win32" && name === "npx" ? "npx.cmd" : process.platform === "win32" && name === "npm" ? "npm.cmd" : rawCommand;
  const normalizedArgs = (args || [])
    .map((arg) => String(arg).trim())
    .filter(Boolean);
  if (name === "npx" && !normalizedArgs.some((arg) => arg === "-y" || arg === "--yes" || arg.startsWith("--yes="))) {
    normalizedArgs.unshift("-y");
  }

  // 非 .cmd/.bat：直接 spawn，参数逐个安全传递，无需 shell
  const needsCmd = process.platform === "win32" && /\.(cmd|bat)$/i.test(executable);
  if (!needsCmd) {
    return { executable, args: normalizedArgs, windowsVerbatimArguments: false };
  }

  // 把 .cmd 解析为 PATH 中的绝对路径，避免在自定义 cwd 下被错误解析
  if (!path.isAbsolute(executable)) {
    executable = resolveOnPath(executable) || executable;
  }

  // .cmd/.bat：用 cmd.exe /d /s /c 包裹。手动为可执行文件与各参数加引号，
  // 配合 windowsVerbatimArguments 让 Node 原样传递，避免 shell 解释元字符。
  const quote = (value) => `"${String(value).replace(/"/g, '""')}"`;
  const innerCommand = [executable, ...normalizedArgs].map(quote).join(" ");
  return {
    executable: process.env.comspec || "cmd.exe",
    // 外层再包一层引号是 cmd.exe /c 处理含空格路径的惯用写法
    args: ["/d", "/s", "/c", `"${innerCommand}"`],
    windowsVerbatimArguments: true,
  };
}

// 通过 stdio 与 MCP server 通信的轻量 JSON-RPC 客户端
class StdioMcpClient {
  constructor(server) {
    const { executable, args, windowsVerbatimArguments } = normalizeCommand(server.command, server.args || []);
    const packageDir = path.join(dataDir(), "mcp", "packages");
    const npmCacheDir = path.join(packageDir, "npm-cache");
    fs.mkdirSync(npmCacheDir, { recursive: true });
    this.child = spawn(executable, args, {
      cwd: packageDir,
      env: {
        ...process.env,
        npm_config_cache: npmCacheDir,
        NPM_CONFIG_CACHE: npmCacheDir,
        npm_config_yes: "true",
        NPM_CONFIG_YES: "true",
        ...(server.env || {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsVerbatimArguments,
      windowsHide: true,
    });
    this.nextId = 1;
    this.buffer = "";
    this.stderr = "";
    this.pending = new Map();
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.onStdout(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => {
      if (this.stderr.length < 8000) this.stderr += chunk;
    });
    this.child.on("close", () => {
      for (const { reject } of this.pending.values()) reject(new Error(`MCP server 已退出${this.stderrHint()}`));
      this.pending.clear();
    });
  }

  stderrHint() {
    const trimmed = this.stderr.trim();
    return trimmed ? `，stderr：${trimmed}` : "";
  }

  onStdout(chunk) {
    this.buffer += chunk;
    let index;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const id = message.id;
      if (id != null && this.pending.has(id)) {
        const { resolve, reject, timer } = this.pending.get(id);
        clearTimeout(timer);
        this.pending.delete(id);
        if (message.error) reject(new Error(`MCP server 返回错误：${JSON.stringify(message.error)}`));
        else resolve(message.result || {});
      } else if (id != null && message.method) {
        this.write({ jsonrpc: "2.0", id, error: { code: -32601, message: "PolarAgent does not handle client-side MCP requests yet" } });
      }
    }
  }

  write(message) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params) {
    const id = this.nextId++;
    this.write({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP server 响应超时${this.stderrHint()}`));
      }, 60000);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  notification(method, params) {
    this.write(params == null ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params });
  }

  async initialize() {
    await this.request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: APP_NAME, version: app.getVersion() },
    });
    this.notification("notifications/initialized");
  }

  close() {
    this.child.kill();
  }
}

// 以「初始化—执行—关闭」的方式安全使用一次性 stdio 客户端
async function withStdioClient(server, run) {
  const client = new StdioMcpClient(server);
  try {
    await client.initialize();
    return await run(client);
  } finally {
    client.close();
  }
}

function register(ipcMain) {
  ipcMain.handle("mcp:stdio-list-tools", (_event, { server }) =>
    withStdioClient(server, async (client) => {
      const result = await client.request("tools/list", {});
      return (result.tools || []).map((tool) => ({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }));
    }),
  );
  ipcMain.handle("mcp:stdio-call-tool", (_event, { request }) =>
    withStdioClient(request.server, (client) =>
      client.request("tools/call", {
        name: request.toolName,
        arguments: request.arguments || {},
      }),
    ),
  );
}

module.exports = { register };
