import type { ExecutionEnv, PromptTemplate } from "@earendil-works/pi-agent-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PromptTemplateInfo } from "@/shared/contracts/prompts";

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

// 目录解析依赖 dataDir()，固定成可断言的路径；exec env 与内核加载整体 mock，
// 本测试只覆盖「目录顺序 → 扫描结果 → 合并/兜底」的纯逻辑，不碰文件系统。
vi.mock("@/main/app/paths", () => ({ dataDir: () => "/data-oint" }));
vi.mock("@/main/pisdk/exec-env", () => ({ createExecEnv: vi.fn() }));
vi.mock("@earendil-works/pi-agent-core", () => ({
  BACKGROUND_CONTEXT: {},
  loadPromptTemplates: vi.fn(),
}));

import { loadPromptTemplates } from "@earendil-works/pi-agent-core";
import { createExecEnv } from "@/main/pisdk/exec-env";
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
  registerPromptsIpc();
});

describe("prompts:list", () => {
  it("目录来源按 数据目录 → 项目目录 的顺序合并，磁盘项一律标为用户添加", async () => {
    templatesByDir.set("/data-oint/prompts", [template("beta", "beta 的说明")]);
    templatesByDir.set("C:/work/.oint/prompts", [template("gamma", "gamma 的说明")]);

    const list = await listPrompts({ workingDir: "C:/work" });

    expect(vi.mocked(createExecEnv).mock.calls.map(([options]) => options.cwd)).toEqual([
      "/data-oint/prompts",
      "C:/work/.oint/prompts",
    ]);
    expect(list.map((item) => item.name)).toEqual(["beta", "gamma"]);
    expect(list.map((item) => item.source)).toEqual(["user", "user"]);
    expect(list.map((item) => item.dir)).toEqual(["/data-oint/prompts", "C:/work/.oint/prompts"]);
  });

  it("每个目录各建一个只放行该目录的 env（路径守卫）", async () => {
    await listPrompts({ workingDir: "C:/work" });

    expect(vi.mocked(createExecEnv).mock.calls.map(([options]) => options.allowedRoots)).toEqual([
      ["/data-oint/prompts"],
      ["C:/work/.oint/prompts"],
    ]);
  });

  it("同名模板「首个胜出」：保留先扫描目录里的条目", async () => {
    templatesByDir.set("/data-oint/prompts", [
      template("dup", "来自数据目录"),
      template("only-a", "只此一处"),
    ]);
    templatesByDir.set("C:/work/.oint/prompts", [template("dup", "来自项目目录")]);

    const list = await listPrompts({ workingDir: "C:/work" });

    expect(list.map((item) => item.name)).toEqual(["dup", "only-a"]);
    expect(list[0]?.description).toBe("来自数据目录");
    expect(list[0]?.source).toBe("user");
    expect(list[0]?.dir).toBe("/data-oint/prompts");
  });

  it("内核缺 description 时兜底为空串", async () => {
    templatesByDir.set("/data-oint/prompts", [template("无描述"), template("有描述", "有说明")]);

    const list = await listPrompts();

    expect(list.map((item) => item.description)).toEqual(["", "有说明"]);
    expect(list.map((item) => item.content)).toEqual(["无描述 的正文", "有描述 的正文"]);
  });

  it("某个目录扫描失败时其余目录仍正常返回，并记录告警", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    templatesByDir.set("C:/work/.oint/prompts", [template("gamma", "gamma 的说明")]);
    vi.mocked(createExecEnv).mockImplementation(async (options) => {
      if (options.cwd === "/data-oint/prompts") throw new Error("ENOENT: 目录不存在");
      return {} as ExecutionEnv;
    });

    const list = await listPrompts({ workingDir: "C:/work" });

    expect(list.map((item) => item.name)).toEqual(["gamma"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("/data-oint/prompts"));
    warn.mockRestore();
  });

  it("workingDir 缺失时只扫描数据目录", async () => {
    templatesByDir.set("/data-oint/prompts", [template("alpha", "alpha 的说明")]);

    const list = await listPrompts();

    expect(vi.mocked(createExecEnv).mock.calls.map(([options]) => options.cwd)).toEqual([
      "/data-oint/prompts",
    ]);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      name: "alpha",
      description: "alpha 的说明",
      content: "alpha 的正文",
      source: "user",
      dir: "/data-oint/prompts",
    });
  });
});
