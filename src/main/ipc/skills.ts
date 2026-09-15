// 技能通道：列表扫描 + 数据目录技能的导入 / 读取 / 删除。
//
// 面板只操作**数据目录**里的全局技能（导入落这里、删除也只删这里，项目级技能只跟着会话 cwd 只读列出）。
// 「发现」这一层不解释技能格式 —— 技能内容的加载与注入由 pisdk runtime 负责
//（runtime.ts 的 loadAgentResources），两侧都复用 resources.ts 的目录解析，保证面板显示与运行时同源。

import { BACKGROUND_CONTEXT, loadSkills } from "@earendil-works/pi-agent-core";
import { BrowserWindow, dialog, ipcMain } from "electron";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { dataDir } from "@/main/app/paths";
import { createExecEnv } from "@/main/pisdk/exec-env";
import { resolveSkillDirs } from "@/main/pisdk/resources";
import { extractSkillZip } from "@/main/skills/zip-import";
import { loadSettings } from "@/main/settings/store";
import { IPC } from "@/shared/contracts/ipc";
import type { SkillDetail, SkillImportResult, SkillInfo } from "@/shared/contracts/skills";
import { handle } from "./handler";

/** 数据目录下的全局技能目录（导入与删除的作用范围） */
function globalSkillsDir(): string {
  return path.join(dataDir(), "skills");
}

/** 扫描单个技能目录；失败只告警并返回空（单个目录坏掉不影响其余目录） */
async function scanSkillDir(dir: string, disabled: Set<string>): Promise<SkillInfo[]> {
  try {
    const env = await createExecEnv({ cwd: dir, allowedRoots: [dir] });
    const { skills } = await loadSkills(env, dir, BACKGROUND_CONTEXT);
    return skills.map(
      (skill): SkillInfo => ({
        name: skill.name,
        description: skill.description,
        filePath: skill.filePath,
        // 磁盘上的技能一律是用户添加；将来随应用附带内置技能时在这里区分
        source: "user",
        disabled: disabled.has(skill.name),
      }),
    );
  } catch (error) {
    console.warn(`扫描技能目录失败 ${dir}: ${String(error)}`);
    return [];
  }
}

/** 在全局技能目录里按名字找一个技能；找不到返回 null */
async function findGlobalSkill(name: string): Promise<SkillInfo | null> {
  const found = await scanSkillDir(globalSkillsDir(), new Set());
  return found.find((skill) => skill.name === name) ?? null;
}

export function registerSkillsIpc(): void {
  handle(
    IPC.skills.list,
    "读取技能列表",
    async (request?: { workingDir?: string }): Promise<SkillInfo[]> => {
      const settings = await loadSettings();
      const disabled = new Set(settings.disabledSkillNames);
      // 目录来源与顺序统一由 resources.ts 解析：数据目录 → 项目目录
      const dirs = resolveSkillDirs(request?.workingDir);
      const results = await Promise.all(dirs.map((dir) => scanSkillDir(dir, disabled)));
      // 同名技能按「先出现者优先」去重，保持列表稳定
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
    const skills = await scanSkillDir(targetDir, new Set());
    return { canceled: false, files, skills: skills.length, diagnostics };
  });

  handle(
    IPC.skills.read,
    "读取技能详情",
    async (request: { name: string }): Promise<SkillDetail> => {
      const skill = await findGlobalSkill(request.name);
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
    if (skill === null) throw new Error(`技能不存在：${request.name}`);
    const root = path.resolve(globalSkillsDir());
    const skillDir = path.resolve(path.dirname(skill.filePath));
    // 只删数据目录下的**技能目录**：SKILL.md 直接躺在 skills 根下时删掉整个目录就等于清空全局技能
    if (skillDir === root || !skillDir.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`)) {
      throw new Error(`只能删除数据目录 skills 子目录里的技能：${request.name}`);
    }
    await rm(skillDir, { recursive: true, force: true });
  });
}
