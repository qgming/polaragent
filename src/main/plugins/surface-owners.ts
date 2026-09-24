// 界面归属表：**哪一个 webContents 属于哪一个插件的哪一个界面**。
//
// ## 为什么这张表就是权限边界的全部
//
// 插件界面里的 JS 能调到宿主，靠的是 guest preload 暴露的 `ipcRenderer.invoke`。
// 于是"这个调用是谁发的"这个问题**不能问调用方** —— 插件可以随便在自己的参数里写
// `pluginId: "别的插件"`。唯一可信的来源是 `event.sender.id`（主进程给的、页面改不了的
// webContents 编号），而这张表就是那个编号 → 身份的映射。
//
// 所以：**不是靠"通道白名单"来限制插件**，而是靠"你这个 webContents 是谁"。
// 通道白名单挡不住"我调我自己被允许的那个通道，但声称我是别人"。
//
// ## 为什么不用 `event.senderFrame` 的 origin
//
// 因为 origin 是 `oint-plugin://surface` —— **所有插件共用同一个 origin**（host 固定，
// 见 surface-url.ts 的文件头）。那是刻意的：按插件分 host 会让 id 里的 `_` 与
// 大小写问题重新出现。代价就是 origin 分辨不出插件，必须由宿主在创建 webContents
// 的时候记下归属。
//
// ## 生命周期
//
// 登记发生在**创建 guest 的那一刻**（`did-attach-webview` / `BrowserWindow` 的
// `web-contents-created`），注销发生在销毁时。另外插件被停用/卸载时要**按插件批量清**——
// 否则一个已经停用的插件，它开着的界面仍然能继续调宿主。

/** 一个界面的归属 */
export interface SurfaceOwner {
  pluginId: string;
  /** 清单里的界面 id（`surfaces[].id`） */
  surfaceId: string;
  /**
   * `panel` 停在右栏里，`modal` 是应用内模态窗，`window` 是独立窗口。
   *
   * 三种形态**对权限判定完全等价**（宿主只看 pluginId，见文件头），这个字段的用途是
   * 「停用插件时该让渲染层关掉哪些」与诊断展示。
   */
  kind: "panel" | "window" | "modal";
}

export interface SurfaceOwners {
  /** 登记一个 webContents 的归属。重复登记会覆盖（见下面的说明） */
  claim(webContentsId: number, owner: SurfaceOwner): void;
  /** 注销；返回它原来属于谁（没登记过返回 undefined） */
  release(webContentsId: number): SurfaceOwner | undefined;
  /** 查归属；**这是所有桥接通道的入口判据** */
  ownerOf(webContentsId: number): SurfaceOwner | undefined;
  /** 某个插件当前开着的全部 webContents 编号（停用/卸载时按它批量关） */
  idsOfPlugin(pluginId: string): number[];
  /** 清空某个插件的全部登记；返回被清掉的编号 */
  releasePlugin(pluginId: string): number[];
  /**
   * 遍历全部登记。
   *
   * 给"宿主 → 全部界面"的广播用（主题变化是唯一一条反方向的消息）。
   * 返回副本：广播过程中可能有界面关掉自己，边遍历边改表是这类代码的经典 bug 源。
   */
  entries(): [number, SurfaceOwner][];
  /** 当前登记总数（诊断与测试用） */
  size(): number;
}

export function createSurfaceOwners(): SurfaceOwners {
  /*
    反转索引（插件 → 编号集合）与主表并存，而不是每次遍历主表。
    两个理由：`releasePlugin` 在停用插件时被调用，而那时可能已经有几十个界面开着；
    更重要的是**遍历主表删元素**这类写法很容易写出"边遍历边删"的 bug。
  */
  const owners = new Map<number, SurfaceOwner>();
  const byPlugin = new Map<string, Set<number>>();

  return {
    claim(webContentsId, owner) {
      /*
        重复登记**覆盖**而不是抛错。这一点与注册表那边（重复注册抛错）相反，是刻意的：
        这里登记的是"某个 webContents 现在是谁"，而**编号会被复用** ——
        Chromium 在 webContents 销毁后会把编号发给下一个。抛错的话，
        一次漏掉的 release 会让此后所有复用该编号的界面都装不上。
        覆盖是自我修复的。
      */
      const previous = owners.get(webContentsId);
      if (previous !== undefined) byPlugin.get(previous.pluginId)?.delete(webContentsId);

      owners.set(webContentsId, owner);
      let set = byPlugin.get(owner.pluginId);
      if (set === undefined) {
        set = new Set();
        byPlugin.set(owner.pluginId, set);
      }
      set.add(webContentsId);
    },

    release(webContentsId) {
      const owner = owners.get(webContentsId);
      if (owner === undefined) return undefined;
      owners.delete(webContentsId);
      const set = byPlugin.get(owner.pluginId);
      set?.delete(webContentsId);
      if (set !== undefined && set.size === 0) byPlugin.delete(owner.pluginId);
      return owner;
    },

    ownerOf: (webContentsId) => owners.get(webContentsId),

    idsOfPlugin: (pluginId) => [...(byPlugin.get(pluginId) ?? [])],

    releasePlugin(pluginId) {
      const ids = [...(byPlugin.get(pluginId) ?? [])];
      for (const id of ids) owners.delete(id);
      byPlugin.delete(pluginId);
      return ids;
    },

    entries: () => [...owners.entries()],

    size: () => owners.size,
  };
}

/**
 * 进程内唯一实例。
 *
 * 桥接的**每一个**通道都要查它，而创建界面的地方（协议、窗口、面板槽）分散在
 * 好几个模块里 —— 各自 new 一个的话，"登记在 A、查询在 B"会让所有插件界面都调不动宿主，
 * 而症状是"点了没反应"。
 */
let shared: SurfaceOwners | null = null;

export function getSurfaceOwners(): SurfaceOwners {
  shared ??= createSurfaceOwners();
  return shared;
}
