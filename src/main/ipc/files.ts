import { IPC } from "@/shared/contracts/ipc";
import { listDirectory, readFileContent } from "../files/service";
import { handle } from "./handler";

/**
 * 文件域通道：右侧面板「文件」用。
 *
 * 两个动作都要求传 root（会话工作目录），主进程据此做路径守卫 ——
 * 面板因此只能浏览会话自己的项目，不会退化成任意路径读取器。
 */
export function registerFilesIpc(): void {
  handle(IPC.files.listDirectory, "列目录", (request: { root: string; path?: string }) =>
    listDirectory(request),
  );
  handle(IPC.files.readFile, "读取文件", (request: { root: string; path: string }) =>
    readFileContent(request),
  );
}
