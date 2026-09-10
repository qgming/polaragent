import { app, ipcMain } from "electron";
import { dataDir } from "@/main/app/paths";
import type { AppInfo } from "@/shared/contracts/app";
import { IPC } from "@/shared/contracts/ipc";

export function registerAppIpc(): void {
  ipcMain.handle(
    IPC.app.getInfo,
    (): AppInfo => ({
      name: app.getName(),
      version: app.getVersion(),
      platform: process.platform,
      dataDir: dataDir(),
    }),
  );
}
