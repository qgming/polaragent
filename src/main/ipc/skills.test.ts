import path from "node:path";
import type { ExecutionEnv, Skill } from "@earendil-works/pi-agent-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SkillInfo } from "@/shared/contracts/skills";

type ListHandler = (event: unknown, request?: { workingDir?: string }) => Promise<SkillInfo[]>;

/** 内置技能目录挂在它下面：`<APP_PATH>/resources/skills` */
const APP_PATH = "/app";

// vi.mock 工厂会先于 import 执行，用 hoisted 容器接住 registerSkillsIpc 注册的 handler
const registered = vi.hoisted(() => ({ handlers: new Map<string, ListHandler>() }));

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, listener: ListHandler) => {
      registered.handlers.set(channel, listener);
    },
  },
  // 内置技能目录由 app.getAppPath() 定位（ipc/skills.ts 用它区分来源）
  app: { getAppPath: () => APP_PATH },
}));

// 目录解析依赖 dataDir()，固定成可断言的路径；设置存储与 exec env 整体 mock，
// 本测试只覆盖「目录顺序 → 扫描结果 → 合并/标记」的纯逻辑，不碰文件系统。
vi.mock("@/main/app/paths", () => ({ dataDir: () => "/data-oint" }));

/**
 * 家目录也固定：跨工具共享技能目录是 `~/.agents/skills`（`agentsSkillsDir`）。
 * 用真实 `homedir()` 的话，断言的值会取决于跑测试的机器上有没有那份技能。
 */
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => "/home-test" };
});

vi.mock("@/main/settings/store", () => ({ loadSettings: vi.fn() }));
vi.mock("@/main/pisdk/exec-env", () => ({ createExecEnv: vi.fn() }));
vi.mock("@earendil-works/pi-agent-core", () => ({
  BACKGROUND_CONTEXT: {},
  loadSkills: vi.fn(),
}));

/**
 * 只替换 `readFile`。
 *
 * `skills:read` 会真的读那一份 SKILL.md，而本测试里的路径都是假路径（必然 ENOENT）。
 * `rm` / `mkdir` 保持真实：remove 的用例断言的是**在碰到磁盘之前**就被拒绝，
 * 用真实实现反而更硬 —— 真要是拒绝了却没走到的分支被漏掉，测试会自己去删文件而报错。
 */
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(async () => "---\nname: x\n---\n正文") };
});

import { readFile } from "node:fs/promises";
import { loadSkills } from "@earendil-works/pi-agent-core";
import { createExecEnv } from "@/main/pisdk/exec-env";
import { agentsSkillsDir, resolveBuiltinSkillDir } from "@/main/pisdk/resources";
import { loadSettings } from "@/main/settings/store";
import { IPC } from "@/shared/contracts/ipc";
import type { Settings } from "@/shared/contracts/settings";
import { registerSkillsIpc } from "./skills";

/** 内置技能目录的实际字符串（分隔符由平台决定，测试不要手写） */
const BUILTIN_DIR = resolveBuiltinSkillDir(APP_PATH);

/** 跨工具共享技能目录（同上，不要手写） */
const SHARED_DIR = agentsSkillsDir();

/** 每个目录返回的技能；key 是目录路径 */
const skillsByDir = new Map<string, Skill[]>();

/** 构造 loadSkills 的最小返回值 */
function skill(name: string, dir: string): Skill {
  return {
    name,
    description: `${name} 的说明`,
    content: "正文",
    filePath: `${dir}/${name}/SKILL.md`,
  };
}

/** handler 只读 disabledSkillNames，测试里不必凑整份 Settings */
function settingsWithDisabled(names: string[]): Settings {
  return { disabledSkillNames: names } as Settings;
}

/** 取回注册好的 skills:list handler（去掉 IPC event 参数） */
function listSkills(request?: { workingDir?: string }): Promise<SkillInfo[]> {
  const handler = registered.handlers.get(IPC.skills.list);
  if (!handler) throw new Error("skills:list handler 未注册");
  return handler({}, request);
}

/** 取回任意一个注册过的 handler —— read / remove 与 list 走同一条注册路径 */
function callHandler<T>(channel: string, request: unknown): Promise<T> {
  const handler = registered.handlers.get(channel) as unknown as
    | ((event: unknown, request: unknown) => Promise<T>)
    | undefined;
  if (!handler) throw new Error(`${channel} handler 未注册`);
  return handler({}, request);
}

beforeEach(() => {
  vi.clearAllMocks();
  registered.handlers.clear();
  skillsByDir.clear();
  vi.mocked(loadSkills).mockImplementation(async (_env, dirs) => {
    const dir = Array.isArray(dirs) ? dirs.join(",") : dirs;
    return { skills: skillsByDir.get(dir) ?? [], diagnostics: [] };
  });
  vi.mocked(createExecEnv).mockResolvedValue({} as ExecutionEnv);
  vi.mocked(loadSettings).mockResolvedValue(settingsWithDisabled([]));
  registerSkillsIpc();
});

describe("skills:list", () => {
  it("目录来源按 数据目录 → 项目 → 跨工具共享 → 内置 的顺序合并，并标记各自来源", async () => {
    skillsByDir.set("/data-oint/skills", [skill("beta", "/data-oint/skills")]);
    skillsByDir.set("C:/work/.oint/skills", [skill("gamma", "C:/work/.oint/skills")]);
    skillsByDir.set(SHARED_DIR, [skill("shared-one", SHARED_DIR)]);
    skillsByDir.set(BUILTIN_DIR, [skill("builtin-one", BUILTIN_DIR)]);

    const list = await listSkills({ workingDir: "C:/work" });

    expect(vi.mocked(createExecEnv).mock.calls.map(([options]) => options.cwd)).toEqual([
      "/data-oint/skills",
      "C:/work/.oint/skills",
      SHARED_DIR,
      BUILTIN_DIR,
    ]);
    expect(list.map((item) => item.name)).toEqual(["beta", "gamma", "shared-one", "builtin-one"]);
    expect(list.map((item) => item.source)).toEqual(["user", "user", "agents", "builtin"]);
  });

  /**
   * 跨工具共享目录里的技能同样是**一等公民**：能被禁用名单命中。
   *
   * 这条是「本地开关」的实现依据 —— 禁用名单按**名字**匹配，与来源无关
   * （见 settings.disabledSkillNames 的语义），所以共享来源不需要任何额外机制。
   */
  it("共享来源的技能进 disabled 映射（禁用名单按名字匹配，与来源无关）", async () => {
    skillsByDir.set(SHARED_DIR, [skill("shared-one", SHARED_DIR)]);
    vi.mocked(loadSettings).mockResolvedValue(settingsWithDisabled(["shared-one"]));

    const list = await listSkills();

    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ source: "agents", disabled: true });
  });

  /**
   * 优先级：用户技能同名时**遮住**内置的。
   *
   * 这条是内置技能能被定制的前提 —— 反过来的话用户永远改不掉内置行为，
   * 而「面板里显示哪个」与「运行时注入哪个」也会因此对不上。
   */
  it("同名时用户技能胜出，被遮住的内置不进列表", async () => {
    skillsByDir.set("/data-oint/skills", [skill("shared", "/data-oint/skills")]);
    skillsByDir.set(BUILTIN_DIR, [skill("shared", BUILTIN_DIR)]);

    const list = await listSkills();

    expect(list).toHaveLength(1);
    expect(list[0]?.source).toBe("user");
    expect(list[0]?.filePath).toBe("/data-oint/skills/shared/SKILL.md");
  });

  it("同名技能「首个胜出」：保留先扫描目录里的条目", async () => {
    skillsByDir.set("/data-oint/skills", [
      skill("dup", "/data-oint/skills"),
      skill("only-a", "/data-oint/skills"),
    ]);
    skillsByDir.set("C:/work/.oint/skills", [skill("dup", "C:/work/.oint/skills")]);

    const list = await listSkills({ workingDir: "C:/work" });

    expect(list.map((item) => item.name)).toEqual(["dup", "only-a"]);
    expect(list[0]?.filePath).toBe("/data-oint/skills/dup/SKILL.md");
    expect(list[0]?.source).toBe("user");
  });

  it("某个目录扫描失败时其余目录仍正常返回，并记录告警", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    skillsByDir.set("C:/work/.oint/skills", [skill("gamma", "C:/work/.oint/skills")]);
    vi.mocked(createExecEnv).mockImplementation(async (options) => {
      if (options.cwd === "/data-oint/skills") throw new Error("ENOENT: 目录不存在");
      return {} as ExecutionEnv;
    });

    const list = await listSkills({ workingDir: "C:/work" });

    expect(list.map((item) => item.name)).toEqual(["gamma"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("/data-oint/skills"));
    warn.mockRestore();
  });

  it("disabledSkillNames 映射到 SkillInfo.disabled（内置技能同样可禁用）", async () => {
    skillsByDir.set("/data-oint/skills", [
      skill("alpha", "/data-oint/skills"),
      skill("beta", "/data-oint/skills"),
    ]);
    skillsByDir.set(BUILTIN_DIR, [skill("builtin-one", BUILTIN_DIR)]);
    vi.mocked(loadSettings).mockResolvedValue(
      settingsWithDisabled(["beta", "builtin-one", "不存在的技能"]),
    );

    const list = await listSkills();

    expect(list.find((item) => item.name === "alpha")?.disabled).toBe(false);
    expect(list.find((item) => item.name === "beta")?.disabled).toBe(true);
    // 内置技能不需要特殊处理：禁用名单对两类来源一视同仁
    expect(list.find((item) => item.name === "builtin-one")?.disabled).toBe(true);
  });

  it("workingDir 缺失时扫描数据目录、共享目录与内置目录（设置面板不带会话）", async () => {
    skillsByDir.set("/data-oint/skills", [skill("alpha", "/data-oint/skills")]);

    const list = await listSkills();

    expect(vi.mocked(createExecEnv).mock.calls.map(([options]) => options.cwd)).toEqual([
      "/data-oint/skills",
      SHARED_DIR,
      BUILTIN_DIR,
    ]);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      name: "alpha",
      description: "alpha 的说明",
      filePath: "/data-oint/skills/alpha/SKILL.md",
      source: "user",
      disabled: false,
    });
  });
});

describe("skills:read / skills:remove 的来源回退", () => {
  /**
   * 数据目录的技能目录字符串**用 path.join 拼**，与 `skills.ts` 里的 `globalSkillsDir()`
   * 逐字一致。
   *
   * 不能抄上面那批用例里的 `"/data-oint/skills"`：那一批比的是 `resolveSkillDirs` 的
   * 模板串（恒为正斜杠），而 `globalSkillsDir()` 走 `path.join`（Windows 上是反斜杠）。
   * 两者指向同一个目录，但作为**夹具的键**是两个不同的字符串 —— 用错的那个会让
   * "数据目录里找不到" 变成静默事实，于是一条测「用户覆盖共享」的用例会在
   * 共享那一份上通过，看起来像是回退顺序对了。
   */
  const DATA_SKILLS_DIR = path.join("/data-oint", "skills");

  it("数据目录里没有时读得到共享目录里的技能（顺序与列表去重一致）", async () => {
    skillsByDir.set(SHARED_DIR, [skill("shared-one", SHARED_DIR)]);

    const detail = await callHandler<{ name: string }>(IPC.skills.read, { name: "shared-one" });

    expect(vi.mocked(readFile).mock.calls.at(-1)?.[0]).toBe(`${SHARED_DIR}/shared-one/SKILL.md`);
    expect(detail.name).toBe("shared-one");
  });

  it("数据目录里有一份同名时读的是那一份（用户覆盖共享，与列表一致）", async () => {
    skillsByDir.set(DATA_SKILLS_DIR, [skill("dup", DATA_SKILLS_DIR)]);
    skillsByDir.set(SHARED_DIR, [skill("dup", SHARED_DIR)]);

    const detail = await callHandler<{ name: string }>(IPC.skills.read, { name: "dup" });

    // 读到的是数据目录那一份：readFile 收到的路径来自 findGlobalSkill
    expect(vi.mocked(readFile).mock.calls.at(-1)?.[0]).toBe(
      `${DATA_SKILLS_DIR}/dup/SKILL.md`.replace(/\\/g, path.sep),
    );
    expect(detail.name).toBe("dup");
  });

  /**
   * 共享目录里的技能**不可在此删除** —— 而且拒绝的理由与内置那条不同。
   *
   * 这条不是"顺手加个保护"：那个目录是**别的工具也在用的**，在这个面板里删掉它，
   * Claude Code / Codex / Cursor 会一起丢掉那份技能。所以错误文案要能说清这一点，
   * 并把用户指向正确的动作（禁用）。
   */
  it("共享目录里的技能不可删除，错误文案指向「禁用」", async () => {
    skillsByDir.set(SHARED_DIR, [skill("shared-one", SHARED_DIR)]);

    await expect(callHandler(IPC.skills.remove, { name: "shared-one" })).rejects.toThrow(
      /跨工具共享技能不可在此删除/,
    );
  });
});
