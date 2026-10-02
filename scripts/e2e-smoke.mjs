// 端到端冒烟：启动真实 Electron，经 CDP 驱动渲染进程，走 preload → IPC → pisdk → 真实端点。
// 覆盖：设置写入与安全存储、会话创建、流式对话、低风险工具自动放行、高风险工具用户审批、
//       完全访问模式免审批、技能注入（OINT_HOME/skills 下的 SKILL.md 进入系统提示）、
//       消息持久化、进程重启后的会话恢复。
// 用法：OINT_PROBE_API_KEY=... node scripts/e2e-smoke.mjs
// 说明：user-data-dir 与 OINT_HOME 都指向临时目录，不触碰真实用户数据。

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const electronPath = require("electron");

/** 探测用环境变量 */
function probeEnv(suffix) {
  return process.env[`OINT_PROBE_${suffix}`];
}

const BASE_URL = probeEnv("BASE_URL") ?? "https://ai.qgming.com/v1";
const API_KEY = probeEnv("API_KEY") ?? "";
const MODEL_ID = probeEnv("MODEL") ?? "deepseek-v4-flash";

const PORT = 19333;
const ROOT = process.cwd();
const TMP = path.join(os.tmpdir(), `oint-e2e-${Date.now()}-${process.pid}`);
const USER_DATA = path.join(TMP, "userdata");
const WORK_DIR = path.join(TMP, "work");
const DATA_DIR = path.join(TMP, "data");
// 技能夹具：写进 OINT_HOME 数据目录下的 skills/，与主进程 resolveSkillDirs 的扫描位置一致
const SKILL_NAME = "oint-e2e-skill-7f3a";
const SKILL_MARKER = "oint-e2e-skill-marker-7f3a";

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
    ws.addEventListener("close", () => {
      for (const { reject } of this.pending.values()) reject(new Error("CDP connection closed"));
      this.pending.clear();
    });
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

/** Wait for a committed native snapshot or approval notification. */
async function waitFor(expression, label, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await evaluate(expression);
    if (last) return last;
    await sleep(300);
  }
  throw new Error(`等待超时：${label}（最后取值 ${JSON.stringify(last)}）`);
}

// Start the send without awaiting its completion: a high-risk tool may be waiting for the approval below.
async function beginRun(text) {
  await evaluate(`(async () => {
    const before = await window.oint.chat.snapshot(window.__e2e.sessionId);
    window.__e2e.baseCount = before?.state.messages.length ?? 0;
    window.__e2e.events.length = 0;
    window.__e2e.sendDone = false;
    window.__e2e.sendError = null;
    window.__e2e.pendingSend = window.oint.chat.send(window.__e2e.sessionId, ${JSON.stringify(text)}).then(
      () => { window.__e2e.sendDone = true; },
      (error) => { window.__e2e.sendError = String(error); window.__e2e.sendDone = true; },
    );
    return true;
  })()`);
}

async function finishRun(label) {
  await waitFor(`(async () => {
    if (!window.__e2e.sendDone) return false;
    if (window.__e2e.sendError) return true;
    const snapshot = await window.oint.chat.snapshot(window.__e2e.sessionId);
    return !!snapshot && !snapshot.state.running && snapshot.state.messages.length > window.__e2e.baseCount;
  })()`, label);
  return evaluate(`(async () => {
    await window.__e2e.pendingSend;
    if (window.__e2e.sendError) throw new Error(window.__e2e.sendError);
    const snapshot = await window.oint.chat.snapshot(window.__e2e.sessionId);
    if (!snapshot || snapshot.state.running) throw new Error("Conversation is not committed and idle");
    const messages = snapshot.state.messages.slice(window.__e2e.baseCount);
    const parts = messages.flatMap((message) => message.parts);
    return {
      text: messages.filter((message) => message.role === "assistant").flatMap((message) => message.parts).filter((part) => part.type === "text").map((part) => part.text).join("\\n"),
      tools: parts.filter((part) => part.type === "tool-call"),
      errored: messages.some((message) => message.status === "error"),
      hasApproval: window.__e2e.events.some((event) => event.type === "approval-requested"),
      approvalResolved: window.__e2e.events.some((event) => event.type === "approval-resolved"),
    };
  })()`);
}

// ==================== 技能夹具 ====================
/**
 * 在 OINT_HOME 数据目录下写一个技能，返回 SKILL.md 路径。
 * 两条硬约束（否则「目录存在却 0 个技能」）：
 * 1. 必须在启动应用之前调用 —— 主进程在会话 runtime 创建时扫描 `${dataDir()}/skills`；
 * 2. frontmatter 必须同时写全 name 与 description，缺 description 会被内核静默丢弃。
 */
function writeSkillFixture() {
  const skillFile = path.join(DATA_DIR, "skills", SKILL_NAME, "SKILL.md");
  fs.mkdirSync(path.dirname(skillFile), { recursive: true });
  fs.writeFileSync(
    skillFile,
    [
      "---",
      `name: ${SKILL_NAME}`,
      `description: "E2E 冒烟夹具技能（标记 ${SKILL_MARKER}）：仅用于验证技能索引进入系统提示，被问及可用技能时应报出该名称。"`,
      "---",
      "",
      "# E2E 冒烟夹具技能",
      "",
      `本技能只服务于端到端冒烟，没有实际用途。标记字符串：${SKILL_MARKER}`,
      "",
    ].join("\n"),
    "utf8",
  );
  return skillFile;
}

// ==================== 主流程 ====================
async function main() {
  if (!API_KEY) {
  console.error("缺少 OINT_PROBE_API_KEY 环境变量，无法执行端到端冒烟");
    process.exit(1);
  }
  fs.mkdirSync(WORK_DIR, { recursive: true });
  // 技能夹具必须在启动之前就位，晚于 launchApp 就扫不到了
  ok("技能夹具写入", `${writeSkillFixture()}（技能名 ${SKILL_NAME}，标记 ${SKILL_MARKER}）`);

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

    // Approval notices are the only event authority used here; conversation state comes from snapshots.
    const sessionId = await evaluate(`(async () => {
      const session = await window.oint.sessions.create({ title: "E2E 冒烟会话" });
      window.__e2e = { events: [], sessionId: session.id, sendDone: true };
      window.__e2e.unsub = window.oint.chat.onEvent(({sessionId, event}) => {
        if (sessionId === window.__e2e.sessionId && (event.type === "approval-requested" || event.type === "approval-resolved")) window.__e2e.events.push(event);
      });
      return session.id;
    })()`);
    ok("会话创建", `sessionId=${sessionId}`);

    await beginRun("只回复两个字：你好");
    const firstRun = await finishRun("第一轮 committed 对话结束");
    assertStep("对话产生已提交文本", firstRun.text.length > 0 && !firstRun.errored, JSON.stringify(firstRun.text));

    await beginRun('请用 bash 工具执行 node -e "console.log(2+3)"，完成后只回复结果数字');
    const bashRun = await finishRun("第二轮 bash 结束");
    const bash = bashRun.tools.find((tool) => tool.toolName === "bash" && tool.status === "done");
    assertStep("低风险 bash 自动放行", !!bash && !bash.isError && !bashRun.hasApproval, JSON.stringify(bashRun));

    const writeTarget = path.join(WORK_DIR, "e2e-written.txt");
    await beginRun(`请用 write 工具把内容 hello-e2e 写入文件 ${writeTarget}，完成后只回复 OK`);
    const approvalId = await waitFor(`(() => {
      if (window.__e2e.sendError) throw new Error(window.__e2e.sendError);
      return window.__e2e.events.find((event) => event.type === "approval-requested")?.request.id ?? null;
    })()`, "高风险工具触发审批");
    await evaluate(`window.oint.approvals.respond(${JSON.stringify(approvalId)}, "allow_once")`);
    const writeRun = await finishRun("第三轮审批后结束");
    const written = writeRun.tools.find((tool) => tool.toolName === "write" && tool.status === "done");
    assertStep("高风险工具审批后执行", !!written && !written.isError && writeRun.approvalResolved && fs.existsSync(writeTarget), JSON.stringify(writeRun));

    const fullTarget = path.join(WORK_DIR, "e2e-full.txt");
    await evaluate(`(async () => {
      const settings = await window.oint.settings.read();
      await window.oint.settings.write({ ...settings, permissionMode: "full" });
    })()`);
    await beginRun(`请用 write 工具把内容 full-mode 写入文件 ${fullTarget}，完成后只回复 OK`);
    const fullRun = await finishRun("第四轮完全访问结束");
    const fullWrite = fullRun.tools.find((tool) => tool.toolName === "write" && tool.status === "done");
    assertStep("完全访问模式免审批", !!fullWrite && !fullWrite.isError && !fullRun.hasApproval && fs.existsSync(fullTarget), JSON.stringify(fullRun));

    await beginRun("不要调用任何工具，直接回答：你当前可用的技能（skills）有哪些？只输出技能名字，用逗号分隔。");
    const skillRun = await finishRun("第五轮技能问答结束");
    assertStep("技能注入（系统提示的技能索引）", skillRun.text.toLowerCase().includes(SKILL_NAME), JSON.stringify(skillRun.text));

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
    await evaluate(`window.oint.window.close()`).catch(() => undefined);
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

    await evaluate(`window.oint.window.close()`).catch(() => undefined);
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
    const cleanupTarget = fs.realpathSync(TMP);
    const temporaryRoot = fs.realpathSync(os.tmpdir());
    if (path.dirname(cleanupTarget) !== temporaryRoot || !path.basename(cleanupTarget).startsWith("oint-e2e-")) throw new Error("Unsafe probe cleanup target");
    fs.rmSync(cleanupTarget, { recursive: true, force: true });
  }

  console.log("-".repeat(64));
  console.log(`端到端冒烟结束：通过 ${passed} 项，失败 ${failed} 项`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`端到端冒烟脚本异常：${String(error)}`);
  process.exit(1);
});
