// 技能扫描通道：把全局技能目录 + 会话工作目录下的 .pi/skills 汇总给设置面板。
// 注意：这里只做「发现 + 展示」。技能内容的加载与注入应由 pisdk 运行时负责，但该接线尚未完成
// ——src/main/pisdk 下目前没有任何技能相关代码，本文件的 loadSkills 结果只喂给设置面板的技能
// 列表，不会进入模型上下文。将来接线 pisdk 运行时时要复用 resources.ts 的 resolveSkillDirs，
// 保证面板显示与实际注入同源。

import { BACKGROUND_CONTEXT, loadSkills } from "@earendil-works/pi-agent-core";
import { ipcMain } from "electron";
import { createExecEnv } from "@/main/pisdk/exec-env";
import { resolveSkillDirs } from "@/main/pisdk/resources";
import { loadSettings } from "@/main/settings/store";
import { IPC } from "@/shared/contracts/ipc";
import type { SkillInfo } from "@/shared/contracts/skills";

export function registerSkillsIpc(): void {
  ipcMain.handle(
    IPC.skills.list,
    async (_event, request: { workingDir?: string } | undefined): Promise<SkillInfo[]> => {
      const settings = await loadSettings();
      const disabled = new Set(settings.disabledSkillNames);
      // 目录来源与顺序统一由 resources.ts 解析：设置里的目录 → 数据目录 → 项目目录
      const dirs = resolveSkillDirs(settings, request?.workingDir);
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
