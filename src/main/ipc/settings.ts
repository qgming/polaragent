import { ipcMain } from "electron";
import { loadSettings, saveSettings } from "@/main/settings/store";
import { IPC } from "@/shared/contracts/ipc";
import type { Settings } from "@/shared/contracts/settings";

/** IPC 通道与请求/响应形状保持不变，读写全部委托给设置存储层 */
export function registerSettingsIpc(): void {
  ipcMain.handle(IPC.settings.read, () => loadSettings());
  ipcMain.handle(IPC.settings.write, (_event, next: Settings) => saveSettings(next));
}
