import { existsSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  applyShellOutputUpdate,
  BACKGROUND_CONTEXT,
  type ExecutionEnv,
  getOrThrow,
  type ShellOutputView,
} from "@earendil-works/pi-agent-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createExecEnv, resolveBashPath } from "./exec-env";

let root: string;
let env: ExecutionEnv;
// 临时根目录的兄弟文件：位于 allowedRoots 之外
const outsideFile = path.join(os.tmpdir(), `polaragent-outside-${process.pid}.txt`);

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "polaragent-exec-"));
  env = await createExecEnv({ cwd: root });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outsideFile, { force: true });
});

describe("resolveBashPath", () => {
  it("win32 下返回存在的 bash 路径或 undefined", () => {
    const resolved = resolveBashPath("win32");
    if (resolved === undefined) {
      expect(resolved).toBeUndefined();
      return;
    }
    expect(resolved.toLowerCase()).toContain("bash");
    expect(existsSync(resolved)).toBe(true);
  });

  it("同一平台的解析结果被缓存", () => {
    expect(resolveBashPath("win32")).toBe(resolveBashPath("win32"));
  });
});

describe("createExecEnv 路径守卫", () => {
  it("允许 cwd 内写入，拒绝 cwd 外写入且不产生文件", async () => {
    const inside = path.join(root, "sub", "a.txt");
    const writeInside = await env.writeFile(inside, "hello", BACKGROUND_CONTEXT);
    expect(writeInside.ok).toBe(true);
    expect(existsSync(inside)).toBe(true);

    const writeOutside = await env.writeFile(outsideFile, "x", BACKGROUND_CONTEXT);
    expect(writeOutside.ok).toBe(false);
    if (!writeOutside.ok) expect(writeOutside.error.code).toBe("permission_denied");
    expect(existsSync(outsideFile)).toBe(false);
  });

  it("拒绝 cwd 外读取与删除，外部文件保持原样", async () => {
    const readOutside = await env.readTextFile(outsideFile, BACKGROUND_CONTEXT);
    expect(readOutside.ok).toBe(false);

    // 先手工在外部建文件，确认 remove 被拒后文件仍在
    writeFileSync(outsideFile, "outside");
    const removeOutside = await env.remove(outsideFile, { force: true }, BACKGROUND_CONTEXT);
    expect(removeOutside.ok).toBe(false);
    expect(existsSync(outsideFile)).toBe(true);
  });

  it("cwd 内读、列表、存在性均正常", async () => {
    const file = path.join(root, "read-me.txt");
    getOrThrow(await env.writeFile(file, "line1\nline2\n", BACKGROUND_CONTEXT));

    expect(getOrThrow(await env.readTextFile(file, BACKGROUND_CONTEXT))).toBe("line1\nline2\n");
    expect(getOrThrow(await env.readTextLines(file, { maxLines: 1 }, BACKGROUND_CONTEXT))).toEqual([
      "line1",
    ]);
    expect(getOrThrow(await env.exists(file, BACKGROUND_CONTEXT))).toBe(true);
    expect(getOrThrow(await env.exists(path.join(root, "missing.txt"), BACKGROUND_CONTEXT))).toBe(
      false,
    );

    const names = getOrThrow(await env.listDir(root, BACKGROUND_CONTEXT)).map((info) => info.name);
    expect(names).toContain("read-me.txt");
  });

  it("cwd 内 exec 可用且能取回 stdout（无可用 shell 则跳过）", async () => {
    let view: ShellOutputView | undefined;
    const result = await env.exec(
      'node -e "console.log(1+1)"',
      {
        capture: { limits: { maxBytes: 64 * 1024, maxLines: 200 } },
        onUpdate: (update) => {
          view = applyShellOutputUpdate(view, update);
        },
      },
      BACKGROUND_CONTEXT,
    );

    if (!result.ok) {
      // 本机无可用 shell 时不判定失败，仅确认错误类型
      expect(["shell_unavailable", "spawn_error"]).toContain(result.error.code);
      return;
    }
    expect(result.value.exitCode).toBe(0);
    expect(view?.text ?? "").toContain("2");
  });
});
