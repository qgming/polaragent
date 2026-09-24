import { type IpcMainInvokeEvent, ipcMain } from "electron";

/** 把底层异常转成带中文描述的错误：Electron invoke 会把 message 原样传回渲染层 */
function fail(action: string, error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(`${action}失败：${detail}`);
}

/**
 * 注册单个处理器并统一包裹异常与日志。
 *
 * ⚠️ **它不把 `IpcMainInvokeEvent` 传给回调** —— 只传载荷。
 *
 * 这是刻意的（绝大多数处理器要的是请求对象，不是事件），但它有一个**很难查的坑**：
 * 回调的参数表写错了**不会报类型错**（`TArgs` 是从回调反推的），
 * 而症状是"第一个参数拿到的是别的东西"。
 *
 * 真踩过：插件界面桥的处理器写成 `(event, command) => …`，实际收到的是
 * `(command, …)` —— 于是 `event.sender` 是 `undefined`，读 `.id` 抛
 * `Cannot read properties of undefined (reading 'id')`。
 * **整座桥（存储 / 通知 / 剪贴板 / 执行命令）全部不可用，而报错完全不指向原因。**
 *
 * 需要 event 就用 `handleWithEvent`，不要用这个。
 */
export function handle<TArgs extends unknown[], TResult>(
  channel: string,
  action: string,
  run: (...args: TArgs) => Promise<TResult> | TResult,
): void {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return await run(...(args as TArgs));
    } catch (error) {
      console.warn(`${action}失败：${String(error)}`);
      throw fail(action, error);
    }
  });
}

/**
 * 需要 `IpcMainInvokeEvent` 的处理器。
 *
 * 目前只有插件界面桥用它 —— 那一组的**每个**处理器都要按 `event.sender.id` 查归属表
 * 来确认"你是谁"（见 main/plugins/surface-owners.ts）。身份的判据是主进程给的
 * webContents 编号，所以 event 是必需的，不是便利。
 *
 * 与 `handle` 分成两个函数而不是给 `handle` 加一个开关：那种"传不传看情况"的签名
 * 会让上面那个坑重新变得可能 —— 而它已经害得整座桥静默失效过一次。
 */
export function handleWithEvent<TArgs extends unknown[], TResult>(
  channel: string,
  action: string,
  run: (event: IpcMainInvokeEvent, ...args: TArgs) => Promise<TResult> | TResult,
): void {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return await run(event, ...(args as TArgs));
    } catch (error) {
      console.warn(`${action}失败：${String(error)}`);
      throw fail(action, error);
    }
  });
}
