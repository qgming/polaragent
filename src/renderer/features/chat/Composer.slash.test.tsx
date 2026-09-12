/**
 * Composer 的斜杠菜单集成测试（ui project / jsdom）。
 *
 * 挂的是**真的** Composer + 真的 AssistantRuntimeProvider + 真的两个 store（settings / chat），
 * 只把 window.oint 这个进程边界换掉。验的是行为不是外观：
 * 每按一个键，输入框里最终留下什么、菜单在不在、`/name args` 会不会被展开。
 *
 * 为什么用 fireEvent.change 而不是 userEvent：库的输入框是受控 textarea，这里只需要把值灌进去；
 * 逐键模拟对 state 的更新时序没有任何额外信息量，反而让断言变脆。
 */

import { AssistantRuntimeProvider, useExternalStoreRuntime } from "@assistant-ui/react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/renderer/i18n";
import { toThreadMessage } from "@/renderer/runtime/message-converter";
import { useChatStore } from "@/renderer/stores/chat-store";
import { useSettingsStore } from "@/renderer/stores/settings-store";
import type { PromptTemplateInfo } from "@/shared/contracts/prompts";
import type { ChatMessage, SessionSummary } from "@/shared/contracts/session";
import type { Settings } from "@/shared/contracts/settings";
import type { SkillInfo } from "@/shared/contracts/skills";
import { Composer } from "./Composer";
import { buildSlashCommands, expandSlashInput } from "./slash-commands";

// vitest 未开 globals，RTL 的自动清理不会注册，必须手动
afterEach(cleanup);

beforeAll(async () => {
  await i18n.changeLanguage("zh-CN");
});

const SESSION: SessionSummary = {
  id: "s1",
  title: "会话",
  createdAt: 0,
  updatedAt: 0,
  cwd: "D:\\proj",
  archived: false,
  pinned: false,
  messageCount: 0,
  model: null,
};

const SKILLS: SkillInfo[] = [
  {
    name: "review",
    description: "看一遍改动",
    filePath: "D:\\proj\\.pi\\skills\\review\\SKILL.md",
    source: "project",
    disabled: false,
  },
];

const TEMPLATES: PromptTemplateInfo[] = [
  {
    name: "translate",
    description: "翻译 $1",
    content: "把下面这段翻译成 $1：\n\n$ARGUMENTS",
    source: "project",
    dir: "D:\\proj\\.pi\\prompts",
  },
];

/** runtime 的 messages 入参：稳定空数组，免得每次渲染给新引用把 runtime 推进循环 */
const EMPTY_MESSAGES: ChatMessage[] = [];

/** 只补 Composer 这条链真的会调到的两个方法，其余不假装；IPC 调用记下来供断言 */
function stubBridge() {
  const listSkills = vi.fn(async () => SKILLS);
  const listPrompts = vi.fn(async () => TEMPLATES);
  vi.stubGlobal("oint", {
    skills: { list: listSkills },
    prompts: { list: listPrompts },
  });
  return { listSkills, listPrompts };
}

/** 把 store 灌成「有一个带工作目录的活跃会话」；settings 用最小可用形状 */
function seedStores() {
  useChatStore.setState({
    sessions: [SESSION],
    activeSessionId: SESSION.id,
    messagesBySession: {},
    loadedSessions: {},
    runningBySession: {},
    queueBySession: {},
  });
  useSettingsStore.setState({
    settings: {
      permissionMode: "default",
      thinkingLevel: "medium",
      defaultModel: null,
      services: [],
      defaultWorkingDir: null,
      theme: "light",
    } as unknown as Settings,
    loaded: true,
  });
}

/**
 * 应用里 Composer 的位置：runtime provider 之下。
 * onNew 走的是与 OintRuntimeProvider 同一条路径（发送前展开斜杠命令），
 * 并把最终文本交给 onSend —— 断言展开结果就看它。
 */
function Harness({ onSend }: { onSend: (text: string) => void }) {
  const runtime = useExternalStoreRuntime<ChatMessage>({
    messages: EMPTY_MESSAGES,
    isRunning: false,
    convertMessage: toThreadMessage,
    onNew: async (message) => {
      const text = message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
      const [skills, templates] = await Promise.all([
        window.oint.skills.list(SESSION.cwd),
        window.oint.prompts.list(SESSION.cwd),
      ]);
      onSend(expandSlashInput(text, buildSlashCommands(skills, templates)));
    },
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Composer />
    </AssistantRuntimeProvider>
  );
}

/** 输入框本体（库渲染成 textarea，且带 combobox 角色） */
function composerInput(): HTMLTextAreaElement {
  const input = screen.getByRole("combobox");
  if (!(input instanceof HTMLTextAreaElement)) throw new Error("输入框不是 textarea");
  return input;
}

/** 把输入框的值设成 value，并等菜单按它重算（菜单状态是从 composer 文本派生的） */
async function type(value: string): Promise<HTMLTextAreaElement> {
  const input = composerInput();
  fireEvent.change(input, { target: { value } });
  await waitFor(() => expect(input.value).toBe(value));
  return input;
}

describe("Composer 的斜杠菜单", () => {
  beforeEach(() => {
    stubBridge();
    seedStores();
  });

  it("敲 / 打开菜单：技能与提示模板分两栏，各带名称与描述", async () => {
    render(<Harness onSend={() => {}} />);
    await type("/");

    expect(await screen.findByRole("listbox", { name: "切换斜杠命令" })).toBeTruthy();
    expect(screen.getByText("技能")).toBeTruthy();
    expect(screen.getByText("提示模板")).toBeTruthy();
    expect(screen.getByText("/review")).toBeTruthy();
    expect(screen.getByText("看一遍改动")).toBeTruthy();
    expect(screen.getByText("/translate")).toBeTruthy();
  });

  it("清单按当前查询词收窄", async () => {
    render(<Harness onSend={() => {}} />);
    await type("/tr");

    await screen.findByText("/translate");
    expect(screen.queryByText("/review")).toBeNull();
  });

  it("没有匹配项时给出空态文案", async () => {
    render(<Harness onSend={() => {}} />);
    await type("/zzz");

    expect(await screen.findByText("没有匹配的技能或模板")).toBeTruthy();
  });

  it("普通输入不打开菜单", async () => {
    render(<Harness onSend={() => {}} />);
    await type("你好");

    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("参数已经开始（协议名后跟空格）就收起菜单：/usr/bin/env 是普通消息", async () => {
    render(<Harness onSend={() => {}} />);
    await type("/usr/bin/env node");

    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("清单按当前会话的 cwd 取（不是设置里的默认目录）", async () => {
    const { listSkills, listPrompts } = stubBridge();
    render(<Harness onSend={() => {}} />);
    await type("/");
    await screen.findByText("/review");

    expect(listSkills).toHaveBeenCalledWith(SESSION.cwd);
    expect(listPrompts).toHaveBeenCalledWith(SESSION.cwd);
  });

  it("↑↓ 在一栏内移动高亮，不含技能与模板的边界", async () => {
    render(<Harness onSend={() => {}} />);
    const input = await type("/");
    await screen.findByText("/review");

    // 初始高亮第一条（技能栏的 /review）
    expect(screen.getByRole("option", { selected: true }).textContent).toContain("/review");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    await waitFor(() =>
      expect(screen.getByRole("option", { selected: true }).textContent).toContain("/translate"),
    );

    // 到底再往下绕回第一条
    fireEvent.keyDown(input, { key: "ArrowDown" });
    await waitFor(() =>
      expect(screen.getByRole("option", { selected: true }).textContent).toContain("/review"),
    );

    fireEvent.keyDown(input, { key: "ArrowUp" });
    await waitFor(() =>
      expect(screen.getByRole("option", { selected: true }).textContent).toContain("/translate"),
    );
  });

  it("Enter 选中高亮行：技能补成 /名称 加空格，菜单收起，且没有发送", async () => {
    const onSend = vi.fn();
    render(<Harness onSend={onSend} />);
    const input = await type("/re");
    await screen.findByText("/review");

    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(input.value).toBe("/review "));
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onSend).not.toHaveBeenCalled();
  });

  it("Escape 只收起菜单，输入框里的文本留着", async () => {
    render(<Harness onSend={() => {}} />);
    const input = await type("/re");
    await screen.findByText("/review");

    fireEvent.keyDown(input, { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    expect(input.value).toBe("/re");
  });
  it("对已经打完的命令再按 Enter 是发送，并且模板会被展开", async () => {
    const onSend = vi.fn();
    render(<Harness onSend={onSend} />);
    // 第二个参数带引号：内核用 shell 风格拆参数，引号里的空格不拆
    const input = await type('/translate 日语 "你好 世界"');

    // 名称后面已经带了参数 → 菜单早已收起
    expect(screen.queryByRole("listbox")).toBeNull();

    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    // $1 ← 第一个参数；$ARGUMENTS ← 全部参数（含第一个）空格连接
    expect(onSend).toHaveBeenCalledWith("把下面这段翻译成 日语：\n\n日语 你好 世界");
  });

  it("不是命令的斜杠开头消息原样发送（不吞用户输入）", async () => {
    const onSend = vi.fn();
    render(<Harness onSend={onSend} />);
    const input = await type("/usr/bin/env node");

    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(onSend).toHaveBeenCalledWith("/usr/bin/env node"));
  });
});
