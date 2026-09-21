#!/usr/bin/env node
// 取一篇论文的可读全文，**不依赖任何 PDF 工具链**。
//
// 策略：arXiv id/URL → ar5iv HTML（全文）→ 退回 arXiv 摘要。
// 带 --latex：改为下载 arXiv 的 e-print（原始 LaTeX 源码）—— 公式、表格、宏都是精确的，
// 解压到一个目录里。
// 对 DOI：先用 OpenAlex 找到开放获取（OA）的落地页，如果它是 HTML 就抓那个页面的文本。
//
// 用法：
//   node fetch_paper.mjs 2504.17192 --out paper.txt
//   node fetch_paper.mjs https://arxiv.org/abs/2504.17192
//   node fetch_paper.mjs 2504.17192 --latex --out-dir paper_src/
//   node fetch_paper.mjs --doi 10.18653/v1/2020.acl-main.1

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { gunzipSync } from "node:zlib";
import { pathToFileURL } from "node:url";

const UA = { "User-Agent": "oint-super-research/1.0 (mailto:research@example.org)" };

async function httpGetBytes(url, retries = 3) {
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      const response = await fetch(url, { headers: UA, signal: AbortSignal.timeout(120_000) });
      if (!response.ok) {
        if (attempt < retries - 1 && (response.status === 429 || response.status >= 500)) {
          await sleep(2 ** (attempt + 1));
          continue;
        }
        console.error(`[warn] GET 失败 (HTTP ${response.status}): ${url}`);
        return null;
      }
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      if (attempt < retries - 1) {
        await sleep(2 ** (attempt + 1));
        continue;
      }
      console.error(`[warn] GET 失败 (${error.message}): ${url}`);
      return null;
    }
  }
  return null;
}

async function httpGet(url, retries = 3) {
  const bytes = await httpGetBytes(url, retries);
  return bytes === null ? null : bytes.toString("utf8");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 把 HTML 转成大体可读的纯文本（够用来给模型读，不追求还原度） */
function htmlToText(page) {
  let text = page.replace(
    /<(script|style|nav|header|footer)[^>]*>[\s\S]*?<\/\1>/gi,
    " ",
  );
  // 块级标签前补换行：否则整篇会挤成一行，段落边界全丢
  text = text.replace(/<(p|div|h[1-6]|li|tr|section|figcaption)\b/gi, "\n<$1");
  text = text.replace(/<[^>]+>/g, " ");
  text = decodeEntities(text);
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n\s*\n+/g, "\n\n");
  return text.trim();
}

function decodeEntities(text) {
  const named = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    mdash: "—",
    ndash: "–",
    hellip: "…",
  };
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&([a-z]+);/gi, (whole, name) => named[name.toLowerCase()] ?? whole);
}

async function arxivAbstract(arxivId) {
  const body = await httpGet(`http://export.arxiv.org/api/query?id_list=${arxivId}`);
  if (body === null) return null;
  const entry = /<entry[^>]*>([\s\S]*?)<\/entry>/.exec(body)?.[1];
  if (entry === undefined) return null;
  const tag = (name) => {
    const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`).exec(entry);
    return m === null ? "" : decodeEntities(m[1]).replace(/\s+/g, " ").trim();
  };
  return `# ${tag("title")}\n\n[只有摘要 —— 拿不到全文]\n\n${tag("summary")}`;
}

async function fetchArxiv(arxivId) {
  const page = await httpGet(`https://ar5iv.labs.arxiv.org/html/${arxivId}`);
  if (page !== null && page.includes("<article")) {
    const article = /<article[\s\S]*?<\/article>/.exec(page)?.[0] ?? page;
    const text = htmlToText(article);
    if (text.length > 2000) return text;
  }
  console.error("[warn] ar5iv 全文拿不到，退回摘要");
  return arxivAbstract(arxivId);
}

/**
 * 下载 arXiv e-print（原始 LaTeX 源码）并解压到 outDir。
 *
 * e-print 有两种打包方式，都要处理：
 * 1. **tar（可能再套 gzip）** —— 多文件投稿；
 * 2. **单个 gzip 过的 .tex** —— 单文件投稿；极少数是 PDF（那就没有 LaTeX 源码）。
 */
async function fetchLatex(arxivId, outDir) {
  const raw = await httpGetBytes(`https://arxiv.org/e-print/${arxivId}`);
  if (raw === null) return null;
  mkdirSync(outDir, { recursive: true });

  const entries = extractTarGz(raw);
  if (entries !== null) {
    for (const entry of entries) writeEntrySafely(outDir, entry.name, entry.data);
  } else {
    // 不是 tar：可能是 gzip 过的单个 .tex，也可能是未压缩的
    let data = raw;
    try {
      data = gunzipSync(raw);
    } catch {
      // 没 gzip 就用原样
    }
    if (data.subarray(0, 5).toString("latin1") === "%PDF-") {
      console.error("[warn] e-print 只有 PDF（拿不到 LaTeX 源码）");
      return null;
    }
    await writeFile(path.join(outDir, "main.tex"), data);
  }

  const texFiles = listFilesRecursive(outDir).filter((rel) => rel.endsWith(".tex"));
  // 主文件 = 含 \documentclass 的那个
  const mains = texFiles.filter((rel) => {
    try {
      return readFileSync(path.join(outDir, rel), "utf8").slice(0, 4000).includes("\\documentclass");
    } catch {
      return false;
    }
  });
  return { dir: outDir, tex_files: texFiles.sort(), main: mains[0] ?? null };
}

/**
 * 极简 tar 解析器。
 *
 * **为什么自己解而不用库**：承诺是「零外部依赖」；而 Node 标准库**没有** tar 读取器
 *（只有 zlib）。tar 的格式足够简单（512 字节头 + 数据块），解出来即可。
 *
 * 返回 null 表示「这不是一个 tar」——由调用方走单文件分支。
 */
function extractTarGz(raw) {
  let buffer = raw;
  // gzip 魔数 1f 8b
  if (buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
    try {
      buffer = gunzipSync(buffer);
    } catch {
      return null;
    }
  }
  const entries = [];
  let offset = 0;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    // 全零块 = 归档结束
    if (header.every((byte) => byte === 0)) break;
    const name = readCString(header.subarray(0, 100));
    const sizeField = readCString(header.subarray(124, 136)).trim();
    const size = Number.parseInt(sizeField, 8);
    if (!Number.isFinite(size) || name === "") return null;
    const typeFlag = String.fromCharCode(header[156] ?? 0);
    const dataStart = offset + 512;
    const data = buffer.subarray(dataStart, dataStart + size);
    // 只收普通文件（'0' 或旧式 '\0'）与目录（'5'）；跳过符号链接等
    if (typeFlag === "0" || typeFlag === "\0" || typeFlag === "5") {
      entries.push({ name, data, isDirectory: typeFlag === "5" });
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return entries.length > 0 ? entries : null;
}

function readCString(bytes) {
  const end = bytes.indexOf(0);
  return bytes.subarray(0, end === -1 ? bytes.length : end).toString("utf8");
}

/**
 * 安全地写一个解压出来的条目。
 *
 * **必须挡住路径穿越**：tar 里的名字可以是 `../../etc/passwd` 这样的绝对/越界路径，
 * 直接 join 再写就等于把任意文件写到盘上任意位置。
 *（Python 那边靠 `filter="data"`，Node 没有对应的内建，只能自己挡。）
 *
 * 判据：解出来的绝对路径必须仍在 outDir 之内。
 */
function writeEntrySafely(outDir, name, data) {
  const root = path.resolve(outDir);
  const target = path.resolve(root, name);
  if (target !== root && !target.startsWith(root + path.sep)) {
    console.error(`[warn] 跳过越界的归档条目：${name}`);
    return;
  }
  if (name.endsWith("/")) {
    mkdirSync(target, { recursive: true });
    return;
  }
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, data);
}

function listFilesRecursive(root, prefix = "") {
  const out = [];
  for (const entry of readdirSync(path.join(root, prefix), { withFileTypes: true })) {
    const rel = prefix === "" ? entry.name : path.join(prefix, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(root, rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

async function fetchDoi(doi) {
  const body = await httpGet(`https://api.openalex.org/works/doi:${encodeURIComponent(doi)}`);
  if (body === null) return null;
  let work;
  try {
    work = JSON.parse(body);
  } catch {
    return null;
  }
  const url = work.best_oa_location?.landing_page_url ?? null;
  const title = work.title ?? "";
  // OpenAlex 的摘要是倒排索引，要还原语序
  let abstract = "";
  if (work.abstract_inverted_index != null) {
    const positions = [];
    for (const [word, indexes] of Object.entries(work.abstract_inverted_index)) {
      for (const index of indexes) positions.push([index, word]);
    }
    positions.sort((a, b) => a[0] - b[0]);
    abstract = positions.map(([, word]) => word).join(" ");
  }
  if (url !== null) {
    const page = await httpGet(url);
    if (page !== null && page.toLowerCase().includes("<html")) {
      const text = htmlToText(page);
      if (text.length > 3000) return `# ${title}\n\n[来源：${url}]\n\n${text}`;
    }
  }
  if (abstract !== "") return `# ${title}\n\n[只有摘要 —— 没找到 OA 全文]\n\n${abstract}`;
  return null;
}

function parseArgs(argv) {
  const options = { paper: null, doi: null, out: null, latex: false, outDir: null, help: false };
  const rest = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--doi") options.doi = argv[++index];
    else if (arg === "--out") options.out = argv[++index];
    else if (arg === "--latex") options.latex = true;
    else if (arg === "--out-dir") options.outDir = argv[++index];
    else if (arg === "--help" || arg === "-h") options.help = true;
    else rest.push(arg);
  }
  options.paper = rest[0] ?? null;
  return options;
}

const USAGE =
  "用法：node fetch_paper.mjs <arXiv id 或 arxiv.org 链接> [--out paper.txt]\n" +
  "      node fetch_paper.mjs <arXiv id> --latex [--out-dir paper_src/]\n" +
  "      node fetch_paper.mjs --doi 10.18653/v1/2020.acl-main.1";

const ARXIV_ID_RE = /(\d{4}\.\d{4,5})(v\d+)?/;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return 2;
  }

  if (args.latex) {
    if (args.paper === null) {
      console.error("--latex 需要给一个 arXiv id 或链接");
      return 2;
    }
    const match = ARXIV_ID_RE.exec(args.paper);
    if (match === null) {
      console.error(`无法从参数里解析出 arXiv id：${args.paper}`);
      return 2;
    }
    const arxivId = match[1];
    const info = await fetchLatex(arxivId, args.outDir ?? `arxiv_${arxivId.replace(/\./g, "_")}_src`);
    if (info === null) {
      console.error("[error] 拿不到 LaTeX 源码（去掉 --latex 试试取文本）");
      return 1;
    }
    console.log(JSON.stringify(info, null, 2));
    console.error(
      `[info] 已解压 ${info.tex_files.length} 个 .tex 到 ${info.dir}，主文件：${info.main}`,
    );
    return 0;
  }

  let text = null;
  if (args.doi !== null) {
    text = await fetchDoi(args.doi);
  } else if (args.paper !== null) {
    const match = ARXIV_ID_RE.exec(args.paper);
    if (match === null) {
      console.error(`无法从参数里解析出 arXiv id：${args.paper}`);
      return 2;
    }
    text = await fetchArxiv(match[1]);
  } else {
    console.error(USAGE);
    return 2;
  }

  if (text === null) {
    console.error("[error] 取不到这篇论文");
    return 1;
  }
  if (args.out !== null) {
    await writeFile(args.out, text, "utf8");
    console.error(`[info] 已写入 ${text.length} 字符到 ${args.out}`);
  } else {
    console.log(text);
  }
  return 0;
}

// 作为入口直接运行时才执行 main；被测试 import 时只导出纯函数。
const isEntry =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isEntry) process.exit(await main());

export { extractTarGz, writeEntrySafely, htmlToText };
