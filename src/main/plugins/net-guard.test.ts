/**
 * 插件出站判据。
 *
 * 这一组是**出站白名单的执行点**的判据部分 —— 方案里 `net.domains` 那个字段
 * 之前只是一张写在清单里的纸，这里决定它到底管住了什么。
 *
 * 每条拒绝都对应一类真实绕过，注释里写明了是哪一类。
 */

import { describe, expect, it } from "vitest";
import { checkOutboundUrl, isHostAllowed } from "./net-guard";

describe("isHostAllowed", () => {
  it("精确匹配", () => {
    expect(isHostAllowed("api.example.com", ["api.example.com"])).toBe(true);
  });

  it("大小写不敏感（URL 的 host 会被小写化，白名单是人手写的）", () => {
    expect(isHostAllowed("API.Example.COM", ["api.example.com"])).toBe(true);
    expect(isHostAllowed("api.example.com", ["Api.Example.Com"])).toBe(true);
  });

  it("**子域通配不包含根域**（严格解释）", () => {
    expect(isHostAllowed("a.example.com", ["*.example.com"])).toBe(true);
    expect(isHostAllowed("a.b.example.com", ["*.example.com"])).toBe(true);
    // 写 `*.example.com` 的人要的通常就是子域；"顺带包含根域"是各家实现的分歧点
    expect(isHostAllowed("example.com", ["*.example.com"])).toBe(false);
  });

  it("**前缀相近的域名不会误命中**", () => {
    // 用 endsWith(suffix) 而不是 endsWith("." + suffix) 时，这条会挂
    expect(isHostAllowed("evil-example.com", ["*.example.com"])).toBe(false);
    expect(isHostAllowed("notexample.com", ["example.com"])).toBe(false);
    expect(isHostAllowed("example.com.evil.com", ["example.com"])).toBe(false);
  });

  it("空数组什么都不许（没写 = 拒绝）", () => {
    expect(isHostAllowed("example.com", [])).toBe(false);
  });

  it("空白项被跳过（手写的清单里常见多余空格）", () => {
    expect(isHostAllowed("example.com", ["", "  ", "example.com"])).toBe(true);
  });
});

describe("checkOutboundUrl", () => {
  const domains = ["api.example.com", "*.cdn.example.com"];

  it("白名单内的 https 通过", () => {
    const result = checkOutboundUrl("https://api.example.com/v1/items?q=1", domains);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.host).toBe("api.example.com");
  });

  it.each([
    ["file 协议", "file:///C:/Windows/System32/config/SAM"],
    ["data 协议", "data:text/html,<script>1</script>"],
    ["blob 协议", "blob:https://api.example.com/x"],
    ["ftp 协议", "ftp://api.example.com/x"],
  ])("**%s 被拒** —— 只允许 http/https", (_label, url) => {
    const result = checkOutboundUrl(url, domains);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("http");
  });

  it("**用查询串伪装的白名单域名不管用**（判据比的是 host）", () => {
    // 朴素的 url.includes(domain) 会在这里放行
    const result = checkOutboundUrl("https://evil.com/?next=api.example.com", domains);
    expect(result.ok).toBe(false);
  });

  it("**用子域名伪装的白名单域名不管用**", () => {
    const result = checkOutboundUrl("https://api.example.com.evil.com/x", domains);
    expect(result.ok).toBe(false);
  });

  it.each([
    ["回环", "http://127.0.0.1:8080/x"],
    ["localhost", "http://localhost:3000/x"],
    ["10 段", "http://10.0.0.5/x"],
    ["192.168 段", "http://192.168.1.1/x"],
    ["172.16 段", "http://172.16.0.1/x"],
    ["链路本地（云元数据）", "http://169.254.169.254/latest/meta-data/"],
  ])("**%s 被拒** —— 那是用户自己的机器", (_label, url) => {
    const result = checkOutboundUrl(url, [...domains, "127.0.0.1", "localhost"]);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("本机/内网");
  });

  it("没声明白名单时给出**说清原因**的文案", () => {
    const result = checkOutboundUrl("https://api.example.com/", []);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("没有声明 net.domains");
  });

  it("不在白名单里时把白名单列出来（作者一眼看得出写漏了什么）", () => {
    const result = checkOutboundUrl("https://other.com/", domains);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("api.example.com");
  });

  it("不是 URL / 没有主机名都被拒", () => {
    expect(checkOutboundUrl("not a url", domains).ok).toBe(false);
    expect(checkOutboundUrl("https://", domains).ok).toBe(false);
  });

  it("端口不算问题（判据只看 host）", () => {
    expect(checkOutboundUrl("https://api.example.com:8443/x", domains).ok).toBe(true);
  });
});
