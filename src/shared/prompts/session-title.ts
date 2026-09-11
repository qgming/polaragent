// 会话命名提示词：内置英文模板，主进程在自动命名时使用（没有用户自定义入口）。
// 素材通过 {{占位符}} 注入，其中最要紧的一条是「标题语言跟随用户消息语言」。
import { renderPrompt } from "./template";

/**
 * 命名补全的角色声明（system prompt）。
 * 中文：你是 Oint（一款桌面 Agent）里给会话起标题的人。
 */
export const SESSION_TITLE_SYSTEM_PROMPT =
  "You name conversation threads in Oint, a desktop agent.";

/**
 * 命名规则与素材。参考 PR 描述生成提示词的写法：
 * 先钉死输出形状，再逐条写规则，最后用占位符注入素材。
 *
 * 下面是英文模板逐条对应的中文说明（改模板时两处一起改）：
 *
 * 输出形状
 * · 只返回一个 JSON 对象，别的什么都不要：不要叙述、不要 JSON 之外的 markdown、不要解释、不要代码块围栏。
 * · 对象形状固定为 {"title": string}。
 *
 * 规则（与 Rules: 各条一一对应）
 * 1. title：一句短语，说明这段对话在讲什么，让用户以后能在列表里认出这条会话。
 * 2. 标题语言跟随下面那条用户消息：中文消息就写中文标题，英文消息就写英文标题；绝不把用户自己的说法翻译成另一种语言。
 * 3. 即使助手的回复是另一种语言（助手可能按应用界面语言作答），也由用户消息决定语言：
 *    判断语言时忽略回复的语言，只取它的内容。（这一条是第 2 条的兜底，防止模型被回复语言带偏。）
 * 4. 写具体对象：用户提到的文件、功能、命令、符号或报错（例如 "Fix login timeout"），
 *    不要写 "Code question"、"Help needed" 这类空泛标签。
 * 5. 用户自己的词汇与标识符（文件名、符号名、报错原文）能体现主题时照用。
 * 6. 描述任务本身，不要描述对话：不要出现 "User asks"，不要行首的短横线或项目符号，不要包裹引号，不要结尾句号。
 * 7. 保持简短：英文最多 8 个词；中文/日文/韩文最多 20 个字。
 * 8. 需求仍不明确时，写它涉及的范围，不要编造细节。
 * 9. JSON 字符串一律用双引号，换行转义成 \\n。
 * 10. 不要尾随逗号，不要注释。
 *
 * 素材（占位符）
 * · {{user_message}}：用户的第一条消息，同时也是标题语言的判定依据。
 * · {{assistant_reply}}：助手的回复，只提供内容。
 */
export const SESSION_TITLE_PROMPT = `Return exactly one JSON object and nothing else. Do not include prose, markdown outside JSON, explanations, or code fences.

The JSON object must have exactly this shape:
{"title": string}

Rules:
- title: one short phrase naming what this conversation is about, so the user can recognise the thread in a list later
- write the title in the same language as the user's message below: a Chinese message gets a Chinese title, an English message gets an English title; never translate the user's own wording into another language
- the user's message decides the language even when the assistant's reply is in another language (the assistant may answer in the app's UI language): ignore the reply's language when choosing, only take its content
- name the concrete object: the file, feature, command, symbol or error the user mentioned (for example "Fix login timeout"), never a generic label such as "Code question" or "Help needed"
- reuse the user's own vocabulary and identifiers (file names, symbol names, error strings) when they carry the topic
- describe the task, not the conversation: no "User asks", no leading dash or bullet, no surrounding quotes, no trailing period
- keep it short: at most 8 words, or at most 20 characters for Chinese, Japanese and Korean
- if the request is still unclear, name the area it touches instead of inventing details
- use double quotes for all JSON strings and escape newlines as \\n
- do not include trailing commas or comments

User's first message (this decides the title language):
{{user_message}}

Assistant's reply (content only):
{{assistant_reply}}`;

export interface SessionTitlePromptInput {
  /** 用户的第一条消息（决定标题语言） */
  userText: string;
  /** 助手对它的回复（只提供内容） */
  assistantText: string;
}

/** 组装命名提示词：把第一轮问答填进内置模板 */
export function buildSessionTitlePrompt(input: SessionTitlePromptInput): string {
  return renderPrompt(SESSION_TITLE_PROMPT, {
    user_message: input.userText,
    assistant_reply: input.assistantText,
  });
}
