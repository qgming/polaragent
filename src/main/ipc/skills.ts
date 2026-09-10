// 技能扫描通道：把全局技能目录 + 会话工作目录下的 .pi/skills 汇总给设置面板。
// 技能内容的加载与注入由 pisdk 在运行时完成，这里只做「发现 + 展示」。

import { BACKGROUND_CONTEXT, loadSkills } from "@earendil-works/pi-agent-core";
import { ipcMain } from "electron";
import { dataDir } from "@/main/app/paths";
import { createExecEnv } from "@/main/pisdk/exec-env";
import { loadSettings } from "@/main/settings/store";
import { IPC } from "@/shared/contracts/ipc";
import type { SkillInfo } from "@/shared/contracts/skills";

/** 汇总技能目录：设置里的目录 + 数据目录 skills + 会话工作目录下的 .pi/skills */
async function resolveSkillDirs(
  workingDir?: string,
): Promise<Array<{ path: string; source: SkillInfo["source"] }>> {
  const settings = await loadSettings();
  const dirs: Array<{ path: string; source: SkillInfo["source"] }> = [];
  for (const dir of settings.skillDirs) {
    if (typeof dir === "string" && dir.trim() !== "") dirs.push({ path: dir, source: "global" });
  }
  // 数据目录下的 skills 作为全局默认位置，始终参与扫描
  dirs.push({ path: `${dataDir()}/skills`, source: "global" });
  if (workingDir !== undefined && workingDir !== "") {
    dirs.push({ path: `${workingDir}/.pi/skills`, source: "project" });
  }
  return dirs;
}

export function registerSkillsIpc(): void {
  ipcMain.handle(
    IPC.skills.list,
    async (_event, request: { workingDir?: string } | undefined): Promise<SkillInfo[]> => {
      const settings = await loadSettings();
      const disabled = new Set(settings.disabledSkillNames);
      const dirs = await resolveSkillDirs(request?.workingDir);
      // 逐个目录扫描：单个目录失败不影响其余目录
      const results = await Promise.all(
        dirs.map(async (dir) => {
          try {
            const env = await createExecEnv({ cwd: dir.path, allowedRoots: [dir.path] });
            const { skills } = await loadSkills(env, dir.path, BACKGROUND_CONTEXT);
            return skills.map(
              (skill): SkillInfo => ({
                name: skill.name,
                description: skill.description,
                filePath: skill.filePath,
                source: dir.source,
                disabled: disabled.has(skill.name),
              }),
            );
          } catch (error) {
            console.warn(`扫描技能目录失败 ${dir.path}: ${String(error)}`);
            return [];
          }
        }),
      );
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
}
