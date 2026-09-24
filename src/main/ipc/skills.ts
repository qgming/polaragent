// 技能通道：列表扫描 + 数据目录技能的导入 / 读取 / 删除。
//
// 面板只操作**数据目录**里的全局技能（导入落这里、删除也只删这里；
// 项目级与随包分发的内置技能只读列出）。「发现」这一层不解释技能格式 ——
// 技能内容的加载与注入由 pisdk runtime 负责（runtime.ts 的 loadAgentResources），
// 两侧都复用 resources.ts 的目录解析，保证面板显示与运行时同源。

import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { BACKGROUND_CONTEXT, loadSkills } from "@earendil-works/pi-agent-core";
import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { dataDir } from "@/main/app/paths";
import { createExecEnv } from "@/main/pisdk/exec-env";
import { agentsSkillsDir, resolveBuiltinSkillDir, resolveSkillDirs } from "@/main/pisdk/resources";
import { isPluginContributionDir } from "@/main/plugins/contributions";
import { loadSettings } from "@/main/settings/store";
import { extractSkillZip } from "@/main/skills/zip-import";
import { IPC } from "@/shared/contracts/ipc";
import type {
  SkillDetail,
  SkillImportResult,
  SkillInfo,
  SkillSource,
} from "@/shared/contracts/skills";
import { handle } from "./handler";

/** 数据目录下的全局技能目录（导入与删除的作用范围） */
function globalSkillsDir(): string {
  return path.join(dataDir(), "skills");
}

/**
 * 这个技能目录属于哪一类来源。
 *
 * 判据是**路径**而不是「第几个目录」：目录清单本身可增可减（appPath 缺失时会少一个），
 * 按位置判断会在某天悄悄把内置技能标成用户的，而那种错误没有任何地方会报。
 *
 * 跨工具共享目录（`~/.agents/skills`）单列一档：它与数据目录的差别不是"优先级"，
 * 而是**这个面板不许动它**（见 remove 里的拒绝理由）。
 */
function sourceOfDir(dir: string): SkillSource {
  const resolved = path.resolve(dir);
  if (resolved === path.resolve(resolveBuiltinSkillDir(app.getAppPath()))) return "builtin";
  if (resolved === path.resolve(agentsSkillsDir())) return "agents";
  return "user";
}

/** 扫描单个技能目录；失败只告警并返回空（单个目录坏掉不影响其余目录） */
async function scanSkillDir(
  dir: string,
  disabled: Set<string>,
  source: SkillSource,
): Promise<SkillInfo[]> {
  try {
    const env = await createExecEnv({ cwd: dir, allowedRoots: [dir] });
    const { skills } = await loadSkills(env, dir, BACKGROUND_CONTEXT);
    return skills.map(
      (skill): SkillInfo => ({
        name: skill.name,
        description: skill.description,
        filePath: skill.filePath,
        source,
        disabled: disabled.has(skill.name),
      }),
    );
  } catch (error) {
    console.warn(`扫描技能目录失败 ${dir}: ${String(error)}`);
    return [];
  }
}

/**
 * 在**数据目录**的全局技能目录里按名字找一个技能；找不到返回 null。
 *
 * 刻意只看数据目录：这是读原文与删除的作用范围（内置技能不可删、也不该被面板当作用户技能编辑）。
 */
async function findGlobalSkill(name: string): Promise<SkillInfo | null> {
  const found = await scanSkillDir(globalSkillsDir(), new Set(), "user");
  return found.find((skill) => skill.name === name) ?? null;
}

/** 内置技能：按名字在随包目录里找；用于「不可删除」的判定 */
async function findBuiltinSkill(name: string): Promise<SkillInfo | null> {
  const dir = resolveBuiltinSkillDir(app.getAppPath());
  const found = await scanSkillDir(dir, new Set(), "builtin");
  return found.find((skill) => skill.name === name) ?? null;
}

/**
 * 跨工具共享目录里的技能：按名字在 `~/.agents/skills` 里找。
 *
 * 只读用：列表里点开详情必须能读到原文，而**删除与编辑不经过这里**（见 remove）。
 */
async function findSharedSkill(name: string): Promise<SkillInfo | null> {
  const found = await scanSkillDir(agentsSkillsDir(), new Set(), "agents");
  return found.find((skill) => skill.name === name) ?? null;
}

export function registerSkillsIpc(): void {
  handle(
    IPC.skills.list,
    "读取技能列表",
    async (request?: { workingDir?: string }): Promise<SkillInfo[]> => {
      const settings = await loadSettings();
      const disabled = new Set(settings.disabledSkillNames);
      // 目录来源与顺序统一由 resources.ts 解析：数据目录 → 项目 → 跨工具共享 → 插件 → 内置
      //（顺序即优先级；插件那一档在下面被过滤掉，见注释）
      /*
        **把插件贡献的目录排除掉。**

        那些技能/提示/子智能体归**插件**管：用户在这里既编辑不了也删不掉
        （改了会被下一次插件同步覆盖）。显示出来只会制造"这里能管它"的错觉，
        而"同一个东西出现在两个地方、只有一个地方能改"是这套界面一直在避免的。

        **模型照样读得到**：运行时那一侧走 `resolveSkillDirs` 的完整清单，
        不经过这个过滤 —— 这里是"藏起来"，不是"不加载"。
      */
      const dirs = resolveSkillDirs(request?.workingDir, app.getAppPath()).filter(
        (dir) => !isPluginContributionDir(dir),
      );
      const results = await Promise.all(
        dirs.map((dir) => scanSkillDir(dir, disabled, sourceOfDir(dir))),
      );
      // 同名技能按「先出现者优先」去重，保持列表稳定。
      // 于是内置技能被用户/项目的同名技能遮住时，列表里只留下生效的那一个 ——
      // 「面板里显示的」与「运行时注入的」因此永远是同一份。
      const seen = new Set<string>();
      const merged: SkillInfo[] = [];
      for (const skill of results.flat()) {
        if (seen.has(skill.name)) continue;
        seen.add(skill.name);
        merged.push(skill);
      }
      return merged;
    },
  );

  // 导入要先弹文件选择框，需要 event 里的父窗口 —— 与 dialog.ts 同一手法，单独用原始 handle 注册
  ipcMain.handle(IPC.skills.import, async (event): Promise<SkillImportResult> => {
    const parent = BrowserWindow.fromWebContents(event.sender);
    const options: Electron.OpenDialogOptions = {
      title: "导入技能包",
      properties: ["openFile"],
      filters: [{ name: "Zip", extensions: ["zip"] }],
    };
    const picked = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options);
    const zipPath = picked.canceled ? undefined : picked.filePaths[0];
    if (zipPath === undefined) return { canceled: true, files: 0, skills: 0, diagnostics: [] };

    const targetDir = globalSkillsDir();
    await mkdir(targetDir, { recursive: true });
    const { files, diagnostics } = await extractSkillZip(zipPath, targetDir);
    // 重新扫一遍：zip 里可能只有散文件（没有 SKILL.md），界面要靠这个数字说清结果
    const skills = await scanSkillDir(targetDir, new Set(), "user");
    return { canceled: false, files, skills: skills.length, diagnostics };
  });

  handle(
    IPC.skills.read,
    "读取技能详情",
    async (request: { name: string }): Promise<SkillDetail> => {
      /**
       * 按**列表去重的同一顺序**找：数据目录（可编辑的那一份）→ 跨工具共享 → 内置。
       *
       * 这个顺序与列表一致才有意义：同名时生效的是排在前面的那一份，
       * 详情当然也要显示同一份 —— 否则用户看到的是「内置的原文」，
       * 而模型读的是他覆盖过的那份，两边对不上。
       */
      const skill =
        (await findGlobalSkill(request.name)) ??
        (await findSharedSkill(request.name)) ??
        (await findBuiltinSkill(request.name));
      if (skill === null) throw new Error(`技能不存在：${request.name}`);
      return {
        name: skill.name,
        description: skill.description,
        filePath: skill.filePath,
        content: await readFile(skill.filePath, "utf8"),
      };
    },
  );

  handle(IPC.skills.remove, "删除技能", async (request: { name: string }): Promise<void> => {
    const skill = await findGlobalSkill(request.name);
    if (skill === null) {
      /**
       * 内置技能不可删除 —— 给出明确报错而不是「技能不存在」。
       *
       * 与子智能体的「内置子智能体不可删除」同一条原则：内置的定义随应用升级更新，
       * 删掉它只会在下次升级时又冒出来，而用户真正的诉求通常是「别用它」→ 那是禁用。
       *
       * 顺带一个安全含义：内置技能住在**应用目录**里，删它等于改应用自身，
       * 那从来不是这个 IPC 通道该做的事。
       */
      if ((await findBuiltinSkill(request.name)) !== null) {
        throw new Error(`内置技能不可删除，请改用「禁用」：${request.name}`);
      }
      /**
       * 跨工具共享目录里的技能同样不可删，但理由与内置那条**不是**同一个。
       *
       * 内置技能住在应用目录里（删不掉，升级后又回来）；而 `~/.agents/skills` 里的技能
       * 是**别的工具也在用的那一份**：在这个面板里删掉它，Claude Code / Codex / Cursor
       * 会一起丢掉它。用户真正的诉求通常是「在 Oint 里别用它」→ 那是禁用。
       */
      if ((await findSharedSkill(request.name)) !== null) {
        throw new Error(
          `跨工具共享技能不可在此删除（删掉它会让其它工具一起丢技能），请改用「禁用」：${request.name}`,
        );
      }
      throw new Error(`技能不存在：${request.name}`);
    }
    const root = path.resolve(globalSkillsDir());
    const skillDir = path.resolve(path.dirname(skill.filePath));
    // 只删数据目录下的**技能目录**：SKILL.md 直接躺在 skills 根下时删掉整个目录就等于清空全局技能
    if (
      skillDir === root ||
      !skillDir.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`)
    ) {
      throw new Error(`只能删除数据目录 skills 子目录里的技能：${request.name}`);
    }
    await rm(skillDir, { recursive: true, force: true });
  });
}
