import path from "node:path";
import { app, ipcMain, shell } from "electron";
import { readKernelDependencies } from "@/main/app/kernel-deps";
import { dataDir } from "@/main/app/paths";
import type { AppInfo } from "@/shared/contracts/app";
import { IPC } from "@/shared/contracts/ipc";

export function registerAppIpc(): void {
  ipcMain.handle(
    IPC.app.getInfo,
    async (): Promise<AppInfo> => ({
      name: app.getName(),
      version: app.getVersion(),
      kernel: await readKernelDependencies(app.getAppPath()),
      dataDir: dataDir(),
    }),
  );

  ipcMain.handle(
    IPC.app.openPath,
    async (
      _event,
      request: { path: string },
    ): Promise<{ ok: true } | { ok: false; reason: string }> => {
      try {
        const target = request?.path;
        if (typeof target !== "string" || target.trim() === "" || !path.isAbsolute(target)) {
          return { ok: false, reason: "invalid-path" };
        }
        const message = await shell.openPath(target);
        return message === "" ? { ok: true } : { ok: false, reason: message };
      } catch (error) {
        return { ok: false, reason: String(error) };
      }
    },
  );
}
