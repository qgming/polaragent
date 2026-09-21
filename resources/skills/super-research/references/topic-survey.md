# 模式：主题调研（Topic survey / 主题调研）

当用户希望**通过搜集并综括外部来源**来回答一个研究问题时使用 ——「调研一下文献」「调研 X」「Y 领域的最新进展」「搜集关于 Z 的证据」。

本模式要防范的失败模式：产出一份听起来头头是道、却无法回溯到具体来源的综述。每一条论断都必须能追溯到 `sources.tsv` 里的某一行。

## 契约字段

1. **研究问题**：一个问题，且要尖锐到**存在答案**。如果用户问「强化学习的现状如何」—— 谈判成「截至 2026 年中期，离线 RL 的前三大开放问题是什么」之类。模糊的问题只会产出模糊的调研。
2. **范围边界**：时间窗（例如「2024 年以来的论文」）、来源类型（同行评审 / 博客 / benchmark / 代码仓库 —— 要写明确）、语言，以及用户关心的任何显式纳入/排除项。
3. **深度**：至少多少个来源才停？默认短调研 15 个，彻底调研 30 个。还有：饱和判据 —— 当最近 5 个来源没有为你的综括增加任何新论断时停止。
4. **交付物**：Markdown 报告 + `sources.tsv`（证据表）+ 可选的 `claims.tsv`（论断 ↔ 来源映射）。长度目标（通常报告正文 1–3 页）。
5. **工作目录**：专用文件夹 `survey/<tag>/`。所有东西 —— 日志、来源、笔记、草稿 —— 都放这里。

## 基线

你的基线是**在搜索之前先做一次结构化的问题拆解**：

- 写 `question.md`，内容含：问题本身、子问题、理想答案长什么样，以及你将用来搜索的 5–10 个关键词变体 / 同义词簇。这会逼你在动手搜之前先想清楚。
- 然后做一轮「冷启动」—— 用最显然的查询搜 3 次，把结果记进 `sources.tsv`。这是你的基线轮。它告诉**你**（以及后来的人类）一次朴素搜索会返回什么。

## 证据日志

`sources.tsv`（tab 分隔），每遇到一个来源记一行：

```
id	url_or_id	kind	year	title	relevance	credibility	claim_ids	notes
S001	arxiv.org/abs/2405.12345	paper	2024	Attention Is All You Need V2	high	high	C1,C3	primary reference on X
S002	nitter.net/andrejkarpathy/status/…	tweet	2026	Thread on Y	medium	low	C2	anecdotal but from primary author
S003	dead-link	404	—	—	dead	dead	—	referenced by S001 but 404
```

- **id** —— `S001`、`S002`… 单调递增。报告里引用的就是它。
- **url_or_id** —— 足以重新定位该来源。
- **kind** —— `paper` / `preprint` / `blog` / `docs` / `code` / `tweet` / `book` / `talk` / `podcast` / `other`。写明确，复核者才能据此给权重。
- **year** —— 用于时效性筛选。
- **title** —— 简短。
- **relevance** —— `high` / `medium` / `low` —— 这个来源对你综括的推动有多大。
- **credibility** —— `high`（同行评审、原作者、官方文档）、`medium`（被广泛引用的预印本、有信誉的博客）、`low`（匿名博客、无旁证）、`dead`（404、已撤稿）。**不要因为来源赞同你的论点就抬高可信度。**
- **claim_ids** —— 该来源支撑的论断 ID（见下方 `claims.tsv`）。仅作背景的来源可以留空。
- **notes** —— 一行；如果有用就写成可机器解析的形式（「supersedes S001」「contradicts C3」）。

**你看过的每一个来源都要记，包括死链和重复项。** 日志的意义不是当参考文献表 —— 而是当审计轨迹。一个最后发现是 404 的来源，或一篇读完摘要才发现跑题的论文，都是**真实做过的工作**，值得记录。悄悄丢弃来源，正是调研被指控为「挑樱桃」的由来。

## 论断日志（可选但推荐）

`claims.tsv`，你的综括所依赖的每一条独立论断记一行：

```
id	claim	support_sources	contradict_sources	confidence
C1	Muon optimizer outperforms AdamW on small-scale LM training by 5-15% val loss reduction	S001,S004,S007	S012	high
C2	SwiGLU activation is universally better than GeLU	S002,S008	S015,S016	medium — two credible contradicting sources
C3	Byte-level tokenization is competitive with BPE below 1B params	S001	—	low — single source
```

如果一条论断**没有任何**反驳来源，这很可疑 —— 要么是大家都同意（成熟领域里常见），要么是你还没认真去找反方意见。在 confidence 里把这一点注明。

## 循环

循环直到饱和，或者达到深度下限**且**最近 5 个来源没有带来新论断：

1. 挑覆盖最弱的那个子问题。选一个查询 —— 各轮之间变换关键词、站点、时间窗。
2. 取回结果。对每一个，读到足以判断相关性的程度（摘要、第一节、关键图）。
3. 记入 `sources.tsv` —— 你看过的每个来源，不只是有用的那些。
4. 如果它支撑或反驳了已有论断，更新 `claims.tsv`。如果它引入了新的独立论断，加一行。
5. 每约 5 个来源，完整重读一遍 `claims.tsv` —— 综括就发生在这里。论断在变锋利吗？有论断在新证据下崩塌吗？有新子问题浮现吗？
6. 继续循环。

## 学术型 / 论文为主的调研 —— 用工具箱

当你关心的来源是同行评审论文或 arXiv 预印本（而非博客 / 推文 / 文档）时，优先用共享脚本而不是临时抓取网页。它们在一次调用里查询多个免费 API 并替你完成去重：

```bash
# 多源论文搜索 —— arXiv + S2 + OpenAlex + Crossref
node scripts/paper_search.mjs "<query>" --sources arxiv,s2,openalex --limit 20 --year-from 2022 --out papers.json

# 从一篇核心论文出发滚雪球（S2 的引用图）
# → 见 references/api-cheatsheet.md 的 Semantic Scholar 一节，`/paper/<id>/citations` 和 `/references`

# 取论文全文或 LaTeX 以便精读
node scripts/fetch_paper.mjs <arxiv_id> --out papers/<slug>.txt
node scripts/fetch_paper.mjs <arxiv_id> --latex --out-dir papers/<slug>/src/
```

论文调研中真正划算的战术：

- 跑 2–4 个查询变体（同义词、子领域术语）再合并 —— 关键词搜索会漏掉相邻文献。
- 滚雪球：对最核心的 2–3 篇论文，沿 S2 的 citations/references 走一遍（见 `references/api-cheatsheet.md`）。一次好的滚雪球胜过又一轮关键词扫描。
- 也要抓取综述论文的相关工作章节和 awesome-list —— 它们能挖出关键词搜索排不上来的东西：主会话用 `browser_open` + `browser_snapshot`；子智能体用 `bash` + `curl`。
- **最终报告里的每一个 URL 都必须来自某一行 `papers.json`，或来自你实际发起过的抓取。** 凭记忆回忆出来的 URL 就是幻觉，不要写。
- 要在 10–25 篇论文上并行抽取信息时，按每批 3–5 个派生子智能体，每个子智能体拿到的是**已抓取的正文文件路径**（不是摘要总结）以及 `question.md` 里的字段 schema。

## 判断准则

**深度优先，广度其次。** 认真读一篇论文，往往比泛读十篇更能推动综括。与其再搜一轮关键词，不如优先沿高质量来源的引用往下走。

**矛盾是金子 —— 标出来，别和稀泥。** 两个可信来源互相打架，**那本身就是**该子问题的发现。你的职责是把它摆到台面上，而不是选一个赢家 —— 除非证据明显一边倒。

**积极地更新论断。** 一个新的高可信度反证，应该迫使你下调某条论断的置信度，即使你已经把那一节写完了。如果你发现自己是在为早先的立场辩护而不是更新它，那你做错了。

**绝不编造引用。** 如果你想下的某条论断找不到来源，不要发明一个。把论断弱化（「看起来是普遍做法，但我们未能找到同行评审来源」）并注明。

## 最终报告

见 SKILL.md 的「Reporting」。正文的模式专属结构：

- **对研究问题的回答** —— 开头 2–3 句。如果确实没有定论，就直说。
- **各子问题的发现** —— 每个子问题一段。每一句非平凡的句子都内联引用 `S00N`。
- **矛盾与开放问题** —— 来源在哪里分歧，哪些还没定论。
- **方法说明** —— 检视了多少来源、在第 N 个来源处达到饱和、排除了什么以及为什么。
- **往哪里看**：`sources.tsv`、`claims.tsv`、`survey/<tag>/` 文件夹。
