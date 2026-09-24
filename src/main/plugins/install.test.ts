/**
 * 插件安装 / 卸载 / 开发挂载。
 *
 * 这一组全部在真实临时目录上跑，并且**真的造 zip**（用 fflate 的 zipSync）——
 * 安装这件事的价值就在"外部压缩包 → 磁盘上可用的插件目录"这条链，
 * 而那只有真的走一遍才算验过。
 *
 * 最要紧的三条：
 *  - **先读懂再落盘**：清单不合法的包一个字节都不该写进去；
 *  - **支持两种包内布局**（清单在根 / 在唯一一层子目录里），且落盘后结构一致；
 *  - **失败不留半装的插件**（暂存目录 + rename）。
 */

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pluginsDir } from "@/main/app/paths";
import { AGENT_PLUGINS_SCHEMA_1_0_0, OINT_EXTENSION_NAMESPACE } from "@/shared/contracts/plugin";
import {
  addDevPlugin,
  installPluginFromZip,
  PluginInstallError,
  removeDevPlugin,
  uninstallPlugin,
} from "./install";

let workspace: string;
let dataDir: string;

beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "oint-install-"));
  dataDir = await mkdtemp(path.join(tmpdir(), "oint-install-data-"));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
});

function manifest(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    $schema: AGENT_PLUGINS_SCHEMA_1_0_0,
    name: id.replace(/\./g, "-"),
    version: "1.0.0",
    description: "测试插件",
    extensions: { [OINT_EXTENSION_NAMESPACE]: { id, apiVersion: "1", permissions: [], ...extra } },
  };
}

/** 造一个 zip；`prefix` 非空时把全部内容放进一层子目录 */
function makeZip(files: Record<string, string>, prefix = ""): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  const encoder = new TextEncoder();
  for (const [name, content] of Object.entries(files)) {
    entries[prefix === "" ? name : `${prefix}/${name}`] = encoder.encode(content);
  }
  return zipSync(entries);
}

async function writeZip(name: string, files: Record<string, string>, prefix = ""): Promise<string> {
  const target = path.join(workspace, name);
  await writeFile(target, makeZip(files, prefix));
  return target;
}

/** 一个最小但完整的插件包 */
function basicFiles(id = "dev.example.demo"): Record<string, string> {
  return {
    "plugin.json": JSON.stringify(manifest(id), null, 2),
    "skills/review/SKILL.md": "# 审查\n",
    "ui/panel.html": "<h1>hi</h1>",
  };
}

async function exists(target: string): Promise<boolean> {
  return (await stat(target).catch(() => undefined)) !== undefined;
}

describe("installPluginFromZip", () => {
  it("装上之后目录与文件都在", async () => {
    const zip = await writeZip("demo.ointplug", basicFiles());
    const result = await installPluginFromZip(zip, dataDir);

    expect(result.pluginId).toBe("dev.example.demo");
    expect(result.replaced).toBe(false);
    expect(result.dir).toBe(path.join(pluginsDir(dataDir), "installed", "dev.example.demo"));

    expect(await readFile(path.join(result.dir, "plugin.json"), "utf8")).toContain(
      "dev.example.demo",
    );
    expect(await exists(path.join(result.dir, "skills", "review", "SKILL.md"))).toBe(true);
  });

  it("**两种包内布局落盘后结构一致**（右键压缩文件夹是常见做法）", async () => {
    // 布局一：清单在压缩包根
    const flat = await writeZip("flat.ointplug", basicFiles("dev.example.flat"));
    const a = await installPluginFromZip(flat, dataDir);
    // 布局二：全部内容在一层子目录里
    const nested = await writeZip("nested.ointplug", basicFiles("dev.example.nested"), "my-plugin");
    const b = await installPluginFromZip(nested, dataDir);

    for (const dir of [a.dir, b.dir]) {
      // 两种布局下 plugin.json 都必须**直接**在插件目录里 ——
      // 嵌套布局不剥前缀的话，它会躺在 <插件目录>/my-plugin/plugin.json，
      // 而宿主按 <插件目录>/plugin.json 找
      expect(await exists(path.join(dir, "plugin.json")), dir).toBe(true);
      expect(await exists(path.join(dir, "skills", "review", "SKILL.md")), dir).toBe(true);
    }
  });

  it("**清单不合法 → 一个字节都不落盘**（先读懂再落盘）", async () => {
    const zip = await writeZip("bad.ointplug", {
      ...basicFiles("dev.example.bad"),
      "plugin.json": JSON.stringify({ ...manifest("dev.example.bad"), name: "Bad_Name" }),
    });

    await expect(installPluginFromZip(zip, dataDir)).rejects.toBeInstanceOf(PluginInstallError);
    expect(await exists(path.join(pluginsDir(dataDir), "installed"))).toBe(false);
  });

  it("没有 plugin.json → 拒绝", async () => {
    const zip = await writeZip("noManifest.ointplug", { "readme.md": "hi" });
    await expect(installPluginFromZip(zip, dataDir)).rejects.toThrow(/没有 plugin\.json/);
  });

  it("不是 zip → 拒绝", async () => {
    const target = path.join(workspace, "junk.ointplug");
    await writeFile(target, "这不是一个压缩包", "utf8");
    await expect(installPluginFromZip(target, dataDir)).rejects.toThrow(/没有 plugin\.json/);
  });

  it("清单 JSON 坏掉 → 拒绝并说明", async () => {
    const zip = await writeZip("broken.ointplug", { "plugin.json": "{ 坏掉的 JSON" });
    await expect(installPluginFromZip(zip, dataDir)).rejects.toThrow(/不是合法 JSON/);
  });

  it("**覆盖安装**：同 id 再装一次会替换掉旧目录，并报告 replaced", async () => {
    const first = await writeZip("v1.ointplug", {
      ...basicFiles(),
      "extra-v1.txt": "v1",
    });
    await installPluginFromZip(first, dataDir);

    const second = await writeZip("v2.ointplug", {
      ...basicFiles(),
      "extra-v2.txt": "v2",
    });
    const result = await installPluginFromZip(second, dataDir);

    expect(result.replaced).toBe(true);
    expect(await exists(path.join(result.dir, "extra-v2.txt"))).toBe(true);
    // **旧文件不该留下** —— 否则升级之后目录里是两次安装的并集
    expect(await exists(path.join(result.dir, "extra-v1.txt"))).toBe(false);
  });

  it("**失败不留半装的插件，也不留暂存目录**", async () => {
    const zip = await writeZip("bad.ointplug", {
      "plugin.json": JSON.stringify(manifest("dev.example.bad")),
      // 一个路径越界的条目：解压时会被跳过并记诊断，但插件本体是合法的
      "../escape.txt": "逃出去了",
    });
    const result = await installPluginFromZip(zip, dataDir);

    // 越界条目被拦掉，且**没有落到 installed/ 之外**
    expect(await exists(path.join(pluginsDir(dataDir), "escape.txt"))).toBe(false);
    expect(result.warnings.join()).toContain("越界");

    // 暂存目录清干净了
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(pluginsDir(dataDir));
    expect(entries.filter((name) => name.startsWith(".staging-"))).toEqual([]);
  });

  it("根字段的未知警告会被带出来（Agent Plugins 的 MUST：报告并忽略）", async () => {
    const zip = await writeZip("warn.ointplug", {
      ...basicFiles(),
      "plugin.json": JSON.stringify({ ...manifest("dev.example.demo"), futureField: 1 }, null, 2),
    });
    const result = await installPluginFromZip(zip, dataDir);
    expect(result.warnings.join()).toContain("futureField");
  });
});

describe("uninstallPlugin", () => {
  it("删掉目录；keepData 决定私有数据目录的去留", async () => {
    const zip = await writeZip("demo.ointplug", basicFiles());
    const installed = await installPluginFromZip(zip, dataDir);

    const pluginData = path.join(pluginsDir(dataDir), "data", "dev.example.demo");
    await mkdir(pluginData, { recursive: true });
    await writeFile(path.join(pluginData, "storage.json"), "{}", "utf8");

    await uninstallPlugin({ id: "dev.example.demo", dir: installed.dir }, dataDir, true);
    expect(await exists(installed.dir)).toBe(false);
    expect(await exists(pluginData)).toBe(true);

    // 第二次保留数据不再有意义（目录已删），但接口要能重复调用
    await uninstallPlugin({ id: "dev.example.demo", dir: installed.dir }, dataDir, false);
    expect(await exists(pluginData)).toBe(false);
  });

  it("目录本来就不存在时不抛错（卸载路径要能重复跑）", async () => {
    await expect(
      uninstallPlugin({ id: "dev.example.nope", dir: path.join(dataDir, "gone") }, dataDir, false),
    ).resolves.toBeUndefined();
  });
});

describe("开发插件挂载", () => {
  async function makeDevPlugin(id: string): Promise<string> {
    const dir = path.join(workspace, `dev-${id}`);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "plugin.json"), JSON.stringify(manifest(id)), "utf8");
    return dir;
  }

  it("挂上之后 dev.json 里有它，解除之后没有", async () => {
    const dir = await makeDevPlugin("dev.example.work");
    expect(await addDevPlugin(dir, dataDir)).toBe("dev.example.work");

    const list = JSON.parse(
      await readFile(path.join(pluginsDir(dataDir), "dev.json"), "utf8"),
    ) as string[];
    expect(list).toEqual([path.resolve(dir)]);

    await removeDevPlugin(dir, dataDir);
    const after = JSON.parse(
      await readFile(path.join(pluginsDir(dataDir), "dev.json"), "utf8"),
    ) as string[];
    expect(after).toEqual([]);
  });

  it("**解除挂载不删目录** —— 那是用户自己的代码", async () => {
    const dir = await makeDevPlugin("dev.example.work");
    await addDevPlugin(dir, dataDir);
    await removeDevPlugin(dir, dataDir);
    expect(await exists(path.join(dir, "plugin.json"))).toBe(true);
  });

  it("重复挂同一个目录不会写两条", async () => {
    const dir = await makeDevPlugin("dev.example.work");
    await addDevPlugin(dir, dataDir);
    await addDevPlugin(dir, dataDir);
    const list = JSON.parse(
      await readFile(path.join(pluginsDir(dataDir), "dev.json"), "utf8"),
    ) as string[];
    expect(list).toHaveLength(1);
  });

  it("目录里没有 plugin.json → 拒绝", async () => {
    const dir = path.join(workspace, "empty");
    await mkdir(dir, { recursive: true });
    await expect(addDevPlugin(dir, dataDir)).rejects.toThrow(/没有 plugin\.json/);
  });

  it("清单不合法 → 拒绝", async () => {
    const dir = path.join(workspace, "bad");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "plugin.json"),
      JSON.stringify({ ...manifest("dev.example.bad"), name: "Bad_Name" }),
      "utf8",
    );
    await expect(addDevPlugin(dir, dataDir)).rejects.toBeInstanceOf(PluginInstallError);
  });

  it("dev.json 坏掉时按空清单处理，挂载仍然能成功", async () => {
    await mkdir(pluginsDir(dataDir), { recursive: true });
    await writeFile(path.join(pluginsDir(dataDir), "dev.json"), "不是 JSON", "utf8");
    const dir = await makeDevPlugin("dev.example.work");
    await expect(addDevPlugin(dir, dataDir)).resolves.toBe("dev.example.work");
  });
});
