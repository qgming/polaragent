// 插件界面桥的**主进程一侧**：身份校验 + 能力分发。
//
// ## 这个文件里最重要的是第一行
//
// 每个处理器都先 `requireOwner(event)`。它查的是 `event.sender.id` 在归属表里的登记，
// 而**不是**任何参数 —— 参数是插件写的，编号是主进程给的。这一条不成立的话，
// 下面所有能力检查都没有意义：一个插件可以声称自己是另一个插件。
//
// ## 与别的 ipc/*.ts 的分工差别
//
// 别的文件服务的是**我们自己的渲染层**（那份 preload 有 ~70 个方法，
// 每一个都是我们主动给的）。这一份服务的是**第三方页面**，所以：
//
//  - 参数一律重新校验（类型、长度、形状），不假设调用方守规矩；
//  - 每个能力都要看**清单里的权限**，而不是"能调到就说明有权限"；
//  - 参数一律重新校验；能力不足时**明确报出缺哪一个权限**，不静默失败。
//
// ## 通道命名
//
// 全部走 `IPC.surface.*`。这一组与主渲染层的通道**必须不重名** ——
// 通道是全局命名空间，一个恶意插件界面能直接 invoke `window.oint` 那一套的话，
// 归属表也救不了（那些处理器不查归属）。

import type { IpcMainInvokeEvent } from "electron";
import { checkOutboundUrl } from "@/main/plugins/net-guard";
import { getPluginRegistry } from "@/main/plugins/registry";
import { execForPlugin, type SurfaceExecResult } from "@/main/plugins/surface-exec";
import { getSurfaceOwners, type SurfaceOwner } from "@/main/plugins/surface-owners";
import {
  clearSurfaceStorage,
  surfaceStorageDelete,
  surfaceStorageGet,
  surfaceStorageKeys,
  surfaceStorageSet,
} from "@/main/plugins/surface-storage";
import { closePluginSurface } from "@/main/plugins/surfaces";
import { IPC } from "@/shared/contracts/ipc";
import { handleWithEvent } from "./handler";

/** 参数不合规（不是"操作失败"，是调用方写错了） */
class SurfaceBadRequestError extends Error {
  readonly code = "BAD_REQUEST";
  constructor(message: string) {
    super(message);
    this.name = "SurfaceBadRequestError";
  }
}

/**
 * **身份闸门**：把一次调用归到某个插件的某个界面上。
 *
 * 查不到就抛错。注意这条错误信息**刻意不透露细节**（不说"你的编号是几"、
 * 不说表里有什么）—— 一个没登记的 webContents 可能是主渲染层误调，
 * 也可能是一个试图探测的页面；两种情况都不需要更多信息。
 */
function requireOwner(event: IpcMainInvokeEvent): SurfaceOwner {
  const owner = getSurfaceOwners().ownerOf(event.sender.id);
  if (owner === undefined) {
    throw new SurfaceBadRequestError("这个界面没有在宿主登记，不能调用宿主接口");
  }
  return owner;
}

/**
 * 取归属，并**顺便确认那个插件仍然启用**。
 *
 * 为什么每一步都要再查一次"还启用着吗"：停用插件时我们会主动关掉它的界面
 *（见 disable 流程），但**关闭是异步的** —— 在那个窗口期里，页面还能发几个调用进来。
 * 只信归属表的话，那几次调用会照常执行。
 */
async function requireEnabledOwner(event: IpcMainInvokeEvent): Promise<SurfaceOwner> {
  const owner = requireOwner(event);
  const registry = getPluginRegistry();
  if (!registry.loaded) await registry.reload();
  const view = registry.find(owner.pluginId);
  if (view === undefined || !view.enabled) {
    throw new SurfaceBadRequestError("提供这个界面的插件已被停用");
  }
  return owner;
}

/** 检查清单里有没有某个权限；没有就明确说是哪一个 */
async function requirePermission(owner: SurfaceOwner, permission: string): Promise<void> {
  const registry = getPluginRegistry();
  if (!registry.loaded) await registry.reload();
  const view = registry.find(owner.pluginId);
  const granted = view?.permissions.some((item) => item.id === permission) ?? false;
  if (!granted) {
    throw new SurfaceBadRequestError(`插件 ${owner.pluginId} 没有申请 "${permission}" 权限`);
  }
}

export function registerSurfaceIpc(): void {
  handleWithEvent(
    IPC.surface.ready,
    "插件界面就绪",
    async (event: IpcMainInvokeEvent): Promise<void> => {
      // 只校验身份：宿主不需要"知道我画好了"这个状态做别的事（撤骨架屏由渲染层管）
      await requireEnabledOwner(event);
    },
  );

  handleWithEvent(
    IPC.surface.close,
    "关闭插件界面",
    async (event: IpcMainInvokeEvent): Promise<void> => {
      const owner = await requireEnabledOwner(event);
      await closePluginSurface(owner, event.sender.id);
    },
  );

  handleWithEvent(
    IPC.surface.storageGet,
    "读取插件存储",
    async (event: IpcMainInvokeEvent, key: unknown) => {
      const owner = await requireOwner(event);
      // storage 是 low 风险能力，但仍然要求清单里写着它 —— "能调到"不等于"有权限"
      await requirePermission(owner, "storage");
      return surfaceStorageGet(owner.pluginId, String(key));
    },
  );

  handleWithEvent(
    IPC.surface.storageSet,
    "写入插件存储",
    async (event: IpcMainInvokeEvent, key: unknown, value: unknown): Promise<void> => {
      const owner = await requireOwner(event);
      await requirePermission(owner, "storage");
      await surfaceStorageSet(owner.pluginId, String(key), value);
    },
  );

  handleWithEvent(
    IPC.surface.storageDelete,
    "删除插件存储键",
    async (event: IpcMainInvokeEvent, key: unknown): Promise<void> => {
      const owner = await requireOwner(event);
      await requirePermission(owner, "storage");
      await surfaceStorageDelete(owner.pluginId, String(key));
    },
  );

  handleWithEvent(
    IPC.surface.storageKeys,
    "列出插件存储键",
    async (event: IpcMainInvokeEvent): Promise<string[]> => {
      const owner = await requireOwner(event);
      await requirePermission(owner, "storage");
      return surfaceStorageKeys(owner.pluginId);
    },
  );

  /*
    剪贴板：**只写不读**。
    `clipboard.write` 与 `clipboard-read` 是两个方向完全不同的能力（见 window.ts 里
    内置浏览器权限门那段说明）：写是页面往用户那边放东西，读是页面把用户的东西拿走。
    所以这里没有 `readText`，`PluginPermission` 里也没有对应的项 —— 插件要读剪贴板
    的话，"能读"这件事本身就该是一次显式的新能力，而不是顺手加个方法。
  */
  handleWithEvent(
    IPC.surface.writeText,
    "插件界面写剪贴板",
    async (event: IpcMainInvokeEvent, text: unknown): Promise<void> => {
      const owner = await requireOwner(event);
      await requirePermission(owner, "clipboard.write");
      if (typeof text !== "string") {
        throw new SurfaceBadRequestError("writeText 的参数必须是字符串");
      }
      /*
        长度上限：剪贴板是**全局共享**的，而一次写入会覆盖用户自己复制的东西。
        一个插件把几百 MB 的字符串塞进系统剪贴板会让整机卡住（Windows 上尤其明显）。
        上限是"够放一段代码/一个路径/一段文本"与"不把系统搞卡"之间的取舍。
      */
      if (text.length > MAX_CLIPBOARD_CHARS) {
        throw new SurfaceBadRequestError(
          `一次最多写 ${MAX_CLIPBOARD_CHARS} 个字符到剪贴板（收到 ${text.length}）`,
        );
      }
      const { clipboard } = await import("electron");
      clipboard.writeText(text);
    },
  );

  handleWithEvent(
    IPC.surface.notify,
    "插件界面发通知",
    async (event: IpcMainInvokeEvent, title: unknown, body: unknown): Promise<void> => {
      const owner = await requireOwner(event);
      await requirePermission(owner, "notify");
      if (typeof title !== "string" || title === "") {
        throw new SurfaceBadRequestError("notify 的标题必须是非空字符串");
      }
      if (body !== undefined && typeof body !== "string") {
        throw new SurfaceBadRequestError("notify 的正文必须是字符串");
      }
      /*
        标题/正文都截断到上限，**而不是拒绝**。
        与工具说明那种"超限就拒绝"不同：通知是给人扫一眼的东西，截断的后果只是
        显示不全；而拒绝会让"任务完成了"这类通知整个发不出去 —— 那更糟。
        截断处加省略号，让用户看得出被截了。
      */
      const { Notification } = await import("electron");
      if (!Notification.isSupported()) {
        // 平台不支持时**明确失败**而不是静默：插件作者需要知道这条通知没发出去
        throw new SurfaceBadRequestError("当前系统不支持桌面通知");
      }
      new Notification({
        title: clamp(title, MAX_NOTIFY_CHARS),
        body: clamp(body ?? "", MAX_NOTIFY_CHARS),
      }).show();
    },
  );

  /** 当前会话的工作目录（没有会话时是空串） */
  handleWithEvent(
    IPC.surface.workspace,
    "读取插件界面的工作目录",
    async (event: IpcMainInvokeEvent) => {
      // 只校验身份：工作目录本身不是秘密，插件界面拿它是为了知道"该看哪个仓库"
      requireOwner(event);
      return getPluginRegistry().getWorkspaceDir() ?? "";
    },
  );

  /*
    执行命令。**这是 `shell.exec` 权限与清单白名单的执行点。**

    权限与白名单**两样都要**：
     - 权限说"这个插件可以跑命令"；
     - 白名单说"它能跑哪几条"。
    只有前者的话，一个申请了 `shell.exec` 的插件能跑任何东西；只有后者的话，
    清单里写个白名单就等于绕过权限。两者是"能不能"与"哪些"的关系，缺一不可。
  */
  handleWithEvent(
    IPC.surface.exec,
    "插件界面执行命令",
    async (
      event: IpcMainInvokeEvent,
      command: unknown,
      args: unknown,
      options: unknown,
    ): Promise<SurfaceExecResult> => {
      const owner = await requireEnabledOwner(event);
      await requirePermission(owner, "shell.exec");
      if (typeof command !== "string" || command === "") {
        throw new SurfaceBadRequestError("exec 的第一个参数必须是非空命令名");
      }

      const registry = getPluginRegistry();
      if (!registry.loaded) await registry.reload();
      const source = registry.sourceOf(owner.pluginId);
      const allowedCommands = source?.manifest.shell?.exec ?? [];

      /*
        **允许根只有当前工作目录。**
        不放行插件自己的数据目录：在数据目录里跑命令没有实际用途，
        而每多一个允许根就多一块"能被命令碰到的地方"。
      */
      const workspace = registry.getWorkspaceDir();
      if (workspace === undefined || workspace === "") {
        throw new SurfaceBadRequestError("还没有会话工作目录，不能执行命令");
      }

      const opts = (options ?? {}) as { cwd?: unknown; timeoutMs?: unknown };
      return execForPlugin({
        command,
        args: Array.isArray(args) ? args.filter((a): a is string => typeof a === "string") : [],
        cwd: typeof opts.cwd === "string" && opts.cwd !== "" ? opts.cwd : workspace,
        allowedCommands,
        allowedRoots: [workspace],
        ...(typeof opts.timeoutMs === "number" ? { timeoutMs: opts.timeoutMs } : {}),
      });
    },
  );

  /*
    出站请求：**这是 `net.domains` 的执行点。**

    白名单来自**清单**（主进程读的），不是请求里带的 —— 插件自报"我要去哪"等于没管。

    三条约束值得说明：
     1. **重定向逐跳检查**：允许的主机可以把人转到任意地方，只查第一跳等于没查。
        所以用 `redirect: "manual"` 自己跟，每一跳都重新过一遍判据；
     2. **响应体有上限**：一个恶意/失控的端点可以回一个 10 GB 的响应，
        而它在主进程内存里 —— 那是能把应用打死的一种；
     3. **不转发 Cookie / Authorization 到别的 host**：跨主机跳转时把它们摘掉，
        否则一次被允许的跳转就能把凭据带到白名单外的域。
  */
  handleWithEvent(
    IPC.surface.fetch,
    "插件界面出站请求",
    async (
      event: IpcMainInvokeEvent,
      url: unknown,
      init: unknown,
    ): Promise<{ status: number; headers: Record<string, string>; body: string }> => {
      const owner = await requireOwner(event);
      await requirePermission(owner, "net.fetch");
      if (typeof url !== "string" || url === "") {
        throw new SurfaceBadRequestError("fetch 的第一个参数必须是非空 URL 字符串");
      }

      const domains = await outboundDomains(owner.pluginId);
      const options = (init ?? {}) as {
        method?: unknown;
        headers?: unknown;
        body?: unknown;
      };

      let current = checkOutboundUrl(url, domains);
      if (!current.ok) throw new SurfaceBadRequestError(current.reason);

      const method = typeof options.method === "string" ? options.method.toUpperCase() : "GET";
      let headers = stringRecord(options.headers);
      const body = typeof options.body === "string" ? options.body : undefined;

      const { net } = await import("electron");
      let response: Response | undefined;

      for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        response = await net.fetch(current.url.toString(), {
          method,
          headers,
          ...(body === undefined || method === "GET" || method === "HEAD" ? {} : { body }),
          // 自己跟（见上面的第 1 条）
          redirect: "manual",
        });

        const location = response.headers.get("location");
        if (location === null || response.status < 300 || response.status >= 400) break;
        if (hop === MAX_REDIRECTS) {
          throw new SurfaceBadRequestError(`重定向超过 ${MAX_REDIRECTS} 跳`);
        }

        const next = new URL(location, current.url);
        const decision = checkOutboundUrl(next.toString(), domains);
        // **每一跳都重新判**：允许的主机把人转到别的地方是最常见的绕过
        if (!decision.ok) {
          throw new SurfaceBadRequestError(`重定向被拒：${decision.reason}`);
        }
        // 跨主机跳转时摘掉凭据（见上面的第 3 条）
        if (decision.host !== current.host) headers = stripCredentials(headers);
        current = decision;
      }

      if (response === undefined) throw new SurfaceBadRequestError("请求没有产生响应");

      const text = await readCapped(response);
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body: text,
      };
    },
  );
}

/** 一次出站的最大跳转数 */
const MAX_REDIRECTS = 5;

/** 响应体读取上限（字符）：它在主进程内存里，不受控的端点能把应用打死 */
const MAX_RESPONSE_CHARS = 5_000_000;

/**
 * 读响应体，**超限就停**。
 *
 * 用流式读而不是 `response.text()`：后者会把整个响应先收进内存，
 * 而我们恰恰是在防那件事。
 */
async function readCapped(response: Response): Promise<string> {
  const body = response.body;
  if (body === null) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let out = "";
  try {
    while (out.length < MAX_RESPONSE_CHARS) {
      const { done, value } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
    }
    out += decoder.decode();
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return out.length > MAX_RESPONSE_CHARS ? out.slice(0, MAX_RESPONSE_CHARS) : out;
}

/** 跨主机跳转时要摘掉的头 */
function stripCredentials(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (lower === "authorization" || lower === "cookie" || lower === "proxy-authorization")
      continue;
    out[key] = value;
  }
  return out;
}

/** 只保留字符串值的头（插件的 init 是外部输入） */
function stringRecord(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") out[key] = entry;
  }
  return out;
}

/** 取一个插件的出站白名单（清单里的 `net.domains`；没有就是空 = 什么都不许） */
async function outboundDomains(pluginId: string): Promise<string[]> {
  const registry = getPluginRegistry();
  if (!registry.loaded) await registry.reload();
  const source = registry.enabledSources().find((entry) => entry.id === pluginId);
  return [...(source?.manifest.net?.domains ?? [])];
}

/** 剪贴板单次写入的字符上限（理由见处理器的说明） */
const MAX_CLIPBOARD_CHARS = 1_000_000;

/** 通知标题/正文的字符上限 */
const MAX_NOTIFY_CHARS = 200;

/** 截断并留一个省略号 —— 让用户看得出显示不全，而不是以为内容就那么长 */
function clamp(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

export { SurfaceBadRequestError };

/**
 * 卸载插件时清掉它的存储。
 *
 * 放在这里而不是 registry：**"数据"是界面这一层的事**（存储是给界面用的），
 * 而注册表只管清单与启停。等 T1 有了插件进程，它的数据也走这个入口。
 */
export async function purgePluginData(pluginId: string): Promise<void> {
  await clearSurfaceStorage(pluginId, true);
}
