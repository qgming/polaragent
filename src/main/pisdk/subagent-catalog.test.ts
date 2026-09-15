/**
 * 子智能体定义目录的测试。
 *
 * 这个文件钉住的是「磁盘格式 → 定义 → 面板行」这条链上的约定：解析器与序列化必须互为逆运算
 * （否则面板保存一次就会悄悄改掉用户的定义），目录合并的优先级与上限必须可见
 * （否则用户只会看到「我写的定义不见了」却不知道原因）。
 *
 * dataDir() 被 mock 到临时目录：真实实现要往数据目录写 .md，测试必须能真的落盘再读回来。
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "@/shared/contracts/settings";
import type { SubagentDefinition } from "@/shared/contracts/subagent";

// mock 工厂先于 import 执行：用 hoisted 容器接住 dataDir，让每个用例指向自己的临时目录，
// 避免用例之间互相看见对方写的定义（文件系统是全局状态）
const paths = vi.hoisted(() => ({ data: "" }));
vi.mock("@/main/app/paths", () => ({ dataDir: () => paths.data }));

import {
  DEFAULT_SUBAGENT_TOOLS,
  MAX_SUBAGENT_DEFINITIONS,
  MAX_SUBAGENT_PROMPT_CHARS,
} from "@/shared/contracts/subagent";
import {
  BUILTIN_SUBAGENTS,
  loadSubagentCatalog,
  parseSubagentMarkdown,
  removeUserSubagentFile,
  serializeSubagentMarkdown,
  subagentFilePath,
  toSubagentInfo,
  writeUserSubagentFile,
} from "./subagent-catalog";

const BASE_SETTINGS: Settings = {
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
  disabledSkillNames: [],
  skillsEnabled: true,
  promptTemplateDirs: [],
  subagentsEnabled: true,
  disabledSubagentNames: [],
  mcpServers: [],
};

function settingsWith(patch: Partial<Settings> = {}): Settings {
  return { ...BASE_SETTINGS, ...patch };
}

let root: string;
/** 会话工作目录：项目级定义固定落在 `${cwd}/.pi/subagents` */
let cwd: string;

/** 数据目录下的全局定义目录 */
function globalDir(): string {
  return path.join(root, "subagents");
}

function projectDir(): string {
  return path.join(cwd, ".pi", "subagents");
}

/** 一份最小可解析的定义文件（frontmatter + 正文） */
function markdown(description: string, body = "正文", extra = ""): string {
  return `---\ndescription: ${description}\n${extra}---\n\n${body}\n`;
}

async function writeDefinition(dir: string, fileName: string, content: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, fileName), content, "utf8");
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "oint-subagents-"));
  paths.data = root;
  cwd = path.join(root, "project");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("内置预设", () => {
  it("四个预设的名字、工具与轮次上限与契约一致", () => {
    expect(BUILTIN_SUBAGENTS.map((def) => def.name)).toEqual([
      "explorer",
      "code-reviewer",
      "fixer",
      "test-runner",
    ]);
    expect(BUILTIN_SUBAGENTS.every((def) => def.source === "builtin")).toBe(true);
    // explorer / code-reviewer 只读；fixer 可写；test-runner 能跑命令但不能改文件
    expect(BUILTIN_SUBAGENTS.map((def) => def.tools)).toEqual([
      ["read", "grep", "glob"],
      ["read", "grep", "glob"],
      ["read", "grep", "glob", "edit", "write", "bash"],
      ["read", "grep", "glob", "bash"],
    ]);
    expect(BUILTIN_SUBAGENTS.map((def) => def.maxTurns)).toEqual([30, 30, 60, 30]);
    // 提示词是「子智能体的全部行为说明」：空提示词等于一个只会瞎猜的子智能体
    for (const def of BUILTIN_SUBAGENTS) {
      expect(def.prompt.length).toBeGreaterThan(0);
      expect(def.prompt.length).toBeLessThanOrEqual(MAX_SUBAGENT_PROMPT_CHARS);
      expect(def.description).not.toContain("\n");
    }
  });
});

describe("parseSubagentMarkdown / serializeSubagentMarkdown", () => {
  it("序列化与解析互为逆运算（含全部可选键）", () => {
    const def: SubagentDefinition = {
      name: "my-agent",
      description: "做一件事",
      prompt: "你是子智能体。\n\n汇报要求：给文件与行号。",
      tools: ["read", "bash"],
      model: { serviceId: "svc-a", modelId: "model-x" },
      thinkingLevel: "high",
      maxTurns: 42,
      source: "user",
    };

    const parsed = parseSubagentMarkdown(def.name, serializeSubagentMarkdown(def));

    expect(parsed.error).toBeUndefined();
    expect(parsed.definition).toEqual(def);
  });

  it("序列化省略缺省的可选键，格式固定", () => {
    const text = serializeSubagentMarkdown({
      name: "x",
      description: "只有必填项",
      prompt: "正文",
      tools: ["read"],
      source: "user",
    });

    // 锁定磁盘格式：键顺序固定、空值不写，`name` 始终写出（冗余一份方便人读）
    expect(text).toBe("---\nname: x\ndescription: 只有必填项\ntools: [read]\n---\n\n正文\n");
  });

  it("tools 支持内联列表与 - item 行两种写法", () => {
    const inline = parseSubagentMarkdown(
      "a",
      "---\ndescription: d\ntools: [read, grep]\n---\nbody",
    );
    expect(inline.definition?.tools).toEqual(["read", "grep"]);

    const block = parseSubagentMarkdown(
      "a",
      "---\ndescription: d\ntools:\n  - read\n  - grep\n---\nbody",
    );
    expect(block.definition?.tools).toEqual(["read", "grep"]);
  });

  it("未知工具名被过滤；过滤后为空则回落到默认只读三件套", () => {
    const mixed = parseSubagentMarkdown(
      "a",
      "---\ndescription: d\ntools: [read, teleport]\n---\nbody",
    );
    expect(mixed.definition?.tools).toEqual(["read"]);

    const unknown = parseSubagentMarkdown("a", "---\ndescription: d\ntools: [teleport]\n---\nbody");
    expect(unknown.definition?.tools).toEqual([...DEFAULT_SUBAGENT_TOOLS]);
  });

  it("description 或正文为空时拒绝解析", () => {
    // 没写 description：主模型没有任何挑选依据，必须报出来而不是给个空描述
    const noDescription = parseSubagentMarkdown("a", "---\ntools: [read]\n---\nbody");
    expect(noDescription.definition).toBeUndefined();
    expect(noDescription.error).toContain("description");

    // 没有 frontmatter 的裸文件同样按「description 为空」拒绝
    expect(parseSubagentMarkdown("a", "只有正文").error).toContain("description");

    const noBody = parseSubagentMarkdown("a", "---\ndescription: d\n---\n\n");
    expect(noBody.definition).toBeUndefined();
    expect(noBody.error).toBeDefined();
  });

  it("maxTurns 不是正整数时拒绝；写成 max_turns 也认", () => {
    expect(
      parseSubagentMarkdown("a", "---\ndescription: d\nmaxTurns: 很多\n---\nbody").error,
    ).toContain("maxTurns");
    expect(
      parseSubagentMarkdown("a", "---\ndescription: d\nmaxTurns: 0\n---\nbody").error,
    ).toContain("maxTurns");
    expect(
      parseSubagentMarkdown("a", "---\ndescription: d\nmaxTurns: 2.5\n---\nbody").error,
    ).toContain("maxTurns");

    // 键名大小写与下划线不敏感：max_turns / thinking_level 都要认
    const parsed = parseSubagentMarkdown(
      "a",
      "---\ndescription: d\nmax_turns: 12\nthinking_level: high\n---\nbody",
    );
    expect(parsed.definition?.maxTurns).toBe(12);
    expect(parsed.definition?.thinkingLevel).toBe("high");
  });

  it("model 按第一个 / 拆分；拆不开时视为未指定", () => {
    const parsed = parseSubagentMarkdown(
      "a",
      "---\ndescription: d\nmodel: openrouter/deep/model\n---\nbody",
    );
    expect(parsed.definition?.model).toEqual({
      serviceId: "openrouter",
      modelId: "deep/model",
    });

    const broken = parseSubagentMarkdown("a", "---\ndescription: d\nmodel: 只有一段\n---\nbody");
    expect(broken.definition?.model).toBeUndefined();
  });

  it("正文里的 --- 不当 frontmatter 结束符（提示词可以随便写 markdown）", () => {
    const body = "第一段\n\n---\n\n第二段";
    const parsed = parseSubagentMarkdown("a", `---\ndescription: d\n---\n\n${body}\n`);
    expect(parsed.definition?.prompt).toBe(body);
  });
});

describe("loadSubagentCatalog", () => {
  it("文件名规范成子智能体名（My_Agent.md → my-agent）", async () => {
    await writeDefinition(globalDir(), "My_Agent.md", markdown("用户定义"));

    const { definitions, diagnostics } = await loadSubagentCatalog(cwd);

    expect(diagnostics).toEqual([]);
    const mine = definitions.find((def) => def.name === "my-agent");
    expect(mine?.description).toBe("用户定义");
    expect(mine?.source).toBe("user");
    expect(mine?.filePath).toBe(path.join(globalDir(), "My_Agent.md"));
  });

  it("同名时用户定义优先于内置预设（否则用户覆盖不掉内置行为）", async () => {
    await writeDefinition(globalDir(), "explorer.md", markdown("用户自定义的探索者"));

    const { definitions } = await loadSubagentCatalog(cwd);

    const explorers = definitions.filter((def) => def.name === "explorer");
    expect(explorers).toHaveLength(1);
    expect(explorers[0]?.source).toBe("user");
    expect(explorers[0]?.description).toBe("用户自定义的探索者");
    // 四个内置全在：被覆盖的那个不重复出现
    expect(definitions).toHaveLength(BUILTIN_SUBAGENTS.length);
  });

  it("项目目录（会话目录下的 .pi/subagents）的定义会被扫描到；与数据目录同名时数据目录优先", async () => {
    await writeDefinition(projectDir(), "project-only.md", markdown("来自项目目录"));
    await writeDefinition(globalDir(), "shared.md", markdown("来自数据目录"));
    await writeDefinition(projectDir(), "shared.md", markdown("来自项目目录"));

    const { definitions } = await loadSubagentCatalog(cwd);

    // 项目目录是现在仅有的两个来源之一：放在里面的定义必须能被发现
    expect(definitions.find((def) => def.name === "project-only")?.description).toBe(
      "来自项目目录",
    );
    // 数据目录排在项目目录之前：同名定义以数据目录那份为准
    expect(definitions.find((def) => def.name === "shared")?.description).toBe("来自数据目录");
  });

  it("坏定义只记诊断并跳过，内置预设照常返回", async () => {
    // 解析失败（缺 description）+ 文件名不规范：两者都该被看见，但不能让整份目录消失
    await writeDefinition(globalDir(), "broken.md", "---\ntools: [read]\n---\nbody\n");
    await writeDefinition(globalDir(), "日本語.md", markdown("名字不合法"));

    const { definitions, diagnostics } = await loadSubagentCatalog(cwd);

    expect(definitions.map((def) => def.name)).toEqual(BUILTIN_SUBAGENTS.map((def) => def.name));
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics.join("\n")).toContain("broken.md");
    expect(diagnostics.join("\n")).toContain("日本語.md");
  });

  it("目录不存在不算诊断（首次使用是正常状态）", async () => {
    const { definitions, diagnostics } = await loadSubagentCatalog(cwd);

    expect(diagnostics).toEqual([]);
    expect(definitions).toHaveLength(BUILTIN_SUBAGENTS.length);
  });

  it("合并后超过上限时截断，并给出一条诊断说明丢弃了多少", async () => {
    for (let index = 0; index < MAX_SUBAGENT_DEFINITIONS; index += 1) {
      await writeDefinition(globalDir(), `agent-${index}.md`, markdown(`定义 ${index}`));
    }

    const { definitions, diagnostics } = await loadSubagentCatalog(cwd);

    // 16 个用户定义已占满上限，4 个内置预设被丢弃
    expect(definitions).toHaveLength(MAX_SUBAGENT_DEFINITIONS);
    expect(definitions.every((def) => def.source === "user")).toBe(true);
    const capDiagnostic = diagnostics.filter((line) => line.includes("丢弃"));
    expect(capDiagnostic).toHaveLength(1);
    expect(capDiagnostic[0]).toContain("4");
  });
});

describe("toSubagentInfo", () => {
  const def: SubagentDefinition = {
    name: "explorer",
    description: "d",
    prompt: `第一行\n${"很长".repeat(120)}`,
    tools: ["read"],
    source: "builtin",
  };

  it("enabled 同时受总开关与禁用名单控制", () => {
    expect(toSubagentInfo(def, settingsWith()).enabled).toBe(true);
    expect(toSubagentInfo(def, settingsWith({ disabledSubagentNames: ["explorer"] })).enabled).toBe(
      false,
    );
    expect(toSubagentInfo(def, settingsWith({ subagentsEnabled: false })).enabled).toBe(false);
    // 名单里是别的名字不影响本定义（禁用表是共用的一份）
    expect(toSubagentInfo(def, settingsWith({ disabledSubagentNames: ["other"] })).enabled).toBe(
      true,
    );
  });

  it("maxTurns 缺省回落默认值，promptPreview 折叠成单行并截断", () => {
    const info = toSubagentInfo(def, settingsWith());

    expect(info.maxTurns).toBe(30);
    expect(info.model).toBeNull();
    expect(info.thinkingLevel).toBeNull();
    expect(info.filePath).toBeUndefined();
    expect(info.promptPreview).not.toContain("\n");
    expect(info.promptPreview.startsWith("第一行 很长")).toBe(true);
    expect(info.promptPreview.length).toBe(160);
  });
});

describe("用户定义的落盘", () => {
  it("写盘后能被目录扫描读回来（重命名会带走旧文件）", async () => {
    const info = await writeUserSubagentFile({
      name: "My_Agent",
      description: "写盘测试",
      prompt: "你是子智能体。",
      tools: ["read", "teleport"],
      model: { serviceId: "svc-a", modelId: "m1" },
      thinkingLevel: "low",
      maxTurns: 12,
    });

    expect(info.name).toBe("my-agent");
    expect(info.tools).toEqual(["read"]);
    expect(info.enabled).toBe(true);

    const parsed = parseSubagentMarkdown(
      "my-agent",
      await readFile(subagentFilePath("my-agent"), "utf8"),
    );
    expect(parsed.definition).toMatchObject({
      name: "my-agent",
      description: "写盘测试",
      tools: ["read"],
      model: { serviceId: "svc-a", modelId: "m1" },
      thinkingLevel: "low",
      maxTurns: 12,
    });

    // 重命名：新名字写成功，旧文件不能留下（否则目录里会出现两份同样的定义）
    await writeUserSubagentFile({
      originalName: "my-agent",
      name: "renamed",
      description: "改名后",
      prompt: "你是子智能体。",
      tools: ["read"],
      model: null,
      thinkingLevel: null,
      maxTurns: null,
    });
    await expect(readFile(subagentFilePath("my-agent"), "utf8")).rejects.toThrow();
    await expect(readFile(subagentFilePath("renamed"), "utf8")).resolves.toContain("改名后");
  });

  it("名字先规范化再落盘：路径穿不进文件名，规范化后仍非法则拒绝", async () => {
    // `../escape` 会被规范成 basename「escape」—— 名字只当文件名用，走不出 subagents 目录
    const info = await writeUserSubagentFile({
      name: "../escape",
      description: "d",
      prompt: "p",
      tools: [],
      model: null,
      thinkingLevel: null,
      maxTurns: null,
    });
    expect(info.name).toBe("escape");
    expect(info.filePath).toBe(subagentFilePath("escape"));
    await expect(readFile(subagentFilePath("escape"), "utf8")).resolves.toContain("description: d");

    // 规范化后仍然不合法的名字（非 ASCII）直接拒绝，绝不落到磁盘上
    await expect(
      writeUserSubagentFile({
        name: "日本語",
        description: "d",
        prompt: "p",
        tools: [],
        model: null,
        thinkingLevel: null,
        maxTurns: null,
      }),
    ).rejects.toThrow("非法的子智能体名");
  });

  it("删除只对用户定义生效：内置与不存在的名字都抛错", async () => {
    await expect(removeUserSubagentFile("explorer")).rejects.toThrow("内置");
    await expect(removeUserSubagentFile("never-written")).rejects.toThrow("不存在");

    await writeDefinition(globalDir(), "gone.md", markdown("待删除"));
    await removeUserSubagentFile("gone");
    await expect(readFile(subagentFilePath("gone"), "utf8")).rejects.toThrow();
  });
});
