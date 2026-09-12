import { ipcMain } from "electron";

/** 把底层异常转成带中文描述的错误：Electron invoke 会把 message 原样传回渲染层 */
function fail(action: string, error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(`${action}失败：${detail}`);
}

/** 注册单个处理器并统一包裹异常与日志 */
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
