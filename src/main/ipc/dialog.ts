// 对话框通道：把系统目录选择器暴露给设置面板（目前只有「默认工作目录」在用）。
// 只提供受控的目录选择，不透出其他 Electron dialog 能力。

import { BrowserWindow, dialog, ipcMain } from "electron";
import { IPC } from "@/shared/contracts/ipc";

export function registerDialogIpc(): void {
  ipcMain.handle(
    IPC.dialog.pickDirectory,
    async (event, request: { defaultPath?: string } | undefined): Promise<string | null> => {
      const parent = BrowserWindow.fromWebContents(event.sender);
      const options: Electron.OpenDialogOptions = {
        properties: ["openDirectory", "createDirectory"],
        ...(request?.defaultPath ? { defaultPath: request.defaultPath } : {}),
      };
      // 目录选择是用户主动操作，取消返回 null 由界面自行处理
      const result = parent
        ? await dialog.showOpenDialog(parent, options)
        : await dialog.showOpenDialog(options);
      if (result.canceled || result.filePaths.length === 0) return null;
      return result.filePaths[0] ?? null;
    },
  );
}
