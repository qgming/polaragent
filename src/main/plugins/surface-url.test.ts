/**
 * `oint-plugin://` 的 URL 形状与解析。
 *
 * 这一组用例是**越界读的防线**，所以重点全在"哪些形状必须被拒"。
 * 每一条拒绝都对应一类真实手法，见 parseSurfaceUrl 的注释。
 */

import { describe, expect, it } from "vitest";
import {
  isPluginSurfaceUrl,
  PLUGIN_SCHEME,
  parseSurfaceUrl,
  SURFACE_HOST,
  surfaceUrl,
} from "./surface-url";

describe("surfaceUrl", () => {
  it("拼出可解析的 URL", () => {
    const url = surfaceUrl("dev.example.git-lens", "./ui/git.html");
    expect(url).toBe(`${PLUGIN_SCHEME}://${SURFACE_HOST}/dev.example.git-lens/ui/git.html`);
    expect(parseSurfaceUrl(url)).toEqual({
      pluginId: "dev.example.git-lens",
      relativePath: "ui/git.html",
    });
  });

  it("开头的 ./ 被去掉（清单里的 entry 就是 ./ 开头的）", () => {
    expect(parseSurfaceUrl(surfaceUrl("a.b", "./x.html"))?.relativePath).toBe("x.html");
    expect(parseSurfaceUrl(surfaceUrl("a.b", "x.html"))?.relativePath).toBe("x.html");
  });

  it("路径里的空格与中文被编码，解析回来仍是原样", () => {
    const url = surfaceUrl("a.b", "./assets/my file 图表.png");
    expect(url).not.toContain(" ");
    expect(parseSurfaceUrl(url)?.relativePath).toBe("assets/my file 图表.png");
  });

  it("插件 id 里的点、连字符、下划线都不会出问题（这正是 host 不用 id 的理由）", () => {
    for (const id of ["dev.example.git-lens", "a.b_c", "x.y-z_w"]) {
      expect(parseSurfaceUrl(surfaceUrl(id, "index.html"))?.pluginId).toBe(id);
    }
  });
});

describe("parseSurfaceUrl 的拒绝", () => {
  it.each([
    ["别的 scheme", "https://surface/a.b/index.html"],
    ["file scheme", "file:///C:/Windows/System32/config/SAM"],
    ["host 不是 surface", `${PLUGIN_SCHEME}://elsewhere/a.b/index.html`],
    ["只有插件 id 没有文件", `${PLUGIN_SCHEME}://${SURFACE_HOST}/a.b`],
    ["只有 host", `${PLUGIN_SCHEME}://${SURFACE_HOST}/`],
    ["空串", ""],
    ["不是 URL", "not a url"],
  ])("%s → null", (_label, raw) => {
    expect(parseSurfaceUrl(raw)).toBeNull();
  });

  it("**路径穿越**：`..` 与它的编码形式都被拒", () => {
    for (const path of [
      "../secret",
      "%2e%2e/secret",
      "a/../../secret",
      "..%2fsecret",
      "a/%2E%2E/b",
    ]) {
      const raw = `${PLUGIN_SCHEME}://${SURFACE_HOST}/a.b/${path}`;
      // Chromium 的 URL 解析会先把一部分 `..` 归一掉，所以这里可能变成更深/更浅的路径；
      // 无论归一成什么，**都不能**得到一个指向插件目录之外的相对路径
      const parsed = parseSurfaceUrl(raw);
      if (parsed !== null) {
        expect(parsed.relativePath.split("/")).not.toContain("..");
      }
    }
  });

  it("**编码的分隔符**被拒（`%2f` 解码成 `/` 会让一段变两段）", () => {
    for (const segment of ["a%2Fb", "a%5Cb", "%2Fetc%2Fpasswd"]) {
      expect(parseSurfaceUrl(`${PLUGIN_SCHEME}://${SURFACE_HOST}/a.b/${segment}`)).toBeNull();
    }
  });

  it("**盘符与绝对路径**被拒", () => {
    for (const path of ["C:", "C:/Windows/System32"]) {
      const parsed = parseSurfaceUrl(`${PLUGIN_SCHEME}://${SURFACE_HOST}/a.b/${path}`);
      // `C:` 作为一段必须被拒；`C:/...` 拆成两段后 `C:` 那一段也要被拒
      expect(parsed).toBeNull();
    }
  });

  it("控制字符（含 NUL）被拒", () => {
    expect(parseSurfaceUrl(`${PLUGIN_SCHEME}://${SURFACE_HOST}/a.b/%00evil`)).toBeNull();
    expect(parseSurfaceUrl(`${PLUGIN_SCHEME}://${SURFACE_HOST}/a.b/%0Aevil`)).toBeNull();
  });

  it("带查询串或 hash 被拒（调用方对形状有误解，而不是「额外信息」）", () => {
    expect(parseSurfaceUrl(`${PLUGIN_SCHEME}://${SURFACE_HOST}/a.b/index.html?v=1`)).toBeNull();
    expect(parseSurfaceUrl(`${PLUGIN_SCHEME}://${SURFACE_HOST}/a.b/index.html#top`)).toBeNull();
  });

  it("坏的百分号编码被拒", () => {
    expect(parseSurfaceUrl(`${PLUGIN_SCHEME}://${SURFACE_HOST}/a.b/%ZZ`)).toBeNull();
  });
});

describe("isPluginSurfaceUrl", () => {
  it("只认 scheme —— 判断「能不能用自定义 preload」与「能不能解析成资源」是两件事", () => {
    expect(isPluginSurfaceUrl(`${PLUGIN_SCHEME}://${SURFACE_HOST}/a.b/x.html`)).toBe(true);
    // host 不对也算插件界面：它会收到 404，而不是悄悄退化成普通网页
    expect(isPluginSurfaceUrl(`${PLUGIN_SCHEME}://whatever/x`)).toBe(true);
  });

  it.each([["https://example.com"], ["file:///tmp/x"], ["about:blank"], [""]])(
    "%s 不是插件界面",
    (raw) => {
      expect(isPluginSurfaceUrl(raw)).toBe(false);
    },
  );
});
