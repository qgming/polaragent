#!/usr/bin/env node
// 引用校验：校验一条引用，或审计 .bib 里的每一条。
//
// 瀑布式查询：Crossref → Semantic Scholar → OpenAlex → arXiv。
// 按**标题相似度 + 作者姓氏重合 + 年份容差**判定。
//
// 结论：
//   VERIFIED  —— 找到了，且元数据吻合
//   MISMATCH  —— 找到了论文，但作者/年份/期刊对不上（细节在 `issues`）
//   NOT_FOUND —— 没有任何来源给出可信匹配（**可能是一条编造的引用**）
//
// 用法：
//   node verify_citation.mjs --title "Attention Is All You Need" --author Vaswani --year 2017
//   node verify_citation.mjs --bib refs.bib --out audit.json

import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

const UA = { "User-Agent": "oint-super-research/1.0 (mailto:research@example.org)" };
const SIM_ACCEPT = 0.85;
const SIM_REJECT = 0.65;

async function httpGet(url, retries = 3) {
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      const response = await fetch(url, { headers: UA, signal: AbortSignal.timeout(30_000) });
      if (!response.ok) {
        if (attempt < retries - 1 && (response.status === 429 || response.status >= 500)) {
          await sleep(2 ** (attempt + 1));
          continue;
        }
        return null;
      }
      return await response.text();
    } catch {
      if (attempt < retries - 1) {
        await sleep(2 ** (attempt + 1));
        continue;
      }
      return null;
    }
  }
  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalize(text) {
  return (text ?? "").toLowerCase().replace(/[^a-z0-9 ]/g, "");
}

/**
 * Python `difflib.SequenceMatcher.ratio()` 的等价实现。
 *
 * **必须忠实复刻**，不能随便换个 Levenshtein 之类的相似度：下面那两个阈值
 *（0.85 接受 / 0.65 拒绝）是对着这个算法的取值调的。换成别的度量，
 * 同一篇论文会被判成不同结论 —— 而「引用校验」这个功能**最不能出错**。
 *
 * Python 的 ratio() = 2*M / T，其中 M 是匹配字符数、T 是两串长度之和。
 * M 由 Ratcliff-Obershelp（递归找最长匹配块）算出，与 Python 的实现一致。
 */
function sequenceRatio(a, b) {
  const total = a.length + b.length;
  if (total === 0) return 1;
  return (2 * countMatches(a, 0, a.length, b, 0, b.length)) / total;
}

function countMatches(a, aLo, aHi, b, bLo, bHi) {
  const block = longestMatch(a, aLo, aHi, b, bLo, bHi);
  if (block.size === 0) return 0;
  return (
    block.size +
    countMatches(a, aLo, block.a, b, bLo, block.b) +
    countMatches(a, block.a + block.size, aHi, b, block.b + block.size, bHi)
  );
}

/**
 * 找最长匹配块。
 *
 * 用动态规划表（O(n*m)）。Python 的 difflib 有 j2len 的优化版本，
 * 但结果相同 —— 这里选可读性，因为标题字符串很短（几十字符）。
 */
function longestMatch(a, aLo, aHi, b, bLo, bHi) {
  let bestI = aLo;
  let bestJ = bLo;
  let bestSize = 0;
  let previous = new Map();
  for (let i = aLo; i < aHi; i += 1) {
    const current = new Map();
    for (let j = bLo; j < bHi; j += 1) {
      if (a[i] !== b[j]) continue;
      const size = (previous.get(j - 1) ?? 0) + 1;
      current.set(j, size);
      if (size > bestSize) {
        bestI = i - size + 1;
        bestJ = j - size + 1;
        bestSize = size;
      }
    }
    previous = current;
  }
  return { a: bestI, b: bestJ, size: bestSize };
}

function sim(a, b) {
  return sequenceRatio(normalize(a), normalize(b));
}

async function queryCrossref(title) {
  const url = `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(title)}&rows=3`;
  const body = await httpGet(url);
  if (body === null) return [];
  try {
    return (JSON.parse(body).message?.items ?? []).map((item) => {
      let year = null;
      for (const key of ["published-print", "published-online", "issued"]) {
        const year0 = item[key]?.["date-parts"]?.[0]?.[0];
        if (year0 != null) {
          year = year0;
          break;
        }
      }
      return {
        title: item.title?.[0] ?? "",
        authors: (item.author ?? []).map((author) => author.family ?? ""),
        year,
        venue: item["container-title"]?.[0] ?? null,
        doi: item.DOI ?? null,
        url: item.URL ?? null,
        source: "crossref",
      };
    });
  } catch {
    return [];
  }
}

async function queryS2(title) {
  const url =
    "https://api.semanticscholar.org/graph/v1/paper/search?" +
    `query=${encodeURIComponent(title)}&limit=3&fields=title,authors,year,venue,externalIds,url`;
  const body = await httpGet(url);
  if (body === null) return [];
  try {
    return (JSON.parse(body).data ?? []).map((paper) => ({
      title: paper.title ?? "",
      // 只要姓氏（末词）—— 与引用里的写法对齐
      authors: (paper.authors ?? [])
        .map((author) => (author.name ?? "").split(/\s+/).pop())
        .filter((name) => name !== undefined && name !== ""),
      year: paper.year ?? null,
      venue: paper.venue ?? null,
      doi: paper.externalIds?.DOI ?? null,
      url: paper.url ?? null,
      source: "s2",
    }));
  } catch {
    return [];
  }
}

async function queryOpenalex(title) {
  const url = `https://api.openalex.org/works?search=${encodeURIComponent(title)}&per-page=3`;
  const body = await httpGet(url);
  if (body === null) return [];
  try {
    return (JSON.parse(body).results ?? []).map((work) => ({
      title: work.title ?? "",
      authors: (work.authorships ?? [])
        .map((item) => (item.author?.display_name ?? "").split(/\s+/).pop())
        .filter((name) => name !== undefined && name !== ""),
      year: work.publication_year ?? null,
      venue: work.primary_location?.source?.display_name ?? null,
      doi: (work.doi ?? "").replace("https://doi.org/", "") || null,
      url: work.doi ?? work.id ?? null,
      source: "openalex",
    }));
  } catch {
    return [];
  }
}

async function queryArxiv(title) {
  const url =
    "http://export.arxiv.org/api/query?search_query=" +
    `${encodeURIComponent(`ti:"${title}"`)}&max_results=3`;
  const body = await httpGet(url);
  if (body === null) return [];
  const blocks = [...body.matchAll(/<entry[^>]*>([\s\S]*?)<\/entry>/g)].map((m) => m[1]);
  return blocks.map((entry) => {
    const text = (tag) => {
      const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(entry);
      return m === null
        ? ""
        : m[1]
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&amp;/g, "&")
            .replace(/\s+/g, " ")
            .trim();
    };
    const authors = [...entry.matchAll(/<author[^>]*>([\s\S]*?)<\/author>/g)].map(
      (m) => /<name[^>]*>([\s\S]*?)<\/name>/.exec(m[1])?.[1]?.trim() ?? "",
    );
    const published = text("published");
    return {
      title: text("title"),
      authors: authors.map((name) => name.split(/\s+/).pop()).filter((n) => n !== undefined),
      year: Number.parseInt(published.slice(0, 4), 10) || null,
      venue: "arXiv",
      doi: null,
      url: text("id"),
      source: "arxiv",
    };
  });
}

/** 取姓氏：支持 BibTeX 的 "Family, Given" 与 "Given Family" 两种写法 */
function surname(name) {
  const trimmed = (name ?? "").trim();
  if (trimmed.includes(",")) return (trimmed.split(",")[0] ?? "").trim().toLowerCase();
  const parts = trimmed.split(/\s+/).filter((part) => part !== "");
  return parts.length === 0 ? "" : (parts[parts.length - 1] ?? "").toLowerCase();
}

function checkMeta(candidate, similarity, authors, year) {
  const issues = [];
  if (similarity < SIM_ACCEPT) issues.push(`标题相似度只有 ${similarity.toFixed(2)}`);
  if (year != null && candidate.year != null && Math.abs(year - candidate.year) > 1) {
    issues.push(`年份不符：引用写 ${year}，查到 ${candidate.year}`);
  }
  if (authors.length > 0) {
    const cited = new Set(authors.filter((a) => a.trim() !== "").map(surname));
    const found = new Set((candidate.authors ?? []).map((a) => (a ?? "").toLowerCase()));
    if (cited.size > 0 && found.size > 0) {
      const overlap = [...cited].some((name) => found.has(name));
      if (!overlap) {
        issues.push(
          `作者没有重合：引用 ${JSON.stringify([...cited].slice(0, 3))}，` +
            `查到 ${JSON.stringify([...found].slice(0, 3))}`,
        );
      }
    }
  }
  return issues;
}

/** 校验一条引用。返回结论对象。 */
async function verify(title, authors = [], year = null) {
  // 候选比较：**无问题的候选优先**，其次相似度更高者
  let best = null;
  for (const query of [queryCrossref, queryS2, queryOpenalex, queryArxiv]) {
    for (const candidate of await query(title)) {
      const similarity = sim(title, candidate.title);
      if (similarity < SIM_REJECT) continue;
      const issues = checkMeta(candidate, similarity, authors, year);
      const entry = { hasIssues: issues.length > 0, similarity, candidate, issues };
      if (
        best === null ||
        (entry.hasIssues ? 1 : 0) < (best.hasIssues ? 1 : 0) ||
        ((entry.hasIssues ? 1 : 0) === (best.hasIssues ? 1 : 0) && entry.similarity > best.similarity)
      ) {
        best = entry;
      }
    }
    // 只有拿到**干净且高置信**的匹配才提前结束瀑布
    if (best !== null && !best.hasIssues && best.similarity >= SIM_ACCEPT) break;
  }

  if (best === null) {
    return {
      verdict: "NOT_FOUND",
      similarity: 0,
      matched: null,
      issues: ["在 crossref/s2/openalex/arxiv 里都没有可信的匹配"],
    };
  }
  return {
    verdict: best.hasIssues ? "MISMATCH" : "VERIFIED",
    similarity: Math.round(best.similarity * 1000) / 1000,
    matched: best.candidate,
    issues: best.issues,
  };
}

/**
 * 极简 BibTeX 解析：每条取 key / title / author / year。
 *
 * 用手写的括号配平来切条目（不用正则硬啃嵌套花括号）：
 * BibTeX 的字段值里可以有任意层 `{}`，正则匹配不了那个结构。
 */
function parseBib(path) {
  const text = readFileSync(path, "utf8");
  const entries = [];
  for (const match of text.matchAll(/@(\w+)\s*\{\s*([^,\s]+)\s*,/g)) {
    if (["comment", "string", "preamble"].includes(match[1].toLowerCase())) continue;
    const start = match.index + match[0].length;
    let depth = 1;
    let index = start;
    while (index < text.length && depth > 0) {
      if (text[index] === "{") depth += 1;
      else if (text[index] === "}") depth -= 1;
      index += 1;
    }
    const body = text.slice(start, index - 1);

    const field = (name) => {
      const found = new RegExp(`${name}\\s*=\\s*[{""](.*?)[}""]\\s*,?\\s*\\n`, "is").exec(body);
      return found === null ? null : found[1].replace(/[{}\s]+/g, " ").trim();
    };

    entries.push({
      key: match[2],
      title: field("title"),
      authors: (field("author") ?? "")
        .split(" and ")
        .map((a) => a.trim())
        .filter((a) => a !== ""),
      year: field("year"),
    });
  }
  return entries;
}

function parseArgs(argv) {
  const options = { title: null, authors: [], year: null, bib: null, out: null, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--title") options.title = argv[++index];
    else if (arg === "--author") options.authors.push(argv[++index]);
    else if (arg === "--year") options.year = Number.parseInt(argv[++index], 10);
    else if (arg === "--bib") options.bib = argv[++index];
    else if (arg === "--out") options.out = argv[++index];
    else if (arg === "--help" || arg === "-h") options.help = true;
  }
  return options;
}

const USAGE =
  '用法：node verify_citation.mjs --title "论文标题" [--author 姓氏]... [--year 2017]\n' +
  "      node verify_citation.mjs --bib refs.bib [--out audit.json]";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return 2;
  }

  if (args.bib !== null) {
    const entries = parseBib(args.bib);
    const results = [];
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (entry.title == null || entry.title === "") {
        results.push({
          key: entry.key,
          verdict: "NOT_FOUND",
          issues: ["这条没有 title 字段"],
        });
        continue;
      }
      const result = await verify(entry.title, entry.authors, Number.parseInt(entry.year, 10) || null);
      result.key = entry.key;
      result.cited_title = entry.title;
      results.push(result);
      console.error(`[${index + 1}/${entries.length}] ${entry.key}: ${result.verdict}`);
      // 未认证的公共 API 限流很紧（S2 约 1 请求/秒），逐条之间必须让一步
      await sleep(1000);
    }
    const summary = {};
    for (const result of results) {
      summary[result.verdict] = (summary[result.verdict] ?? 0) + 1;
    }
    const text = JSON.stringify({ summary, entries: results }, null, 2);
    if (args.out !== null) {
      writeFileSync(args.out, text, "utf8");
      console.error(`[info] 审计已写入 ${args.out}：${JSON.stringify(summary)}`);
    } else {
      console.log(text);
    }
    return 0;
  }

  if (args.title === null) {
    console.error(USAGE);
    return 2;
  }
  console.log(JSON.stringify(await verify(args.title, args.authors, args.year), null, 2));
  return 0;
}

// 作为入口直接运行时才执行 main；被测试 import 时只导出纯函数。
// 没有这个守卫的话，import 该文件会立刻跑检索并 process.exit，
// 相似度算法就永远无法被单测覆盖 —— 而那两个阈值全依赖它的正确性。
const isEntry =
  process.argv[1] !== undefined &&
  pathToFileURL(process.argv[1]).href === import.meta.url;

if (isEntry) process.exit(await main());

export { sequenceRatio, sim, surname, parseBib };
