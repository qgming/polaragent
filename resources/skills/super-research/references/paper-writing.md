# 模式：写论文 & 引用校验（Paper writing + citation audit / 写论文 & 引用校验）

当用户要求撰写、润色一篇学术论文，或核验其参考文献表时使用 ——「写一篇关于 X 的论文」「润色这份草稿」「逐条检查引用」「查引用」「citation audit」。也可独立用于一份已有、但引用让你不放心的 PDF/tex。

本模式要防范的失败模式：**编造的参考文献**，以及（更糟的）把真实论文引在了它其实并未提出的论断上。一份参考文献表全是幻觉的润色稿，在复核者打开你引用的某篇论文之前看起来完美无缺 —— 然后一切崩塌。**终稿里的每一条引用都必须追溯到一条 API 返回的记录。**

本模式分两部分。它们可以一起跑（写一篇新论文），也可以独立跑（审计别人的论文）。

## Part A：写作

### 契约字段（写作）

1. **手头输入**：已有草稿（路径）、实验日志 / `results.tsv`（路径 —— 这可能就是一次实验循环运行的产物）、图表、目标会议/期刊 + 模板、页数上限。
2. **论断主线（Claim spine）**：这篇论文将要提出的 3–7 条实证论断。在起草之前写好。每条论断都要映射到 (a) 某一行具体的 `results.tsv` / 某张图，或 (b) 一篇被引论文。如果一条论断两边都映射不到，**现在**就删掉或弱化 —— 而不是等复核者发现。
3. **大纲**：章节结构，每节配 1–2 句话说明其目的 + 该节的关键论断。起草前与用户确认。
4. **参考文献来源**：`refs.bib` 在你写作的过程中由 `scripts/paper_search.mjs` 的结果构建。每一条目都源自一条 API 记录 —— 元数据从 JSON 复制，绝不从记忆中回忆。
5. **工作目录**：`paper/<tag>/` —— draft.tex 或 draft.md、`refs.bib`、`claims.tsv`、`citation_audit.json`、修订 `LOG.md`。

### 基线 —— 论断映射表

起草之前：写 `claims.tsv`，每条实证论断一行，各自映射到它的证据来源。这是你的基线产物。

```
id	claim	evidence_kind	evidence_ref	confidence	notes
K1	our method reduces val-loss by 12% at 200M params	own experiment	results.tsv row 47 (commit c3d4e5f)	high	
K2	prior work uses AdamW as default optimizer for LMs	cited paper	@vaswani2017,@brown2020	medium	need one more citation for "default"
K3	Muon has been shown to outperform AdamW at small scale	cited paper	@karpathy2024	low — single blog source	replace with peer-reviewed source or hedge
K4	our approach is "significantly better"	???	—	—	CUT — no evidence source, drop or hedge
```

没有证据来源的行，要在起草前删掉或弱化。剩下的每一行都必须能通过 Part B 的审计。

### 修订日志

`LOG.md`（只追加），每一轮起草或修订记一条：

```
2026-07-07T14:30  outline confirmed with user (3 sections, 6 pages)
2026-07-07T15:10  drafted §2 (related work) — refs added: karpathy2024, vaswani2017, brown2020
2026-07-07T16:00  ran citation audit v1 — 2 NOT_FOUND, 1 MISMATCH; fixed metadata, replaced fabricated ref
2026-07-07T17:20  reviewer subagent pass — flagged §4 overclaims "significantly"; softened to "consistently"
```

### 起草循环

对大纲里的每一节：

1. 一节一节地起草。数字来自 `results.tsv` 和图表 —— 绝不含入取整，绝不肉眼估读。
2. 每条引用都在论断被提出的那个位置插入。当你插入 `\cite{key}` 时，确保 `key` 存在于 `refs.bib` 且来自某条 `paper_search.mjs` 结果。如果还没有，现在就跑搜索、加入条目，然后才引用。
3. 每写完一节，重读一遍：每个非平凡的句子是否都带了引用或 `results.tsv` 指向？空引用是反模式。
4. 全稿完成后：在评审轮之前先跑 Part B（引用校验）—— 你不会想让复核者发现你本可以机械地抓出来的编造。
5. **评审子智能体轮** —— 派生一个全新的子智能体，只给它草稿路径（不给你的 `claims.tsv`，不给你的置信度）。要它给出最强的拒稿论证：最弱的论断、缺失的 baseline、过度声称。在正文里回应，或明确承认。1–3 轮；当新发现开始变得只是表面文章时就停。
6. **精修只会收紧，绝不膨胀。** 如果一轮修订结束时论断比基线更强了，就回退 —— 你已经漂移到了过度声称。

## Part B：引用校验

可对任何带参考文献表的论文/草稿运行。可独立使用（对一份已有 PDF/tex「查引用」）。

### 契约字段（仅审计）

1. **bib 来源**：`refs.bib` 的路径（或从论文 PDF/tex 中抽取 bib 的路径）。
2. **草稿来源**：tex/md 草稿的路径（Part B 第 2 步的上下文审计需要它）。
3. **交付物**：`citation_audit.json`（逐条目裁定）、`audit_report.md`（小结 + 修复）。
4. **修复权限**：审计者可以自动做什么、必须先问什么（见下面的修复矩阵）。

### 基线 —— 机械审计

在做任何上下文分析之前，先对整个 bib 跑元数据检查：

```bash
node scripts/verify_citation.mjs --bib refs.bib --out citation_audit.json
```

逐条目的机械裁定：

| 裁定 | 含义 |
|---|---|
| `VERIFIED` | 标题/作者/年份与 Crossref / S2 / OpenAlex / arXiv 中的真实记录匹配 |
| `MISMATCH` | 找到了记录，但元数据不一致（年份错、会议错、第一作者错） |
| `NOT_FOUND` | 4 个 API 全都查不到 —— 可能是编造的 |
| `UNCERTAIN` | 多个弱匹配，无法确定 |

`citation_audit.json` 就成为本次运行的审计日志。每一条目都必须有裁定；不许悄悄跳过任何一条。

### 上下文审计 —— 真正要紧的那个失败模式

把一篇真实论文引在它并未提出的论断上，比一条明显编造的引用更糟，因为它能通过机械检查。对草稿里的每条引用：

1. 抽出含 `\cite{key}` 的那句话，识别它支撑的具体论断。
2. 取回被引论文的摘要（从 `citation_audit.json` 的 `matched` 字段取，或用 `scripts/fetch_paper.mjs <arxiv_id>`）。
3. 判定为以下之一：`SUPPORTS` / `WEAK`（摘要有所暗示但未直接这么说）/ `WRONG`（摘要不含该论断）/ `UNKNOWN`（需要取全文 —— 标记留待后续）。
4. 对**承重引用**（论文的核心贡献所依赖的论断），要读摘要之外的内容 —— 把抓取预算花在这些地方。

参考文献表很长时，用子智能体批量处理。每个子智能体拿到那句话 + 摘要 + 引用 key —— **不要**给它你对裁定结果的预期。新鲜的眼光能防止确认偏差。

把上下文裁定追加到 `citation_audit.json` 的每一条目上。

### 修复矩阵 —— 四种裁定，四种动作

| 组合裁定 | 动作 | 自动？ |
|---|---|---|
| VERIFIED + SUPPORTS | KEEP | 是 |
| VERIFIED + WEAK | REVIEW（必要时在正文里弱化该论断） | 问用户 |
| MISMATCH + SUPPORTS | 用 `matched` 字段修复元数据 | 是 |
| MISMATCH + WRONG | REPLACE | 问用户 |
| NOT_FOUND | REPLACE（搜索真实替代品）或 REMOVE | 问用户 |
| 任意 + WRONG | REPLACE（找一篇真正支撑该论断的论文）或 REMOVE + 弱化 | 问用户 |
| UNCERTAIN / UNKNOWN | 保留标记；**不要**猜一个裁定 | — |

**REMOVE 之后绝不要留下悬空的 `\cite`。** 删除 `.bib` 条目**和**删除 `\cite` 是一次操作。如果某条论断只靠一条被移除的引用支撑，那这条论断现在就没有支撑了 —— 弱化它或删掉它。

**修复只能来自 API 返回的记录，绝不来自记忆。** 如果 API 说年份是 2023 而 bib 里写 2022，以 API 为准。绝不要按你以为的论文年份去改元数据。

### 审计报告

`audit_report.md`：

```
Total entries: 47
VERIFIED + SUPPORTS: 39 (kept)
MISMATCH (fixed):    5   → metadata corrected from API records
NOT_FOUND:           2   → 1 replaced (Muon → @jordan2024muon), 1 removed + claim hedged
WRONG context:       1   → replaced (@brown2020 cited for a claim only @wei2022 makes)
UNCERTAIN:           0   remaining after review
```

## 反模式（两部分通用）

- 把数字往有利方向取整。
- 没有统计检验却使用「显著（significantly）」。
- 把一篇论文引在它摘要中并不包含的论断上（Part B 第 2 步会检查）。
- 在精修阶段扩张论断（精修只会收紧，绝不膨胀）。
- 凭记忆而不是 API 结果填写 bib 元数据。
- 仅凭标题匹配就把一条承重引用标成 `VERIFIED`，而没有读摘要。

## 最终报告

见 SKILL.md 的「Reporting」。模式专属正文：

- **写了什么 / 审计了什么** —— 一段话。
- **论断映射小结** —— 总共多少条论断，多少条由自己的实验支撑、多少条由被引工作支撑，多少条在写作过程中被删掉或弱化。
- **审计结果** —— 按裁定分类的条目计数、采取的动作、未解决的 `UNCERTAIN` 条目。
- **残余风险** —— 任何带着弱化措辞存活到终稿里的 WEAK 或 UNKNOWN 引用，以及原因。
- **往哪里看**：`claims.tsv`、`refs.bib`、`citation_audit.json`、`audit_report.md`、草稿、`paper/<tag>/`。
