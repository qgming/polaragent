// AGENTS.md 通道：读写数据目录下的个性化指令文件。
// 该文件由 runtime 的 buildSystemPrompt 注入每轮系统提示词，这里是设置面板的读写入口。

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { ipcMain } from "electron";
import { dataDir } from "@/main/app/paths";
import { IPC } from "@/shared/contracts/ipc";

function agentsMdPath(): string {
  return path.join(dataDir(), "AGENTS.md");
}

export function registerAgentsIpc(): void {
  ipcMain.handle(IPC.agents.read, async (): Promise<string> => {
    try {
      return await readFile(agentsMdPath(), "utf8");
    } catch {
      // 文件不存在视为空内容，设置面板显示为空即可
      return "";
    }
  });

  ipcMain.handle(IPC.agents.write, async (_event, request: { content: string }) => {
    const filePath = agentsMdPath();
    await mkdir(path.dirname(filePath), { recursive: true });
    // 先写临时文件再 rename，避免中断时留下半截文件
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, request.content, "utf8");
    await rename(tempPath, filePath);
  });
}
