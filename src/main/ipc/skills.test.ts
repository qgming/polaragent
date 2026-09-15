import type { ExecutionEnv, Skill } from "@earendil-works/pi-agent-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
import type { Settings } from "@/shared/contracts/settings";
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
  it("目录来源按 数据目录 → 项目目录 的顺序合并，磁盘项一律标为用户添加", async () => {
    skillsByDir.set("/data-oint/skills", [skill("beta", "/data-oint/skills")]);
    skillsByDir.set("C:/work/.oint/skills", [skill("gamma", "C:/work/.oint/skills")]);

    const list = await listSkills({ workingDir: "C:/work" });

    expect(vi.mocked(createExecEnv).mock.calls.map(([options]) => options.cwd)).toEqual([
      "/data-oint/skills",
      "C:/work/.oint/skills",
    ]);
    expect(list.map((item) => item.name)).toEqual(["beta", "gamma"]);
    expect(list.map((item) => item.source)).toEqual(["user", "user"]);
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

  it("disabledSkillNames 映射到 SkillInfo.disabled", async () => {
    skillsByDir.set("/data-oint/skills", [
      skill("alpha", "/data-oint/skills"),
      skill("beta", "/data-oint/skills"),
    ]);
    vi.mocked(loadSettings).mockResolvedValue(
      settingsWithDisabled(["beta", "不存在的技能"]),
    );

    const list = await listSkills();

    expect(list.find((item) => item.name === "alpha")?.disabled).toBe(false);
    expect(list.find((item) => item.name === "beta")?.disabled).toBe(true);
  });

  it("workingDir 缺失时只扫描数据目录", async () => {
    skillsByDir.set("/data-oint/skills", [skill("alpha", "/data-oint/skills")]);

    const list = await listSkills();

    expect(vi.mocked(createExecEnv).mock.calls.map(([options]) => options.cwd)).toEqual([
      "/data-oint/skills",
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
