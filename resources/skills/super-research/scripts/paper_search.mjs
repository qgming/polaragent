#!/usr/bin/env node
// 多源论文检索：arXiv + Semantic Scholar + OpenAlex + Crossref。
//
// 零外部依赖（只用 Node 内置能力）。统一输出结构，跨源按 DOI / arXiv id / 归一化标题去重。
//
// 用法：
//   node paper_search.mjs "query terms" [--sources arxiv,s2,openalex,crossref] [--limit 10]
//                         [--year-from 2020] [--out papers.json]

import { writeFileSync } from "node:fs";
import process from "node:process";

const UA = { "User-Agent": "oint-super-research/1.0 (mailto:research@example.org)" };

/**
 * 带退避重试的 GET。
 *
 * 与 Python 版同样的策略：429 与 5xx 退避重试，其余错误直接放弃并告警。
 * 返回 null 表示这个来源拿不到数据 —— 调用方要**继续用其他来源并标出缺口**，
 * 而不是让整个检索失败（多源的意义正在于此）。
 */
async function httpGet(url, retries = 3) {
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      const response = await fetch(url, { headers: UA, signal: AbortSignal.timeout(30_000) });
      if (!response.ok) {
        const code = response.status;
        if (attempt < retries - 1 && (code === 429 || code >= 500)) {
          await sleep(2 ** (attempt + 1));
          continue;
        }
        console.error(`[warn] GET 失败 (HTTP ${code}): ${url}`);
        return null;
      }
      return await response.text();
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 归一化标题：去掉所有非字母数字并转小写 —— 用于跨源判重 */
function normTitle(title) {
  return (title ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * 从 XML 里取一个标签的文本（含嵌套的同名标签取第一个）。
 *
 * 刻意不引 XML 库：arXiv 的 Atom 结构固定且简单，为一个来源装一个解析器不值得
 *（也与「零外部依赖」的承诺冲突）。代价是这个函数**只认扁平结构** ——
 * arXiv 的 entry 正是扁平的（title / summary / id / published / author>name）。
 */
function xmlText(xml, tag) {
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(xml);
  if (match === null) return "";
  return decodeXml(match[1]).replace(/\s+/g, " ").trim();
}

/** 取所有匹配的标签块（用于 <entry> / <author>） */
function xmlBlocks(xml, tag) {
  return [...xml.matchAll(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "g"))].map(
    (match) => match[1],
  );
}

function decodeXml(text) {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, "&");
}

/** 去掉 HTML 标签（Crossref 的 abstract 里带 JATS 标记） */
function stripTags(text) {
  return (text ?? "").replace(/<[^>]+>/g, "");
}

async function searchArxiv(query, limit, yearFrom) {
  const url =
    `http://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}` +
    `&max_results=${limit}&sortBy=relevance`;
  const body = await httpGet(url);
  if (body === null) return [];

  const out = [];
  for (const entry of xmlBlocks(body, "entry")) {
    const published = xmlText(entry, "published");
    const year = Number.parseInt(published.slice(0, 4), 10) || 0;
    if (yearFrom != null && year !== 0 && year < yearFrom) continue;
    const id = xmlText(entry, "id");
    const rawId = id.split("/abs/").pop() ?? "";
    out.push({
      title: xmlText(entry, "title"),
      authors: xmlBlocks(entry, "author").map((author) => xmlText(author, "name")),
      year: year === 0 ? null : year,
      abstract: xmlText(entry, "summary"),
      doi: null,
      // 去掉末尾的版本号（v1 / v2），让同一篇的不同版本能判重
      arxiv_id: rawId.replace(/v\d+$/, ""),
      url: `https://arxiv.org/abs/${rawId}`,
      venue: "arXiv",
      citations: null,
      source: "arxiv",
    });
  }
  return out;
}

async function searchS2(query, limit, yearFrom) {
  let url =
    `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}` +
    `&limit=${limit}&fields=title,authors,year,abstract,externalIds,url,venue,citationCount`;
  if (yearFrom != null) url += `&year=${yearFrom}-`;
  const body = await httpGet(url);
  if (body === null) return [];

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    console.error("[warn] s2 返回的不是合法 JSON，跳过该来源");
    return [];
  }
  return (parsed.data ?? []).map((paper) => {
    const ext = paper.externalIds ?? {};
    return {
      title: paper.title ?? null,
      authors: (paper.authors ?? []).map((author) => author.name),
      year: paper.year ?? null,
      abstract: paper.abstract ?? null,
      doi: ext.DOI ?? null,
      arxiv_id: ext.ArXiv ?? null,
      url: paper.url ?? null,
      venue: paper.venue ?? null,
      citations: paper.citationCount ?? null,
      source: "s2",
    };
  });
}

async function searchOpenalex(query, limit, yearFrom) {
  const filter = yearFrom != null ? `&filter=from_publication_date:${yearFrom}-01-01` : "";
  const url = `https://api.openalex.org/works?search=${encodeURIComponent(query)}&per-page=${limit}${filter}`;
  const body = await httpGet(url);
  if (body === null) return [];

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    console.error("[warn] openalex 返回的不是合法 JSON，跳过该来源");
    return [];
  }
  return (parsed.results ?? []).map((work) => {
    // OpenAlex 把摘要存成「词 → 位置数组」的倒排索引，要还原成正常语序
    let abstract = null;
    const inverted = work.abstract_inverted_index;
    if (inverted != null) {
      const positions = [];
      for (const [word, indexes] of Object.entries(inverted)) {
        for (const index of indexes) positions.push([index, word]);
      }
      positions.sort((a, b) => a[0] - b[0]);
      abstract = positions.map(([, word]) => word).join(" ");
    }
    const location = work.primary_location?.source ?? {};
    return {
      title: work.title ?? null,
      authors: (work.authorships ?? []).map((item) => item.author?.display_name),
      year: work.publication_year ?? null,
      abstract,
      doi: (work.doi ?? "").replace("https://doi.org/", "") || null,
      arxiv_id: null,
      url: work.doi ?? work.id ?? null,
      venue: location.display_name ?? null,
      citations: work.cited_by_count ?? null,
      source: "openalex",
    };
  });
}

async function searchCrossref(query, limit, yearFrom) {
  const filter = yearFrom != null ? `&filter=from-pub-date:${yearFrom}-01-01` : "";
  const url = `https://api.crossref.org/works?query=${encodeURIComponent(query)}&rows=${limit}${filter}`;
  const body = await httpGet(url);
  if (body === null) return [];

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    console.error("[warn] crossref 返回的不是合法 JSON，跳过该来源");
    return [];
  }
  return (parsed.message?.items ?? []).map((item) => {
    // Crossref 的日期字段有好几个，按优先级取第一个有年份的
    let year = null;
    for (const key of ["published-print", "published-online", "issued"]) {
      const year0 = item[key]?.["date-parts"]?.[0]?.[0];
      if (year0 != null) {
        year = year0;
        break;
      }
    }
    return {
      title: item.title?.[0] ?? null,
      authors: (item.author ?? []).map((author) =>
        `${author.given ?? ""} ${author.family ?? ""}`.trim(),
      ),
      year,
      abstract: stripTags(item.abstract ?? "") || null,
      doi: item.DOI ?? null,
      arxiv_id: null,
      url: item.URL ?? null,
      venue: item["container-title"]?.[0] ?? null,
      citations: item["is-referenced-by-count"] ?? null,
      source: "crossref",
    };
  });
}

const SEARCHERS = {
  arxiv: searchArxiv,
  s2: searchS2,
  openalex: searchOpenalex,
  crossref: searchCrossref,
};

/**
 * 跨源判重。
 *
 * 同一个键命中时**合并**而不是丢弃：新的一方的非空字段补进已记录的那条
 *（比如 arXiv 没有 DOI，而 S2 有），并把来源名累加起来 ——
 * 这样人能从 `source` 看出「这条被几个源独立确认过」，那是可信度的信号。
 */
function dedup(papers) {
  const seen = new Map();
  const out = [];
  for (const paper of papers) {
    const key =
      (paper.doi ?? "").toLowerCase() || paper.arxiv_id || normTitle(paper.title) || null;
    if (key === null) continue;
    const previous = seen.get(key);
    if (previous === undefined) {
      seen.set(key, paper);
      out.push(paper);
      continue;
    }
    for (const field of ["doi", "arxiv_id", "abstract", "venue", "citations"]) {
      if (!previous[field] && paper[field]) previous[field] = paper[field];
    }
    previous.source += `,${paper.source}`;
  }
  return out;
}

/** 极简参数解析 —— 只为几个固定选项，不引依赖 */
function parseArgs(argv) {
  const options = { sources: "arxiv,s2,openalex", limit: 10, yearFrom: null, out: null, query: null };
  const rest = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--sources") options.sources = argv[++index];
    else if (arg === "--limit") options.limit = Number.parseInt(argv[++index], 10);
    else if (arg === "--year-from") options.yearFrom = Number.parseInt(argv[++index], 10);
    else if (arg === "--out") options.out = argv[++index];
    else if (arg === "--help" || arg === "-h") options.help = true;
    else rest.push(arg);
  }
  options.query = rest[0] ?? null;
  return options;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help === true || args.query === null) {
    console.error(
      '用法：node paper_search.mjs "查询词" [--sources arxiv,s2,openalex,crossref] ' +
        "[--limit 10] [--year-from 2020] [--out papers.json]",
    );
    return 2;
  }

  let papers = [];
  for (const raw of args.sources.split(",")) {
    const source = raw.trim();
    const searcher = SEARCHERS[source];
    if (searcher === undefined) {
      console.error(`[warn] 未知来源：${source}`);
      continue;
    }
    const found = await searcher(args.query, args.limit, args.yearFrom);
    console.error(`[info] ${source}: ${found.length} 条结果`);
    papers = papers.concat(found);
  }

  papers = dedup(papers);
  papers.sort((a, b) => (b.citations ?? 0) - (a.citations ?? 0));
  const text = JSON.stringify(papers, null, 2);
  if (args.out !== null) {
    writeFileSync(args.out, text, "utf8");
    console.error(`[info] 已写入 ${papers.length} 篇去重后的论文到 ${args.out}`);
  } else {
    console.log(text);
  }
  return 0;
}

process.exit(await main());
