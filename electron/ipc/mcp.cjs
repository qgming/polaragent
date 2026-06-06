// IPC：stdio MCP server 客户端（列举工具、调用工具）
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { app } = require("electron");

const { APP_NAME, MCP_PROTOCOL_VERSION } = require("../lib/constants.cjs");
const { dataDir } = require("../lib/app-paths.cjs");

// 归一化启动命令：处理 Windows 下的 npx/npm、自动注入 -y、判定是否需要 shell
function normalizeCommand(command, args) {
  const rawCommand = String(command || "").trim();
  if (!rawCommand) throw new Error("stdio MCP server 缺少 command");

  const name = path.basename(rawCommand).toLowerCase();
  const executable = process.platform === "win32" && name === "npx" ? "npx.cmd" : process.platform === "win32" && name === "npm" ? "npm.cmd" : rawCommand;
  const normalizedArgs = (args || [])
    .map((arg) => String(arg).trim())
    .filter(Boolean);
  if (name === "npx" && !normalizedArgs.some((arg) => arg === "-y" || arg === "--yes" || arg.startsWith("--yes="))) {
    normalizedArgs.unshift("-y");
  }
  const shell = process.platform === "win32" && /\.(cmd|bat)$/i.test(executable);
  return { executable, args: normalizedArgs, shell };
}

// 通过 stdio 与 MCP server 通信的轻量 JSON-RPC 客户端
class StdioMcpClient {
  constructor(server) {
    const { executable, args, shell } = normalizeCommand(server.command, server.args || []);
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
      shell,
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
