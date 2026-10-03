// runtime 单测：只覆盖不依赖真实 harness 的纯逻辑（系统提示、技能装配、规则模式、单例生命周期）。
// 真实 prompt 往返需要模型服务，留给端到端验收。
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validatePathAccess } from "@/main/security/path-guard";
import type { Settings } from "@/shared/contracts/settings";
import { DEFAULT_WEB_SEARCH_SETTINGS } from "@/shared/contracts/web";
import { createApprovalService } from "./approvals";
import { createExecEnv } from "./exec-env";
import {
  agentMessageText,
  buildSystemPrompt,
  createChatRuntime,
  deriveRulePattern,
  getChatRuntime,
  loadAgentResources,
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
    expect(prompt).toContain("默认直接完成任务");
    expect(prompt).toContain("set_work_contract");
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
