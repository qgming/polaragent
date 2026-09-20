// paths 单测：数据根解析（默认 / OINT_HOME 覆盖 / 非法值回落）、子目录补建与遗留临时文件清理。
import { existsSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPermissionRuleStore } from "@/main/pisdk/permissions";
import { createSessionsIndex } from "@/main/pisdk/sessions-index";
import { createSettingsStore, DEFAULT_SETTINGS } from "@/main/settings/store";
import { DATA_DIR_ENV, dataDir, ensureAppDirs, purgeStaleTempFiles, resolveDataDir } from "./paths";

/** 固定的假家目录：期望值全部用 path.join 拼，跨平台不受分隔符影响 */
const HOME = path.resolve(path.sep, "home", "tester");
const DEFAULT_DIR = path.join(HOME, ".oint");

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "oint-paths-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveDataDir", () => {
  it("未设置 OINT_HOME 时用家目录下的 .oint", () => {
    expect(resolveDataDir({ env: {}, home: HOME })).toBe(DEFAULT_DIR);
  });

  it("空白值等同未设置", () => {
    expect(resolveDataDir({ env: { [DATA_DIR_ENV]: "   " }, home: HOME })).toBe(DEFAULT_DIR);
  });

  it("OINT_HOME 为绝对路径时原样采用", () => {
    const custom = path.resolve(path.sep, "data", "oint-home");
    expect(resolveDataDir({ env: { [DATA_DIR_ENV]: custom }, home: HOME })).toBe(custom);
  });

  it("OINT_HOME 为相对路径时告警并回落到默认值", () => {
    const warn = vi.fn();
    const resolved = resolveDataDir({
      env: { [DATA_DIR_ENV]: "relative/data" },
      home: HOME,
      warn,
    });
    expect(resolved).toBe(DEFAULT_DIR);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("必须是绝对路径"));
  });

  it("不去读进程环境（env 完全由调用方注入）", () => {
    // 默认参数才读 process.env；显式注入后结果只由注入值决定
    expect(resolveDataDir({ env: {}, home: HOME })).toBe(DEFAULT_DIR);
  });
});

describe("ensureAppDirs", () => {
  it("创建数据目录与既定子目录，且不再创建已废弃的 config / logs", () => {
    const dir = path.join(makeTempDir(), "data");
    ensureAppDirs(dir);

    expect(existsSync(dir)).toBe(true);
    for (const name of ["sessions", "skills", "cache"]) {
      expect(existsSync(path.join(dir, name))).toBe(true);
    }
    expect(existsSync(path.join(dir, "config"))).toBe(false);
    expect(existsSync(path.join(dir, "logs"))).toBe(false);
  });

  it("重复调用安全（幂等）", () => {
    const dir = path.join(makeTempDir(), "data");
    ensureAppDirs(dir);
    expect(() => ensureAppDirs(dir)).not.toThrow();
  });

  it.runIf(process.platform !== "win32")("数据目录权限为 700（仅当前用户可访问）", () => {
    const dir = path.join(makeTempDir(), "data");
    ensureAppDirs(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(dir, "sessions")).mode & 0o777).toBe(0o700);
  });
});

/**
 * 原子写临时文件的清理（P2-2）。
 *
 * 五处配置写入都走「写临时文件 → rename」。正常路径下临时文件会被 rename 掉，
 * 但在 rename 之前失败（进程被杀、磁盘满）就会留下 `<file>.<pid>.<ts>.tmp`：
 * 实测本机数据根积了 7 个（48~78 KB，最早两周前），此前没有任何机制回收它们。
 */
describe("purgeStaleTempFiles", () => {
  /** 造一个临时文件并把 mtime 拨到指定年龄 */
  function makeTempFile(dir: string, name: string, ageMs: number): string {
    const file = path.join(dir, name);
    writeFileSync(file, "{}", "utf8");
    const when = (Date.now() - ageMs) / 1000;
    utimesSync(file, when, when);
    return file;
  }

  it("老临时文件被清掉，新鲜的留着（可能是正在进行的写入）", () => {
    const dir = makeTempDir();
    const stale = makeTempFile(dir, "sessions-index.json.123.456.tmp", 30 * 60 * 1000);
    const fresh = makeTempFile(dir, "settings.json.999.111.tmp", 0);

    const removed = purgeStaleTempFiles(dir);

    expect(removed).toBe(1);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  it("非 .tmp 文件一律不动（尤其不能碰 settings.json 本身）", () => {
    const dir = makeTempDir();
    const settings = makeTempFile(dir, "settings.json", 60 * 60 * 1000);
    const other = makeTempFile(dir, "AGENTS.md", 60 * 60 * 1000);

    purgeStaleTempFiles(dir);

    expect(existsSync(settings)).toBe(true);
    expect(existsSync(other)).toBe(true);
  });

  it("只看根目录直接子级，不递归进 sessions/", () => {
    const dir = makeTempDir();
    const sessions = path.join(dir, "sessions");
    ensureAppDirs(dir);
    const nested = makeTempFile(sessions, "x.sqlite.1.2.tmp", 60 * 60 * 1000);

    purgeStaleTempFiles(dir);

    expect(existsSync(nested)).toBe(true);
  });

  it("目录不存在时不抛错（首次启动）", () => {
    const missing = path.join(makeTempDir(), "never-created");
    expect(() => purgeStaleTempFiles(missing)).not.toThrow();
    expect(purgeStaleTempFiles(missing)).toBe(0);
  });

  it("ensureAppDirs 会顺带清理遗留临时文件", () => {
    const dir = makeTempDir();
    const stale = makeTempFile(dir, "projects.json.42.43.tmp", 60 * 60 * 1000);

    ensureAppDirs(dir);

    expect(existsSync(stale)).toBe(false);
  });
});

describe("数据目录布局", () => {
  it("三个存储都直接写在数据根下，不再嵌套 config/", async () => {
    const dir = path.join(makeTempDir(), "data");
    ensureAppDirs(dir);

    const settings = createSettingsStore(dir, { warn: () => {} });
    await settings.save({ ...DEFAULT_SETTINGS });

    const index = createSessionsIndex(dir);
    await index.update("session-1", { title: "布局检查" });

    const rules = createPermissionRuleStore(dir);
    await rules.add({ toolName: "read", createdAt: 1 });

    for (const name of ["settings.json", "sessions-index.json", "permission-rules.json"]) {
      expect(existsSync(path.join(dir, name))).toBe(true);
    }
    // 扁平化是刻意的：~/.oint 本身已是专属目录，再嵌一层 config/ 只会藏起文件
    expect(existsSync(path.join(dir, "config"))).toBe(false);
  });
});

describe("dataDir", () => {
  it.skipIf(process.env[DATA_DIR_ENV] !== undefined && process.env[DATA_DIR_ENV].trim() !== "")(
    "未设置 OINT_HOME 时指向家目录下的 .oint",
    () => {
      expect(dataDir()).toBe(path.join(homedir(), ".oint"));
    },
  );
});
