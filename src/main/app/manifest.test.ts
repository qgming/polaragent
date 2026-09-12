import path from "node:path";
import { describe, expect, it } from "vitest";
import { readAppManifest } from "./manifest";

/** 与 kernel-deps.test.ts 同一套注入式假读件：路径键按 path.join 的拼法，不受平台分隔符影响 */
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
const manifestPath = path.join(APP, "package.json");

describe("readAppManifest", () => {
  it("显示名优先取 productName，版本取 version", async () => {
    const read = fakeReader({
      [manifestPath]: { name: "oint", productName: "Oint", version: "0.1.0" },
    });

    await expect(readAppManifest(APP, read)).resolves.toEqual({ name: "Oint", version: "0.1.0" });
  });

  it("没有 productName 时回退到 name", async () => {
    const read = fakeReader({ [manifestPath]: { name: "oint", version: "0.1.0" } });

    await expect(readAppManifest(APP, read)).resolves.toEqual({ name: "oint", version: "0.1.0" });
  });

  it("版本号原样透出，不做规范化（含预发布后缀）", async () => {
    const read = fakeReader({ [manifestPath]: { name: "oint", version: "0.1.0-beta.2" } });

    await expect(readAppManifest(APP, read)).resolves.toEqual({
      name: "oint",
      version: "0.1.0-beta.2",
    });
  });

  it("缺 version / 空白串 / 非字符串一律按读不到处理（留空而不编造）", async () => {
    const cases: Record<string, unknown>[] = [
      { name: "oint" },
      { name: "oint", version: "   " },
      { name: "oint", version: 1 },
    ];

    for (const raw of cases) {
      const read = fakeReader({ [manifestPath]: raw });
      await expect(readAppManifest(APP, read)).resolves.toEqual({ name: "oint", version: null });
    }
  });

  it("文件读不到 / JSON 非法 / 不是对象时都返回 null 对，且不抛错", async () => {
    const cases: Record<string, unknown>[] = [
      {},
      { [manifestPath]: "{ 这不是 JSON" },
      { [manifestPath]: "[1, 2]" },
      { [manifestPath]: "null" },
    ];

    for (const files of cases) {
      const read = fakeReader(files);
      await expect(readAppManifest(APP, read)).resolves.toEqual({ name: null, version: null });
    }
  });
});
