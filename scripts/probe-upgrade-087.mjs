// 升级探针（0.85.1 → 0.87.0）：不联网，验证新增/变更的 API 真的按预期工作。
//
// 覆盖点（都是本次升级真正动过的地方）：
// 1. FileSystem.openTextLineReader —— 0.86.0 新增的必需方法（旧接口没有它，升级后 TS 会直接报错）
// 2. pi-ai providers/all 的 provider 枚举 —— known-models 改为上游枚举后的数据源
// 3. SystemMessage / TranscriptContext / normalizeContext —— 0.86.0 的系统提示新载体
// 4. estimateContextTokens 能接 TranscriptContext 与「带 system 消息的消息数组」
// 5. 完整装配：AgentHarness.create + lane → 工具 schema 仍是 typebox 1.3.27 的实例
//
// 运行：node scripts/probe-upgrade-087.mjs
// 产物：只写系统临时目录，不改动仓库文件。

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import {
  AgentHarness,
  BACKGROUND_CONTEXT,
  createBashTool,
  createReadTool,
  createWriteTool,
  estimateContextTokens as estimateFromCore,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/harness/env/nodejs";
import {
  createInitialSystemMessage,
  createModels,
  createProvider,
  getCurrentSystemPrompt,
  getSystemMessageText,
  normalizeContext,
} from "@earendil-works/pi-ai";
import * as openaiCompletions from "@earendil-works/pi-ai/api/openai-completions";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { estimateContextTokens as estimateFromUtil } from "@earendil-works/pi-ai/utils/estimate";
import {
  SqliteSessionRepo,
  createNodeSqliteFactory,
} from "@earendil-works/pi-session-backend-sqlite-node";

const DATA_DIR = path.join(os.tmpdir(), "oint-upgrade-probe");

const steps = [];
function step(n, ok, detail) {
  console.log(`STEP ${n} ${ok ? "OK  " : "FAIL"} - ${detail}`);
  steps.push({ step: n, ok, detail });
  return ok;
}

function errText(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * STEP 1：openTextLineReader 是 0.86.0 加进 FileSystem 接口的必需方法。
 *
 * 这是本次升级唯一一处**硬**编译错误来源：只包了一层守卫的 createExecEnv 必须把它一起转发，
 * 否则 tsc 直接红（内核不提供默认实现）。这里直接对着 NodeExecutionEnv 验证真实行为，
 * 确认「拉取式逐行读取」真的能读到最后一行，并保留未终止的尾行。
 */
async function checkTextLineReader(workDir) {
  const env = new NodeExecutionEnv({ cwd: workDir });
  try {
    // 尾行**不带**换行符：TextLineReader 的 terminated 字段正是为区分这种情况而存在
    await env.writeFile("lines.txt", "alpha\nbeta\ngamma", BACKGROUND_CONTEXT);

    const opened = await env.openTextLineReader("lines.txt", BACKGROUND_CONTEXT);
    if (!opened.ok) throw new Error(`openTextLineReader 失败: ${errText(opened.error)}`);

    const reader = opened.value;
    const seen = [];
    for (;;) {
      const line = await reader.readLine(BACKGROUND_CONTEXT);
      if (!line.ok) throw new Error(`readLine 失败: ${errText(line.error)}`);
      if (line.value === undefined) break;
      seen.push({ text: line.value.text, terminated: line.value.terminated });
    }
    await reader.close(BACKGROUND_CONTEXT);

    const texts = seen.map((l) => l.text);
    if (texts.join("|") !== "alpha|beta|gamma") {
      throw new Error(`逐行读取结果不符: ${JSON.stringify(texts)}`);
    }
    const last = seen[seen.length - 1];
    if (last.terminated !== false) {
      throw new Error(`尾行未终止，但 terminated=${String(last.terminated)}`);
    }
    if (seen[0].terminated !== true) {
      throw new Error(`首行应已终止，但 terminated=${String(seen[0].terminated)}`);
    }

    // readTextLines 仍走同一条实现，顺带确认旧方法没被新接口破坏
    const viaOld = await env.readTextLines("lines.txt", { maxLines: 2 }, BACKGROUND_CONTEXT);
    if (!viaOld.ok || viaOld.value.join("|") !== "alpha|beta") {
      throw new Error(`readTextLines 回归: ${JSON.stringify(viaOld)}`);
    }

    return `逐行读到 ${texts.length} 行（尾行 terminated=false），readTextLines 未回归`;
  } finally {
    await env.cleanup(BACKGROUND_CONTEXT);
  }
}

/** STEP 2：known-models 的新数据源 —— 上游枚举出的 provider 与模型 */
function checkBuiltinCatalog() {
  const providers = getBuiltinProviders();
  if (providers.length === 0) throw new Error("getBuiltinProviders 返回空");

  let total = 0;
  const empty = [];
  for (const provider of providers) {
    const models = getBuiltinModels(provider);
    total += models.length;
    if (models.length === 0) empty.push(provider);
  }
  if (empty.length > 0) throw new Error(`以下 provider 没有模型: ${empty.join(", ")}`);

  // 手写清单时代漏掉的两个 provider（0.86.0 新增）。它们就是本次改造的动机
  for (const required of ["meta", "radius"]) {
    if (!providers.includes(required)) throw new Error(`枚举里缺少 ${required}`);
  }
  // provider 名与模型上的 provider 字段必须一致，否则 `<provider>/<id>` 建不出正确键
  const mismatch = providers.filter((provider) =>
    getBuiltinModels(provider).some((model) => model.provider !== provider),
  );
  if (mismatch.length > 0) throw new Error(`provider 字段不一致: ${mismatch.join(", ")}`);

  return `${providers.length} 个 provider / ${total} 个模型（含 meta、radius）`;
}

/** STEP 3：0.86.0 的系统提示新载体（SystemMessage + TranscriptContext） */
function checkTranscriptContext() {
  const tools = [
    {
      name: "probe_tool",
      description: "探针工具",
      parameters: { type: "object", properties: {} },
    },
  ];
  const system = createInitialSystemMessage("你是探针。", tools);
  if (system === undefined) throw new Error("createInitialSystemMessage 返回 undefined");
  if (system.role !== "system") throw new Error(`role 应为 system，实际 ${system.role}`);
  if (system.content !== "你是探针。") throw new Error(`content 不符: ${String(system.content)}`);
  if (system.toolsAdded?.length !== 1) {
    throw new Error(`toolsAdded 应为 1 项，实际 ${String(system.toolsAdded?.length)}`);
  }

  // sections 是 0.86.0 新增的「命名提示段」：后出现的 system 消息按名字覆盖
  const withSection = {
    ...system,
    sections: { skills: "<skills>probe</skills>" },
  };
  const rendered = getSystemMessageText(withSection);
  if (!rendered.includes("你是探针。") || !rendered.includes("<skills>probe</skills>")) {
    throw new Error(`getSystemMessageText 未渲染 content + sections: ${rendered}`);
  }

  const context = normalizeContext({
    systemPrompt: "回放出来的提示",
    messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
    tools,
  });
  const replayed = getCurrentSystemPrompt(context.messages);
  if (replayed !== "回放出来的提示") {
    throw new Error(`normalizeContext 回放出的提示不符: ${replayed}`);
  }

  return `SystemMessage 承载提示与 ${system.toolsAdded?.length} 个工具声明；normalizeContext 回放一致`;
}

/**
 * STEP 4：estimateContextTokens 有两个同名实现，签名不同 —— 这里把区别钉死。
 *
 * - `pi-agent-core` 的收 **AgentMessage[]**（内部按 AgentMessage 的 estimateTokens 走）；
 * - `pi-ai/utils/estimate` 的收 **TranscriptContext | Message[]**，且 TranscriptContext 形态
 *   会把 system 消息里的提示与 toolsAdded/toolsRemoved 一起算进去（这正是 0.86.0 的新口径）。
 *
 * 后者**没有**从 pi-ai 根导出，只能走 `@earendil-works/pi-ai/utils/estimate` 子路径 —— 容易踩。
 */
function checkEstimate() {
  const messages = [
    { role: "system", content: "系统提示", timestamp: 1 },
    { role: "user", content: "问题", timestamp: 2 },
  ];
  const tools = [
    { name: "probe_tool", description: "探针工具", parameters: { type: "object", properties: {} } },
  ];

  const fromArray = estimateFromUtil(messages);
  if (!(fromArray.tokens > 0)) throw new Error("estimateContextTokens(数组) 应大于 0");

  // 同一个函数也能接 TranscriptContext（品牌类型）
  const fromContext = estimateFromUtil(normalizeContext({ messages, tools }));
  if (!(fromContext.tokens > 0)) throw new Error("estimateContextTokens(TranscriptContext) 应大于 0");
  if (fromContext.tokens <= fromArray.tokens) {
    throw new Error(
      `TranscriptContext 形态应把工具声明算进去（${fromContext.tokens} vs ${fromArray.tokens}）`,
    );
  }

  // agent-core 的同名函数只吃消息数组，两者不可互换
  const coreTokens = estimateFromCore(messages);
  if (!(coreTokens.tokens > 0)) throw new Error("agent-core estimateContextTokens 应大于 0");
  let coreAcceptedContext = false;
  try {
    estimateFromCore(normalizeContext({ messages }));
    coreAcceptedContext = true;
  } catch {
    // 预期路径：它按消息数组遍历，接到 TranscriptContext 会抛
  }
  if (coreAcceptedContext) {
    throw new Error("agent-core 版不应接受 TranscriptContext（两者已可互换，需重新核对口径）");
  }

  return `pi-ai 版：数组 ${fromArray.tokens} / TranscriptContext ${fromContext.tokens}（含工具）；agent-core 版 ${coreTokens.tokens}`;
}

/** STEP 5：真实装配 —— harness + lane + 工具 schema 在 typebox 1.3.27 下仍可用 */
async function checkAssembly(workDir) {
  const model = {
    id: "probe-model",
    name: "Probe Model",
    api: "openai-completions",
    provider: "probe-svc",
    baseUrl: "https://example.invalid/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
  };

  const models = createModels();
  models.setProvider(
    createProvider({
      id: "probe-svc",
      name: "Probe Service",
      baseUrl: model.baseUrl,
      models: [model],
      auth: {
        apiKey: {
          name: "Probe Key",
          resolve: async () => ({ auth: { apiKey: "probe-key" } }),
        },
      },
      api: {
        stream: openaiCompletions.stream,
        streamSimple: openaiCompletions.streamSimple,
      },
    }),
  );
  if (!models.getModel("probe-svc", "probe-model")) throw new Error("getModel 返回 undefined");

  const repo = new SqliteSessionRepo({
    directory: DATA_DIR,
    databaseFactory: createNodeSqliteFactory(),
  });
  let session;
  try {
    session = await repo.create(undefined, BACKGROUND_CONTEXT);
    await session.createBranch("main", null, BACKGROUND_CONTEXT);

    const env = new NodeExecutionEnv({ cwd: workDir });
    try {
      // 工具 schema 是 Oint 自己用 typebox 造的；内核会把它原样送进 typebox 的类型系统。
      // typebox 与内核不同版本时，这里的装配与序列化最容易先炸。
      const tools = [createBashTool(), createReadTool(), createWriteTool()];
      const created = await AgentHarness.create(
        {
          session,
          models,
          model,
          systemPrompt: "你是升级探针。",
          tools,
          toolContext: { env },
          compaction: { enabled: true, reserveTokens: 20000, keepRecentTokens: 40000 },
        },
        BACKGROUND_CONTEXT,
      );
      const lane = await created.harness.lane("main", BACKGROUND_CONTEXT);
      const active = await lane.getActiveTools(BACKGROUND_CONTEXT);
      const roundTrip = JSON.stringify(tools.map((t) => t.parameters));
      if (roundTrip.length < 10) throw new Error("工具 schema 序列化异常");

      await created.harness.close(BACKGROUND_CONTEXT).catch(() => undefined);
      return `harness 装配成功，lane=${lane.name}，生效工具 ${active.length} 个，schema 可序列化`;
    } finally {
      await env.cleanup(BACKGROUND_CONTEXT);
    }
  } finally {
    if (session) await session.close(BACKGROUND_CONTEXT).catch(() => undefined);
    await repo.close(BACKGROUND_CONTEXT).catch(() => undefined);
  }
}

async function main() {
  console.log("=".repeat(72));
  console.log("升级探针 0.85.1 → 0.87.0（离线，不发起任何模型请求）");
  console.log("=".repeat(72));

  const workDir = path.join(DATA_DIR, "work");
  await fs.rm(DATA_DIR, { recursive: true, force: true });
  await fs.mkdir(workDir, { recursive: true });

  const checks = [
    ["openTextLineReader（0.86.0 新增必需方法）", () => checkTextLineReader(workDir)],
    ["providers/all 枚举（known-models 新数据源）", () => checkBuiltinCatalog()],
    ["SystemMessage / TranscriptContext（0.86.0 系统提示载体）", () => checkTranscriptContext()],
    ["estimateContextTokens 新签名", () => checkEstimate()],
    ["AgentHarness 装配 + 工具 schema", () => checkAssembly(workDir)],
  ];

  for (const [index, [name, run]] of checks.entries()) {
    try {
      step(index + 1, true, `${name} —— ${await run()}`);
    } catch (error) {
      step(index + 1, false, `${name} —— ${errText(error)}`);
    }
  }

  console.log("=".repeat(72));
  const failed = steps.filter((s) => !s.ok);
  console.log(
    `结果：${steps.length - failed.length}/${steps.length} 通过` +
      (failed.length ? `，失败步骤 ${failed.map((s) => s.step).join(",")}` : ""),
  );
  console.log("=".repeat(72));
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((error) => {
  console.error("探针未捕获异常:", error);
  process.exitCode = 1;
});
