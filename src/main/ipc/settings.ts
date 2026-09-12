import { ipcMain } from "electron";
import { getMcpServers } from "@/main/pisdk/mcp-servers";
import { loadSettings, saveSettings } from "@/main/settings/store";
import { IPC } from "@/shared/contracts/ipc";
import type { Settings } from "@/shared/contracts/settings";

/** IPC 通道与请求/响应形状保持不变，读写全部委托给设置存储层 */
export function registerSettingsIpc(): void {
  ipcMain.handle(IPC.settings.read, () => loadSettings());
  ipcMain.handle(IPC.settings.write, async (_event, next: Settings) => {
    await saveSettings(next);
    // MCP server 列表可能刚被改过：让连接池按新配置对账。
    // 刻意不 await —— 新建连接要等子进程握手，不该让「保存设置」这个动作卡住渲染层；
    // 面板自己要的是即时反馈，它会另行调用 mcp:reload 并等结果。
    void getMcpServers()
      .reload()
      .catch((error: unknown) => {
        console.warn(`MCP 服务器重载失败：${String(error)}`);
      });
  });
}
