// 公网地址解析与连接钉死 —— 抓取后端的安全核心。
//
// 为什么必须自己写、且不能用裸 fetch()：
//   fetch() 没有暴露 DNS lookup 注入点，于是「验证时解析到公网 IP、连接时解析到内网 IP」
//   这个窗口关不掉（DNS 重绑定）。node:http/https 的 request 接受 `lookup` 选项，
//   这是 Node 侧唯一可用的钉死手段。
//
// 为什么不用 undici：它在本仓库**只是 devDependency 的传递依赖**
//   （package.json 里没有它，package-lock 里标着 "dev": true）—— 生产打包时不可靠。
//   node:http/https 是内置的，零新增依赖。
//
// 判定规则与 dsh 的 dsh-web-fetch-http 逐条对齐（见 docs/web-tools-research.md §2.1）。

import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { WebError } from "./types";

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/**
 * 明确拒绝的 IPv4 网段（CIDR，起始地址 + 前缀长度）。
 *
 * 用显式网段表而不是引一个 IP 库（dsh 用 ipaddr.js）：
 * 判断公网与否是一个**封闭、不常变**的规则集，为它加一个依赖不划算。
 * 每一条都是「不该被模型抓到的目标」：
 */
const BLOCKED_IPV4: readonly { base: readonly number[]; bits: number; why: string }[] = [
  { base: [0, 0, 0, 0], bits: 8, why: "「本网络」" },
  { base: [10, 0, 0, 0], bits: 8, why: "私有网段" },
  { base: [100, 64, 0, 0], bits: 10, why: "运营商级 NAT（CGNAT）" },
  { base: [127, 0, 0, 0], bits: 8, why: "环回" },
  { base: [169, 254, 0, 0], bits: 16, why: "链路本地（含云元数据 169.254.169.254）" },
  { base: [172, 16, 0, 0], bits: 12, why: "私有网段" },
  { base: [192, 0, 0, 0], bits: 24, why: "IETF 协议保留" },
  { base: [192, 0, 2, 0], bits: 24, why: "文档用（TEST-NET-1）" },
  { base: [192, 168, 0, 0], bits: 16, why: "私有网段" },
  { base: [198, 18, 0, 0], bits: 15, why: "基准测试" },
  { base: [198, 51, 100, 0], bits: 24, why: "文档用（TEST-NET-2）" },
  { base: [203, 0, 113, 0], bits: 24, why: "文档用（TEST-NET-3）" },
  { base: [224, 0, 0, 0], bits: 4, why: "组播" },
  { base: [240, 0, 0, 0], bits: 4, why: "保留" },
];

/** RFC 6052 里可能承载 IPv4 目的的 NAT64 前缀长度 */
const RFC6052_PREFIX_LENGTHS: readonly number[] = [32, 40, 48, 56, 64, 96];

/** RFC 7050 保留的发现主机名与它的哨兵地址 */
const IPV4ONLY_HOST = "ipv4only.arpa";
const IPV4ONLY_SENTINELS: readonly string[] = ["192.0.0.170", "192.0.0.171"];

/** 解析成 4 字节数组；不是合法 IPv4 时返回 undefined */
function parseIpv4(input: string): number[] | undefined {
  const parts = input.split(".");
  if (parts.length !== 4) return undefined;
  const bytes: number[] = [];
  for (const part of parts) {
    // 只接受十进制点分：八进制（010）、十六进制（0x0a）等写法一律拒绝，
    // 否则 0177.0.0.1 这类绕过会从「解析差异」变成「安全漏洞」
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const value = Number(part);
    if (value > 255) return undefined;
    bytes.push(value);
  }
  return bytes;
}

/** 把 IPv6 文本展开成 16 字节；失败返回 undefined（含 IPv4 尾巴的点分写法） */
function parseIpv6(input: string): number[] | undefined {
  let text = input;
  // 尾部的 IPv4 形式（::ffff:127.0.0.1）先转成两段十六进制
  const lastColon = text.lastIndexOf(":");
  if (lastColon !== -1 && text.slice(lastColon + 1).includes(".")) {
    const ipv4 = parseIpv4(text.slice(lastColon + 1));
    if (ipv4 === undefined) return undefined;
    const high = ((ipv4[0] ?? 0) << 8) | (ipv4[1] ?? 0);
    const low = ((ipv4[2] ?? 0) << 8) | (ipv4[3] ?? 0);
    text = `${text.slice(0, lastColon + 1)}${high.toString(16)}:${low.toString(16)}`;
  }

  const halves = text.split("::");
  if (halves.length > 2) return undefined;

  const expand = (segment: string): number[] | undefined => {
    if (segment === "") return [];
    const groups = segment.split(":");
    const out: number[] = [];
    for (const group of groups) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return undefined;
      const value = Number.parseInt(group, 16);
      out.push((value >> 8) & 0xff, value & 0xff);
    }
    return out;
  };

  const head = expand(halves[0] ?? "");
  if (head === undefined) return undefined;

  if (halves.length === 1) return head.length === 16 ? head : undefined;

  const tail = expand(halves[1] ?? "");
  if (tail === undefined) return undefined;
  const missing = 16 - head.length - tail.length;
  if (missing < 0) return undefined;
  return [...head, ...new Array<number>(missing).fill(0), ...tail];
}

/** 前 bits 位是否相同 */
function inNetwork(bytes: readonly number[], base: readonly number[], bits: number): boolean {
  let remaining = bits;
  for (let index = 0; index < 4 && remaining > 0; index += 1) {
    const take = Math.min(8, remaining);
    const mask = take === 8 ? 0xff : (0xff << (8 - take)) & 0xff;
    if (((bytes[index] ?? 0) & mask) !== ((base[index] ?? 0) & mask)) return false;
    remaining -= take;
  }
  return true;
}

/** 把 4 字节数组还原成点分文本（用于 NAT64 解出的内嵌 IPv4 再校验） */
function formatIpv4(bytes: readonly number[]): string {
  return bytes.map((byte) => String(byte)).join(".");
}

/**
 * 地址是否**公网单播**。
 *
 * IPv4-mapped IPv6（::ffff:127.0.0.1）按其**内嵌 IPv4** 判定 ——
 * 否则 ::ffff:127.0.0.1 会绕过对 127.0.0.0/8 的检查。
 *
 * 传入 IPv6 时**不做** NAT64 解包：那需要先发现活动前缀（见 resolvePublicAddresses），
 * 是异步的；这里的职责只是「这个字面量地址本身是否公网」。
 */
export function isPublicIpAddress(input: string): boolean {
  const bare = stripIpv6Brackets(input);
  const version = isIP(bare);

  if (version === 4) {
    const bytes = parseIpv4(bare);
    if (bytes === undefined) return false;
    return !BLOCKED_IPV4.some((entry) => inNetwork(bytes, entry.base, entry.bits));
  }

  if (version === 6) {
    const bytes = parseIpv6(bare);
    if (bytes === undefined) return false;

    // IPv4-mapped（::ffff:0:0/96）与 IPv4-compatible（::/96）：按内嵌 IPv4 判定
    const isMapped =
      bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
    const isCompatible = bytes.slice(0, 12).every((byte) => byte === 0);
    if (isMapped || isCompatible) {
      return isPublicIpAddress(formatIpv4(bytes.slice(12, 16)));
    }

    // ::（未指定）与 ::1（环回）
    if (bytes.every((byte) => byte === 0)) return false;
    if (bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1) return false;

    // fc00::/7（唯一本地）与 fe80::/10（链路本地）
    if ((bytes[0] ?? 0) >= 0xfc && (bytes[0] ?? 0) <= 0xfd) return false;
    if (bytes[0] === 0xfe && ((bytes[1] ?? 0) & 0xc0) === 0x80) return false;
    // fec0::/10（已废弃的站点本地）也一并拒掉
    if (bytes[0] === 0xfe && ((bytes[1] ?? 0) & 0xc0) === 0xc0) return false;

    return true;
  }

  return false;
}

/** WHATWG URL 保留 IPv6 的方括号；IP 解析器不认 */
export function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

/**
 * 从 RFC 6052 布局里解出内嵌的 IPv4（点分文本）；解不出返回 undefined。
 *
 * 前缀长度 96 时 IPv4 在最后 4 字节；其余长度按 RFC 6052 的
 * 「前缀 + 保留字节(全 0) + IPv4」布局取。
 */
function embeddedIpv4(bytes: readonly number[], prefixLength: number): string | undefined {
  if (prefixLength === 96) return formatIpv4(bytes.slice(12, 16));
  if (bytes[8] !== 0) return undefined;
  const prefixBytes = prefixLength / 8;
  const beforeReserved = 8 - prefixBytes;
  const octets = [
    ...bytes.slice(prefixBytes, prefixBytes + beforeReserved),
    ...bytes.slice(9, 13 - beforeReserved),
  ];
  if (octets.length !== 4) return undefined;
  return formatIpv4(octets);
}

/**
 * 发现当前网络的活动 DNS64 前缀（RFC 7050）。
 *
 * 为什么需要：在 NAT64 网络上，`64:ff9b::127.0.0.1` 这样的地址会被网关
 * 转换成对 127.0.0.1 的连接 —— 只检查「这个 IPv6 是不是公网」会放行它。
 * 所以要先问出「本机所在网络把哪个前缀当作 NAT64」，再对匹配该前缀的地址
 * 解出内嵌 IPv4 并**重新做一次公网判定**。
 *
 * 解析失败（无 DNS64）时返回空数组 —— 那是最常见的情况，不是错误。
 */
export async function discoverNat64Prefixes(
  signal?: AbortSignal,
): Promise<{ bytes: number[]; length: number }[]> {
  let resolved: { address: string; family: number }[];
  try {
    resolved = await raceWithSignal(
      dnsLookup(IPV4ONLY_HOST, { all: true, order: "verbatim" }),
      signal,
    );
  } catch {
    return [];
  }

  const prefixes: { bytes: number[]; length: number }[] = [];
  const seen = new Set<string>();
  for (const entry of resolved) {
    if (entry.family !== 6 || isIP(entry.address) !== 6) continue;
    const bytes = parseIpv6(entry.address);
    if (bytes === undefined) continue;
    for (const length of RFC6052_PREFIX_LENGTHS) {
      const embedded = embeddedIpv4(bytes, length);
      if (embedded === undefined || !IPV4ONLY_SENTINELS.includes(embedded)) continue;
      const prefixBytes = bytes.slice(0, length / 8);
      const key = `${length}:${prefixBytes.join(".")}`;
      if (seen.has(key)) continue;
      seen.add(key);
      prefixes.push({ bytes: prefixBytes, length });
    }
  }
  return prefixes;
}

/** 地址是否匹配某个已发现的 NAT64 前缀 */
function matchesPrefix(bytes: readonly number[], prefix: { bytes: number[]; length: number }) {
  return prefix.bytes.every((byte, index) => bytes[index] === byte);
}

/**
 * 解析主机名并校验**整个地址集合**。
 *
 * 关键口径：**集合中任何一个地址不是公网单播就整体拒绝**，
 * 而不是「过滤掉私网的那个」。理由是 DNS 可以返回混合集合
 * （A 记录公网 + AAAA 记录私网），过滤会让「最终连哪个」取决于运行时的地址选择策略 ——
 * 那是不可预测的。整体拒绝是唯一确定的规则。
 *
 * 返回的地址集合就是**唯一允许连接的目标**（交给 createPinnedLookup）。
 */
export async function resolvePublicAddresses(
  hostname: string,
  signal?: AbortSignal,
): Promise<ResolvedAddress[]> {
  const bare = stripIpv6Brackets(hostname);
  const literalFamily = isIP(bare);

  let resolved: { address: string; family: number }[];
  if (literalFamily !== 0) {
    // IP 字面量：不需要解析，直接用
    resolved = [{ address: bare, family: literalFamily }];
  } else {
    try {
      resolved = await raceWithSignal(dnsLookup(bare, { all: true, order: "verbatim" }), signal);
    } catch (error) {
      throw new WebError(
        `无法解析主机名「${hostname}」：${error instanceof Error ? error.message : String(error)}`,
        "WEB_PROVIDER_ERROR",
        { cause: error },
      );
    }
  }

  if (resolved.length === 0) {
    throw new WebError(`主机名「${hostname}」没有解析到任何地址`, "WEB_PROVIDER_ERROR");
  }

  // 只有真的存在 IPv6 地址时才去发现 DNS64 前缀（省一次 DNS 查询）
  const hasIpv6 = resolved.some((entry) => entry.family === 6 && isIP(entry.address) === 6);
  const nat64Prefixes = hasIpv6 ? await discoverNat64Prefixes(signal) : [];

  const addresses: ResolvedAddress[] = [];
  for (const entry of resolved) {
    const version = isIP(entry.address);
    if ((entry.family !== 4 && entry.family !== 6) || version !== entry.family) {
      throw new WebError(`主机名「${hostname}」解析到了非法地址`, "WEB_PROVIDER_ERROR");
    }

    if (!isPublicIpAddress(entry.address)) {
      throw new WebError(
        `主机名「${hostname}」指向非公网地址（${entry.address}），已拒绝`,
        "WEB_BLOCKED_URL",
      );
    }

    /**
     * NAT64：地址本身是公网 IPv6，但它可能被网关转换成内网 IPv4。
     * 匹配已发现的前缀时，解出内嵌 IPv4 再判一次。
     */
    if (version === 6) {
      const bytes = parseIpv6(entry.address);
      if (bytes !== undefined) {
        for (const prefix of nat64Prefixes) {
          if (!matchesPrefix(bytes, prefix)) continue;
          const embedded = embeddedIpv4(bytes, prefix.length);
          if (embedded !== undefined && !isPublicIpAddress(embedded)) {
            throw new WebError(
              `主机名「${hostname}」经 NAT64 指向非公网地址（${embedded}），已拒绝`,
              "WEB_BLOCKED_URL",
            );
          }
        }
      }
    }

    addresses.push({ address: entry.address, family: entry.family as 4 | 6 });
  }

  return addresses;
}

/**
 * 构造一个只回**已验证地址**的 lookup 回调。
 *
 * 这是钉死的落点：把它交给 `http(s).request` 的 `lookup` 选项之后，
 * 传输层拿到的地址就是我们校验过的那一批 —— 中间不存在第二次解析，
 * 于是「验证时公网、连接时内网」的窗口被关掉。
 *
 * URL 里的主机名保持不变，所以 Host 头与 TLS SNI 仍然正确。
 */
export function createPinnedLookup(
  addresses: ResolvedAddress[],
): (
  hostname: string,
  options: { family?: number | string; all?: boolean },
  callback: (error: Error | null, address?: unknown, family?: number) => void,
) => void {
  return (_hostname, options, callback) => {
    const wantFamily =
      typeof options.family === "number"
        ? options.family
        : options.family === "IPv4"
          ? 4
          : options.family === "IPv6"
            ? 6
            : 0;
    const eligible =
      wantFamily === 0 ? addresses : addresses.filter((entry) => entry.family === wantFamily);
    const selected = eligible[0];

    if (selected === undefined) {
      const error = Object.assign(new Error("没有可用的已验证地址"), {
        code: "ENOTFOUND",
      });
      callback(error, options.all === true ? [] : "", 0);
      return;
    }

    if (options.all === true) {
      callback(
        null,
        eligible.map((entry) => ({ ...entry })),
      );
      return;
    }
    callback(null, selected.address, selected.family);
  };
}

/**
 * 给操作系统级解析套上取消语义。
 *
 * `dns.lookup` 不可取消，而工具层要能中止 —— 用竞速把「不再等」表达出来，
 * 底层那次解析继续跑完即可（它的结果没人用）。
 */
function raceWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) {
    return Promise.reject(new WebError("请求已取消", "WEB_ABORTED", { cause: signal.reason }));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(new WebError("请求已取消", "WEB_ABORTED", { cause: signal.reason }));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}
