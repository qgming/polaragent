import { getSessionStore } from "@/main/pisdk/session-store";
import { IPC } from "@/shared/contracts/ipc";
import { listDirectory, readFileContent, readImageContent } from "../files/service";
import { handle } from "./handler";

/**
 * 文件域通道：右侧面板「文件」用。
 *
 * **根由主进程解析，渲染层给不了**：请求只带 sessionId，root 从会话索引里读出来。
 * 早先的实现让渲染层传 root，而主进程用 `validatePathAccess(root, [root])` 校验它 ——
 * 路径永远在它自己内部，那个判断恒真、等于没有校验，面板可以退化成任意路径读取器。
 *
 * 会话没绑定工作目录（或者 id 不存在）时直接拒绝：宁可面板空着，
 * 也不要落到「进程当前目录」这种含糊的默认值上 —— 那会让边界随启动方式漂移。
 */
async function resolveRoot(sessionId: unknown): Promise<string> {
  if (typeof sessionId !== "string" || sessionId.trim() === "") {
    throw new Error("缺少会话 id，无法确定文件面板的根目录");
  }
  const cwd = await getSessionStore().readCwd(sessionId);
  if (cwd === null) {
    throw new Error("该会话未绑定工作目录，文件面板不可用");
  }
  return cwd;
}

export function registerFilesIpc(): void {
  handle(
    IPC.files.listDirectory,
    "列目录",
    async (request: { sessionId: string; path?: string }) => {
      const root = await resolveRoot(request?.sessionId);
      return listDirectory({
        root,
        ...(request?.path === undefined ? {} : { path: request.path }),
      });
    },
  );
  handle(IPC.files.readFile, "读取文件", async (request: { sessionId: string; path: string }) => {
    const root = await resolveRoot(request?.sessionId);
    return readFileContent({ root, path: request?.path });
  });
  /**
   * 读一张图片。与 readFile 同一条守卫（root 由会话索引解析、目标必须落在 root 内），
   * 只是结果形态不同：那个回文本，这个回可直接显示的 dataUrl。
   */
  handle(IPC.files.readImage, "读取图片", async (request: { sessionId: string; path: string }) => {
    const root = await resolveRoot(request?.sessionId);
    return readImageContent({ root, path: request?.path });
  });
}
