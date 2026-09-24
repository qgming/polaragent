// `oint-plugin://` 的 URL 形状与解析。
//
// **纯函数、无 electron 依赖** —— 这一层是"插件界面能读到哪些文件"的判据，
// 每一条规则都要能单测。真正的文件读写在 protocol.ts（那里才有 fs 与 realpath）。
//
// ## 为什么 host 是固定的 `surface` 而不是插件 id
//
// 最自然的长相是 `oint-plugin://<pluginId>/index.html`，但**插件 id 不能安全地当
// hostname**：id 的文法是 `^[a-z0-9]+(\.[a-z0-9_-]+)+$`（反向域名），其中允许 `_`
// 与 `-`。`-` 在 hostname 里没问题，`_` 严格来说不合法 —— 各家解析器对它的容忍度
// 不一致，而"解析器之间不一致"正是绕过类漏洞的温床。另外 host 会被**自动小写化**，
// 今天 id 恰好全小写（校验器强制），但那是巧合而不是保证。
//
// 所以 host 固定成字面量 `surface`，插件 id 放进**第一个路径段**：
//
//     oint-plugin://surface/<pluginId>/<插件内的相对路径>
//
// 路径段由我们自己解码与校验，没有任何解析器的自由度。

/** 自定义协议名。注册在 main/plugins/protocol.ts */
export const PLUGIN_SCHEME = "oint-plugin";

/** 固定 host（理由见文件头） */
export const SURFACE_HOST = "surface";

/**
 * 拼一个界面资源的 URL。
 *
 * `relativePath` 来自清单里的 `entry` 或页面自己发起的相对请求，两种都应当是
 * 插件内的相对路径（`./ui/git.html` 或 `./x.js`）。
 */
export function surfaceUrl(pluginId: string, relativePath: string): string {
  const clean = relativePath.replace(/^\.?\//, "");
  return `${PLUGIN_SCHEME}://${SURFACE_HOST}/${encodeURIComponent(pluginId)}/${clean
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")}`;
}

/** 解析结果；`relativePath` 已经解码并逐段校验过 */
export interface ParsedSurfaceUrl {
  pluginId: string;
  relativePath: string;
}

/**
 * 解析一个 `oint-plugin://` URL。
 *
 * **不合法一律返回 null**，而不是"尽量解析" —— 这是一个越界读的入口，
 * 宽容解析在这里没有任何收益。下面每一条拒绝都对应一类真实手法：
 *
 *  - scheme / host 不匹配：不是我们的 URL，直接拒（避免被当成通用 file 代理）；
 *  - 路径段里出现 `..`（**解码之后**再判）：`%2e%2e%2f` 这类编码是教科书手法；
 *  - 段里出现分隔符或反斜杠（解码之后）：`%2f` 解码成 `/` 会让"一段"变成两段；
 *  - 绝对路径 / 盘符：`oint-plugin://surface/x/C:/Windows/...`；
 *  - 空段：`//` 这种。
 *
 * 需要注意 URL 解析器**已经**帮我们做了一部分（Chromium 会把 `..` 在解析阶段
 * 就归一掉）。但这里**不依赖它** —— 判据要在自己的代码里成立，
 * 而不是"因为上游恰好也做了"。
 */
export function parseSurfaceUrl(raw: string): ParsedSurfaceUrl | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== `${PLUGIN_SCHEME}:`) return null;
  if (url.hostname !== SURFACE_HOST) return null;
  // 查询串与 hash 不参与文件解析：带上它们说明调用方对形状有误解，而不是"额外信息"
  if (url.search !== "" || url.hash !== "") return null;

  const segments = url.pathname.split("/").filter((segment) => segment !== "");
  if (segments.length < 1) return null;

  const decoded: string[] = [];
  for (const segment of segments) {
    let value: string;
    try {
      value = decodeURIComponent(segment);
    } catch {
      // 坏的百分号编码
      return null;
    }
    if (value === "" || value === "." || value === "..") return null;
    if (value.includes("/") || value.includes("\\")) return null;
    // Windows 盘符与 UNC：`C:` 这种段不该出现在插件内的相对路径里
    if (/^[a-zA-Z]:$/.test(value)) return null;
    // NUL 与其它控制字符
    if (hasControlCharacter(value)) return null;
    decoded.push(value);
  }

  const pluginId = decoded[0];
  const relativePath = decoded.slice(1).join("/");
  // 只给了插件 id 没给文件：没有可服务的东西
  if (pluginId === undefined || relativePath === "") return null;

  return { pluginId, relativePath };
}

/**
 * 插件界面用的 Electron 分区名。
 *
 * **每个插件一个分区**，不是所有插件共用一个。理由不是洁癖：共用分区意味着共用
 * `localStorage` / `IndexedDB` / cookie —— 插件 A 的页面能直接读到插件 B 存的东西，
 * 而那是真实的数据泄漏。
 *
 * （这与"跨插件能读到一张图片"完全不是一个量级：图片是随包分发的静态资源，
 * 谁都能去读那个包；而 localStorage 里可能是插件 B 缓存的令牌或用户数据。）
 *
 * 归一规则把 id 压成 `[a-z0-9-]`：分区名最终会变成用户数据目录下的一个文件夹名，
 * 而 id 里允许 `.` 与 `_`。**归一必须与渲染层算出来的逐字相同** ——
 * 所以这个字符串只有主进程算，渲染层直接读 `PluginSurfaceInfo.partition`
 *（见契约里那条说明：两处各算一份，不一致的症状是权限阻挡悄悄失效）。
 */
/**
 * 插件分区的**前缀**。
 *
 * 单独导出是因为 `window.ts` 要靠它做反向判断："这个 guest 是不是插件界面" ——
 * 而那必须在 `will/did-attach-webview` 时就能判，那时 `getURL()` 往往还是空的，
 * **只有分区一定就绪**。
 */
export const PLUGIN_PARTITION_PREFIX = "persist:oint-plugin-";

export function pluginPartition(pluginId: string): string {
  return `${PLUGIN_PARTITION_PREFIX}${pluginId.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}

/**
 * 含 C0 控制字符（含 NUL）或 DEL 吗。
 *
 * 用显式循环而不是 `/[\u0000-\u001f]/` —— 一是 biome 的
 * `noControlCharactersInRegex` 会拦下那种写法（那个规则本身是对的：
 * 正则里的裸控制字符在编辑器里看不见），二是**顺手把 DEL（0x7f）也纳进来**，
 * 而它同样是文件名里不该出现的东西。
 */
function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * 这个 URL 是不是插件界面资源。
 *
 * 给 `hardenWebviews` 用：它要判断"这个 guest 是不是插件界面"来决定装不装 preload。
 * **只认 scheme**，不认 host —— 判断"能不能用自定义 preload"与"这个 URL 能不能被
 * 解析成资源"是两件事，后者失败时页面会收到 404，而不是悄悄退化成普通网页。
 */
export function isPluginSurfaceUrl(raw: string): boolean {
  return raw.startsWith(`${PLUGIN_SCHEME}://`);
}
