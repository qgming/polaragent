// 应用路径：数据根固定在家目录的点目录（~/.oint，可用 OINT_HOME 覆盖），
// 与 Electron 的平台目录分开。
//
// 为什么要分层：Electron 的 userData 里绝大部分是 Chromium 缓存——实测数据目录 454 MB 中
// 442 MB 是 Cache / Code Cache / GPUCache，真正的应用数据（会话 + 设置 + 技能）只有约 10 MB。
// 把应用数据放进 ~/.oint 后，用户备份、同步、迁移、卸载都只碰这一个目录；
// Chromium 继续待在平台默认位置（%APPDATA%\Oint 等）自己管自己的缓存。
//
// 这里刻意不调用 app.setPath("userData")：那会把浏览器状态一起搬走，反而把缓存带回数据目录。

import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** 覆盖数据根目录的环境变量（对齐 codex 的 CODEX_HOME） */
export const DATA_DIR_ENV = "OINT_HOME";

/** 家目录下的数据目录名 */
const DATA_DIR_NAME = ".oint";

/** 数据目录内的子目录；缺少时由 ensureAppDirs 补建 */
const DATA_SUBDIRS = ["sessions", "skills", "prompts", "subagents", "cache", "plugins"] as const;

/** 数据目录权限：只允许当前用户访问（Windows 忽略该位） */
const DIR_MODE = 0o700;

/**
 * 插件私有数据目录的**目录名**归一。
 *
 * 插件的 id 是反向域名（`dev.example.git-lens`），它可以合法地含点与连字符 ——
 * 那在目录名里没问题，但**必须挡掉路径分隔符与 `..`**：id 来自一份第三方写的
 * 清单文件，`id: "../../etc"` 这种值是能通过"反向域名"这条正则之外的想象的。
 * 校验器已经要求了 `^[a-z0-9]+(\.[a-z0-9_-]+)+$`，这里再兜一层 ——
 * 因为**数据目录的路径拼接不能依赖"上游校验过了"**（将来 id 可能来自别处，
 * 比如市场目录）。
 *
 * 归一规则：白名单字符之外的**一切**替换成 `_`。于是 `..` 与 `/` 都变成下划线，
 * 拼出来的路径一定落在 plugins/ 里。
 */
export function pluginDirName(id: string): string {
  return id.replace(/[^a-z0-9._-]/gi, "_");
}

/** 插件根目录：`<dataDir>/plugins` */
export function pluginsDir(dir: string = dataDir()): string {
  return path.join(dir, "plugins");
}

/** 某个插件的私有数据目录：`<dataDir>/plugins/data/<sanitized-id>` */
export function pluginDataDir(id: string, dir: string = dataDir()): string {
  return path.join(pluginsDir(dir), "data", pluginDirName(id));
}

export interface ResolveDataDirOptions {
  /** 环境变量来源，默认 process.env */
  env?: Record<string, string | undefined>;
  /** 家目录，默认 os.homedir() */
  home?: string;
  /** 警告输出，默认 console.warn */
  warn?: (message: string) => void;
}

/**
 * 解析数据根目录：OINT_HOME 优先（必须是绝对路径），否则 ~/.oint。
 *
 * 相对路径记警告并回落默认值：设置文件本身就在这个目录里，语义含糊的路径比「静默写到奇怪的地方」更危险。
 */
export function resolveDataDir(options: ResolveDataDirOptions = {}): string {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const fallback = path.join(home, DATA_DIR_NAME);

  const raw = env[DATA_DIR_ENV]?.trim() ?? "";
  if (raw === "") return fallback;
  if (!path.isAbsolute(raw)) {
    warn(`${DATA_DIR_ENV} 必须是绝对路径，已回落到 ${fallback}：${raw}`);
    return fallback;
  }
  return path.resolve(raw);
}

/** 应用数据根目录；每次按当前环境解析，不缓存（环境变量在进程内不会变） */
export function dataDir(): string {
  return resolveDataDir();
}

/**
 * 启动时确保数据目录与子目录存在，后续写入无需再判空。
 * dir 可注入以便测试；生产调用不传，走 dataDir()。
 */
export function ensureAppDirs(dir: string = dataDir()): void {
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  for (const name of DATA_SUBDIRS) {
    mkdirSync(path.join(dir, name), { recursive: true, mode: DIR_MODE });
  }
  purgeStaleTempFiles(dir);
}

/** 原子写临时文件的后缀（`<file>.<pid>.<ts>.tmp`），六处原子写共用这一套命名 */
const TEMP_SUFFIX = ".tmp";
/** 超过这个年龄的临时文件即视为遗留（正常写入是毫秒级，分钟级还没被 rename 就是中断残留） */
const STALE_TEMP_MS = 10 * 60 * 1000;

/**
 * 清理数据根目录下遗留的原子写临时文件。
 *
 * 五处配置写入都走「写临时文件 → rename」：正常路径下临时文件会被 rename 掉，
 * 但在 rename 之前失败（进程被杀、磁盘满、权限问题）就会留下 `<file>.<pid>.<ts>.tmp`。
 * 实测本机数据根积了 7 个这样的文件（48~78 KB，最早两周前）—— 没有任何机制回收它们。
 *
 * 判据是**年龄**而不是 pid：pid 会被复用，而「十分钟前还没被 rename 掉」已经足够确定
 * 它是一次中断残留 —— 正常写入从创建到 rename 只有毫秒级。
 * 只看根目录的直接子级：临时文件只会出现在配置文件的旁边，不递归进 sessions/ 等子目录。
 */
export function purgeStaleTempFiles(dir: string, now: number = Date.now()): number {
  let removed = 0;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    // 目录还不存在（首次启动）或不可读：清理只是卫生工作，失败不该阻断启动
    return 0;
  }
  for (const name of names) {
    if (!name.endsWith(TEMP_SUFFIX)) continue;
    const target = path.join(dir, name);
    try {
      const info = statSync(target);
      if (!info.isFile()) continue;
      if (now - info.mtimeMs < STALE_TEMP_MS) continue;
      rmSync(target, { force: true });
      removed += 1;
    } catch {
      // 单个文件清理失败（被占用 / 刚好被删）：跳过，不影响其余文件
    }
  }
  return removed;
}
