// 会话自动命名：首轮问答结束后，用默认路由模型把对话内容概括成标题。
// 与 ai-approver 同构：一次性纯文本补全 + 任何异常都返回 null（保留默认会话名，不影响主流程）。

import type { MutableModels } from "@earendil-works/pi-ai";
import type { ChatMessage, Settings } from "@/shared/contracts";
import {
  buildSessionTitlePrompt,
  SESSION_TITLE_SYSTEM_PROMPT,
} from "@/shared/prompts/session-title";
import { buildProviders, resolveModel } from "./providers";

export interface SessionTitleInput {
  /** 用户的第一条需求 */
  userText: string;
  /** 助手对它的回复 */
  assistantText: string;
}

/** 生成器可选的副作用钩子：真的要去调模型前通知调用方 */
export interface SessionTitleHooks {
  /** 模型可用、即将发起补全时调用；调用方据此记下「本次进程已试过」 */
  onAttempt?: () => void;
}

/** 返回 null 表示放弃本次命名（无模型、超时、输出不可用…），调用方保留原标题 */
export type SessionTitleGenerator = (
  input: SessionTitleInput,
  hooks?: SessionTitleHooks,
) => Promise<string | null>;

/** 命名补全的超时时间（毫秒），超时视为放弃 */
const TIMEOUT_MS = 15_000;
/**
 * 输出上限：标题很短，但默认路由模型可能是思考型模型，
 * 上限太紧会只吐推理、没有标题，所以留出余量。
 */
const MAX_TOKENS = 128;
/** 送给模型的两段正文各自的截断长度 */
const MAX_USER_CHARS = 2_000;
const MAX_ASSISTANT_CHARS = 2_000;
/** 标题长度上限：按字符数（不是 UTF-16 码元）计，超出即截断 */
const MAX_TITLE_CHARS = 40;
/** 完整匹配的代码块围栏（含语言标记），整段内容优先取围栏内部 */
const FENCED_BLOCK = /^\s*```[^\n]*\n([\s\S]*?)```\s*$/;
/** 输出里的第一个 JSON 对象：优先按它取 title（提示词已要求只输出 JSON） */
const JSON_OBJECT = /\{[\s\S]*\}/;

/** 从 JSON 输出里取 title；不是合法 JSON 或没有 title 时返回 null，交给文本启发式兜底 */
function titleFromJson(raw: string): string | null {
  const match = JSON_OBJECT.exec(raw);
  if (!match) return null;
  try {
    const parsed: unknown = JSON.parse(match[0]);
    if (typeof parsed !== "object" || parsed === null) return null;
    const value = (parsed as { title?: unknown }).title;
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
  } catch {
    return null;
  }
}

/** 读消息里的可见文字（工具调用、图片都不算命名素材） */
function textOf(message: ChatMessage): string {
  return message.parts
    .filter((part): part is Extract<ChatMessage["parts"][number], { type: "text" }> => {
      return part.type === "text";
    })
    .map((part) => part.text)
    .join("")
    .trim();
}

/**
 * 从消息列表里挑命名素材：第一条有文字的**用户**消息 + 其后第一条有文字的**助手**消息。
 * 一次运行会先落用户条目再落助手条目，只按顺序取会拿错角色，因此按角色各找第一条。
 */
export function collectTitleSource(messages: readonly ChatMessage[]): SessionTitleInput | null {
  const userIndex = messages.findIndex(
    (message) => message.role === "user" && textOf(message) !== "",
  );
  if (userIndex < 0) return null;
  const assistant = messages
    .slice(userIndex + 1)
    .find((message) => message.role === "assistant" && textOf(message) !== "");
  if (assistant === undefined) return null;
  return {
    userText: textOf(messages[userIndex] as ChatMessage),
    assistantText: textOf(assistant),
  };
}

/**
 * 把模型输出整理成能直接当标题用的字符串：
 * 先剥掉代码块围栏与 JSON 外壳，再去掉「标题：」这类前缀、包裹引号、Markdown 记号与结尾标点，
 * 最后按字符数截断。整理后为空则返回 null（不覆盖默认会话名）。
 */
export function normalizeSessionTitle(raw: string): string | null {
  const text = stripWrappers(raw);
  if (text === null) return null;
  const chars = Array.from(text);
  return chars.length > MAX_TITLE_CHARS ? chars.slice(0, MAX_TITLE_CHARS).join("") : text;
}

/** 去壳与去噪；无可读内容时返回 null */
function stripWrappers(raw: string): string | null {
  let text = raw.trim();
  if (text === "") return null;

  // 提示词要求只输出 JSON：优先解 JSON（能正确处理转义引号），失败才走下面的文本启发式
  const fromJson = titleFromJson(text);
  if (fromJson !== null) text = fromJson;

  // 代码块围栏：模型偶尔会照格式习惯包一层
  const fenced = FENCED_BLOCK.exec(text);
  if (fenced?.[1] !== undefined) text = fenced[1].trim();

  if (text === "") return null;
  // 只要第一行：模型偶尔会附一行解释
  text = (text.split(/\r?\n/).find((line) => line.trim() !== "") ?? "").trim();
  // 单行残留的围栏（``` 或 ```json）不是标题
  if (/^```/.test(text) || /^```/.test(text.replace(/[`\s]/g, ""))) return null;
  // 前缀：「标题：」「Title:」之类
  text = text.replace(/^(标题|题目|title)\s*[:：]\s*/i, "").trim();
  // 对称包裹的引号/书名号/括号才成对剥掉，避免把 "Fix crash (Node 20)" 的右括号当装饰
  text = stripPairedWrapper(text, /^(["'“”‘’《》「」【】[(（])/, /(["'“”‘’《》「」【】\])）])$/);
  // Markdown 强调与标题记号
  text = text
    .replace(/^[#*\->\s]+/, "")
    .replace(/[*_`]+$/, "")
    .trim();
  // 结尾句号/顿号在标题里是噪音
  text = text.replace(/[。.、,，]+$/, "").trim();
  return text === "" ? null : text;
}

/** 首尾是同一类装饰符时才成对去掉（引号、方括号、书名号…） */
function stripPairedWrapper(text: string, leading: RegExp, trailing: RegExp): string {
  const pairs: ReadonlyArray<readonly [string, string]> = [
    ['"', '"'],
    ["'", "'"],
    ["“", "”"],
    ["‘", "’"],
    ["《", "》"],
    ["「", "」"],
    ["【", "】"],
    ["[", "]"],
    ["(", ")"],
    ["（", "）"],
  ];
  for (const [open, close] of pairs) {
    if (text.startsWith(open) && text.endsWith(close) && text.length > open.length + close.length) {
      return text.slice(open.length, text.length - close.length).trim();
    }
  }
  // 只在一端出现的装饰符仍按旧口径清掉（模型常在标题两侧各加一个引号）
  return text.replace(leading, "").replace(trailing, "").trim();
}

/** 按码点截断（避免切在代理对中间，留下半个 emoji） */
function truncate(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : text;
}

/** 自动命名所需的外部能力：抽出来便于直接单测「什么时候该命名」 */
export interface AutoTitleDeps {
  generate: SessionTitleGenerator;
  readTitle: (sessionId: string) => Promise<string | null>;
  loadMessages: (sessionId: string) => Promise<readonly ChatMessage[]>;
  rename: (sessionId: string, title: string) => Promise<void>;
  /** 真正要调模型前的记账回调（素材不足时不调用，留给下一轮） */
  onAttempt?: () => void;
}

/**
 * 按需为一个会话命名：没有名字时才生成并落盘，返回最终标题（null = 本次不命名）。
 *
 * 标题本身就是「已命名」的标记，所以用户手动改过名、或分支会话带着来源标题时都不会覆盖。
 * 生成期间用户可能刚手动改过名，因此落盘前再确认一次；写完后也回读索引确认真的生效，
 * 避免 UI 显示一个没落盘的名字。
 */
export async function autoTitleSession(
  sessionId: string,
  deps: AutoTitleDeps,
): Promise<string | null> {
  if ((await deps.readTitle(sessionId)) !== null) return null;
  const source = collectTitleSource(await deps.loadMessages(sessionId));
  if (!source) return null;

  const title = await deps.generate(source, { onAttempt: deps.onAttempt });
  if (title === null) return null;
  // 生成期间（最长 15s）用户可能手动改了名：这时不该覆盖
  if ((await deps.readTitle(sessionId)) !== null) return null;

  await deps.rename(sessionId, title);
  return (await deps.readTitle(sessionId)) === title ? title : null;
}

/**
 * 基于 pi-ai 一次性补全的命名器：
 * 模型固定取默认路由模型（settings.defaultModel），提示词是内置英文模板（buildSessionTitlePrompt）。
 */
export function createSessionTitleGenerator(deps: {
  getSettings: () => Promise<Settings>;
  /** 每次调用时构造 models（设置可能变化）；复用 providers.ts 的实现 */
  buildModels?: (settings: Settings) => MutableModels;
}): SessionTitleGenerator {
  const buildModels = deps.buildModels ?? ((settings: Settings) => buildProviders(settings).models);

  return async (input, hooks) => {
    let settings: Settings;
    try {
      settings = await deps.getSettings();
    } catch (error) {
      console.warn(`读取设置失败，跳过会话命名：${String(error)}`);
      return null;
    }

    const model = resolveModel(settings, settings.defaultModel);
    // 没有可用模型时不算「试过」：用户配好默认模型后，下一轮仍能补上标题
    if (!model) return null;
    hooks?.onAttempt?.();

    try {
      const message = await buildModels(settings).completeSimple(
        model,
        {
          systemPrompt: SESSION_TITLE_SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: buildSessionTitlePrompt({
                userText: truncate(input.userText, MAX_USER_CHARS),
                assistantText: truncate(input.assistantText, MAX_ASSISTANT_CHARS),
              }),
              timestamp: Date.now(),
            },
          ],
        },
        { maxTokens: MAX_TOKENS, signal: AbortSignal.timeout(TIMEOUT_MS) },
      );
      const text = message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
      return normalizeSessionTitle(text);
    } catch (error) {
      console.warn(`会话命名失败，保留默认名称：${String(error)}`);
      return null;
    }
  };
}
