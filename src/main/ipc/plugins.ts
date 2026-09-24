// 插件通道：设置里那个插件管理模态窗的全部数据通路。
//
// 与 ipc/mcp.ts 同一分层：**注册表在别处单例持有（main/plugins/registry.ts），
// 这里只做转发与形状收口**。面板看到的「装了什么、什么状态、要什么权限」
// 就是运行时实际在用的那一份。
//
// ## 依赖注入的是 `appPath`，不是 electron
//
// `appPath` 由调用方（main/index.ts）注入 —— 与 resources.ts / kernel-deps.ts 同一手法：
// `app.getAppPath()` 只有 Electron 主进程拿得到，而这个文件不该自己去问。
//
// ⚠️ **这里是静态导入 electron 的**（早先不是）。当初为了"单测能跑"把它写成了一串
// `await import(...)`，但**没有任何测试导入这个文件** —— 那层间接什么都没换来，
// 只留下十几处动态导入，其中几个还被 rolldown 报 `INEFFECTIVE_DYNAMIC_IMPORT`
//（模块本来就在同一个 chunk 里，拆不出去）。测不动它的真实原因是它直接依赖 ipcMain，
// 而那与"静态还是动态导入 electron"无关。
//
// ## 全部通道都已接入
//
// **本期全部通道都已接入。** 曾经有一批抛 `PluginRuntimeUnavailableError` 的占位
//（安装 / 卸载 / 打开界面 / 打开数据目录），它们在 P6 与 S1–S3 落地后都换成了真实实现 ——
// 那个类也随之删掉了：留一个再也没人抛的错误类型，只会让后来的人以为还有没接完的东西。

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { BrowserWindow, dialog, nativeTheme, shell } from "electron";
import { dataDir, pluginDataDir } from "@/main/app/paths";
import { refreshPluginContributions } from "@/main/plugins/contributions";
import { exportPluginZip } from "@/main/plugins/export";
import {
  addDevPlugin,
  installPluginFromZip,
  removeDevPlugin,
  uninstallPlugin,
} from "@/main/plugins/install";
import { pluginCommands, pluginProcessIssues, runPluginCommand } from "@/main/plugins/process-host";
import { getPluginRegistry } from "@/main/plugins/registry";
import {
  broadcastSurfaceEvent,
  closeAllSurfacesOfPlugin,
  type OpenSurfaceResult,
  openPluginSurface,
  preparePluginPartitions,
  rememberSurfaceTheme,
} from "@/main/plugins/surfaces";
import { IPC } from "@/shared/contracts/ipc";
import type {
  PluginCommandView,
  PluginDiagnostic,
  PluginListResult,
  PluginMutationResult,
  PluginView,
} from "@/shared/contracts/plugin";
import { handle } from "./handler";

export interface PluginsIpcOptions {
  /** 应用根目录（内置插件住在 `<appPath>/resources/plugins`） */
  appPath?: string;
  warn?: (message: string) => void;
}

/** 用户取消对话框时的返回：**不是错误**，界面上不该弹"安装失败" */
function canceled(): PluginMutationResult {
  return { canceled: true, views: [], diagnostics: [] };
}

/** 安装对话框：只认 .ointplug 与 .zip（后者是作者最常见的打包产物） */
const installDialogOptions = {
  title: "选择插件包",
  properties: ["openFile" as const],
  filters: [
    { name: "Oint 插件包", extensions: ["ointplug"] },
    { name: "ZIP 压缩包", extensions: ["zip"] },
  ],
};

/** 开发插件选的是**目录**（里面要有 plugin.json），不是文件 */
const devDialogOptions = {
  title: "选择插件目录",
  properties: ["openDirectory" as const],
};

export function registerPluginsIpc(options: PluginsIpcOptions = {}): void {
  /*
    数据根目录由这里解析（注入 appPath 的同一手法）：ipc/plugins.ts 刻意不 import electron，
    而 paths 的 dataDir() 读环境变量、不依赖 electron —— 所以可以直接用。
  */
  const resolveDataDir = (): string => dataDir();
  const registry = getPluginRegistry({
    ...(options.appPath === undefined ? {} : { appPath: options.appPath }),
    ...(options.warn === undefined ? {} : { warn: options.warn }),
  });

  /**
   * 读列表：**每次调用都重新扫盘**。
   *
   * ## 为什么不是"扫过一次就够"
   *
   * 早先这里是 `if (!registry.loaded) await registry.reload()` —— 启动后只扫一次。
   * 后果是：**用户（或模型）往插件目录里放了一个插件，打开插件管理看不到它，
   * 必须重启应用**。而那正是这个功能最自然的用法（"我把插件放进去了，怎么没有"）。
   *
   * 代价是一次目录遍历（几个 readdir + 每个插件一次 readFile）。插件管理是
   * **用户显式打开**的界面，不是热路径 —— 用一次几十毫秒的扫描换"放进去就能看见"，
   * 这个交换毫无疑问。
   *
   * 顺带：`reload()` 也会让贡献面与进程池跟着对上（技能/提示/MCP/工具都读同一份），
   * 所以"新放进来的插件立刻能用"这句话对**全部**贡献面成立，不只是列表。
   */
  /**
   * 刷新贡献面 + 把插件的分区准备好。
   *
   * 两件事必须一起做：分区里要装 `oint-plugin://` 的协议处理器，
   * 而 `<webview>` 一旦开始加载就来不及了（见 preparePluginPartitions 的说明）。
   * 放在这里而不是界面创建时，是因为用户能点到面板时这一步一定已经跑过。
   */
  async function syncRuntime(): Promise<void> {
    await refreshPluginContributions(options);
    preparePluginPartitions(registry.enabledSources().map((source) => source.id));
  }

  async function list(): Promise<PluginView[]> {
    const views = await registry.reload();
    // 列表变了，贡献面、插件进程与分区都要跟着重算 —— 否则"列表里有了但技能还没生效"
    await syncRuntime();
    return views;
  }

  /*
    设置当前会话的工作目录。**只改状态，不立刻重扫** ——
    下一次 `list()` 本来就会重扫（见上面那段说明），而在这里顺手扫一遍
    意味着每次切会话都多一次目录遍历，换来的只是"切会话时列表已经更新了"，
    而那时用户根本没打开插件管理。
  */
  handle(
    IPC.plugins.setWorkspace,
    "设置插件扫描的工作目录",
    async (dir: unknown): Promise<void> => {
      registry.setWorkspaceDir(typeof dir === "string" && dir !== "" ? dir : undefined);
    },
  );

  handle(IPC.plugins.list, "读取插件列表", list);

  handle(IPC.plugins.diagnostics, "读取插件诊断", async (): Promise<PluginDiagnostic[]> => {
    // 与列表同一个口径：**每次重新扫** —— 诊断就是"这次扫描出了什么事"，
    // 用上次的结果等于是拿旧日志解释新问题
    await registry.reload();

    /*
      **进程启动失败 / 崩溃的记录也并进这里。**

      这是它们**唯一**的出口。早先 `pluginProcessIssues()` 被收集了却没有任何界面显示它 ——
      于是"插件的工具没进工具表"这种问题在界面上完全看不到原因，
      只能靠读代码猜（真发生过：工具表里少一个网关，而没有任何线索）。

      与清单诊断混在一起是刻意的：对用户来说"这个插件为什么没生效"是一个问题，
      而"清单不合法"与"进程没起来"只是它的两种答案。
    */
    const fromScan = registry.diagnostics(200);
    const fromProcess = pluginProcessIssues().map((issue, index) => ({
      pluginId: issue.pluginId,
      // 负数 seq：与扫描诊断（正数、按时间递增）分开放，界面上按 key 渲染不会撞
      seq: -1 - index,
      level: "error" as const,
      event: "process.start",
      message:
        issue.details.length === 0
          ? issue.message
          : `${issue.message}\n${issue.details.map((detail) => `  · ${detail}`).join("\n")}`,
      at: Date.now(),
    }));

    return [...fromProcess, ...fromScan].slice(0, 200);
  });

  /**
   * 启停共用的形状：找不到 id 由注册表抛错，`handle` 会把它包成可读文案。
   *
   * **改完状态必须重算贡献面。** 启用一个技能插件之后不重算的话，它的技能要等到
   * **下次启动**才生效 —— 而用户看到的是「点了启用，技能没出现」，
   * 于是他会再点一次、再重启一次，然后觉得插件系统不可靠。
   * 这是快照式设计的代价，三处刷新时机缺任何一处都会以这种形态暴露出来。
   */
  async function setEnabled(request: { id: string }, enabled: boolean): Promise<PluginListResult> {
    if (!registry.loaded) await registry.reload();
    const views = await registry.setEnabled(request.id, enabled);
    await syncRuntime();
    return { views, diagnostics: [] };
  }

  handle(
    IPC.plugins.enable,
    "启用插件",
    async (request: { id: string }): Promise<PluginListResult> => setEnabled(request, true),
  );

  handle(
    IPC.plugins.disable,
    "停用插件",
    async (request: { id: string }): Promise<PluginListResult> => setEnabled(request, false),
  );

  handle(IPC.plugins.reload, "重载插件列表", async (): Promise<PluginListResult> => {
    // 重载同样要重算贡献面：用户手改了磁盘上的插件目录之后点「重载」，
    // 期望的是"重新读一遍"，而不只是列表刷新
    const views = await registry.reload();
    await refreshPluginContributions(options);
    return { views, diagnostics: [] };
  });

  /*
    安装 / 卸载 / 开发挂载。

    三个都用**系统文件选择框**而不是"让渲染层把路径传进来"：路径来自渲染层的话，
    一个被 XSS 的界面（或将来某个插件界面）就能让宿主去解压任意位置的压缩包、
    或把任意目录挂成开发插件。选择框把"用户选了什么"这件事交回给操作系统 ——
    渲染层拿不到伪造的机会。

    取消（用户关掉对话框）**不是错误**：返回 `canceled: true` 而不是抛异常，
    否则界面上会弹一条"安装失败"，而用户只是按了取消。
  */
  handle(IPC.plugins.install, "安装插件", async (): Promise<PluginMutationResult> => {
    const parent = BrowserWindow.getFocusedWindow();
    const picked = parent
      ? await dialog.showOpenDialog(parent, installDialogOptions)
      : await dialog.showOpenDialog(installDialogOptions);
    if (picked.canceled || picked.filePaths.length === 0) return canceled();
    await installPluginFromZip(picked.filePaths[0] as string, resolveDataDir());
    await refreshPluginContributions(options);
    return { canceled: false, views: await registry.reload(), diagnostics: [] };
  });

  handle(IPC.plugins.loadDev, "加载开发插件", async (): Promise<PluginMutationResult> => {
    const parent = BrowserWindow.getFocusedWindow();
    const picked = parent
      ? await dialog.showOpenDialog(parent, devDialogOptions)
      : await dialog.showOpenDialog(devDialogOptions);
    if (picked.canceled || picked.filePaths.length === 0) return canceled();
    await addDevPlugin(picked.filePaths[0] as string, resolveDataDir());
    await refreshPluginContributions(options);
    return { canceled: false, views: await registry.reload(), diagnostics: [] };
  });

  handle(
    IPC.plugins.uninstall,
    "卸载插件",
    async (request: { id: string; keepData: boolean }): Promise<PluginListResult> => {
      if (!registry.loaded) await registry.reload();
      const view = registry.find(request.id);
      if (view === undefined) throw new Error(`找不到插件：${request.id}`);
      /*
        **内置插件不能卸载**（只能停用）。
        它随包分发、住在 asar 里 —— "删掉它"要么失败、要么删掉应用自己的文件。
        这一条同时是界面上的语义：内置插件的「卸载」按钮本来就不该出现，
        但渲染层可以撒谎，所以判据在这里。
      */
      if (view.source === "builtin") {
        throw new Error("内置插件不能卸载，可以停用它");
      }

      // **不看启停**：停用的插件同样要能卸载（见 registry.sourceOf 的说明）
      const source = registry.sourceOf(request.id);
      if (view.source === "dev") {
        // 开发插件是**解除挂载**，不删目录 —— 那是用户自己的代码
        await removeDevPlugin(source?.dir ?? request.id, resolveDataDir());
      } else {
        if (source === undefined) {
          throw new Error(`找不到插件目录：${request.id}（它可能已损坏）`);
        }
        await uninstallPlugin(
          { id: request.id, dir: source.dir },
          resolveDataDir(),
          request.keepData,
        );
      }

      /*
        顺序：先停进程与界面 → 再刷新贡献面 → 最后重扫列表。
        反过来的话，被卸载的插件的进程会短暂地指向已经不存在的文件，
        而它下一次工具调用会以 ENOENT 失败 —— 用户看到的是"卸载之后报了个错"。
      */
      closeAllSurfacesOfPlugin(request.id);
      await syncRuntime();
      return { views: await registry.reload(), diagnostics: [] };
    },
  );

  /*
    「打开界面」与「打开数据目录」都是**副作用型**通道：它们不改列表，
    所以不需要返回 PluginListResult。
    窗口类表面在这里建；面板类表面回一个标记，由渲染层去加右栏标签。
  */
  /*
    分享：把插件目录打成 zip 并让用户选保存位置。

    **只有 user / dev 能导出。** 内置插件住在 asar 里 —— 那个路径对用户没有意义
    （他没法把应用自带的东西"分享"给别人用），而且从 asar 里读文件要多一层特判。
    这条判据在主进程，不在渲染层：按钮藏起来挡不住直接调 IPC。

    保存路径**由系统对话框给**，不由渲染层传 —— 与安装那边同一条理由。
  */
  handle(
    IPC.plugins.export,
    "分享插件",
    async (request: {
      id: string;
    }): Promise<{ canceled: boolean; path?: string; files?: number; skipped?: string[] }> => {
      if (!registry.loaded) await registry.reload();
      const view = registry.find(request.id);
      if (view === undefined) throw new Error(`找不到插件：${request.id}`);
      if (view.source === "builtin") throw new Error("内置插件随应用分发，不能导出");

      const dir = registry.sourceOf(request.id)?.dir;
      if (dir === undefined) throw new Error(`找不到插件目录：${request.id}`);
      const parent = BrowserWindow.getFocusedWindow();
      const options = {
        title: "分享插件",
        defaultPath: `${request.id}.ointplug`,
        filters: [{ name: "Oint 插件包", extensions: ["ointplug"] }],
      };
      const picked = parent
        ? await dialog.showSaveDialog(parent, options)
        : await dialog.showSaveDialog(options);
      if (picked.canceled || picked.filePath === undefined || picked.filePath === "") {
        return { canceled: true };
      }
      const result = await exportPluginZip(dir, path.basename(dir));
      await writeFile(picked.filePath, result.archive);
      return {
        canceled: false,
        path: picked.filePath,
        files: result.files,
        skipped: result.skipped,
      };
    },
  );

  /*
    主题推送。**由我们自己的渲染层调用**，所以不查插件归属 ——
    主题的唯一真源在渲染层的设置里，主进程没有"主题变了"的事件源。

    送达数返回给调用方只用于诊断；0 是正常情况（没有插件声明 ui.theme）。
  */
  handle(
    IPC.plugins.broadcastTheme,
    "推送主题到插件界面",
    async (theme: unknown): Promise<number> => {
      /*
        `"system"` 在这里解析：`nativeTheme` 只有主进程拿得到，而渲染层自己猜
        操作系统现在是深色还是浅色一定会猜错（它读不到 `prefers-color-scheme` 的
        真实来源，只有一个可能过期的 matchMedia 快照）。
      */
      const resolved =
        theme === "system"
          ? nativeTheme.shouldUseDarkColors
            ? "dark"
            : "light"
          : theme === "dark"
            ? "dark"
            : "light";
      /*
        记下当前主题：**后开的**界面（面板 / 模态窗）的 guest 是渲染层建的，
        主进程只能在 will-attach-webview 里补 preload 参数，而那时它需要一个主题值 ——
        这里就是它唯一的来源（见 surfaces.ts 的 surfaceArgumentsForUrl）。
      */
      rememberSurfaceTheme(resolved);
      return broadcastSurfaceEvent("theme", resolved, "ui.theme");
    },
  );

  /*
    插件命令。

    `workspaceDir` 由渲染层给：主进程不知道"当前会话在看哪个目录"，而插件命令
    多半要针对那个目录做事。传空串表示没有特定工作目录 —— 插件自己决定怎么办
    （通常是报"没有工作目录"而不是猜一个）。
  */
  handle(
    IPC.plugins.commands,
    "列出插件命令",
    async (): Promise<PluginCommandView[]> => pluginCommands(),
  );

  handle(
    IPC.plugins.runCommand,
    "执行插件命令",
    async (
      id: unknown,
      args: unknown,
      workspaceDir: unknown,
    ): Promise<{ ok: boolean; text?: string; error?: string }> => {
      if (typeof id !== "string" || id === "") throw new Error("命令 id 必须是非空字符串");
      return runPluginCommand(
        id,
        typeof args === "string" ? args : "",
        typeof workspaceDir === "string" ? workspaceDir : "",
      );
    },
  );

  /*
    「打开界面」：窗口类建独立窗口，面板类**交给渲染层**去加一个右栏标签。

    分流不在主进程做：面板的宿主是渲染层的一个 React 组件，主进程没有它的句柄 ——
    要在这里建面板就得发明一个"往渲染层里插组件"的机制，而右栏注册表已经在做这件事。
    所以主进程只回答"该建窗口还是该加标签"，加标签由渲染层调 openRightPanel 完成。

    ⚠️ `@/main/plugins/surfaces` **动态导入**：那个模块 import 了 electron，
    而本文件刻意保持"不 import electron"（单测要能在 node 环境里跑）。
    顶层静态导入会让整个文件在 node 里加载失败，动态导入只在真的打开界面时才付这个代价。
  */
  handle(
    IPC.plugins.openSurface,
    "打开插件界面",
    async (request: { id: string; surfaceId: string }): Promise<OpenSurfaceResult> => {
      if (!registry.loaded) await registry.reload();
      const view = registry.find(request.id);
      if (view === undefined) throw new Error(`找不到插件：${request.id}`);
      const surface = view.surfaces.find((item) => item.id === request.surfaceId);
      if (surface === undefined) {
        throw new Error(`插件 ${request.id} 没有名为 ${request.surfaceId} 的界面`);
      }
      return openPluginSurface(request.id, request.surfaceId);
    },
  );

  /*
    「打开数据目录」：**先建目录再开**。
    插件从没写过数据时那个目录不存在，而"用文件管理器打开一个不存在的目录"
    在 Windows 上是静默失败（资源管理器弹一个错误框），用户会以为按钮坏了。
  */
  handle(
    IPC.plugins.revealData,
    "打开插件数据目录",
    async (request: { id: string }): Promise<{ ok: boolean }> => {
      if (registry.find(request.id) === undefined) {
        throw new Error(`找不到插件：${request.id}`);
      }
      const target = pluginDataDir(request.id);
      await mkdir(target, { recursive: true });
      const error = await shell.openPath(target);
      // openPath 用**返回值**表达失败（而不是抛错）：空串 = 成功
      if (error !== "") throw new Error(`打不开目录：${error}`);
      return { ok: true };
    },
  );
}
