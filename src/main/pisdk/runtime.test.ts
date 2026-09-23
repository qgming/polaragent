// runtime 单测：只覆盖不依赖真实 harness 的纯逻辑（系统提示、技能装配、规则模式、单例生命周期）。
// 真实 prompt 往返需要模型服务，留给端到端验收。
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validatePathAccess } from "@/main/security/path-guard";
import type { ToolCallPart } from "@/shared/contracts/session";
import type { Settings } from "@/shared/contracts/settings";
import { DEFAULT_WEB_SEARCH_SETTINGS } from "@/shared/contracts/web";
import { createApprovalService } from "./approvals";
import { createExecEnv } from "./exec-env";
import {
  abortStaleOperation,
  agentMessageText,
  applyToolEnd,
  buildSystemPrompt,
  createChatRuntime,
  deriveRulePattern,
  getChatRuntime,
  isLaneBusy,
  keptToolCallIds,
  loadAgentResources,
  needsModelWrite,
  type PendingEntry,
  pairEntryWithMessage,
  readLaneModelRef,
  sessionAllowedRoots,
} from "./runtime";
import type { SessionStore } from "./session-store";

// 资源目录解析依赖 dataDir()：固定成不存在的路径，避免测试读到开发机上真实的 ~/.oint/skills。
// 用 hoisted 容器接住，让 AGENTS.md 那组用例能把它指到自己的临时目录（其余用例不受影响）。
const paths = vi.hoisted(() => ({ data: "/data-oint-unused" }));
vi.mock("@/main/app/paths", () => ({ dataDir: () => paths.data }));

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    theme: "system",
    language: "zh-CN",
    density: "comfortable",
    chatFont: "",
    chatFontSize: 14,
    services: [],
    defaultModel: null,
    thinkingLevel: "medium",
    permissionMode: "default",
    agentMode: "standard",
    disabledSubagentNames: [],
    mcpServers: [],
    systemMcpServerEnabled: {},
    webSearch: DEFAULT_WEB_SEARCH_SETTINGS,
    disabledSkillNames: [],
    ...overrides,
  };
}

describe("buildSystemPrompt", () => {
  it("包含工作目录、工作方式与中文回复要求", async () => {
    const prompt = await buildSystemPrompt(makeSettings(), "D:\\workspace\\demo");
    expect(prompt).toContain("D:\\workspace\\demo");
    // 旧断言是「工作规则」；通用模式把它换成了「怎么工作」——
    // 新的一段讲的不是编程规则清单，而是「先判断这是什么任务」（见 agent-mode-prompt.ts）
    expect(prompt).toContain("怎么工作");
    expect(prompt).toContain("使用简体中文回复用户");
  });

  it("语言为 en-US 时要求英文回复", async () => {
    const prompt = await buildSystemPrompt(makeSettings({ language: "en-US" }), "/tmp/demo");
    expect(prompt).toContain("使用英文回复用户");
  });

  it("AGENTS.md 不可读时仍返回可用提示（不抛错）", async () => {
    await expect(buildSystemPrompt(makeSettings(), "/tmp/demo")).resolves.toBeTypeOf("string");
  });

  /**
   * 两层 AGENTS.md：数据目录的全局指令 + 工作目录的项目指令。
   *
   * 为什么要两层：全局那份是跨项目的长期偏好（「回答用中文」），项目那份是这个仓库的约定
   * （「用 pnpm」）。只有一层时用户得二选一 —— 要么污染所有项目，要么每个项目重复写。
   */
  describe("两层 AGENTS.md", () => {
    let globalDir: string;
    let projectDir: string;
    /** 原始值：这组用例会改 paths.data，**必须还原**，否则后面的用例会看见临时目录 */
    const ORIGINAL_DATA_DIR = "/data-oint-unused";

    beforeEach(async () => {
      globalDir = await mkdtemp(path.join(tmpdir(), "oint-agents-global-"));
      projectDir = await mkdtemp(path.join(tmpdir(), "oint-agents-project-"));
      paths.data = globalDir;
    });

    afterEach(() => {
      paths.data = ORIGINAL_DATA_DIR;
    });

    it("只有全局：注入全局段，不出现项目段", async () => {
      await writeFile(path.join(globalDir, "AGENTS.md"), "回答用中文", "utf8");

      const prompt = await buildSystemPrompt(makeSettings(), projectDir);

      expect(prompt).toContain("全局 AGENTS.md");
      expect(prompt).toContain("回答用中文");
      expect(prompt).not.toContain("项目指令（AGENTS.md）");
    });

    it("只有项目：注入项目段，不出现全局段", async () => {
      await writeFile(path.join(projectDir, "AGENTS.md"), "这个仓库用 pnpm", "utf8");

      const prompt = await buildSystemPrompt(makeSettings(), projectDir);

      expect(prompt).toContain("项目指令（AGENTS.md）");
      expect(prompt).toContain("这个仓库用 pnpm");
      expect(prompt).not.toContain("全局 AGENTS.md");
    });

    it("**两层都有时都注入**，且全局在前、项目在后", async () => {
      await writeFile(path.join(globalDir, "AGENTS.md"), "全局偏好：简洁", "utf8");
      await writeFile(path.join(projectDir, "AGENTS.md"), "项目约定：用 pnpm", "utf8");

      const prompt = await buildSystemPrompt(makeSettings(), projectDir);

      expect(prompt).toContain("全局偏好：简洁");
      expect(prompt).toContain("项目约定：用 pnpm");
      // 顺序是刻意的：项目级更贴近当前任务，放后面（越靠后的指令越新）
      expect(prompt.indexOf("全局偏好：简洁")).toBeLessThan(prompt.indexOf("项目约定：用 pnpm"));
    });

    it("两层指向同一个文件时只注入一次（OINT_HOME 被设成会话工作目录）", async () => {
      await writeFile(path.join(projectDir, "AGENTS.md"), "只有一份", "utf8");
      paths.data = projectDir; // 全局目录 == 工作目录

      const prompt = await buildSystemPrompt(makeSettings(), projectDir);

      expect(prompt).toContain("只有一份");
      // 出现两遍就是同一段指令被注入了两次
      expect(prompt.split("只有一份")).toHaveLength(2);
    });

    it("两层都不存在时不出现任何 AGENTS.md 段（也不留空标题）", async () => {
      const prompt = await buildSystemPrompt(makeSettings(), projectDir);

      expect(prompt).not.toContain("AGENTS.md");
    });

    it("只有空白的文件不注入（避免一个空标题）", async () => {
      await writeFile(path.join(globalDir, "AGENTS.md"), "   \n\n  ", "utf8");

      const prompt = await buildSystemPrompt(makeSettings(), projectDir);

      expect(prompt).not.toContain("全局 AGENTS.md");
    });
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

/** 在临时目录里造一个项目级技能（`<root>/.oint/skills/<name>/SKILL.md`），返回 root */
async function makeSkillFixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "oint-skill-"));
  const skillDir = path.join(root, ".oint", "skills", SKILL_NAME);
  await mkdir(skillDir, { recursive: true });
  await writeFile(path.join(skillDir, "SKILL.md"), SKILL_MD, "utf8");
  return root;
}

describe("loadAgentResources", () => {
  it("工作目录下的 .oint/skills 在 allowedRoots 内时能加载，并生成 <available_skills> 索引", async () => {
    const root = await makeSkillFixture();
    const env = await createExecEnv({ cwd: root, allowedRoots: [root] });
    const loaded = await loadAgentResources(env, makeSettings(), root);
    expect(loaded.skills.map((skill) => skill.name)).toContain(SKILL_NAME);
    expect(loaded.skillsSection).toContain("<available_skills>");
    expect(loaded.skillsSection).toContain(SKILL_NAME);
    // 索引里只有名称/描述/路径，不含正文 —— 正文由模型按需读取
    expect(loaded.skillsSection).not.toContain("# 夹具技能");
  });

  it("技能目录不在 allowedRoots 内时会被路径守卫拦掉，表现为 0 个技能", async () => {
    // 这条测试是「为什么 runtime.ts 必须把 cwd 与资源子目录加进 allowedRoots」的回归保护：
    // 守卫拒绝后内核只在 diagnostics 里报 list_failed，接口上看起来就是「这个技能不存在」
    const root = await makeSkillFixture();
    const elsewhere = path.join(root, "elsewhere");
    await mkdir(elsewhere, { recursive: true });
    const env = await createExecEnv({ cwd: elsewhere, allowedRoots: [elsewhere] });
    const loaded = await loadAgentResources(env, makeSettings(), root);
    expect(loaded.skills.map((skill) => skill.name)).not.toContain(SKILL_NAME);
  });

  it("disabledSkillNames 里的技能被过滤掉，也不进索引", async () => {
    const root = await makeSkillFixture();
    const env = await createExecEnv({ cwd: root, allowedRoots: [root] });
    const loaded = await loadAgentResources(
      env,
      makeSettings({ disabledSkillNames: [SKILL_NAME] }),
      root,
    );
    expect(loaded.skills.map((skill) => skill.name)).not.toContain(SKILL_NAME);
    expect(loaded.skillsSection).not.toContain(SKILL_NAME);
  });
});

describe("sessionAllowedRoots", () => {
  it("只放行数据目录下的资源子目录，不放行整个数据目录（settings.json 含 API Key）", () => {
    const roots = sessionAllowedRoots("D:\\work\\demo");
    // cwd 与 tmpdir 仍是必须的（技能/模板可能落在 cwd 下；spill 文件在 tmpdir）
    expect(roots).toContain("D:\\work\\demo");
    expect(roots).toContain(tmpdir());
    // 三个资源子目录必须在（技能 / 魔法提示 / 子智能体定义要经守卫读取）
    expect(roots).toContain(path.join("/data-oint-unused", "skills"));
    expect(roots).toContain(path.join("/data-oint-unused", "prompts"));
    expect(roots).toContain(path.join("/data-oint-unused", "subagents"));
    // 数据根自身**不得**出现：settings.json / permission-rules.json / sessions/ 都在那里
    expect(roots).not.toContain("/data-oint-unused");
  });

  it("凭据文件落在允许根之外：settings.json 与 permission-rules.json 都读不到", () => {
    // 用真实的路径守卫判定，而不是只看数组内容 —— 这一条钉住的是「守卫的结论」
    const roots = sessionAllowedRoots("D:\\work\\demo");
    for (const secret of ["settings.json", "permission-rules.json", "sessions-index.json"]) {
      const target = path.join("/data-oint-unused", secret);
      expect(validatePathAccess(target, roots).ok, `${secret} 不该在允许根内`).toBe(false);
    }
  });

  it("资源子目录之下的技能文件仍可读（收窄不能把技能一起挡掉）", () => {
    const roots = sessionAllowedRoots("D:\\work\\demo");
    const skill = path.join("/data-oint-unused", "skills", "demo", "SKILL.md");
    expect(validatePathAccess(skill, roots).ok).toBe(true);
  });
});

describe("keptToolCallIds（一轮结束时哪些 toolCall 必须保留）", () => {
  it("仍在跑的作业必须保留：它的结论要等进程退出才回填", () => {
    const keep = keptToolCallIds({
      jobs: [{ status: "running", toolCallId: "call-a" }],
      subagentRuns: [],
    });
    expect([...keep]).toEqual(["call-a"]);
  });

  it("已终态的作业可以回收（结论已经回写完了）", () => {
    for (const status of ["exited", "failed", "killed"]) {
      const keep = keptToolCallIds({
        jobs: [{ status, toolCallId: "call-a" }],
        subagentRuns: [],
      });
      expect(keep.size, `${status} 的作业不该占着 toolCall`).toBe(0);
    }
  });

  it("未终结的子智能体委派必须保留，终态的可以回收", () => {
    const keep = keptToolCallIds({
      jobs: [],
      subagentRuns: [
        { status: "running", delegationId: "call-run" },
        { status: "completed", delegationId: "call-done" },
        { status: "interrupted", delegationId: "call-interrupted" },
        { status: "aborted", delegationId: "call-aborted" },
      ],
    });
    expect([...keep]).toEqual(["call-run"]);
  });

  it("没有 toolCallId 的作业（历史作业）不影响结果", () => {
    const keep = keptToolCallIds({
      jobs: [{ status: "running", toolCallId: undefined }],
      subagentRuns: [],
    });
    expect(keep.size).toBe(0);
  });

  it("作业与委派同时存在时取并集", () => {
    const keep = keptToolCallIds({
      jobs: [{ status: "running", toolCallId: "call-job" }],
      subagentRuns: [{ status: "running", delegationId: "call-task" }],
    });
    expect([...keep].sort()).toEqual(["call-job", "call-task"]);
  });
});

describe("deriveRulePattern", () => {
  it("bash 取命令首词", () => {
    expect(deriveRulePattern("bash", { command: "  git   status  " })).toBe("git");
    expect(deriveRulePattern("bash", {})).toBeUndefined();
  });

  /**
   * 解释器 / 包管理器**不派生规则**。
   *
   * 批准一次 `npm run build` 若记成「允许 npm」，连带放行的是
   * `npm install evil-pkg` / `npm publish` / `npm config set ...:_authToken`；
   * `node -e "..."` 更是任意执行。派生不出窄模式就不写规则 ——
   * 代价是下次再点一次卡，而不是把 shell 永久交出去。
   */
  it("解释器与包管理器首词不派生规则（否则等于永久放行任意执行）", () => {
    for (const command of [
      "npm run build",
      "node scripts/build.js",
      "npx some-tool",
      "pnpm install",
      "python -c 'x'",
      "bash -c 'x'",
      "powershell -enc AAAA",
      "go run .",
    ]) {
      expect(deriveRulePattern("bash", { command }), command).toBeUndefined();
    }
    // 非解释器的命令照常派生
    expect(deriveRulePattern("bash", { command: "git status" })).toBe("git");
    expect(deriveRulePattern("bash", { command: "ls -la" })).toBe("ls");
  });

  /**
   * write/edit 只对**相对路径**派生首段。
   *
   * 绝对路径的首段是 `Users` / `home` / `dev` 这种盘符下第一层 ——
   * 把它当授权范围等于放行整个用户目录（`C:\Users\me\.ssh\authorized_keys` 也会命中）。
   */
  it("write/edit 只对相对路径取首段；绝对路径不派生", () => {
    expect(deriveRulePattern("write", { path: "src/foo.ts" })).toBe("src");
    expect(deriveRulePattern("edit", { path: "./src/a.ts" })).toBe("src");
    expect(deriveRulePattern("write", {})).toBeUndefined();
    // 绝对路径：首段没有授权意义，宁可每次都问
    expect(deriveRulePattern("edit", { path: "D:\\dev\\oint\\a.ts" })).toBeUndefined();
    expect(deriveRulePattern("write", { path: "/home/u/a.ts" })).toBeUndefined();
    expect(
      deriveRulePattern("write", { path: "C:/Users/me/.ssh/authorized_keys" }),
    ).toBeUndefined();
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

/**
 * 取文函数的回归测试。
 *
 * 为什么值得单独钉：它是报告链上**唯一**没人测的一环。harness 的 message_end 走到这里，
 * 结果再进 subagent-runner 记成 `run.report` —— 而 runner 的测试是手工把文本喂进
 * noteSubagentAssistantMessage 的，所以「喂进去的文本从哪来」这段一直没人管。
 * 历史上这里对助手消息常数式返回空串，于是所有子智能体的报告恒为空，
 * 而轮次、工具计数、状态全都正常：TaskWait 显示「已完成 · 4 轮」，报告栏却是空的。
 */
describe("agentMessageText", () => {
  it("助手消息的文本块能取到（子智能体报告走的就是这条路）", () => {
    expect(
      agentMessageText({
        role: "assistant",
        content: [
          { type: "text", text: "MAX_CONCURRENT_SUBAGENT_RUNS = 4，" },
          { type: "text", text: "见 src/shared/contracts/subagent.ts:63" },
        ],
      } as never),
    ).toBe("MAX_CONCURRENT_SUBAGENT_RUNS = 4，见 src/shared/contracts/subagent.ts:63");
  });

  it("用户消息同样能取到（排队消息那条路没被这次修改影响）", () => {
    expect(agentMessageText({ role: "user", content: "你好" } as never)).toBe("你好");
  });

  it("只有非文本块时返回空串：别把思考/工具块当正文", () => {
    expect(
      agentMessageText({
        role: "assistant",
        content: [{ type: "thinking", thinking: "内部推理" }],
      } as never),
    ).toBe("");
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
  /**
   * 假 lane：`inspectExecution` 报告当前压着什么操作（null = 没有），abort 记调用次数。
   *
   * 两个都要：判定「是不是遗留操作」靠 inspectExecution，收敛靠 abort ——
   * 只看 abort 的次数测不出「压缩期间不该被清掉」这条新口径。
   */
  function fakeLane(
    outcome: { ok: true } | { ok: false; error: unknown } | Error,
    current: { kind: "run" | "compaction" | "navigation" } | null = null,
  ) {
    let calls = 0;
    const lane = {
      inspectExecution: async () => ({
        lane: "main",
        tipId: null,
        current:
          current === null
            ? null
            : { id: "op1", kind: current.kind, startedAt: 0, status: "running" as const },
      }),
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

  /**
   * 本函数被调用的场景是「prompt 被 LaneBusy 拒了 → 清掉遗留再重试」。
   * 而 LaneBusy 也会由**正在跑的压缩/导航**触发：那时 abort 会把用户刚发起的
   * `/compact` 直接杀掉，所以必须只收敛 run 类残留。
   */
  it("lane 上压着压缩时不 abort（否则一次发送会杀掉正在跑的压缩）", async () => {
    const { lane, calls } = fakeLane({ ok: true }, { kind: "compaction" });
    await expect(abortStaleOperation(lane, "s1")).resolves.toBe(false);
    expect(calls()).toBe(0);
  });

  it("lane 上压着导航时同样不 abort", async () => {
    const { lane, calls } = fakeLane({ ok: true }, { kind: "navigation" });
    await expect(abortStaleOperation(lane, "s1")).resolves.toBe(false);
    expect(calls()).toBe(0);
  });

  it("压着的确实是遗留的 run 时照常收敛", async () => {
    const { lane, calls } = fakeLane({ ok: true }, { kind: "run" });
    await expect(abortStaleOperation(lane, "s1")).resolves.toBe(true);
    expect(calls()).toBe(1);
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

  describe("readLaneModelRef / needsModelWrite（模型是否要写回 lane）", () => {
    it("lane 里解析得出模型时取出它的坐标", async () => {
      const lane = {
        getModel: async () => ({ id: "m2", provider: "svc-b" }),
      } as unknown as Parameters<typeof readLaneModelRef>[0];
      await expect(readLaneModelRef(lane)).resolves.toEqual({
        serviceId: "svc-b",
        modelId: "m2",
      });
    });

    it("lane 里解析不出模型（存储的是已删除的服务）→ null", async () => {
      const lane = {
        getModel: async () => undefined,
      } as unknown as Parameters<typeof readLaneModelRef>[0];
      await expect(readLaneModelRef(lane)).resolves.toBeNull();
    });

    it("与期望一致时不写（避免每条消息都落一次配置更新）", () => {
      expect(
        needsModelWrite(
          { serviceId: "svc-a", modelId: "m1" },
          { serviceId: "svc-a", modelId: "m1" },
        ),
      ).toBe(false);
    });

    it("引用不同、或 lane 里读不出模型时必须写", () => {
      expect(
        needsModelWrite(
          { serviceId: "svc-a", modelId: "m1" },
          { serviceId: "svc-a", modelId: "m2" },
        ),
      ).toBe(true);
      expect(
        needsModelWrite(
          { serviceId: "svc-a", modelId: "m1" },
          { serviceId: "svc-b", modelId: "m1" },
        ),
      ).toBe(true);
      // null = lane 里的模型已不可解析：不写的话之后每次运行都会 model_unavailable
      expect(needsModelWrite(null, { serviceId: "svc-a", modelId: "m1" })).toBe(true);
    });
  });
});
