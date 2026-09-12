import type { ExecutionEnv, Skill } from "@earendil-works/pi-agent-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "@/shared/contracts/settings";
import type { SkillInfo } from "@/shared/contracts/skills";

type ListHandler = (event: unknown, request?: { workingDir?: string }) => Promise<SkillInfo[]>;

// vi.mock 工厂会先于 import 执行，用 hoisted 容器接住 registerSkillsIpc 注册的 handler
const registered = vi.hoisted(() => ({ handlers: new Map<string, ListHandler>() }));

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, listener: ListHandler) => {
      registered.handlers.set(channel, listener);
    },
  },
}));

// 目录解析依赖 dataDir()，固定成可断言的路径；设置存储与 exec env 整体 mock，
// 本测试只覆盖「目录顺序 → 扫描结果 → 合并/标记」的纯逻辑，不碰文件系统。
vi.mock("@/main/app/paths", () => ({ dataDir: () => "/data-oint" }));
vi.mock("@/main/settings/store", () => ({ loadSettings: vi.fn() }));
vi.mock("@/main/pisdk/exec-env", () => ({ createExecEnv: vi.fn() }));
vi.mock("@earendil-works/pi-agent-core", () => ({
  BACKGROUND_CONTEXT: {},
  loadSkills: vi.fn(),
}));

import { loadSkills } from "@earendil-works/pi-agent-core";
import { createExecEnv } from "@/main/pisdk/exec-env";
import { loadSettings } from "@/main/settings/store";
import { IPC } from "@/shared/contracts/ipc";
import { registerSkillsIpc } from "./skills";

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
  skillDirs: ["/custom/skills"],
  skillsEnabled: true,
  promptTemplateDirs: [],
  disabledSkillNames: [],
};

function settingsWith(patch: Partial<Settings>): Settings {
  return { ...BASE_SETTINGS, ...patch };
}

/** 取回注册好的 skills:list handler（去掉 IPC event 参数） */
function listSkills(request?: { workingDir?: string }): Promise<SkillInfo[]> {
  const handler = registered.handlers.get(IPC.skills.list);
  if (!handler) throw new Error("skills:list handler 未注册");
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
  vi.mocked(loadSettings).mockResolvedValue(settingsWith({}));
  registerSkillsIpc();
});

describe("skills:list", () => {
  it("多目录来源按 设置目录 → 数据目录 → 项目目录 的顺序合并", async () => {
    skillsByDir.set("/custom/skills", [skill("alpha", "/custom/skills")]);
    skillsByDir.set("/data-oint/skills", [skill("beta", "/data-oint/skills")]);
    skillsByDir.set("C:/work/.pi/skills", [skill("gamma", "C:/work/.pi/skills")]);

    const list = await listSkills({ workingDir: "C:/work" });

    expect(vi.mocked(createExecEnv).mock.calls.map(([options]) => options.cwd)).toEqual([
      "/custom/skills",
      "/data-oint/skills",
      "C:/work/.pi/skills",
    ]);
    expect(list.map((item) => item.name)).toEqual(["alpha", "beta", "gamma"]);
    expect(list.map((item) => item.source)).toEqual(["global", "global", "project"]);
  });

  it("同名技能「首个胜出」：保留先扫描目录里的条目", async () => {
    skillsByDir.set("/custom/skills", [
      skill("dup", "/custom/skills"),
      skill("only-a", "/custom/skills"),
    ]);
    skillsByDir.set("/data-oint/skills", [skill("dup", "/data-oint/skills")]);
    skillsByDir.set("C:/work/.pi/skills", [skill("dup", "C:/work/.pi/skills")]);

    const list = await listSkills({ workingDir: "C:/work" });

    expect(list.map((item) => item.name)).toEqual(["dup", "only-a"]);
    expect(list[0]?.filePath).toBe("/custom/skills/dup/SKILL.md");
    expect(list[0]?.source).toBe("global");
  });

  it("某个目录扫描失败时其余目录仍正常返回，并记录告警", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    skillsByDir.set("/custom/skills", [skill("alpha", "/custom/skills")]);
    skillsByDir.set("C:/work/.pi/skills", [skill("gamma", "C:/work/.pi/skills")]);
    vi.mocked(createExecEnv).mockImplementation(async (options) => {
      if (options.cwd === "/data-oint/skills") throw new Error("ENOENT: 目录不存在");
      return {} as ExecutionEnv;
    });

    const list = await listSkills({ workingDir: "C:/work" });

    expect(list.map((item) => item.name)).toEqual(["alpha", "gamma"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("/data-oint/skills"));
    warn.mockRestore();
  });

  it("disabledSkillNames 映射到 SkillInfo.disabled", async () => {
    skillsByDir.set("/custom/skills", [
      skill("alpha", "/custom/skills"),
      skill("beta", "/custom/skills"),
    ]);
    vi.mocked(loadSettings).mockResolvedValue(
      settingsWith({ disabledSkillNames: ["beta", "不存在的技能"] }),
    );

    const list = await listSkills();

    expect(list.find((item) => item.name === "alpha")?.disabled).toBe(false);
    expect(list.find((item) => item.name === "beta")?.disabled).toBe(true);
  });

  it("空/空白目录项被跳过，workingDir 缺失时不追加项目目录", async () => {
    skillsByDir.set("/real/skills", [skill("alpha", "/real/skills")]);
    vi.mocked(loadSettings).mockResolvedValue(
      settingsWith({ skillDirs: ["/real/skills", "", "   "] }),
    );

    const list = await listSkills();

    expect(vi.mocked(createExecEnv).mock.calls.map(([options]) => options.cwd)).toEqual([
      "/real/skills",
      "/data-oint/skills",
    ]);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      name: "alpha",
      description: "alpha 的说明",
      filePath: "/real/skills/alpha/SKILL.md",
      source: "global",
      disabled: false,
    });
  });
});
