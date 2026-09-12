import path from "node:path";
import { describe, expect, it } from "vitest";
import { KERNEL_PACKAGES, readKernelDependencies } from "./kernel-deps";

/**
 * 用注入的读文件假件代替真实 node_modules：路径键与实现里 path.join 的拼法保持一致，
 * 这样既覆盖了取值顺序，又不受平台分隔符影响。
 */
function fakeReader(files: Record<string, unknown>) {
  const byPath = new Map(
    Object.entries(files).map(([file, content]) => [
      file,
      typeof content === "string" ? content : JSON.stringify(content),
    ]),
  );
  return (file: string): Promise<string> => {
    const content = byPath.get(file);
    if (content === undefined) return Promise.reject(new Error(`ENOENT: ${file}`));
    return Promise.resolve(content);
  };
}

const APP = path.join("D:", "apps", "oint");
const manifest = (name: string) => path.join(APP, "node_modules", name, "package.json");
const appManifest = path.join(APP, "package.json");

const [PI_CORE, PI_AI] = KERNEL_PACKAGES;

describe("readKernelDependencies", () => {
  it("按 KERNEL_PACKAGES 顺序返回两个内核，版本取实际安装版本", async () => {
    const read = fakeReader({
      [appManifest]: { dependencies: { [PI_CORE]: "^0.85.1", [PI_AI]: "^0.85.1" } },
      [manifest(PI_CORE)]: { name: PI_CORE, version: "0.85.1" },
      [manifest(PI_AI)]: { name: PI_AI, version: "0.85.2" },
    });

    await expect(readKernelDependencies(APP, read)).resolves.toEqual([
      { name: PI_CORE, version: "0.85.1" },
      { name: PI_AI, version: "0.85.2" },
    ]);
  });

  it("node_modules 读不到时回退到 package.json 声明的版本范围（去掉 ^ / ~ 前缀）", async () => {
    const read = fakeReader({
      [appManifest]: { dependencies: { [PI_CORE]: "~0.85.1", [PI_AI]: ">=0.85.1" } },
    });

    await expect(readKernelDependencies(APP, read)).resolves.toEqual([
      { name: PI_CORE, version: "0.85.1" },
      { name: PI_AI, version: "0.85.1" },
    ]);
  });

  it("两处都读不到时版本为 null（留空而不是编造）", async () => {
    const read = fakeReader({ [appManifest]: { dependencies: {} } });

    await expect(readKernelDependencies(APP, read)).resolves.toEqual([
      { name: PI_CORE, version: null },
      { name: PI_AI, version: null },
    ]);
  });

  it("package.json 内容不是合法 JSON 时不抛错，一律回退 null", async () => {
    const read = fakeReader({
      [appManifest]: "{ 这不是 JSON",
      [manifest(PI_CORE)]: { version: "0.85.1" },
      [manifest(PI_AI)]: { version: 85 },
    });

    await expect(readKernelDependencies(APP, read)).resolves.toEqual([
      { name: PI_CORE, version: "0.85.1" },
      // 版本号不是字符串：按读不到处理
      { name: PI_AI, version: null },
    ]);
  });
});
