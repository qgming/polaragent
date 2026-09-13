import { IPC } from "@/shared/contracts/ipc";
import { getTerminalService } from "../terminal/service";
import { handle } from "./handler";

/**
 * 终端域通道。
 *
 * 输出不走 invoke 而是走 terminal:event 推送（见 main/terminal/service.ts 的 emit）：
 * 终端输出是持续的高频流，每次 ask 一遍会让渲染层为了「有没有新内容」反复轮询。
 * 这里只有「面板挂载时拉一次列表」与「用户动作」（建、写、改尺寸、关）。
 *
 * 事件出口由服务自己广播（与 chat 事件同一套 BroadcastWindow 做法），
 * 所以这个文件不需要知道窗口在哪。
 */
export function registerTerminalIpc(): void {
  handle(IPC.terminal.list, "读取终端列表", () => getTerminalService().list());
  handle(
    IPC.terminal.create,
    "新建终端",
    (request: { cwd: string; cols?: number; rows?: number }) =>
      getTerminalService().create(request),
  );
  handle(IPC.terminal.replay, "回放终端输出", (request: { id: string; fromSeq: number }) =>
    getTerminalService().replay(request.id, request.fromSeq),
  );
  // write / resize / close 是高频且「错了也无所谓」的动作（进程刚好退出就丢掉），
  // 但 IPC 契约要返回 Promise，所以同步返回 undefined 即可
  handle(IPC.terminal.write, "写入终端", (request: { id: string; data: string }) => {
    getTerminalService().write(request.id, request.data);
  });
  handle(
    IPC.terminal.resize,
    "调整终端尺寸",
    (request: { id: string; cols: number; rows: number }) => {
      getTerminalService().resize(request.id, request.cols, request.rows);
    },
  );
  handle(IPC.terminal.close, "关闭终端", (request: { id: string }) => {
    getTerminalService().close(request.id);
  });
}
