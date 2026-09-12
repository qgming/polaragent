import path from "node:path";
import { app, ipcMain, shell } from "electron";
import { readKernelDependencies } from "@/main/app/kernel-deps";
import { readAppManifest } from "@/main/app/manifest";
import { dataDir } from "@/main/app/paths";
import type { AppInfo } from "@/shared/contracts/app";
import { IPC } from "@/shared/contracts/ipc";

export function registerAppIpc(): void {
  ipcMain.handle(IPC.app.getInfo, async (): Promise<AppInfo> => {
    // 显示名与版本一律读应用根目录的 package.json —— 不要用 app.getName() / app.getVersion()：
    // 它们在解析不到应用清单时会回退成 Electron 自身的名字/版本（"Electron" / "44.3.0"），
    // 「关于」就会显示一个看似合理的错数字。宁可留空。
    const appPath = app.getAppPath();
    const manifest = await readAppManifest(appPath);
    return {
      name: manifest.name,
      version: manifest.version,
      kernel: await readKernelDependencies(appPath),
      dataDir: dataDir(),
    };
  });

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
