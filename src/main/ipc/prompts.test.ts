import type { ExecutionEnv, PromptTemplate } from "@earendil-works/pi-agent-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PromptTemplateInfo } from "@/shared/contracts/prompts";
import type { Settings } from "@/shared/contracts/settings";

type ListHandler = (
  event: unknown,
  request?: { workingDir?: string },
) => Promise<PromptTemplateInfo[]>;

// vi.mock 工厂会先于 import 执行，用 hoisted 容器接住 registerPromptsIpc 注册的 handler
const registered = vi.hoisted(() => ({ handlers: new Map<string, ListHandler>() }));

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, listener: ListHandler) => {
      registered.handlers.set(channel, listener);
    },
  },
}));

// 目录解析依赖 dataDir()，固定成可断言的路径；设置存储与 exec env 整体 mock，
// 本测试只覆盖「目录顺序 → 扫描结果 → 合并/兜底」的纯逻辑，不碰文件系统。
vi.mock("@/main/app/paths", () => ({ dataDir: () => "/data-oint" }));
vi.mock("@/main/settings/store", () => ({ loadSettings: vi.fn() }));
vi.mock("@/main/pisdk/exec-env", () => ({ createExecEnv: vi.fn() }));
vi.mock("@earendil-works/pi-agent-core", () => ({
  BACKGROUND_CONTEXT: {},
  loadPromptTemplates: vi.fn(),
}));

import { loadPromptTemplates } from "@earendil-works/pi-agent-core";
import { createExecEnv } from "@/main/pisdk/exec-env";
import { loadSettings } from "@/main/settings/store";
import { IPC } from "@/shared/contracts/ipc";
import { registerPromptsIpc } from "./prompts";

/** 每个目录返回的模板；key 是目录路径 */
const templatesByDir = new Map<string, PromptTemplate[]>();

/** 构造 loadPromptTemplates 的最小返回值；description 缺省表示内核没解析出描述 */
function template(name: string, description?: string): PromptTemplate {
  return description === undefined
    ? { name, content: `${name} 的正文` }
    : { name, description, content: `${name} 的正文` };
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
  disabledSkillNames: [],
  promptTemplateDirs: ["/custom/prompts"],
  mcpServers: [],
};

function settingsWith(patch: Partial<Settings>): Settings {
  return { ...BASE_SETTINGS, ...patch };
}

/** 取回注册好的 prompts:list handler（去掉 IPC event 参数） */
function listPrompts(request?: { workingDir?: string }): Promise<PromptTemplateInfo[]> {
  const handler = registered.handlers.get(IPC.prompts.list);
  if (!handler) throw new Error("prompts:list handler 未注册");
  return handler({}, request);
}

beforeEach(() => {
  vi.clearAllMocks();
  registered.handlers.clear();
  templatesByDir.clear();
  vi.mocked(loadPromptTemplates).mockImplementation(async (_env, paths) => {
    const dir = Array.isArray(paths) ? paths.join(",") : paths;
    return { promptTemplates: templatesByDir.get(dir) ?? [], diagnostics: [] };
  });
  vi.mocked(createExecEnv).mockResolvedValue({} as ExecutionEnv);
  vi.mocked(loadSettings).mockResolvedValue(settingsWith({}));
  registerPromptsIpc();
});

describe("prompts:list", () => {
  it("多目录来源按 设置目录 → 数据目录 → 项目目录 的顺序合并", async () => {
    templatesByDir.set("/custom/prompts", [template("alpha", "alpha 的说明")]);
    templatesByDir.set("/data-oint/prompts", [template("beta", "beta 的说明")]);
    templatesByDir.set("C:/work/.pi/prompts", [template("gamma", "gamma 的说明")]);

    const list = await listPrompts({ workingDir: "C:/work" });

    expect(vi.mocked(createExecEnv).mock.calls.map(([options]) => options.cwd)).toEqual([
      "/custom/prompts",
      "/data-oint/prompts",
      "C:/work/.pi/prompts",
    ]);
    expect(list.map((item) => item.name)).toEqual(["alpha", "beta", "gamma"]);
    expect(list.map((item) => item.source)).toEqual(["global", "global", "project"]);
    expect(list.map((item) => item.dir)).toEqual([
      "/custom/prompts",
      "/data-oint/prompts",
      "C:/work/.pi/prompts",
    ]);
  });

  it("每个目录各建一个只放行该目录的 env（路径守卫）", async () => {
    await listPrompts({ workingDir: "C:/work" });

    expect(vi.mocked(createExecEnv).mock.calls.map(([options]) => options.allowedRoots)).toEqual([
      ["/custom/prompts"],
      ["/data-oint/prompts"],
      ["C:/work/.pi/prompts"],
    ]);
  });

  it("同名模板「首个胜出」：保留先扫描目录里的条目", async () => {
    templatesByDir.set("/custom/prompts", [
      template("dup", "来自设置目录"),
      template("only-a", "只此一处"),
    ]);
    templatesByDir.set("/data-oint/prompts", [template("dup", "来自数据目录")]);
    templatesByDir.set("C:/work/.pi/prompts", [template("dup", "来自项目目录")]);

    const list = await listPrompts({ workingDir: "C:/work" });

    expect(list.map((item) => item.name)).toEqual(["dup", "only-a"]);
    expect(list[0]?.description).toBe("来自设置目录");
    expect(list[0]?.source).toBe("global");
    expect(list[0]?.dir).toBe("/custom/prompts");
  });

  it("内核缺 description 时兜底为空串", async () => {
    templatesByDir.set("/custom/prompts", [template("无描述"), template("有描述", "有说明")]);

    const list = await listPrompts();

    expect(list.map((item) => item.description)).toEqual(["", "有说明"]);
    expect(list.map((item) => item.content)).toEqual(["无描述 的正文", "有描述 的正文"]);
  });

  it("某个目录扫描失败时其余目录仍正常返回，并记录告警", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    templatesByDir.set("/custom/prompts", [template("alpha", "alpha 的说明")]);
    templatesByDir.set("C:/work/.pi/prompts", [template("gamma", "gamma 的说明")]);
    vi.mocked(createExecEnv).mockImplementation(async (options) => {
      if (options.cwd === "/data-oint/prompts") throw new Error("ENOENT: 目录不存在");
      return {} as ExecutionEnv;
    });

    const list = await listPrompts({ workingDir: "C:/work" });

    expect(list.map((item) => item.name)).toEqual(["alpha", "gamma"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("/data-oint/prompts"));
    warn.mockRestore();
  });

  it("空/空白目录项被跳过，workingDir 缺失时不追加项目目录", async () => {
    templatesByDir.set("/real/prompts", [template("alpha", "alpha 的说明")]);
    vi.mocked(loadSettings).mockResolvedValue(
      settingsWith({ promptTemplateDirs: ["/real/prompts", "", "   "] }),
    );

    const list = await listPrompts();

    expect(vi.mocked(createExecEnv).mock.calls.map(([options]) => options.cwd)).toEqual([
      "/real/prompts",
      "/data-oint/prompts",
    ]);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      name: "alpha",
      description: "alpha 的说明",
      content: "alpha 的正文",
      source: "global",
      dir: "/real/prompts",
    });
  });
});
