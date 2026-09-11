// 端到端冒烟：启动真实 Electron，经 CDP 驱动渲染进程，走 preload → IPC → pisdk → 真实端点。
// 覆盖：设置写入与安全存储、会话创建、流式对话、低风险工具自动放行、
//       高风险工具用户审批、完全访问模式免审批、消息持久化、进程重启后的会话恢复。
// 用法：POLAR_PROBE_API_KEY=... node scripts/e2e-smoke.mjs
// 说明：user-data-dir 与 OINT_HOME 都指向临时目录，不触碰真实用户数据。

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const electronPath = require("electron");

const BASE_URL = process.env.POLAR_PROBE_BASE_URL ?? "https://ai.qgming.com/v1";
const API_KEY = process.env.POLAR_PROBE_API_KEY ?? "";
const MODEL_ID = process.env.POLAR_PROBE_MODEL ?? "deepseek-v4-flash";

const PORT = 19333;
const ROOT = process.cwd();
const TMP = path.join(os.tmpdir(), "oint-e2e");
const USER_DATA = path.join(TMP, "userdata");
const WORK_DIR = path.join(TMP, "work");
const DATA_DIR = path.join(TMP, "data");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ==================== 结果记录 ====================
let passed = 0;
let failed = 0;

function ok(step, detail) {
  passed += 1;
  console.log(`OK   | ${step} | ${detail}`);
}

function fail(step, detail) {
  failed += 1;
  console.log(`FAIL | ${step} | ${detail}`);
}

function assertStep(step, condition, detail) {
  if (condition) ok(step, detail);
  else throw Object.assign(new Error(`${step}: ${detail}`), { step });
}

// ==================== CDP 客户端 ====================
class CdpClient {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (!message.id || !this.pending.has(message.id)) return;
      const { resolve, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) reject(new Error(`${message.error.message} (${message.error.code})`));
      else resolve(message.result);
    });
  }

  static connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener("open", () => resolve(new CdpClient(ws)));
      ws.addEventListener("error", () => reject(new Error("CDP WebSocket 连接失败")));
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {
      // 连接可能已断开，忽略
    }
  }
}

// ==================== Electron 进程管理 ====================
function launchApp() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  // 应用数据（~/.oint）同样要隔离：OINT_HOME 指到临时目录，
  // 否则冒烟测试会读写真实的 ~/.oint，污染开发者的会话与设置。
  env.OINT_HOME = DATA_DIR;
  const child = spawn(
    electronPath,
    [".", `--remote-debugging-port=${PORT}`, `--user-data-dir=${USER_DATA}`],
    { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stdout.on("data", (data) => process.stdout.write(`[app] ${data}`));
  child.stderr.on("data", (data) => process.stderr.write(`[app] ${data}`));
  return child;
}

async function waitForTarget(timeoutMs, child) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`应用提前退出，exitCode=${child.exitCode}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const targets = await response.json();
      const page = targets.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      // 调试端口尚未就绪，继续轮询
    }
    await sleep(400);
  }
  throw new Error("等待调试目标超时");
}

function killApp(child) {
  if (!child || child.exitCode !== null) return;
  spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
}

async function waitForExit(child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return true;
    await sleep(200);
  }
  return false;
}

// ==================== 渲染进程求值 ====================
let cdp = null;

async function evaluate(expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    const description =
      result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "未知异常";
    throw new Error(`渲染进程求值异常：${description}`);
  }
  return result.result.value;
}

/** 轮询求值直到表达式返回真值；用于等待 run-ended / approval-requested */
async function waitFor(expression, label, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await evaluate(expression).catch(() => undefined);
    if (last) return last;
    await sleep(300);
  }
  throw new Error(`等待超时：${label}（最后取值 ${JSON.stringify(last)}）`);
}

// ==================== 主流程 ====================
async function main() {
  if (!API_KEY) {
    console.error("缺少 POLAR_PROBE_API_KEY 环境变量，无法执行端到端冒烟");
    process.exit(1);
  }
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(WORK_DIR, { recursive: true });

  let child = null;
  try {
    // ---- 第一段：启动并连接 ----
    child = launchApp();
    const target = await waitForTarget(30000, child);
    cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
    await cdp.send("Runtime.enable");
    ok("启动", `已连接渲染进程 ${target.url}`);

    // ---- 探针：确认 preload 桥生效、且数据目录被 OINT_HOME 隔离到临时目录 ----
    const info = await evaluate(`(async () => {
      const info = await window.oint.app.getInfo();
      return { name: info.name, version: info.version, dataDir: info.dataDir };
    })()`);
    assertStep(
      "preload 桥与隔离的数据目录",
      typeof info.dataDir === "string" && path.resolve(info.dataDir) === path.resolve(DATA_DIR),
      `dataDir=${info.dataDir}`,
    );

    // ---- 配置模型服务（含 safeStorage 加密落盘）----
    const settingsEcho = await evaluate(`(async () => {
      const settings = await window.oint.settings.read();
      const service = {
        id: "e2e-svc",
        name: "E2E 工装服务",
        baseUrl: ${JSON.stringify(BASE_URL)},
        apiKey: ${JSON.stringify(API_KEY)},
        wireFormat: "openai-completions",
        // 回归：还原用户误把上下文窗口当输出上限的配置，验证不再触发 max_tokens 400
        models: [{ id: ${JSON.stringify(MODEL_ID)}, name: "E2E Model", contextWindow: 1000000, maxTokens: 1000000 }],
      };
      const next = {
        ...settings,
        language: "zh-CN",
        permissionMode: "default",
        defaultWorkingDir: ${JSON.stringify(WORK_DIR)},
        services: [service],
        defaultModel: { serviceId: "e2e-svc", modelId: ${JSON.stringify(MODEL_ID)} },
      };
      await window.oint.settings.write(next);
      const back = await window.oint.settings.read();
      return {
        serviceCount: back.services.length,
        modelId: back.defaultModel && back.defaultModel.modelId,
        keyRoundTrip: back.services[0] && back.services[0].apiKey === ${JSON.stringify(API_KEY)},
      };
    })()`);
    assertStep(
      "设置写入与 API Key 往返",
      settingsEcho.serviceCount === 1 && settingsEcho.modelId === MODEL_ID && settingsEcho.keyRoundTrip,
      `服务 ${settingsEcho.serviceCount} 个，模型 ${settingsEcho.modelId}，keyRoundTrip=${settingsEcho.keyRoundTrip}`,
    );

    // ---- 事件采集器 + 建会话 ----
    const sessionId = await evaluate(`(async () => {
      if (!window.__e2e) {
        window.__e2e = { events: [] };
        window.__e2e.unsub = window.oint.chat.onEvent((event) => window.__e2e.events.push(event));
      }
      window.__e2e.events.length = 0;
      const session = await window.oint.sessions.create({ title: "E2E 冒烟会话" });
      window.__e2e.sessionId = session.id;
      return session.id;
    })()`);
    ok("会话创建", `sessionId=${sessionId}`);

    // ---- 第一轮：纯文本流式对话 ----
    await evaluate(
      `window.oint.chat.send(window.__e2e.sessionId, ${JSON.stringify("只回复两个字：你好")})`,
    );
    await waitFor(
      `window.__e2e.events.some((e) => e.type === "run-ended")`,
      "第一轮流式对话结束",
    );
    const firstRun = await evaluate(`(() => {
      const texts = window.__e2e.events.filter((e) => e.type === "part-upsert" && e.part && e.part.type === "text");
      const lastText = texts.length ? texts[texts.length - 1].part.text : "";
      const ended = window.__e2e.events.find((e) => e.type === "run-ended");
      const errored = window.__e2e.events.some((e) => e.type === "message-updated" && e.patch && e.patch.status === "error");
      return { text: lastText, reason: ended ? ended.reason : null, errored };
    })()`);
    assertStep(
      "流式对话产生文本",
      typeof firstRun.text === "string" && firstRun.text.length > 0 && !firstRun.errored,
      `文本=${JSON.stringify(firstRun.text)}，reason=${firstRun.reason}`,
    );

    // ---- 第二轮：低风险 bash（默认权限下应自动放行）----
    await evaluate(`(async () => {
      window.__e2e.events.length = 0;
      await window.oint.chat.send(window.__e2e.sessionId, ${JSON.stringify(
        '请用 bash 工具执行 node -e "console.log(2+3)"，完成后只回复结果数字',
      )});
      return true;
    })()`);
    await waitFor(`window.__e2e.events.some((e) => e.type === "run-ended")`, "第二轮 bash 结束");
    const bashRun = await evaluate(`(() => {
      // 工具调用在渲染侧表现为 part-upsert 的 tool-call part（不是 harness 的 tool_end 事件）
      const parts = window.__e2e.events
        .filter((e) => e.type === "part-upsert" && e.part && e.part.type === "tool-call")
        .map((e) => e.part);
      const done = parts.find((p) => p.status === "done");
      const approval = window.__e2e.events.find((e) => e.type === "approval-requested");
      return {
        hasApproval: !!approval,
        toolName: done ? done.toolName : null,
        isError: done ? !!done.isError : null,
        result: done ? done.result : null,
      };
    })()`);
    assertStep(
      "低风险 bash 自动放行",
      bashRun.toolName === "bash" && bashRun.isError === false && bashRun.hasApproval === false,
      `工具=${bashRun.toolName}，结果=${JSON.stringify(bashRun.result)}，是否弹审批=${bashRun.hasApproval}`,
    );

    // ---- 第三轮：高风险 write（默认权限下应弹审批，用户允许一次）----
    const writeTarget = path.join(WORK_DIR, "e2e-written.txt");
    await evaluate(`(async () => {
      window.__e2e.events.length = 0;
      await window.oint.chat.send(window.__e2e.sessionId, ${JSON.stringify(
        `请用 write 工具把内容 hello-e2e 写入文件 ${writeTarget}，完成后只回复 OK`,
      )});
      return true;
    })()`);
    const approvalId = await waitFor(
      `(() => {
        const e = window.__e2e.events.find((item) => item.type === "approval-requested");
        return e ? e.request.id : null;
      })()`,
      "高风险工具触发审批",
      120000,
    );
    await evaluate(
      `window.oint.approvals.respond(${JSON.stringify(approvalId)}, "allow_once")`,
    );
    await waitFor(`window.__e2e.events.some((e) => e.type === "run-ended")`, "第三轮审批后结束");
    const writeRun = await evaluate(`(() => {
      const parts = window.__e2e.events
        .filter((e) => e.type === "part-upsert" && e.part && e.part.type === "tool-call")
        .map((e) => e.part);
      const done = parts.find((p) => p.status === "done");
      const resumed = window.__e2e.events.some((e) => e.type === "approval-resolved");
      return {
        toolName: done ? done.toolName : null,
        isError: done ? !!done.isError : null,
        approvalResolved: resumed,
      };
    })()`);
    assertStep(
      "高风险工具审批后执行",
      writeRun.toolName === "write" &&
        writeRun.isError === false &&
        writeRun.approvalResolved &&
        fs.existsSync(writeTarget),
      `工具=${writeRun.toolName}，isError=${writeRun.isError}，审批已决=${writeRun.approvalResolved}，文件存在=${fs.existsSync(writeTarget)}`,
    );

    // ---- 第四轮：完全访问模式（write 不再弹审批）----
    const fullTarget = path.join(WORK_DIR, "e2e-full.txt");
    await evaluate(`(async () => {
      const settings = await window.oint.settings.read();
      await window.oint.settings.write({ ...settings, permissionMode: "full" });
      window.__e2e.events.length = 0;
      await window.oint.chat.send(window.__e2e.sessionId, ${JSON.stringify(
        `请用 write 工具把内容 full-mode 写入文件 ${fullTarget}，完成后只回复 OK`,
      )});
      return true;
    })()`);
    await waitFor(`window.__e2e.events.some((e) => e.type === "run-ended")`, "第四轮完全访问结束");
    const fullRun = await evaluate(`(() => {
      const parts = window.__e2e.events
        .filter((e) => e.type === "part-upsert" && e.part && e.part.type === "tool-call")
        .map((e) => e.part);
      const done = parts.find((p) => p.status === "done");
      const approval = window.__e2e.events.find((e) => e.type === "approval-requested");
      return {
        hasApproval: !!approval,
        toolName: done ? done.toolName : null,
        isError: done ? !!done.isError : null,
      };
    })()`);
    assertStep(
      "完全访问模式免审批",
      fullRun.toolName === "write" &&
        fullRun.isError === false &&
        fullRun.hasApproval === false &&
        fs.existsSync(fullTarget),
      `工具=${fullRun.toolName}，isError=${fullRun.isError}，是否弹审批=${fullRun.hasApproval}`,
    );

    // ---- 持久化：渲染层回读 ----
    const persisted = await evaluate(`(async () => {
      const page = await window.oint.sessions.loadMessages(window.__e2e.sessionId, { limit: 40 });
      const toolDone = page.messages.some((m) =>
        m.parts.some((p) => p.type === "tool-call" && p.status === "done"),
      );
      const roles = page.messages.map((m) => m.role);
      return { count: page.messages.length, toolDone, hasAssistant: roles.includes("assistant") };
    })()`);
    assertStep(
      "消息持久化回读",
      persisted.count > 0 && persisted.hasAssistant && persisted.toolDone,
      `消息 ${persisted.count} 条，含助手=${persisted.hasAssistant}，工具已完成=${persisted.toolDone}`,
    );

    // ---- 优雅退出 ----
    await evaluate(`window.oint.window.close()`);
    const exited = await waitForExit(child, 15000);
    ok("优雅退出", exited ? "进程已退出" : "进程未在 15s 内退出（后续强制结束）");
    cdp.close();
    cdp = null;
    if (!exited) {
      killApp(child);
      await waitForExit(child, 8000);
    }

    // ---- 第二段：重启后恢复 ----
    await sleep(800);
    child = launchApp();
    const target2 = await waitForTarget(30000, child);
    cdp = await CdpClient.connect(target2.webSocketDebuggerUrl);
    await cdp.send("Runtime.enable");

    const recovered = await evaluate(`(async () => {
      const list = await window.oint.sessions.list();
      const target = list.find((s) => s.title === "E2E 冒烟会话");
      if (!target) return { found: false, total: list.length };
      const page = await window.oint.sessions.loadMessages(target.id, { limit: 40 });
      return {
        found: true,
        id: target.id,
        count: page.messages.length,
        hasToolDone: page.messages.some((m) =>
          m.parts.some((p) => p.type === "tool-call" && p.status === "done"),
        ),
      };
    })()`);
    assertStep(
      "重启后会话恢复",
      recovered.found && recovered.count > 0 && recovered.hasToolDone,
      `会话数命中=${recovered.found}，消息 ${recovered.count} 条，工具记录保留=${recovered.hasToolDone}`,
    );

    // ---- 会话列表排序与字段 ----
    const listShape = await evaluate(`(async () => {
      const list = await window.oint.sessions.list();
      const first = list[0] || null;
      return first
        ? { hasId: typeof first.id === "string", hasUpdatedAt: typeof first.updatedAt === "number", archived: first.archived }
        : null;
    })()`);
    assertStep(
      "会话列表字段",
      listShape !== null && listShape.hasId && listShape.hasUpdatedAt,
      JSON.stringify(listShape),
    );

    await evaluate(`window.oint.window.close()`);
    await waitForExit(child, 15000);
    cdp.close();
    cdp = null;
    killApp(child);
  } catch (error) {
    fail("端到端冒烟", error instanceof Error ? error.message : String(error));
  } finally {
    if (cdp) cdp.close();
    killApp(child);
    await sleep(500);
    fs.rmSync(TMP, { recursive: true, force: true });
  }

  console.log("-".repeat(64));
  console.log(`端到端冒烟结束：通过 ${passed} 项，失败 ${failed} 项`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`端到端冒烟脚本异常：${String(error)}`);
  process.exit(1);
});
