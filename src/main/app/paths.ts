// 应用路径：数据根固定在家目录的点目录（~/.oint，可用 OINT_HOME 覆盖），
// 与 Electron 的平台目录分开。
//
// 为什么要分层：Electron 的 userData 里绝大部分是 Chromium 缓存——实测数据目录 454 MB 中
// 442 MB 是 Cache / Code Cache / GPUCache，真正的应用数据（会话 + 设置 + 技能）只有约 10 MB。
// 把应用数据放进 ~/.oint 后，用户备份、同步、迁移、卸载都只碰这一个目录；
// Chromium 继续待在平台默认位置（%APPDATA%\Oint 等）自己管自己的缓存。
//
// 这里刻意不调用 app.setPath("userData")：那会把浏览器状态一起搬走，反而把缓存带回数据目录。

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** 覆盖数据根目录的环境变量（对齐 codex 的 CODEX_HOME） */
export const DATA_DIR_ENV = "OINT_HOME";

/** 家目录下的数据目录名 */
const DATA_DIR_NAME = ".oint";

/** 数据目录内的子目录；缺少时由 ensureAppDirs 补建 */
const DATA_SUBDIRS = ["sessions", "skills", "prompts", "subagents", "cache"] as const;

/** 数据目录权限：只允许当前用户访问（Windows 忽略该位） */
const DIR_MODE = 0o700;

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
}
