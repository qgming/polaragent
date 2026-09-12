// 提示模板扫描通道：把用户配置的模板目录 + 数据目录 prompts + 会话目录 .pi/prompts 汇总给设置面板。
// 与 ipc/skills.ts 同构：目录来源与顺序统一由 resources.ts 解析，逐目录独立扫描，最后按 name 去重。

import { BACKGROUND_CONTEXT, loadPromptTemplates } from "@earendil-works/pi-agent-core";
import { ipcMain } from "electron";
import { createExecEnv } from "@/main/pisdk/exec-env";
import { resolvePromptTemplateDirs } from "@/main/pisdk/resources";
import { loadSettings } from "@/main/settings/store";
import { IPC } from "@/shared/contracts/ipc";
import type { PromptTemplateInfo } from "@/shared/contracts/prompts";

export function registerPromptsIpc(): void {
  ipcMain.handle(
    IPC.prompts.list,
    async (_event, request: { workingDir?: string } | undefined): Promise<PromptTemplateInfo[]> => {
      const settings = await loadSettings();
      // 目录来源与顺序统一由 resources.ts 解析：设置里的目录 → 数据目录 → 项目目录
      const dirs = resolvePromptTemplateDirs(settings, request?.workingDir);
      // 逐个目录扫描：单个目录失败不影响其余目录
      const results = await Promise.all(
        dirs.map(async (dir) => {
          try {
            // 每个目录一个 env：allowedRoots 必须已包含该目录，否则 listDir / readTextFile 会被
            // 路径守卫拒绝，而内核只把它记成 diagnostics 警告 —— 接口上看起来就是「这个目录没有模板」。
            const env = await createExecEnv({ cwd: dir.path, allowedRoots: [dir.path] });
            const { promptTemplates, diagnostics } = await loadPromptTemplates(
              env,
              dir.path,
              BACKGROUND_CONTEXT,
            );
            for (const diagnostic of diagnostics) {
              console.warn(
                `提示模板加载警告（${diagnostic.code}）：${diagnostic.message}（${diagnostic.path}）`,
              );
            }
            return promptTemplates.map(
              (template): PromptTemplateInfo => ({
                name: template.name,
                // 内核里 description 可选，契约统一成字符串
                description: template.description ?? "",
                content: template.content,
                source: dir.source,
                dir: dir.path,
              }),
            );
          } catch (error) {
            console.warn(`扫描提示模板目录失败 ${dir.path}: ${String(error)}`);
            return [];
          }
        }),
      );
      // 同名模板按「先出现者优先」去重，保持列表稳定
      const seen = new Set<string>();
      const merged: PromptTemplateInfo[] = [];
      for (const template of results.flat()) {
        if (seen.has(template.name)) continue;
        seen.add(template.name);
        merged.push(template);
      }
      return merged;
    },
  );
}
