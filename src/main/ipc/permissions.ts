// 权限规则通道：给设置面板提供「始终允许」规则的管理能力。
// 规则库与运行时权限门共用同一实例（见 pisdk/permissions.ts 的共享单例），避免缓存不同步。

import { ipcMain } from "electron";
import { dataDir } from "@/main/app/paths";
import { getSharedPermissionRuleStore } from "@/main/pisdk/permissions";
import { IPC } from "@/shared/contracts/ipc";
import type { PermissionRuleView } from "@/shared/contracts/permissions";

export function registerPermissionsIpc(): void {
  ipcMain.handle(IPC.permissions.listRules, async (): Promise<PermissionRuleView[]> => {
    const rules = await getSharedPermissionRuleStore(dataDir()).list();
    return rules.map((rule) => ({
      toolName: rule.toolName,
      ...(rule.pattern === undefined ? {} : { pattern: rule.pattern }),
      createdAt: rule.createdAt,
    }));
  });

  ipcMain.handle(IPC.permissions.addRule, async (_event, rule: PermissionRuleView) => {
    await getSharedPermissionRuleStore(dataDir()).add({
      toolName: rule.toolName,
      ...(rule.pattern === undefined ? {} : { pattern: rule.pattern }),
      createdAt: rule.createdAt || Date.now(),
    });
  });

  ipcMain.handle(
    IPC.permissions.removeRule,
    async (_event, request: { toolName: string; pattern?: string }) => {
      await getSharedPermissionRuleStore(dataDir()).remove(request.toolName, request.pattern);
    },
  );
}
