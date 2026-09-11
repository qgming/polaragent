// 会话命名提示词：内置英文模板，主进程在自动命名时使用（没有用户自定义入口）。
// 素材通过 {{占位符}} 注入，其中最要紧的一条是「标题语言跟随用户消息语言」。
import { renderPrompt } from "./template";

/** 命名补全的角色声明（system prompt） */
export const SESSION_TITLE_SYSTEM_PROMPT =
  "You name conversation threads in PolarAgent, a desktop agent.";

/**
 * 命名规则与素材。参考 PR 描述生成提示词的写法：
 * 先钉死输出形状，再逐条写规则，最后用占位符注入素材。
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
  userText: string;
  assistantText: string;
}

/** 组装命名提示词：把第一轮问答填进内置模板 */
export function buildSessionTitlePrompt(
  input: SessionTitlePromptInput,
): string {
  return renderPrompt(SESSION_TITLE_PROMPT, {
    user_message: input.userText,
    assistant_reply: input.assistantText,
  });
}
