import { getSessionStore } from "@/main/pisdk/session-store";
import { IPC } from "@/shared/contracts/ipc";
import {
  listDirectory,
  readFileContent,
  readImageContent,
  writeFileContent,
} from "../files/service";
import { handle } from "./handler";

/**
 * 文件域通道：右侧面板「文件」用。
 *
 * **根由主进程解析，渲染层给不了**：请求只带 sessionId，root 从会话索引里读出来。
 * 早先的实现让渲染层传 root，而主进程用 `validatePathAccess(root, [root])` 校验它 ——
 * 路径永远在它自己内部，那个判断恒真、等于没有校验，面板可以退化成任意路径读取器。
 *
 * 会话没有绑定工作目录（历史会话，或在项目外新建的会话）时**现补一个本会话的临时目录**，
 * 而不是报错：报错的表现是「模型写过的文件在右侧一律打不开」。补出来的目录与会话同生命周期
 * （删除会话时一起清掉，见 session-store 的 removeWorkspace），用户显式让模型保存到别处的
 * 文件不在其中。
 *
 * 仍然不落到「进程当前目录」这种含糊的默认值上 —— 那会让边界随启动方式漂移；
 * 临时目录是按会话 id 算出来的确定路径。
 */
async function resolveRoot(sessionId: unknown): Promise<string> {
  if (typeof sessionId !== "string" || sessionId.trim() === "") {
    throw new Error("缺少会话 id，无法确定文件面板的根目录");
  }
  return getSessionStore().ensureCwd(sessionId);
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
  /**
   * 把编辑后的文本写回文件。
   *
   * root 的来源与上面三条完全相同（会话索引，渲染层给不了），所以「能写哪个目录」
   * 与「能读哪个目录」是同一套。**但路径守卫是 realpath 版**：写盘会让
   * 「root 内的符号链接指向外部」从只读边界变成真实损害，理由写在 files/service.ts
   * 的 writeFileContent 上。
   */
  handle(
    IPC.files.writeFile,
    "写入文件",
    async (request: { sessionId: string; path: string; text: string }) => {
      const root = await resolveRoot(request?.sessionId);
      return writeFileContent({
        root,
        path: request?.path,
        text: request?.text,
      });
    },
  );
}
