# 免费来源接口（无需 API key）

**Oint 的默认通道是 `browser_*` 工具**（主会话专属）。子智能体没有浏览器工具，
它们走 `bash` + `curl` —— 下面这些免费接口对两者都适用，而且返回的是**结构化数据**，
比解析网页正文可靠得多，所以优先用它们。

全部无需 key。遇到 429 / 5xx 就退避一次，然后**跳过这个来源继续**，不要卡住。

## 通用网页搜索

主会话：`browser_open` 打开搜索页 → `browser_snapshot` 读结果。

子智能体（bash）：

```bash
# DuckDuckGo 纯 HTML 端点，实测返回完整结果页
curl -s "https://html.duckduckgo.com/html/?q=<url-encoded+query>"
```

- 结果链接被包成 `//duckduckgo.com/l/?uddg=<url-encoded 真实 URL>` ——
  **先解 `uddg` 再去取**，直接取包装链接拿不到东西；
- 支持操作符：`site:github.com`、`"精确短语"`，
  以及查询参数 `df=y`（近一年）/ `df=m`（近一月）；
- 中文主题可以再试 Bing：`curl -s "https://www.bing.com/search?q=<q>&setlang=zh"`。

## 学术 / 论文

```bash
# arXiv（Atom XML）
curl -s "http://export.arxiv.org/api/query?search_query=all:%22deep+research+agent%22&sortBy=submittedDate&sortOrder=descending&max_results=10"

# Semantic Scholar（JSON；未认证约 1 请求/秒）
curl -s "https://api.semanticscholar.org/graph/v1/paper/search?query=deep+research+agent&fields=title,year,abstract,citationCount,externalIds,url&limit=10"

# OpenAlex（JSON，限额宽松；带 mailto 更礼貌）
curl -s "https://api.openalex.org/works?search=deep%20research%20agent&per-page=10&mailto=research@example.com"
```

arXiv 论文全文：`https://arxiv.org/abs/<id>` 拿摘要，`https://ar5iv.org/abs/<id>` 拿 HTML 全文。
（后者是 JS 不多的静态页，`curl` 一般能取到；取不到就交回编排者用浏览器。）

## 代码 / GitHub

```bash
# 仓库搜索（未认证 60 请求/小时）
curl -s "https://api.github.com/search/repositories?q=deep+research+agent&sort=stars&per_page=10"

# 某仓库的 README
curl -s "https://raw.githubusercontent.com/<owner>/<repo>/HEAD/README.md"
```

## 社区 / 讨论

- Hacker News：`https://hn.algolia.com/api/v1/search?query=<q>&tags=story`（JSON，无需 key）
- Stack Overflow：`https://api.stackexchange.com/2.3/search/advanced?q=<q>&site=stackoverflow`（JSON）
- Reddit：`https://www.reddit.com/search.json?q=<q>`，或在任意帖子 URL 后加 `.json`
  （纯 HTML 页现在多要 JS，`.json` 端点更稳）

## 数据 / 事实

- Wikipedia REST：`https://en.wikipedia.org/api/rest_v1/page/summary/<title>`（JSON）
- Wikidata：`https://www.wikidata.org/w/api.php?action=wbsearchentities&search=<q>&language=en&format=json`

## 可选增强（**已配置才用，绝不强求**）

环境里若已有这些 MCP server / 工具，按各自擅长优先用；没有就**静默忽略**：

- Firecrawl MCP → 需要 JS 渲染、`curl` 取不好的页面；
- arxiv / paper-search MCP → 下载论文 + 抽 PDF 文本；
- 任何搜索 MCP（Tavily / Exa…）→ 比 DuckDuckGo 质量更高的结果。

**绝不要求用户中途去装或配任何东西。**
