// 公网地址判定与连接钉死。
//
// 这是整个 web 能力里**唯一的安全边界**：web_fetch 的目标 URL 完全由模型指定，
// 所以「哪些地址不该被访问」这条规则错了，就等于把内网探测能力交给了模型。
// 下面每一条都是「错了会变成安全问题」的，不要因为看起来啰嗦就删。

import { describe, expect, it } from "vitest";
import { createPinnedLookup, isPublicIpAddress, stripIpv6Brackets } from "./network";

describe("isPublicIpAddress · 必须拒绝的 IPv4", () => {
  const blocked: [string, string][] = [
    ["0.0.0.0", "本网络"],
    ["0.1.2.3", "本网络段内"],
    ["10.0.0.1", "10/8 私有"],
    ["10.255.255.255", "10/8 私有上界"],
    ["100.64.0.1", "CGNAT 下界"],
    ["100.127.255.255", "CGNAT 上界"],
    ["127.0.0.1", "环回"],
    ["127.1.2.3", "整个 127/8 都是环回"],
    ["169.254.169.254", "云元数据端点"],
    ["169.254.0.1", "链路本地"],
    ["172.16.0.1", "172.16/12 下界"],
    ["172.31.255.255", "172.16/12 上界"],
    ["192.0.0.1", "IETF 保留"],
    ["192.0.2.5", "TEST-NET-1"],
    ["192.168.1.1", "家庭网段"],
    ["198.18.0.1", "基准测试"],
    ["198.51.100.5", "TEST-NET-2"],
    ["203.0.113.5", "TEST-NET-3"],
    ["224.0.0.1", "组播"],
    ["239.255.255.255", "组播上界"],
    ["240.0.0.1", "保留"],
    ["255.255.255.255", "广播"],
  ];

  for (const [address, why] of blocked) {
    it(`拒绝 ${address}（${why}）`, () => {
      expect(isPublicIpAddress(address)).toBe(false);
    });
  }

  it("拒绝非法/畸形输入（宁可拒绝也不要放行）", () => {
    for (const bad of ["", "not-an-ip", "999.1.1.1", "1.2.3", "1.2.3.4.5", "1.2.3.256"]) {
      expect(isPublicIpAddress(bad), bad).toBe(false);
    }
  });

  it("拒绝八进制/十六进制等非十进制点分写法（解析差异会变成绕过）", () => {
    // 0177.0.0.1 在某些解析器里等于 127.0.0.1；这里一律不认
    for (const weird of ["0177.0.0.1", "0x7f.0.0.1", "127.0.0.01x"]) {
      expect(isPublicIpAddress(weird), weird).toBe(false);
    }
  });
});

describe("isPublicIpAddress · 必须放行的 IPv4", () => {
  it("放行公网地址", () => {
    for (const good of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "223.5.5.5"]) {
      expect(isPublicIpAddress(good), good).toBe(true);
    }
  });

  it("边界：紧邻私有段的公网地址要放行", () => {
    // 这些是「差一位就落在私有段里」的地址，用来钉住网段判断的边界
    expect(isPublicIpAddress("9.255.255.255")).toBe(true); // 10/8 之前
    expect(isPublicIpAddress("11.0.0.0")).toBe(true); // 10/8 之后
    expect(isPublicIpAddress("172.15.255.255")).toBe(true); // 172.16/12 之前
    expect(isPublicIpAddress("172.32.0.1")).toBe(true); // 172.16/12 之后
    expect(isPublicIpAddress("192.167.255.255")).toBe(true); // 192.168/16 之前
    expect(isPublicIpAddress("192.169.0.1")).toBe(true); // 192.168/16 之后
    expect(isPublicIpAddress("100.63.255.255")).toBe(true); // CGNAT 之前
    expect(isPublicIpAddress("100.128.0.1")).toBe(true); // CGNAT 之后
    expect(isPublicIpAddress("223.255.255.255")).toBe(true); // 组播之前
  });
});

describe("isPublicIpAddress · IPv6", () => {
  it("拒绝环回、未指定、ULA、链路本地", () => {
    for (const bad of ["::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "fec0::1"]) {
      expect(isPublicIpAddress(bad), bad).toBe(false);
    }
  });

  it("拒绝 IPv4-mapped 形式的内网地址（按内嵌 IPv4 判定）", () => {
    // 这是最容易漏的一类：地址看起来是 IPv6，实际打到 IPv4 内网
    expect(isPublicIpAddress("::ffff:127.0.0.1")).toBe(false);
    expect(isPublicIpAddress("::ffff:10.0.0.1")).toBe(false);
    expect(isPublicIpAddress("::ffff:192.168.1.1")).toBe(false);
    expect(isPublicIpAddress("::ffff:169.254.169.254")).toBe(false);
  });

  it("放行 IPv4-mapped 形式的公网地址", () => {
    expect(isPublicIpAddress("::ffff:8.8.8.8")).toBe(true);
  });

  it("放行公网 IPv6", () => {
    for (const good of ["2606:4700:4700::1111", "2001:4860:4860::8888", "2a00:1450:4001::1"]) {
      expect(isPublicIpAddress(good), good).toBe(true);
    }
  });

  it("拒绝畸形 IPv6", () => {
    for (const bad of ["gggg::1", "1:2:3:4:5:6:7:8:9", ":::", "12345::1"]) {
      expect(isPublicIpAddress(bad), bad).toBe(false);
    }
  });
});

describe("stripIpv6Brackets", () => {
  it("去掉 URL 形式的方括号", () => {
    expect(stripIpv6Brackets("[::1]")).toBe("::1");
    expect(stripIpv6Brackets("::1")).toBe("::1");
    expect(stripIpv6Brackets("example.com")).toBe("example.com");
  });
});

describe("createPinnedLookup", () => {
  const addresses = [
    { address: "93.184.216.34", family: 4 as const },
    { address: "2606:2800:220:1::1", family: 6 as const },
  ];

  /** 调一次 pinned lookup，返回 callback 的入参 */
  function call(
    options: { family?: number | string; all?: boolean },
    list = addresses,
  ): { error: Error | null; address: unknown; family: number | undefined } {
    const lookup = createPinnedLookup(list);
    let captured: { error: Error | null; address: unknown; family: number | undefined } = {
      error: null,
      address: undefined,
      family: undefined,
    };
    lookup("example.com", options, (error, address, family) => {
      captured = { error, address, family };
    });
    return captured;
  }

  it("只返回已验证的地址，不做任何解析", () => {
    const result = call({ family: 4 });
    expect(result.error).toBeNull();
    expect(result.address).toBe("93.184.216.34");
    expect(result.family).toBe(4);
  });

  it("按 family 过滤", () => {
    expect(call({ family: 6 }).address).toBe("2606:2800:220:1::1");
    expect(call({ family: "IPv4" }).address).toBe("93.184.216.34");
    expect(call({ family: "IPv6" }).address).toBe("2606:2800:220:1::1");
  });

  it("family 不限时取第一个（顺序即 DNS 给出的偏好顺序）", () => {
    expect(call({}).address).toBe("93.184.216.34");
  });

  it("all=true 时返回全部符合 family 的地址", () => {
    const result = call({ all: true });
    expect(result.address).toEqual([
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800:220:1::1", family: 6 },
    ]);
  });

  it("请求不存在的 family 时报 ENOTFOUND（而不是回退到另一族）", () => {
    // 回退会让「只允许 IPv4」这类约束失效 —— 必须硬失败
    const result = call({ family: 6 }, [{ address: "93.184.216.34", family: 4 }]);
    expect(result.error).toBeInstanceOf(Error);
    expect((result.error as NodeJS.ErrnoException).code).toBe("ENOTFOUND");
    expect(result.address).toBe("");
  });

  it("all=true 且无可用地址时回空数组（Node 的约定）", () => {
    const result = call({ family: 6, all: true }, [{ address: "93.184.216.34", family: 4 }]);
    expect(result.address).toEqual([]);
  });

  it("返回的是副本，调用方改动不会污染已验证集合", () => {
    const list = [{ address: "93.184.216.34", family: 4 as const }];
    const lookup = createPinnedLookup(list);
    let returned: { address: string }[] = [];
    lookup("example.com", { all: true }, (_error, address) => {
      returned = address as { address: string }[];
    });
    const first = returned[0];
    expect(first).toBeDefined();
    if (first !== undefined) first.address = "10.0.0.1";
    expect(list[0]?.address).toBe("93.184.216.34");
  });
});
