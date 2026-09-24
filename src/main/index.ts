import { app, BrowserWindow } from "electron";
import { IPC } from "@/shared/contracts/ipc";
import { ensureAppDirs } from "./app/paths";
import { createMainWindow, getMainWindow } from "./app/window";
import { disposeBrowser } from "./browser/service";
import { registerIpcHandlers } from "./ipc/registry";
import { bootstrapPisdk } from "./pisdk/bootstrap";
import { refreshPluginContributions } from "./plugins/contributions";
import { stopPluginProcesses } from "./plugins/process-host";
import { installPluginProtocol, registerPluginScheme } from "./plugins/protocol";
import { getPluginRegistry } from "./plugins/registry";
import { preparePluginPartitions } from "./plugins/surfaces";
import { disposeTerminalService } from "./terminal/service";

/*
  **必须在 app ready 之前**注册 `oint-plugin://` 的权限位。

  Electron 在初始化网络栈时读这份表，之后再注册**不报错也不生效** ——
  症状是"插件界面加载了但相对路径与 fetch 全坏"，而没有任何一条日志指向这里。
  放在模块顶层（而不是 whenReady 里面）就是为了让顺序在代码形状上成立。
*/
registerPluginScheme();

// 单实例锁：SQLite 会话库与窗口状态都不允许并发写
const gotSingleInstanceLock = app.requestSingleInstanceLock();

// pisdk 清理函数：退出前统一释放运行时与 sqlite 资源
let disposePisdk: (() => Promise<void>) | null = null;

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const win = getMainWindow();
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });

  // IPC 先注册再建窗口，保证渲染进程首帧调用即可用。
  // appPath 用来定位随包分发的内置插件（<appPath>/resources/plugins）——
  // 由这里注入而不是让 ipc 层 import electron（那会让它无法在 node 单测里跑）。
  registerIpcHandlers({ appPath: app.getAppPath() });

  void app.whenReady().then(async () => {
    ensureAppDirs();
    /*
      启动时先把插件的贡献面算出来，**再**装配 pisdk。

      顺序不能反：`resolveSkillDirs` 等三个解析函数读的是那份快照，而装配期的
      loadAgentResources 就在读它们。反过来的话，用户在打开插件面板之前启动的
      每一个会话都拿不到插件技能 —— 症状是「装了插件但技能时有时无」，
      而"时有时无"取决于他有没有点过插件管理。
    */
    await refreshPluginContributions({ appPath: app.getAppPath() });
    /*
      把已启用插件的分区提前准备好（协议处理器 + 权限门）。

      **必须在任何插件界面被创建之前** —— `<webview>` 一插进 DOM 就开始加载，
      那时再装就晚了：Chromium 会把 `oint-plugin://` 当外部协议交给操作系统。
    */
    preparePluginPartitions(
      getPluginRegistry()
        .enabledSources()
        .map((source) => source.id),
    );
    /*
      协议处理器要在 ready 之后装（权限位那一步在模块顶层，见上面）。
      顺序同样要紧：它服务的是插件界面资源，而上面那次 refresh 让注册表有了内容 ——
      反过来的话，插件窗口的第一批请求会在"注册表还没扫过盘"时到达。
      （真发生了也不会错：处理器自己会惰性 reload，只是白跑一次扫描。）
    */
    installPluginProtocol();
    // 装配 pisdk 并把聊天事件广播到所有窗口
    disposePisdk = bootstrapPisdk({
      emit: (event) => {
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send(IPC.chat.event, event);
        }
      },
    });
    createMainWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow();
      }
    });
  });
}

/**
 * 退出前释放 pisdk 与终端；清理函数幂等，重复触发安全。
 *
 * **必须 await**（所以先 preventDefault）：`disposePisdk` 要串行关闭每个会话的
 * harness / 存储、收掉 MCP 子进程，终端还要杀掉整棵 PTY 进程树 ——
 * 早先这里是「调用后立即返回」，进程可能在收尾中途退出：SQLite 没 flush、
 * 子进程变孤儿。终端尤其不能跳：PTY 的 shell 与它前台挂着的子进程不清理会留下
 * 占着端口的孤儿进程。
 *
 * 浏览器不需要额外清理：guest 进程随窗口一起销毁，disposeBrowser 只是不留悬挂引用。
 *
 * 另加**总超时**兜底：某个 store 卡住时不能让应用变成「关不掉」。
 * 但超时**不等于清理完成** —— 到点强退会把 SQLite 写入与子进程收尾截断在半路，
 * 所以这一点必须如实反映出来（退出码 + 日志），不能静默当成正常退出。
 */
const QUIT_TIMEOUT_MS = 3_000;
let quitting = false;

app.on("before-quit", (event) => {
  if (quitting) return;
  quitting = true;
  event.preventDefault();
  void (async () => {
    let timedOut = false;
    const timeout = new Promise<"timeout">((resolve) => {
      setTimeout(() => {
        timedOut = true;
        resolve("timeout");
      }, QUIT_TIMEOUT_MS);
      // 刻意不 unref：这个定时器是退出流程的一部分，必须活到 race 结束，
      // 否则事件循环可能在清理挂住时提前空转退出（那更糟：进程直接没了、日志都没有）。
    });
    const cleanup = (async (): Promise<"done"> => {
      /*
        插件进程**最先停**：它们是我们起的子进程，而下面的 disposePisdk 会关掉
        运行时与 sqlite —— 那时插件进程如果还活着，它的工具调用会打到已经关掉的
        东西上。反过来（先关运行时）的症状是退出时刷一片"插件进程已退出"的噪声日志。
      */
      stopPluginProcesses();
      disposeBrowser();
      disposeTerminalService();
      await disposePisdk?.();
      disposePisdk = null;
      return "done";
    })().catch((error: unknown) => {
      console.warn(`退出清理失败：${String(error)}`);
      return "done" as const;
    });
    const outcome = await Promise.race([cleanup, timeout]);
    if (timedOut || outcome === "timeout") {
      // 退出码 1：让「关不干净」这件事可被观察到（与正常退出区分）
      console.warn(
        `退出清理超过 ${QUIT_TIMEOUT_MS}ms 未完成，强制退出（可能残留未 flush 的写入或子进程）`,
      );
      app.exit(1);
      return;
    }
    app.exit(0);
  })();
});

// macOS 下关闭窗口不退出应用，其余平台沿用系统习惯
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
