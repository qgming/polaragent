/**
 * 随包分发的内置插件。
 *
 * 这一组存在的理由不是"测那个示例插件"，而是**守住打包链的内容那一半**：
 *
 * 方案 §2 点过名的一个坑 —— `electron-builder.yml` 的 `files:` 漏了 `resources/**` 时，
 * 症状是「开发模式一切正常、打包后内置技能为 0」，因为 asar 里根本没有那个目录。
 * 那一条已经在配置里查过并且是对的，但**没有内容走过那条链**，所以"对不对"只是推断。
 *
 * 现在有内容了。下面用真实的 `resources/plugins/` 目录验三件事：
 *  1. 目录里至少有一个插件（否则这条链仍然是"通而空"，下次配置被改坏也没人发现）；
 *  2. 每一份清单都合法（内置插件不能是坏的 —— 它随包分发，用户没法修）；
 *  3. 清单里引用的界面文件**真的存在**（相对路径写错在运行期表现为"窗口打开是白的"）。
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validatePluginManifest } from "./manifest";

/** 仓库根下的 resources/plugins —— 与 electron-builder.yml 的 `files:` 指向同一处 */
const BUILTIN_ROOT = path.resolve(import.meta.dirname, "../../../resources/plugins");

async function pluginDirs(): Promise<string[]> {
  const entries = await readdir(BUILTIN_ROOT, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

describe("内置插件目录", () => {
  /*
    这一组**允许 `resources/plugins/` 为空**（当前就是空的：内置插件还没定）。
    它的职责是"放进去的每一份都对"，而不是"必须至少有一份" ——
    后者会在插件还没写出来的时候拦住整个测试套件，而那是没有信息量的红。

    ⚠️ 但**空目录会让打包配置的对错无从验证**：`electron-builder.yml` 的 `files:`
    漏了 `resources/**` 时，症状是"开发模式一切正常、打包后内置插件为 0"，
    而空目录下这个症状与正常状态长得一模一样。所以内置插件补回来之后，
    这一条要恢复成"至少有一个"。
  */
  it("**至少有一个内置插件** —— 空的 resources/plugins 会让打包配置的对错无从验证", async () => {
    /*
      空目录与"`electron-builder.yml` 的 `files:` 漏了 `resources/**`"这两种状态
      长得一模一样（都是"打包后内置插件为 0"），所以空目录下这条链的对错无法验证。
      这一条因此是**必须有的**：它保证那条链上一直有东西走着。
    */
    expect(await pluginDirs()).not.toEqual([]);
  });

  it("每一份清单都合法（内置插件随包分发，用户没法修）", async () => {
    for (const name of await pluginDirs()) {
      const raw = await readFile(path.join(BUILTIN_ROOT, name, "plugin.json"), "utf8");
      const result = validatePluginManifest(JSON.parse(raw) as unknown);
      if (!result.ok) {
        throw new Error(
          `${name}/plugin.json 不合法：\n` +
            result.issues.map((issue) => `  ${issue.path}：${issue.message}`).join("\n"),
        );
      }
      // 根级的未知字段只是警告，但内置插件连警告都不该有 —— 它是我们自己写的
      expect(result.warnings, `${name} 有警告`).toEqual([]);
    }
  });

  it("**清单里引用的界面文件真的存在**（路径写错在运行期是「窗口打开是白的」）", async () => {
    for (const name of await pluginDirs()) {
      const dir = path.join(BUILTIN_ROOT, name);
      const raw = await readFile(path.join(dir, "plugin.json"), "utf8");
      const result = validatePluginManifest(JSON.parse(raw) as unknown);
      if (!result.ok) continue; // 上一条用例已经报过了

      for (const surface of result.manifest.surfaces) {
        const target = path.join(dir, surface.entry);
        const content = await readFile(target, "utf8").catch(() => undefined);
        expect(
          content,
          `${name} 的界面 ${surface.id} 指向了不存在的文件：${surface.entry}`,
        ).toBeDefined();
      }
    }
  });

  it("内置插件的 id 用 `dev.oint.` 前缀（与用户装进来的第三方插件分得开）", async () => {
    for (const name of await pluginDirs()) {
      const raw = await readFile(path.join(BUILTIN_ROOT, name, "plugin.json"), "utf8");
      const result = validatePluginManifest(JSON.parse(raw) as unknown);
      if (!result.ok) continue;
      expect(result.manifest.id, `${name} 的 id 前缀不对`).toMatch(/^dev\.oint\./);
    }
  });

  it("**声明了 main 的插件必须申请对应的注册权限** —— 否则进程永远起不来", async () => {
    /*
      这条挡的是一种**静默无效**：`process-host` 只在插件申请了
      `agent.tool.register` 或 `commands.register` 时才起进程。
      于是"写了 main.js 但忘了申请权限"的插件会：进程从不启动、工具从不存在、
      界面上一切正常 —— 作者完全不知道发生了什么。

      注意它**不是**"内置插件都不许有 main.js"：那是另一回事，而且太严。
      能声明就别写代码（Git 面板与番茄钟证明了声明式的表达力），
      但一个计算函数**声明不出来** —— 那种时候就该有代码。
    */
    for (const name of await pluginDirs()) {
      const raw = await readFile(path.join(BUILTIN_ROOT, name, "plugin.json"), "utf8");
      const result = validatePluginManifest(JSON.parse(raw) as unknown);
      if (!result.ok) continue;
      if (result.manifest.main === undefined) continue;
      const canRegister =
        result.manifest.permissions.includes("agent.tool.register") ||
        result.manifest.permissions.includes("commands.register");
      expect(canRegister, `${name} 有 main.js 却没申请注册类权限（进程永远不会起）`).toBe(true);
    }
  });

  it("贡献技能 / 提示 / 子智能体的插件必须申请对应权限", async () => {
    /*
      与上一条同源：`contributions.ts` 按权限筛目录，没申请就整块不贡献。
      一个带了 `skills/` 却没写 `skills.contribute` 的插件，
      技能会**静默消失** —— 那是最难查的一类（目录明明在）。
    */
    for (const name of await pluginDirs()) {
      const dir = path.join(BUILTIN_ROOT, name);
      const raw = await readFile(path.join(dir, "plugin.json"), "utf8");
      const result = validatePluginManifest(JSON.parse(raw) as unknown);
      if (!result.ok) continue;
      for (const [folder, permission] of [
        ["skills", "skills.contribute"],
        ["prompts", "prompts.contribute"],
        ["subagents", "subagents.contribute"],
      ] as const) {
        const present = await readdir(path.join(dir, folder)).catch(() => undefined);
        if (present === undefined) continue;
        expect(
          result.manifest.permissions.includes(permission),
          `${name} 有 ${folder}/ 却没申请 ${permission}`,
        ).toBe(true);
      }
    }
  });
});
