// paths 单测：数据根解析（默认 / OINT_HOME 覆盖 / 非法值回落）与子目录补建。
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPermissionRuleStore } from "@/main/pisdk/permissions";
import { createSessionsIndex } from "@/main/pisdk/sessions-index";
import { createSettingsStore, DEFAULT_SETTINGS } from "@/main/settings/store";
import { DATA_DIR_ENV, dataDir, ensureAppDirs, resolveDataDir } from "./paths";

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
