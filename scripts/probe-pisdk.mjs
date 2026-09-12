// pisdk 关键装配探针（checkpoint-2 关键路径验证）
// 用途：使用真实 OpenAI 兼容端点，跑通 @earendil-works/pi-agent-core 的 AgentHarness 主进程装配链路。
// 运行：node scripts/probe-pisdk.mjs
// 产物：事件样本写入系统临时目录（oint-probe/probe-events.json），不修改项目文件。

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import {
  AgentHarness,
  BACKGROUND_CONTEXT,
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/harness/env/nodejs";
import { createModels, createProvider } from "@earendil-works/pi-ai";
import * as openaiCompletions from "@earendil-works/pi-ai/api/openai-completions";
import {
  SqliteSessionRepo,
  createNodeSqliteFactory,
} from "@earendil-works/pi-session-backend-sqlite-node";

// ==================== 配置 ====================
// 密钥从环境变量读取，避免写入仓库；缺少时给出明确提示
/** 探测用环境变量：新名优先，兼容改名前的 POLAR_PROBE_* */
function probeEnv(suffix) {
  return process.env[`OINT_PROBE_${suffix}`] ?? process.env[`POLAR_PROBE_${suffix}`];
}

const BASE_URL = probeEnv("BASE_URL") ?? "https://ai.qgming.com/v1";
const API_KEY = probeEnv("API_KEY") ?? "";
const MODEL_ID = probeEnv("MODEL") ?? "deepseek-v4-flash";
const PROVIDER_ID = "probe-svc";

const DATA_DIR = path.join(os.tmpdir(), "oint-probe");
const WORK_DIR = path.join(DATA_DIR, "work");
const EVENTS_PATH = path.join(DATA_DIR, "probe-events.json");

// 与 HarnessEventPayload 联合类型保持一致的事件类型清单
const EVENT_TYPES = [
  "run_start",
  "run_resume",
  "run_suspend",
  "run_end",
  "message_start",
  "message_update",
  "message_end",
  "turn_start",
  "turn_end",
  "tool_start",
  "tool_update",
  "tool_end",
  "entry_added",
  "queue_update",
  "usage",
  "compaction_start",
  "compaction_end",
  "retry_scheduled",
  "retry_start",
  "retry_end",
  "fault",
  "handler_error",
  "value_update",
  "config_update",
];

const EVENT_SAMPLE_LIMIT = 30; // 只保留前 30 条事件摘要

// ==================== 步骤输出 ====================
const stepResults = [];

function step(n, ok, detail) {
  const line = `STEP ${n} ${ok ? "OK" : "FAIL"} - ${detail}`;
  console.log(line);
  stepResults.push({ step: n, ok, detail });
  return ok;
}

function errText(error) {
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function truncateString(value, max) {
  const text = value == null ? "" : String(value);
  return text.length > max ? `${text.slice(0, max)}...[已截断]` : text;
}

function truncateJson(value, maxChars) {
  let json;
  try {
    json = JSON.stringify(value, null, 2);
  } catch {
    json = String(value);
  }
  if (typeof json !== "string") json = String(json);
  if (json.length <= maxChars) return json;
  return `${json.slice(0, maxChars)}\n...[已截断，原始长度 ${json.length} 字符]`;
}

function contentToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  return content
    .map((block) => {
      if (block?.type === "text") return block.text ?? "";
      if (block?.type === "image") return `<image:${block.mimeType ?? "?"}>`;
      return `<${block?.type ?? "unknown"}>`;
    })
    .join("");
}

// ==================== 事件收集 ====================
const eventLog = []; // 前 30 条事件的关键字段
const eventCounts = new Map(); // 各类型计数
let firstMessageUpdateJson = null; // 首条 message_update 的完整 JSON（截断）
let assistantText = ""; // 当前 prompt 的流式文本累积
let textDeltaCount = 0; // 当前 prompt 的 text_delta 数量
const toolStarts = []; // 工具调用开始记录
const toolEnds = []; // 工具调用结束记录
const hookBeforeToolCalls = []; // before_tool 钩子命中记录

function summarizeEvent(event) {
  const base = { type: event?.type ?? "unknown" };
  if (event?.lane !== undefined) base.lane = event.lane;
  if (event?.runId !== undefined) base.runId = event.runId;

  switch (event?.type) {
    case "message_update": {
      const inner = event.event ?? {};
      const summary = { ...base, assistantEvent: inner.type };
      if (inner.contentIndex !== undefined) summary.contentIndex = inner.contentIndex;
      if (typeof inner.delta === "string") summary.delta = inner.delta;
      if (typeof inner.content === "string") summary.content = truncateString(inner.content, 300);
      if (inner.toolCall) summary.toolCall = inner.toolCall;
      if (inner.reason) summary.reason = inner.reason;
      return summary;
    }
    case "message_start":
    case "message_end":
      return { ...base, role: event.message?.role, entryId: event.entryId };
    case "tool_start":
      return {
        ...base,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
      };
    case "tool_update":
      return {
        ...base,
        toolName: event.toolName,
        partialText: truncateString(contentToText(event.partialResult?.content), 300),
      };
    case "tool_end":
      return {
        ...base,
        toolName: event.toolName,
        isError: event.isError,
        terminate: event.terminate,
        resultText: truncateString(contentToText(event.result?.content), 500),
        details: event.result?.details,
      };
    case "run_end":
      return {
        ...base,
        status: event.status,
        fromTipId: event.fromTipId,
        tipId: event.tipId,
        endedAt: event.endedAt,
        error: event.error,
      };
    case "turn_end":
      return {
        ...base,
        stopReason: event.message?.stopReason,
        toolResultCount: Array.isArray(event.toolResults) ? event.toolResults.length : 0,
      };
    case "entry_added":
      return { ...base, entryType: event.entry?.type, entryId: event.entry?.id };
    case "usage":
      return { ...base, totals: event.totals };
    case "value_update":
      return {
        ...base,
        value: event.value,
        ...(event.name !== undefined ? { name: event.name } : {}),
        ...(event.targetId !== undefined ? { targetId: event.targetId } : {}),
        ...(event.label !== undefined ? { label: event.label } : {}),
      };
    case "fault":
    case "handler_error":
      return {
        ...base,
        message: event.message ?? event.error,
        code: event.code,
        hook: event.hook,
        event: event.event,
      };
    case "retry_scheduled":
      return { ...base, step: event.step, attempt: event.attempt, errorMessage: event.errorMessage };
    default:
      return base;
  }
}

function recordEvent(event) {
  try {
    const type = event?.type ?? "unknown";
    eventCounts.set(type, (eventCounts.get(type) ?? 0) + 1);

    if (type === "message_update") {
      const inner = event.event ?? {};
      if (inner.type === "text_delta" && typeof inner.delta === "string") {
        assistantText += inner.delta;
        textDeltaCount += 1;
      }
      if (firstMessageUpdateJson === null) {
        firstMessageUpdateJson = truncateJson(event, 4000);
      }
    }

    if (type === "tool_start") {
      toolStarts.push({ runId: event.runId, toolName: event.toolName, args: event.args });
    }

    if (type === "tool_end") {
      toolEnds.push({
        runId: event.runId,
        toolName: event.toolName,
        isError: event.isError,
        terminate: event.terminate,
        text: contentToText(event.result?.content),
      });
    }

    if (eventLog.length < EVENT_SAMPLE_LIMIT) {
      eventLog.push(summarizeEvent(event));
    }
  } catch (error) {
    console.error("[event-recorder] 监听器内部异常（已忽略）:", error);
  }
}

// ==================== 环境辅助 ====================
function execFileOutput(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 5000, windowsHide: true }, (error, stdout) => {
      resolve(error ? null : String(stdout));
    });
  });
}

async function fileExists(target) {
  try {
    const stat = await fs.stat(target);
    return stat.isFile();
  } catch {
    return false;
  }
}

// Windows 上 NodeExecutionEnv 自动探测会优先取 C:\Windows\System32\bash.exe（旧版 WSL），
// 而本机未安装 WSL 发行版。这里显式解析可用的 Git Bash，保证 bash 工具可执行。
async function resolveShellPath() {
  if (process.platform !== "win32") return undefined;
  const candidates = [];
  if (process.env.ProgramFiles) {
    candidates.push(path.join(process.env.ProgramFiles, "Git", "bin", "bash.exe"));
  }
  if (process.env["ProgramFiles(x86)"]) {
    candidates.push(path.join(process.env["ProgramFiles(x86)"], "Git", "bin", "bash.exe"));
  }
  const whereBash = await execFileOutput("where.exe", ["bash.exe"]);
  if (whereBash) {
    for (const line of whereBash.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed) candidates.push(trimmed);
    }
  }
  const whereGit = await execFileOutput("where.exe", ["git.exe"]);
  if (whereGit) {
    for (const line of whereGit.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const gitRoot = path.dirname(path.dirname(trimmed)); // <root>\cmd\git.exe -> <root>
      candidates.push(path.join(gitRoot, "bin", "bash.exe"));
    }
  }
  for (const candidate of candidates) {
    // 跳过旧版 WSL bash（本机不可用）
    if (/[\\/]windows[\\/](system32|sysnative)[\\/]bash\.exe$/i.test(candidate)) continue;
    if (await fileExists(candidate)) return candidate;
  }
  return undefined;
}

// ==================== 主流程 ====================
async function main() {
  console.log("=".repeat(72));
  console.log("pisdk 装配探针启动");
  console.log(`  端点: ${BASE_URL}`);
  console.log(`  模型: ${MODEL_ID} (provider=${PROVIDER_ID}, api=openai-completions)`);
  console.log(`  API Key: ${API_KEY.slice(0, 12)}...${API_KEY.slice(-4)}`);
  console.log(`  数据目录: ${DATA_DIR}`);
  console.log("=".repeat(72));

  const state = {};
  let aborted = false;

  // guarded：若上游步骤失败，后续步骤标记为 SKIPPED，避免误报
  async function guarded(n, body) {
    if (aborted) {
      step(n, false, "SKIPPED - 上游步骤失败");
      return;
    }
    try {
      const detail = await body();
      step(n, true, detail);
    } catch (error) {
      step(n, false, errText(error));
      aborted = true;
    }
  }

  try {
    // STEP 1 数据目录
    await guarded(1, async () => {
      await fs.rm(DATA_DIR, { recursive: true, force: true });
      await fs.mkdir(WORK_DIR, { recursive: true });
      return `临时数据目录已清空并重建: ${DATA_DIR}`;
    });

    // STEP 2 Model 对象（必填字段以 pi-ai/dist/types.d.ts 的 Model/ModelCost 为准）
    await guarded(2, async () => {
      state.model = {
        id: MODEL_ID,
        name: "DeepSeek V4 Flash (probe)",
        api: "openai-completions",
        provider: PROVIDER_ID,
        baseUrl: BASE_URL,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 8192,
      };
      const required = [
        "id",
        "name",
        "api",
        "provider",
        "baseUrl",
        "reasoning",
        "input",
        "cost",
        "contextWindow",
        "maxTokens",
      ];
      const missing = required.filter((key) => state.model[key] === undefined);
      if (missing.length > 0) throw new Error(`Model 缺少必填字段: ${missing.join(", ")}`);
      const costRequired = ["input", "output", "cacheRead", "cacheWrite"];
      const missingCost = costRequired.filter((key) => state.model.cost[key] === undefined);
      if (missingCost.length > 0) throw new Error(`ModelCost 缺少必填字段: ${missingCost.join(", ")}`);
      return `Model 构造完成: id=${MODEL_ID} api=${state.model.api} baseUrl=${BASE_URL}`;
    });

    // STEP 3 createModels + createProvider 注册
    await guarded(3, async () => {
      state.models = createModels();
      const provider = createProvider({
        id: PROVIDER_ID,
        name: "Probe Service",
        baseUrl: BASE_URL,
        models: [state.model],
        auth: {
          apiKey: {
            name: "Probe API Key",
            resolve: async () => ({ auth: { apiKey: API_KEY }, source: "probe-inline-key" }),
          },
        },
        api: {
          stream: openaiCompletions.stream,
          streamSimple: openaiCompletions.streamSimple,
        },
      });
      state.models.setProvider(provider);
      const resolved = state.models.getModel(PROVIDER_ID, MODEL_ID);
      if (!resolved) throw new Error(`models.getModel("${PROVIDER_ID}","${MODEL_ID}") 返回 undefined`);
      return `provider 已注册 (id=${provider.id})，getModel 返回 id=${resolved.id} provider=${resolved.provider}`;
    });

    // STEP 4 NodeExecutionEnv + hello.txt
    await guarded(4, async () => {
      const shellPath = await resolveShellPath();
      state.env = new NodeExecutionEnv({
        cwd: WORK_DIR,
        ...(shellPath ? { shellPath } : {}),
      });
      const writeResult = await state.env.writeFile("hello.txt", "hello pisdk", BACKGROUND_CONTEXT);
      if (!writeResult.ok) throw new Error(`env.writeFile 失败: ${errText(writeResult.error)}`);
      const readResult = await state.env.readTextFile("hello.txt", BACKGROUND_CONTEXT);
      if (!readResult.ok) throw new Error(`env.readTextFile 失败: ${errText(readResult.error)}`);
      if (!readResult.value.includes("hello")) {
        throw new Error(`hello.txt 回读内容异常: ${readResult.value}`);
      }
      return `NodeExecutionEnv(cwd=${WORK_DIR}, shellPath=${shellPath ?? "自动探测"})，hello.txt 写入并回读成功`;
    });

    // STEP 5 SQLite 会话 + main 分支
    await guarded(5, async () => {
      state.repo = new SqliteSessionRepo({
        directory: DATA_DIR,
        databaseFactory: createNodeSqliteFactory(),
      });
      state.session = await state.repo.create(undefined, BACKGROUND_CONTEXT);
      state.branch = await state.session.createBranch("main", null, BACKGROUND_CONTEXT);
      if (state.branch.name !== "main") throw new Error(`分支名异常: ${state.branch.name}`);
      const list = await state.repo.list(undefined, BACKGROUND_CONTEXT);
      return `session.id=${state.session.metadata?.id}，branch=${state.branch.name}，repo.list=${list.length} 条`;
    });

    // STEP 6 创建 harness（注意：createAgentHarness 非根导出，使用 AgentHarness.create） + 获取 lane
    await guarded(6, async () => {
      const created = await AgentHarness.create(
        {
          session: state.session,
          models: state.models,
          model: state.model,
          systemPrompt: "你是 Oint 的装配探针代理。严格按用户指令执行，回复尽量简短。",
          tools: [createBashTool(), createReadTool(), createWriteTool(), createEditTool()],
          toolContext: { env: state.env },
          compaction: { enabled: true, reserveTokens: 20000, keepRecentTokens: 40000 },
        },
        BACKGROUND_CONTEXT,
      );
      state.harness = created.harness;
      state.lane = await created.harness.lane("main", BACKGROUND_CONTEXT);
      return `harness 创建成功，open=${created.open.length}，lane=${state.lane.name}，返回键=[${Object.keys(created).join(",")}]`;
    });

    // STEP 7 事件监听 + before_tool 钩子
    await guarded(7, async () => {
      state.unsubscribers = EVENT_TYPES.map((type) =>
        state.harness.events.on(type, (event) => recordEvent(event)),
      );
      state.harness.hooks.on("before_tool", (event) => {
        hookBeforeToolCalls.push({ toolName: event.toolName, args: event.args });
        return undefined; // 放行：不修改参数、不拦截
      });
      return `已订阅 ${state.unsubscribers.length} 类事件 + before_tool 钩子；载荷样本将在首个事件到达后打印`;
    });

    // STEP 8 流式文本验证
    await guarded(8, async () => {
      assistantText = "";
      textDeltaCount = 0;
      const result = await state.lane.prompt("只回复两个字：你好", undefined, BACKGROUND_CONTEXT);
      if (!result.ok) throw new Error(`lane.prompt 返回错误: ${errText(result.error)}`);
      if (textDeltaCount < 1) throw new Error(`未收到 text_delta（收到 ${textDeltaCount} 个）`);
      console.log("--- 首条 message_update 完整 JSON（截断 4000 字符） ---");
      console.log(firstMessageUpdateJson ?? "(未收到 message_update 事件)");
      console.log("--- 首条 message_update 结束 ---");
      return `run=${result.value.operationId} status=${result.value.status}，text_delta=${textDeltaCount}，文本="${truncateString(assistantText, 100)}"`;
    });

    // STEP 9 工具调用验证
    await guarded(9, async () => {
      assistantText = "";
      textDeltaCount = 0;
      const startCount = toolStarts.length;
      const endCount = toolEnds.length;
      const result = await state.lane.prompt(
        '用 bash 工具执行命令 node -e "console.log(2+3)"，然后只回复数字结果',
        undefined,
        BACKGROUND_CONTEXT,
      );
      if (!result.ok) throw new Error(`lane.prompt 返回错误: ${errText(result.error)}`);
      const started = toolStarts.slice(startCount);
      const ended = toolEnds.slice(endCount);
      const bashStart = started.find((entry) => entry.toolName === "bash");
      if (!bashStart) {
        throw new Error(
          `未观察到 bash 的 tool_start（本次 tool_start: ${JSON.stringify(started.map((entry) => entry.toolName))}）`,
        );
      }
      const bashEnd = ended.find((entry) => entry.toolName === "bash");
      if (!bashEnd) throw new Error("未观察到 bash 的 tool_end");
      if (bashEnd.isError) throw new Error(`bash 工具执行报错: ${bashEnd.text}`);
      if (!String(bashEnd.text ?? "").includes("5")) {
        throw new Error(`bash 结果不含 "5": ${bashEnd.text}`);
      }
      return `tool_start=${started.length} tool_end=${ended.length}，bash 输出="${truncateString(bashEnd.text, 200)}"，回复="${truncateString(assistantText, 50)}"，before_tool 命中=${hookBeforeToolCalls.length}`;
    });

    // STEP 10 会话条目 + 会话名
    await guarded(10, async () => {
      const entries = await state.lane.findEntries(
        { order: "newestFirst", limit: 5 },
        BACKGROUND_CONTEXT,
      );
      const messageEntry = entries.find((entry) => entry.type === "message");
      console.log("--- 单条 message Entry 完整 JSON（截断 3000 字符） ---");
      console.log(messageEntry ? truncateJson(messageEntry, 3000) : "(未找到 message 类型 Entry)");
      console.log("--- message Entry 结束 ---");
      if (!messageEntry) throw new Error("lane.findEntries 未返回 message Entry");
      await state.session.setName("探针会话", BACKGROUND_CONTEXT);
      const name = await state.session.getName(BACKGROUND_CONTEXT);
      if (name !== "探针会话") throw new Error(`会话名回读不一致: ${name}`);
      return `findEntries=${entries.length} 条（首条 message entry id=${messageEntry.id}），会话名回读="${name}"`;
    });
  } catch (error) {
    console.error("探针主流程异常:", error);
    aborted = true;
  } finally {
    // 落盘事件样本
    try {
      await fs.mkdir(DATA_DIR, { recursive: true });
      await fs.writeFile(
        EVENTS_PATH,
        JSON.stringify(
          {
            generatedAt: new Date().toISOString(),
            totalEventTypes: Object.fromEntries(eventCounts),
            sampleLimit: EVENT_SAMPLE_LIMIT,
            sample: eventLog,
            toolStarts,
            toolEnds,
            hookBeforeToolCalls,
          },
          null,
          2,
        ),
        "utf8",
      );
      console.log(`事件样本已写入: ${EVENTS_PATH}`);
    } catch (error) {
      console.error(`写入事件样本失败: ${errText(error)}`);
    }

    // STEP 11 关闭资源
    const closeErrors = [];
    try {
      state.unsubscribers?.forEach((unsubscribe) => unsubscribe());
    } catch (error) {
      closeErrors.push(`events.unsubscribe: ${errText(error)}`);
    }
    try {
      if (state.harness) await state.harness.close(BACKGROUND_CONTEXT);
    } catch (error) {
      closeErrors.push(`harness.close: ${errText(error)}`);
    }
    try {
      if (state.session) await state.session.close(BACKGROUND_CONTEXT);
    } catch (error) {
      closeErrors.push(`session.close: ${errText(error)}`);
    }
    try {
      if (state.repo) await state.repo.close(BACKGROUND_CONTEXT);
    } catch (error) {
      closeErrors.push(`repo.close: ${errText(error)}`);
    }
    try {
      if (state.env) await state.env.cleanup(BACKGROUND_CONTEXT);
    } catch (error) {
      closeErrors.push(`env.cleanup: ${errText(error)}`);
    }
    step(
      11,
      closeErrors.length === 0,
      closeErrors.length === 0
        ? "harness/session/repo/env 均已关闭"
        : `关闭过程报错: ${closeErrors.join(" | ")}`,
    );

    // 汇总
    console.log("=".repeat(72));
    console.log("探针汇总");
    console.log(`  事件类型计数: ${JSON.stringify(Object.fromEntries(eventCounts))}`);
    console.log(`  前 ${EVENT_SAMPLE_LIMIT} 条事件已写入: ${EVENTS_PATH}`);
    const failedSteps = stepResults.filter((entry) => !entry.ok);
    console.log(
      `  步骤结果: ${stepResults.filter((entry) => entry.ok).length}/${stepResults.length} OK` +
        (failedSteps.length ? `，失败步骤: ${failedSteps.map((entry) => entry.step).join(",")}` : ""),
    );
    console.log("=".repeat(72));
    process.exitCode = failedSteps.length ? 1 : 0;
  }
}

main().catch((error) => {
  console.error("探针未捕获异常:", error);
  process.exitCode = 1;
});
