// IPC：CLI 工具检测（检测 lark-cli 等命令行工具是否已安装）
import { execFileSync } from "node:child_process";
import type { IpcMain, IpcMainInvokeEvent } from "electron";

// 检测指定 CLI 命令是否存在
function detectCli(cliName: string) {
  try {
    const command = process.platform === "win32" ? "where" : "which";
    execFileSync(command, [cliName], { timeout: 5000, encoding: "utf8" });
    return { exists: true, command: cliName };
  } catch {
    return { exists: false, command: cliName };
  }
}

// 获取 CLI 工具版本
function getCliVersion(cliName: string): string | null {
  try {
    const versionFlag = cliName === "python" || cliName === "python3" ? "--version" : "--version";
    const result = execFileSync(cliName, [versionFlag], {
      timeout: 5000,
      encoding: "utf8",
      shell: process.platform === "win32"
    });
    return result.trim().split("\n")[0];
  } catch {
    return null;
  }
}

// 批量检测 CLI 工具列表
async function detectCliTools(cliNames: string[]) {
  return cliNames.map((name) => detectCli(name));
}

// 批量获取 CLI 工具版本
async function getCliVersions(cliNames: string[]) {
  return cliNames.map((name) => ({
    command: name,
    version: getCliVersion(name)
  }));
}

function register(ipcMain: IpcMain) {
  ipcMain.handle("cli:detect", (_event: IpcMainInvokeEvent, { cliName }: { cliName: string }) => detectCli(cliName));
  ipcMain.handle("cli:detect-batch", (_event: IpcMainInvokeEvent, { cliNames }: { cliNames: string[] }) => detectCliTools(cliNames));
  ipcMain.handle("cli:get-versions", (_event: IpcMainInvokeEvent, { cliNames }: { cliNames: string[] }) => getCliVersions(cliNames));
}

export { register };
