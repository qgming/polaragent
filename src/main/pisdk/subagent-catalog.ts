// 子智能体定义目录：内置预设 + 磁盘上的用户 .md 定义。
//
// 为什么定义放磁盘而不是数据库：与技能 / 提示模板一致 —— 用户要能用任意编辑器改、
// 能用 git 管理、能被面板的「在文件夹中显示」定位。内置预设写在代码里（随应用升级更新），
// 用户同名定义优先：否则用户永远覆盖不掉内置行为。
//
// frontmatter 解析是手写的子集（只支持 `键: 值` 与 `- item` 列表），刻意不引 YAML 依赖：
// 依赖越少，「面板里看到的定义」与「运行时装配的定义」越不可能因解析差异而对不上。

import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { dataDir } from "@/main/app/paths";
import { loadSettings } from "@/main/settings/store";
import { ALL_THINKING_LEVELS, type ModelRef, type ThinkingLevel } from "@/shared/contracts/common";
import type { Settings } from "@/shared/contracts/settings";
import {
  DEFAULT_SUBAGENT_MAX_TURNS,
  DEFAULT_SUBAGENT_TOOLS,
  MAX_SUBAGENT_DEFINITIONS,
  MAX_SUBAGENT_MAX_TURNS,
  MAX_SUBAGENT_PROMPT_CHARS,
  normalizeSubagentName,
  SUBAGENT_ASSIGNABLE_TOOLS,
  SUBAGENT_NAME_PATTERN,
  type SubagentDefinition,
  type SubagentInfo,
  type SubagentReadResult,
  type SubagentWriteRequest,
} from "@/shared/contracts/subagent";
import { resolveSubagentDirs } from "./resources";

const THINKING_LEVELS = new Set<string>(ALL_THINKING_LEVELS);
const ASSIGNABLE_TOOLS = new Set<string>(SUBAGENT_ASSIGNABLE_TOOLS);
/** 面板列表里 prompt 只显示前若干字符，避免把整段系统提示塞进列表行 */
const PROMPT_PREVIEW_CHARS = 160;

const EXPLORER_PROMPT = `你是 Oint 的子智能体「explorer」，一个只读的代码库探索者。主代理把你派来回答一个具体的探索问题：定位代码、理清调用链、总结既有约定。

你看不到用户，也不能向任何人提问，更不能把任务再委派给别的子智能体。信息不足时不要停下来等待，而要明确写出「缺哪一条信息、你已经查到了哪一步」，让主代理决定是否追问。你只应使用 read / grep / glob，不要尝试修改任何文件或执行会写盘的命令。

汇报要求：用中文，先给结论，再列证据 —— 每条结论都要带准确的文件路径与行号；说明你实际搜过的关键词或目录，以及哪些部分没能确认。不要复述自己执行了哪些工具、按什么顺序找的，只写结论、证据与未完成项。`;

const CODE_REVIEWER_PROMPT = `你是 Oint 的子智能体「code-reviewer」，负责对刚完成的改动做一次对抗式审查。你的立场是挑错而不是肯定：先假设这段代码有缺陷、边界遗漏或与既有约定不一致，再去证实或证伪。

你看不到用户，不能提问，也不能委派其他子智能体。只做只读工作：用 read / grep / glob 看代码，不要改文件，也不要跑会写盘或联网的命令。信息不足时直接写明「无法确认」以及原因，不要凭猜测下结论。

汇报要求：按严重程度排列问题，每条都带准确的文件路径与行号，并给出「什么输入或时序下会出错」的具体场景；把「确定的缺陷」「可疑但未证实」「缺少测试的地方」分开写。同时列出你没有审查到的部分。不要描述你的审查过程或工具调用。`;

const FIXER_PROMPT = `你是 Oint 的子智能体「fixer」，按主代理给出的自包含规格实现改动。规格已经过用户确认：照它做，不要顺手扩大范围，也不要重构没让你动的代码。

你可以在规格范围内读代码、改文件、跑命令（read / grep / glob / edit / write / bash），改动要小而贴合周围代码风格。你看不到用户，不能提问，也不能委派其他子智能体；规格缺关键信息时，宁可停下并在汇报里写明缺口，也不要自己补一个设计出来。

汇报要求：说明实际改了哪些文件（准确路径，必要处给行号）、每处改动对应规格里的哪一条、跑了什么验证以及结果如何；明确列出没做完或没验证的部分。不要叙述你的思考与试错过程。`;

const TEST_RUNNER_PROMPT = `你是 Oint 的子智能体「test-runner」，只做一件事：跑主代理指定的测试或构建命令，并如实汇报结果。

用 bash 执行命令；必要时先用 read / grep / glob 读配置文件，搞清该怎么跑。不要改文件，也不要为了让命令通过而放宽断言或跳过用例 —— 你的价值是把失败原样带回去。你看不到用户，不能提问，也不能委派别的子智能体；命令本身有误或缺少依赖时，直接汇报失败原因，不要反复重试同一个错。

汇报要求：先给最终结论（通过 / 失败 / 无法执行），再给关键输出：失败用例的完整名字、准确的文件路径与行号、原始错误行；输出很长时只保留与失败相关的部分，并说明截断了多少。同时写明你实际执行的完整命令。不要复述你的执行流程。`;

/**
 * 内置预设：名字与参考实现 PI-Desktop 保持同一组。
 *
 * 名字固定成这四个是刻意的 —— 面板、i18n 与用户的肌肉记忆都按名字走，
 * 改名字等于换一个子智能体，所以只在这里定义一次，别处一律引用本常量。
 */
export const BUILTIN_SUBAGENTS: readonly SubagentDefinition[] = [
  {
    name: "explorer",
    description:
      "只读的代码库探索：需要摸清一段实现的位置、调用链与既有约定时派给它，它不改任何文件。",
    prompt: EXPLORER_PROMPT,
    tools: ["read", "grep", "glob"],
    maxTurns: 30,
    source: "builtin",
  },
  {
    name: "code-reviewer",
    description:
      "对刚完成的改动做对抗式审查：只读地找出缺陷、边界遗漏与缺失的测试，并给出文件与行号。",
    prompt: CODE_REVIEWER_PROMPT,
    tools: ["read", "grep", "glob"],
    maxTurns: 30,
    source: "builtin",
  },
  {
    name: "fixer",
    description:
      "按自包含的规格实现多文件改动：它能改文件、跑命令，并在汇报里说明改了什么、还剩什么。",
    prompt: FIXER_PROMPT,
    tools: ["read", "grep", "glob", "edit", "write", "bash"],
    maxTurns: 60,
    source: "builtin",
  },
  {
    name: "test-runner",
    description: "跑一个具体的测试或构建命令并只汇报失败：适合把长输出挡在主会话之外。",
    prompt: TEST_RUNNER_PROMPT,
    tools: ["read", "grep", "glob", "bash"],
    maxTurns: 30,
    source: "builtin",
  },
];

/** frontmatter 里一个键的原始值：单个字符串，或 `- item` 收集出来的列表 */
type FrontmatterValue = string | string[];

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 折叠所有空白为单个空格：description / promptPreview 都要求单行 */
function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** 剥掉成对的首尾引号（`"x"` / `'x'` → x），其余原样 trim */
function stripQuotes(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1).trim();
    }
  }
  return value;
}

/** 键名大小写与下划线不敏感：thinkingLevel / thinking_level / THINKING_LEVEL 视作同一个键 */
function normalizeKey(key: string): string {
  return key.trim().toLowerCase().replace(/_/g, "");
}

function asList(value: FrontmatterValue | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function readString(fields: Map<string, FrontmatterValue>, key: string): string {
  const value = fields.get(key);
  if (value === undefined) return "";
  return Array.isArray(value) ? value.join(" ").trim() : value;
}

/** 把 frontmatter 正文行收集成 键 → 值；同名键重复出现时合并为列表 */
function collectFrontmatter(lines: readonly string[]): Map<string, FrontmatterValue> {
  const fields = new Map<string, FrontmatterValue>();
  let pendingKey: string | undefined;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const item = /^-\s*(.*)$/.exec(trimmed);
    if (item && pendingKey !== undefined) {
      const value = stripQuotes(item[1] ?? "");
      if (value === "") continue;
      const existing = fields.get(pendingKey);
      fields.set(pendingKey, existing === undefined ? [value] : [...asList(existing), value]);
      continue;
    }
    const pair = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(trimmed);
    if (!pair) {
      pendingKey = undefined;
      continue;
    }
    const key = normalizeKey(pair[1] ?? "");
    const valueText = (pair[2] ?? "").trim();
    pendingKey = key;
    if (valueText === "") {
      // `tools:` 后面跟 `- item` 行的写法：先占位成空列表，等列表项到达再填
      if (!fields.has(key)) fields.set(key, []);
      continue;
    }
    const value: FrontmatterValue =
      valueText.startsWith("[") && valueText.endsWith("]")
        ? valueText
            .slice(1, -1)
            .split(",")
            .map(stripQuotes)
            .filter((entry) => entry !== "")
        : stripQuotes(valueText);
    const existing = fields.get(key);
    if (existing === undefined || (Array.isArray(existing) && existing.length === 0)) {
      fields.set(key, value);
    } else {
      fields.set(key, [...asList(existing), ...asList(value)]);
    }
  }
  return fields;
}

/** 过滤出可分配给子智能体的工具并去重；过滤后为空时回落到默认只读三件套 */
function normalizeTools(tools: readonly string[]): string[] {
  const filtered = tools.map((tool) => tool.trim()).filter((tool) => ASSIGNABLE_TOOLS.has(tool));
  const unique = [...new Set(filtered)];
  return unique.length > 0 ? unique : [...DEFAULT_SUBAGENT_TOOLS];
}

/** 轮次上限压到 [1, MAX_SUBAGENT_MAX_TURNS]：一个定义不该把子智能体设成无限轮次 */
function clampMaxTurns(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SUBAGENT_MAX_TURNS;
  return Math.min(Math.max(1, Math.floor(value)), MAX_SUBAGENT_MAX_TURNS);
}

/** `serviceId/modelId` 按**第一个** `/` 拆分；拆不开（缺斜杠或任一侧为空）视为未指定 */
function parseModelRef(raw: string): ModelRef | undefined {
  const slash = raw.indexOf("/");
  if (slash <= 0) return undefined;
  const serviceId = raw.slice(0, slash).trim();
  const modelId = raw.slice(slash + 1).trim();
  if (serviceId === "" || modelId === "") return undefined;
  return { serviceId, modelId };
}

/**
 * 解析一份子智能体定义 markdown。
 *
 * 只有「开头的 `---` … `---` 块」是 frontmatter，之后的一切都是正文 ——
 * 正文里出现的 `---` 不当分隔符，所以提示词可以随便写 markdown。
 *
 * `name` 是调用方给的名字（文件名的规范化结果）：文件里的 `name:` 键只作展示，
 * 与文件名冲突时**以文件名为准**，避免「文件名和 name 不一致」导致同一份定义两处漂移。
 */
export function parseSubagentMarkdown(
  name: string,
  raw: string,
):
  | { definition: SubagentDefinition; error?: undefined }
  | { definition?: undefined; error: string } {
  const lines = raw.split(/\r?\n/);
  let fields = new Map<string, FrontmatterValue>();
  let bodyStart = 0;
  if ((lines[0] ?? "").trim() === "---") {
    const closing = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
    if (closing === -1) return { error: "frontmatter 缺少结束的 ---" };
    fields = collectFrontmatter(lines.slice(1, closing));
    bodyStart = closing + 1;
  }

  const body = lines.slice(bodyStart).join("\n").trim();
  const description = singleLine(readString(fields, "description"));
  if (description === "") return { error: "description 不能为空（主模型靠它决定要不要委派）" };
  if (body === "") return { error: "正文（prompt）不能为空" };
  if (body.length > MAX_SUBAGENT_PROMPT_CHARS) {
    return { error: `正文过长（${body.length} 字符，上限 ${MAX_SUBAGENT_PROMPT_CHARS}）` };
  }

  // maxTurns：冒号后留空视为未填写；写了值就必须是正整数，写错要报出来而不是静默用默认值
  const rawMaxTurns = readString(fields, "maxturns");
  let maxTurns: number | undefined;
  if (rawMaxTurns !== "") {
    const parsed = Number(rawMaxTurns);
    if (!Number.isInteger(parsed) || parsed < 1) {
      return { error: `maxTurns 必须是正整数，收到「${rawMaxTurns}」` };
    }
    maxTurns = clampMaxTurns(parsed);
  }

  const rawThinking = readString(fields, "thinkinglevel");
  const thinkingLevel = THINKING_LEVELS.has(rawThinking)
    ? (rawThinking as ThinkingLevel)
    : undefined;
  const model = parseModelRef(readString(fields, "model"));

  return {
    definition: {
      name,
      description,
      prompt: body,
      tools: normalizeTools(asList(fields.get("tools"))),
      ...(model === undefined ? {} : { model }),
      ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
      ...(maxTurns === undefined ? {} : { maxTurns }),
      source: "user",
    },
  };
}

/**
 * 序列化成磁盘格式（parseSubagentMarkdown 的逆运算）。
 * 缺省的可选键直接省略，不写空值；`name` 始终写出（冗余一份方便人读，解析时仍以文件名为准）。
 */
export function serializeSubagentMarkdown(def: SubagentDefinition): string {
  const lines = [`name: ${def.name}`, `description: ${singleLine(def.description)}`];
  if (def.tools.length > 0) lines.push(`tools: [${def.tools.join(", ")}]`);
  if (def.model != null) lines.push(`model: ${def.model.serviceId}/${def.model.modelId}`);
  if (def.thinkingLevel !== undefined) lines.push(`thinkingLevel: ${def.thinkingLevel}`);
  if (def.maxTurns !== undefined) lines.push(`maxTurns: ${def.maxTurns}`);
  return `---\n${lines.join("\n")}\n---\n\n${def.prompt.trim()}\n`;
}

/** 用户定义的落盘路径：`${dataDir()}/subagents/<name>.md` */
export function subagentFilePath(name: string): string {
  // 名字是文件名的唯一来源：带 `/`、`..` 的名字会越出数据目录，必须在这里挡死
  if (!SUBAGENT_NAME_PATTERN.test(name)) throw new Error(`非法的子智能体名：${name}`);
  return `${dataDir()}/subagents/${name}.md`;
}

/** 把任意输入规范成合法名，不合法直接拒绝（不做「猜用户想写什么」的容错） */
function requireValidName(raw: string): string {
  const name = normalizeSubagentName(raw);
  if (!SUBAGENT_NAME_PATTERN.test(name)) throw new Error(`非法的子智能体名：${raw}`);
  return name;
}

/** 定义 + 设置 → 面板里的一行；enabled 由设置算出来，不落进 .md */
export function toSubagentInfo(def: SubagentDefinition, settings: Settings): SubagentInfo {
  return {
    name: def.name,
    description: def.description,
    tools: [...def.tools],
    model: def.model ?? null,
    thinkingLevel: def.thinkingLevel ?? null,
    maxTurns: def.maxTurns ?? DEFAULT_SUBAGENT_MAX_TURNS,
    source: def.source,
    enabled: settings.subagentsEnabled && !settings.disabledSubagentNames.includes(def.name),
    ...(def.filePath === undefined ? {} : { filePath: def.filePath }),
    promptPreview: singleLine(def.prompt).slice(0, PROMPT_PREVIEW_CHARS),
  };
}

/**
/**
 * 汇总全部子智能体定义：逐目录扫描 + 内置预设兜底 + 上限截断。
 *
 * 与 loadAgentResources 同一个姿态：**绝不抛错** —— 任何失败只记一条 diagnostic 并跳过，
 * 一个手改坏的 .md 不该让整份目录（连同内置预设）都看不见。
 *
 * `disabledSubagentNames` 在这里**不过滤**：面板需要显示「已禁用的定义」才能重新启用，
 * 是否启用由调用方拿 toSubagentInfo 现算。
 *
 * **没有 ExecutionEnv 参数**（技能那条路有）：定义目录是固定的两处，
 * 这里用普通的 fs 读取，不经过路径守卫 —— 让调用方为此白建一个沙箱环境，
 * 只会让人以为这份读取也受 allowedRoots 约束。
 */
export async function loadSubagentCatalog(
  cwd: string,
): Promise<{ definitions: SubagentDefinition[]; diagnostics: string[] }> {
  const diagnostics: string[] = [];
  const definitions: SubagentDefinition[] = [];
  const seen = new Set<string>();
  // 目录来源与顺序统一由 resources.ts 解析：数据目录 → 项目目录
  for (const dir of resolveSubagentDirs(cwd)) {
    let entries: Dirent[];
    try {
      entries = await readdir(dir.path, { withFileTypes: true });
    } catch (error) {
      // 目录还没建出来是最常见的情况（首次使用、项目里没放定义），不当成问题；
      // 其余失败（权限、同名文件占位）必须让用户看见，否则表现就是「定义莫名消失了」
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        diagnostics.push(`读取子智能体目录失败 ${dir.path}：${errorText(error)}`);
      }
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) continue;
      if (!entry.name.toLowerCase().endsWith(".md")) continue;
      const filePath = path.join(dir.path, entry.name);
      const name = normalizeSubagentName(entry.name);
      if (!SUBAGENT_NAME_PATTERN.test(name)) {
        diagnostics.push(`跳过子智能体定义 ${filePath}：文件名不符合命名规则`);
        continue;
      }
      // 同名「先出现者优先」：靠前目录（设置 → 数据目录 → 项目目录）里的定义胜出
      // 同名「先出现者优先」：靠前目录（数据目录 → 项目目录）里的定义胜出
      try {
        const parsed = parseSubagentMarkdown(name, await readFile(filePath, "utf8"));
        if (parsed.error !== undefined) {
          diagnostics.push(`解析子智能体定义失败 ${filePath}：${parsed.error}`);
          continue;
        }
        seen.add(name);
        definitions.push({ ...parsed.definition, filePath, source: "user" });
      } catch (error) {
        diagnostics.push(`读取子智能体定义失败 ${filePath}：${errorText(error)}`);
      }
    }
  }

  // 内置预设垫底：同名的用户定义已经进了 definitions，这里自然跳过（用户定义优先）
  for (const builtin of BUILTIN_SUBAGENTS) {
    if (seen.has(builtin.name)) continue;
    seen.add(builtin.name);
    definitions.push(builtin);
  }
  // 上限：含内置一起截断，并明确指出丢了多少 —— 静默截断会让用户以为文件坏了
  if (definitions.length > MAX_SUBAGENT_DEFINITIONS) {
    const dropped = definitions.length - MAX_SUBAGENT_DEFINITIONS;
    diagnostics.push(`子智能体定义过多，已丢弃 ${dropped} 个（上限 ${MAX_SUBAGENT_DEFINITIONS} 个）`);
    definitions.length = MAX_SUBAGENT_DEFINITIONS;
  }

  return { definitions, diagnostics };
}

/** 读取用户定义的原文（含 frontmatter）；文件不存在时抛错，由 IPC 层转成中文提示 */
export async function readUserSubagentFile(name: string): Promise<SubagentReadResult> {
  const normalized = requireValidName(name);
  const content = await readFile(subagentFilePath(normalized), "utf8");
  return { name: normalized, content };
}

/**
 * 新建 / 更新一个用户定义并返回落盘后的那一行。
 *
 * 重命名（originalName 与新名不同）时先写新文件再删旧文件：中途失败最多留下一份重复定义，
 * 而不是把用户的定义弄丢。删除失败（旧文件本来就不存在）不影响本次写入结果。
 */
export async function writeUserSubagentFile(request: SubagentWriteRequest): Promise<SubagentInfo> {
  const name = requireValidName(request.name);
  const description = singleLine(request.description);
  if (description === "") throw new Error("description 不能为空");
  const prompt = request.prompt.trim();
  if (prompt === "") throw new Error("系统提示（prompt）不能为空");
  if (prompt.length > MAX_SUBAGENT_PROMPT_CHARS) {
    throw new Error(`系统提示过长（${prompt.length} 字符，上限 ${MAX_SUBAGENT_PROMPT_CHARS}）`);
  }

  const filePath = subagentFilePath(name);
  const definition: SubagentDefinition = {
    name,
    description,
    prompt,
    tools: normalizeTools(request.tools),
    ...(request.model == null ? {} : { model: request.model }),
    ...(request.thinkingLevel == null ? {} : { thinkingLevel: request.thinkingLevel }),
    ...(request.maxTurns == null ? {} : { maxTurns: clampMaxTurns(request.maxTurns) }),
    source: "user",
    filePath,
  };

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, serializeSubagentMarkdown(definition), "utf8");

  const original =
    request.originalName === undefined ? undefined : normalizeSubagentName(request.originalName);
  if (original !== undefined && original !== name && SUBAGENT_NAME_PATTERN.test(original)) {
    await unlink(subagentFilePath(original)).catch(() => undefined);
  }

  // enabled 由设置算出（写文件不改设置），所以这里要在返回前把当前设置读进来
  return toSubagentInfo(definition, await loadSettings());
}

/** 删除一个用户定义；内置定义与不存在的文件都抛错（内部/上层据此给出明确提示） */
export async function removeUserSubagentFile(name: string): Promise<void> {
  const normalized = requireValidName(name);
  // 内置定义不在磁盘上：真删只会误删数据目录里的同名用户文件
  if (BUILTIN_SUBAGENTS.some((def) => def.name === normalized)) {
    throw new Error(`内置子智能体不可删除：${normalized}`);
  }
  try {
    await unlink(subagentFilePath(normalized));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`子智能体定义不存在：${normalized}`);
    }
    throw error;
  }
}
