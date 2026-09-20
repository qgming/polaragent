// 权限规则通道：给设置面板提供「始终允许」规则的管理能力。
// 规则库与运行时权限门共用同一实例（见 pisdk/permissions.ts 的共享单例），避免缓存不同步。

import { ipcMain } from "electron";
import { dataDir } from "@/main/app/paths";
import { getSharedPermissionRuleStore } from "@/main/pisdk/permissions";
import { IPC } from "@/shared/contracts/ipc";
import type { PermissionRuleView } from "@/shared/contracts/permissions";

/**
 * 校验一条要写入的规则。
 *
 * 拒绝面收在这里的理由：一条「无 pattern 的规则」等于把匹配到的工具**永久全局放行**
 *（`matchesPermissionRule` 对空 pattern 直接返回 true）。写入方是渲染层，
 * 而渲染层的输入又可能来自模型生成的内容 —— 让这条路能写宽规则，
 * 整条审批门的价值就只取决于渲染层有多可信。
 *
 * **前缀规则只允许 MCP 形态**（`mcp__<server>__*`）。
 *
 * 这里修过一个实测确认的漏洞：原来只判 `toolName.endsWith("*")`，
 * 而前缀匹配是 `toolName.startsWith(prefix)` —— 于是 `bash*` 直接放行了
 * bash 与 bash_background（含 `rm -rf /`），`w*` 放行了 write（可写
 * `~/.ssh/authorized_keys`）。当时注释还写着「前缀规则不覆盖内置工具」，与实现相反。
 *
 * 现在用 `/^mcp__[^_]+__\*$/` 收口：前缀规则只能作用于第三方 MCP server 的工具，
 * 而它正是 MCP 的必需形态（外部工具名与数量不可预知，逐工具写规则等于每次都要点卡）。
 * 内置工具（bash / write / edit / …）一律必须带 pattern。
 */
function assertWritableRule(rule: PermissionRuleView): void {
  if (typeof rule?.toolName !== "string" || rule.toolName.trim() === "") {
    throw new Error("规则缺少工具名");
  }
  const name = rule.toolName.trim();
  const isMcpPrefixRule = /^mcp__[^_]+__\*$/.test(name);
  if (name.endsWith("*") && !isMcpPrefixRule) {
    throw new Error(
      `只允许 MCP 形态的前缀规则（mcp__<server>__*）：${name}（通配内置工具等于把它永久全部放行）`,
    );
  }
  if (!isMcpPrefixRule && (rule.pattern === undefined || rule.pattern.trim() === "")) {
    throw new Error(`拒绝写入无匹配模式的规则：${name}（那等于把该工具永久全部放行）`);
  }
}

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
    assertWritableRule(rule);
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
