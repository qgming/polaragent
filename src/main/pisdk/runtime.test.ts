// runtime 单测：只覆盖不依赖真实 harness 的纯逻辑（系统提示、技能装配、规则模式、单例生命周期）。
// 真实 prompt 往返需要模型服务，留给端到端验收。
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ToolCallPart } from "@/shared/contracts/session";
import type { Settings } from "@/shared/contracts/settings";
import { createApprovalService } from "./approvals";
import { createExecEnv } from "./exec-env";
import {
  abortStaleOperation,
  applyToolEnd,
  buildSystemPrompt,
  createChatRuntime,
  deriveRulePattern,
  getChatRuntime,
  isLaneBusy,
  loadAgentResources,
  type PendingEntry,
  pairEntryWithMessage,
} from "./runtime";
import type { SessionStore } from "./session-store";

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    theme: "system",
    language: "zh-CN",
    density: "comfortable",
    chatFont: "",
    chatFontSize: 14,
    defaultWorkingDir: null,
    services: [],
    defaultModel: null,
    thinkingLevel: "medium",
    permissionMode: "default",
    skillDirs: [],
    skillsEnabled: true,
    promptTemplateDirs: [],
    disabledSkillNames: [],
    ...overrides,
  };
}

describe("buildSystemPrompt", () => {
  it("包含工作目录、工作规则与中文回复要求", async () => {
    const prompt = await buildSystemPrompt(makeSettings(), "D:\\workspace\\demo");
    expect(prompt).toContain("D:\\workspace\\demo");
    expect(prompt).toContain("工作规则");
    expect(prompt).toContain("使用简体中文回复用户");
  });

  it("语言为 en-US 时要求英文回复", async () => {
    const prompt = await buildSystemPrompt(makeSettings({ language: "en-US" }), "/tmp/demo");
    expect(prompt).toContain("使用英文回复用户");
  });

  it("AGENTS.md 不可读时仍返回可用提示（不抛错）", async () => {
    await expect(buildSystemPrompt(makeSettings(), "/tmp/demo")).resolves.toBeTypeOf("string");
  });

  it("传入技能索引时拼进系统提示", async () => {
    const section =
      "<available_skills>\n  <skill>\n    <name>demo-skill</name>\n  </skill>\n</available_skills>";
    const prompt = await buildSystemPrompt(makeSettings(), "/tmp/demo", section);
    expect(prompt).toContain("<available_skills>");
    expect(prompt).toContain("demo-skill");
  });

  it("无技能时不出现技能段（禁用全部技能或关闭注入时不该污染提示）", async () => {
    expect(await buildSystemPrompt(makeSettings(), "/tmp/demo")).not.toContain(
      "<available_skills>",
    );
    expect(await buildSystemPrompt(makeSettings(), "/tmp/demo", "")).not.toContain(
      "<available_skills>",
    );
  });

  it("包含工具使用指导，且指导里点名了自建工具", async () => {
    const prompt = await buildSystemPrompt(makeSettings(), "/tmp/demo");
    expect(prompt).toContain("工具使用：");
    expect(prompt).toContain("grep / glob");
    expect(prompt).toContain("todo");
  });
});

/** 夹具技能：名称必须是小写字母/数字/连字符，且与所在目录同名（内核校验规则） */
const SKILL_NAME = "oint-runtime-test-skill";
const SKILL_MD = [
  "---",
  `name: ${SKILL_NAME}`,
  "description: 仅用于 runtime 单测的夹具技能",
  "---",
  "",
  "# 夹具技能",
  "",
].join("\n");

/** 在临时目录里造一个技能目录，返回 { root, skillDir } */
async function makeSkillFixture(): Promise<{ root: string; skillDir: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "oint-skill-"));
  const skillDir = path.join(root, "skills");
  await mkdir(path.join(skillDir, SKILL_NAME), { recursive: true });
  await writeFile(path.join(skillDir, SKILL_NAME, "SKILL.md"), SKILL_MD, "utf8");
  return { root, skillDir };
}

describe("loadAgentResources", () => {
  it("skillsEnabled 为 false 时完全跳过加载", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "oint-skill-off-"));
    const env = await createExecEnv({ cwd: root, allowedRoots: [root] });
    const loaded = await loadAgentResources(env, makeSettings({ skillsEnabled: false }), root);
    expect(loaded.skills).toEqual([]);
    expect(loaded.promptTemplates).toEqual([]);
    expect(loaded.skillsSection).toBe("");
  });

  it("技能目录在 allowedRoots 内时能加载，并生成 <available_skills> 索引", async () => {
    const { root, skillDir } = await makeSkillFixture();
    const env = await createExecEnv({ cwd: root, allowedRoots: [root, skillDir] });
    const loaded = await loadAgentResources(env, makeSettings({ skillDirs: [skillDir] }), root);
    expect(loaded.skills.map((skill) => skill.name)).toContain(SKILL_NAME);
    expect(loaded.skillsSection).toContain("<available_skills>");
    expect(loaded.skillsSection).toContain(SKILL_NAME);
    // 索引里只有名称/描述/路径，不含正文 —— 正文由模型按需读取
    expect(loaded.skillsSection).not.toContain("# 夹具技能");
  });

  it("技能目录不在 allowedRoots 内时会被路径守卫拦掉，表现为 0 个技能", async () => {
    // 这条测试是「为什么 runtime.ts 必须把 skillDirs 加进 allowedRoots」的回归保护：
    // 守卫拒绝后内核只在 diagnostics 里报 list_failed，接口上看起来就是「这个技能不存在」
    const { root, skillDir } = await makeSkillFixture();
    const elsewhere = path.join(root, "elsewhere");
    await mkdir(elsewhere, { recursive: true });
    const env = await createExecEnv({ cwd: elsewhere, allowedRoots: [elsewhere] });
    const loaded = await loadAgentResources(env, makeSettings({ skillDirs: [skillDir] }), root);
    expect(loaded.skills.map((skill) => skill.name)).not.toContain(SKILL_NAME);
  });

  it("disabledSkillNames 里的技能被过滤掉，也不进索引", async () => {
    const { root, skillDir } = await makeSkillFixture();
    const env = await createExecEnv({ cwd: root, allowedRoots: [root, skillDir] });
    const loaded = await loadAgentResources(
      env,
      makeSettings({ skillDirs: [skillDir], disabledSkillNames: [SKILL_NAME] }),
      root,
    );
    expect(loaded.skills.map((skill) => skill.name)).not.toContain(SKILL_NAME);
    expect(loaded.skillsSection).not.toContain(SKILL_NAME);
  });
});

describe("deriveRulePattern", () => {
  it("bash 取命令首词", () => {
    expect(deriveRulePattern("bash", { command: "  git   status  " })).toBe("git");
    expect(deriveRulePattern("bash", {})).toBeUndefined();
  });

  it("write/edit 取路径首段并跳过盘符", () => {
    expect(deriveRulePattern("write", { path: "src/foo.ts" })).toBe("src");
    expect(deriveRulePattern("edit", { path: "D:\\dev\\oint\\a.ts" })).toBe("dev");
    expect(deriveRulePattern("write", {})).toBeUndefined();
  });
});

describe("pairEntryWithMessage", () => {
  const assistantEntry = (id: string, parentId: string | null = "u1") => ({
    type: "message",
    id,
    parentId,
    message: { role: "assistant" },
  });
  const userEntry = (id: string, parentId: string | null = null) => ({
    type: "message",
    id,
    parentId,
    message: { role: "user" },
  });
  const assistant = (messageId: string) => ({ messageId, role: "assistant" as const });
  const user = (messageId: string) => ({ messageId, role: "user" as const });

  it("同一角色内部按 FIFO 配对，多轮工具调用不会错配", () => {
    const pending = [assistant("m1"), assistant("m2")];

    expect(pairEntryWithMessage(pending, assistantEntry("e1"))).toEqual({
      messageId: "m1",
      patch: { entryId: "e1", parentId: "u1" },
    });
    expect(pairEntryWithMessage(pending, assistantEntry("e2"))).toEqual({
      messageId: "m2",
      patch: { entryId: "e2", parentId: "u1" },
    });
    expect(pending).toEqual([]);
  });

  // 回归：队列原来只存 id、弹队首，于是先落的用户条目把助手消息挤出去，
  // 助手条目反认领了用户消息 —— 用户消息永远没 entryId（分支按钮不出现），
  // 且重新生成拿到的是助手条目（= 当前 tip），报 "target must differ from the current tip"
  it("按角色配对：助手条目不会认领用户消息", () => {
    const pending = [user("u-msg"), assistant("a-msg")];

    expect(pairEntryWithMessage(pending, userEntry("u-entry"))).toEqual({
      messageId: "u-msg",
      patch: { entryId: "u-entry", parentId: null },
    });
    expect(pairEntryWithMessage(pending, assistantEntry("a-entry", "u-entry"))).toEqual({
      messageId: "a-msg",
      patch: { entryId: "a-entry", parentId: "u-entry" },
    });
    expect(pending).toEqual([]);
  });

  it("toolResult / compaction 之类的条目不吃掉队列位置", () => {
    const pending = [assistant("m1")];
    const toolResult = {
      type: "message",
      id: "e0b",
      parentId: "u1",
      message: { role: "toolResult" },
    };
    const compaction = { type: "compaction", id: "c1", parentId: "u1" };

    expect(pairEntryWithMessage(pending, toolResult)).toBeNull();
    expect(pairEntryWithMessage(pending, compaction)).toBeNull();
    // 队列原封不动，助手条目仍配到它身上
    expect(pending).toEqual([assistant("m1")]);
    expect(pairEntryWithMessage(pending, assistantEntry("e1"))?.messageId).toBe("m1");
  });

  it("没有同角色待配项时返回 null 且不动队列", () => {
    const pending = [assistant("m1")];
    expect(pairEntryWithMessage(pending, userEntry("u-entry"))).toBeNull();
    expect(pending).toEqual([assistant("m1")]);

    const empty: PendingEntry[] = [];
    expect(pairEntryWithMessage(empty, assistantEntry("e1"))).toBeNull();
  });

  it("parentId 为 null（会话首条）也照常带出", () => {
    const pending = [assistant("m1")];
    expect(pairEntryWithMessage(pending, assistantEntry("e1", null))?.patch).toEqual({
      entryId: "e1",
      parentId: null,
    });
  });
});

describe("applyToolEnd", () => {
  /** 流式路径上被写入的那份 part；只填 applyToolEnd 会碰的字段 */
  function makePart(): ToolCallPart {
    return {
      type: "tool-call",
      toolCallId: "call-1",
      toolName: "edit",
      argsText: "{}",
      status: "running",
    };
  }

  it("文本结果与结构化详情并存，状态随 isError", () => {
    const details = { patch: "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-旧\n+新\n" };
    const part = makePart();
    applyToolEnd(
      part,
      { content: [{ type: "text", text: "Successfully replaced 1 block(s)" }], details },
      false,
    );

    expect(part.result).toBe("Successfully replaced 1 block(s)");
    // 关键：details 不因为文本存在而丢失（渲染层的 diff 面板全靠它）
    expect(part.details).toEqual(details);
    expect(part.isError).toBe(false);
    expect(part.status).toBe("done");
  });

  it("工具无 details 时不写入该字段", () => {
    const part = makePart();
    // 真实工具可以不带 details（pi 的类型标为必填，运行时却常见缺省），显式给 undefined
    applyToolEnd(part, { content: [{ type: "text", text: "内容" }], details: undefined }, false);

    expect(part.result).toBe("内容");
    expect(Object.hasOwn(part, "details")).toBe(false);
  });

  it("失败时状态为 error 并保留 isError", () => {
    const part = makePart();
    applyToolEnd(part, { content: [{ type: "text", text: "命令失败" }], details: undefined }, true);

    expect(part.status).toBe("error");
    expect(part.isError).toBe(true);
  });

  it("无文本时退回 details 作为结果（两者都不丢）", () => {
    const details = { truncation: { truncated: true } };
    const part = makePart();
    applyToolEnd(part, { content: [], details }, false);

    expect(part.result).toEqual(details);
    expect(part.details).toEqual(details);
  });
});

describe("getChatRuntime", () => {
  it("createChatRuntime 注册默认单例，dispose 后复用会报错", async () => {
    const settings = makeSettings();
    const runtime = createChatRuntime({
      getSettings: async () => settings,
      sessionStore: {} as unknown as SessionStore,
      emit: () => undefined,
      approvals: createApprovalService({
        getSettings: async () => settings,
        emit: () => undefined,
      }),
      resolveWorkingDir: async () => process.cwd(),
    });

    expect(getChatRuntime()).toBe(runtime);
    expect(runtime.isRunning("missing")).toBe(false);

    await runtime.dispose();
    expect(() => getChatRuntime()).toThrow("聊天运行时尚未初始化");
  });
});

/**
 * 遗留活跃操作：上一次进程在运行中被关掉后，lane 里会留着「当前操作 id」，
 * 之后任何 prompt 都会被 pi 以 LaneBusy 拒收 —— 这里只覆盖我们自己的判断与收敛动作，
 * 真 lane 需要模型与存储，留给端到端验收。
 */
describe("遗留操作清理", () => {
  /** 只用到 abort 的假 lane */
  function fakeLane(outcome: { ok: true } | { ok: false; error: unknown } | Error) {
    let calls = 0;
    const lane = {
      abort: async () => {
        calls += 1;
        if (outcome instanceof Error) throw outcome;
        return outcome.ok ? { ok: true, value: {} } : { ok: false, error: outcome.error };
      },
    };
    return {
      lane: lane as unknown as Parameters<typeof abortStaleOperation>[0],
      calls: () => calls,
    };
  }

  it("abort 收敛成功即视为清理完成", async () => {
    const { lane, calls } = fakeLane({ ok: true });
    await expect(abortStaleOperation(lane, "s1")).resolves.toBe(true);
    expect(calls()).toBe(1);
  });

  it("没有活跃操作（abort 返回错误）时不视为清理完成", async () => {
    const { lane } = fakeLane({
      ok: false,
      error: { _tag: "NoActiveOperation", message: "no active operation" },
    });
    await expect(abortStaleOperation(lane, "s1")).resolves.toBe(false);
  });

  it("abort 抛异常时吞掉异常并返回 false（关闭流程不该被它带崩）", async () => {
    const { lane } = fakeLane(new Error("存储写入失败"));
    await expect(abortStaleOperation(lane, "s1")).resolves.toBe(false);
  });
});

describe("isLaneBusy", () => {
  it("按 _tag 识别 pi 的 LaneBusy", () => {
    expect(
      isLaneBusy({ _tag: "LaneBusy", message: 'Lane "main" already has an active operation' }),
    ).toBe(true);
  });

  it("其它错误与非法值都不误判", () => {
    // 注意：LaneBusy 是带 tag 的普通对象，不是 Error 子类 —— 文案里出现 LaneBusy 的 Error 不算
    expect(isLaneBusy(new Error('Lane "main" already has an active operation'))).toBe(false);
    expect(isLaneBusy({ _tag: "InvalidMessage" })).toBe(false);
    expect(isLaneBusy(null)).toBe(false);
    expect(isLaneBusy("LaneBusy")).toBe(false);
  });
});
