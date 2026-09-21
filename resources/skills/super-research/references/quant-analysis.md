# 模式：量化分析（Quantitative analysis / 量化分析）

当用户想要一个从数据集算出来的、以数据为依据的答案时使用 ——「分析这份数据」「量化分析」「检验 X 是否与 Y 相关」「估计 Z 的效应」「研究一下这个数据集」。

本模式要防范的失败模式：产出一张看起来像样的图表或统计量，而用户无法复现、无法验证、也看不懂它的前提假设。**每一个报告出来的数字都必须能追溯到某个脚本，而每个脚本都必须能在原始数据上端到端跑通。**

## 契约字段

1. **问题**：一个清晰的假设或估计目标。不是「看看这份数据」，而是「在控制 Z 之后，特征 X 能预测结果 Y 吗？」或「按团队分组的首次响应时间中位数是多少？」。如果用户只有数据集没有问题，就在契约里谈判到一个具体问题。
2. **数据集**：路径、格式（CSV / parquet / JSON / 数据库连接）、已知行数、已知 schema。记下用户提醒的任何事（已知缺失值、重复列、样本偏差）。
3. **交付物**：一份含结论的 `report.md`、一个 `analysis_log.tsv`（每个分析步骤一行），以及一个 `scripts/` 文件夹，里面是按编号排列、能复现报告中每个图和数字的脚本。可选再加一个 `figures/` 文件夹。
4. **约束**：什么是禁区？（例如「不要和内网 HR 表做关联」「每个脚本计算必须在 10 分钟内跑完」「不用 ML 库 —— 保持可解释的统计」）。
5. **工作目录**：专用文件夹 `analysis/<tag>/`。所有东西都放那里。

## 基线 —— 数据审计

在做任何建模或假设检验**之前**，先产出一次数据审计。这是你的基线产物；如果审计暴露出足够严重的问题（schema 不对、单位不对、文件损坏），分析就到此为止，改为报告这个发现。

审计是一个脚本（`scripts/00_audit.mjs` 之类），输出 `audit.md`，涵盖：

- **形状**：行数、列数。
- **Schema**：列名、dtype、非空计数、唯一值计数、min/max 或 top-3 取值。
- **缺失情况**：每列的空值百分比，以及空值是否是系统性的（例如与另一列相关）。
- **重复**：是否存在整行重复；在自然键上是否有重复。
- **离群值**：对每个数值列，给出第 1/99 百分位处的取值，以及明显越界的值。
- **针对问题的合理性检查**：回答该问题所需的那一列到底存不存在，非空方差够不够？

如果审计揭示了致命问题（用这份数据根本回答不了该问题），停下并报告。不要拿糊弄盖过去。

## 分析日志

`analysis_log.tsv`（tab 分隔），每个分析步骤一行：

```
step	script	status	finding	caveat
01	scripts/00_audit.mjs	done	dataset OK: 42k rows, 3.2% missing in `age`, one obvious duplicate row	age nulls concentrated in the pre-2023 cohort — possible collection bias
02	scripts/01_distributions.mjs	done	Y is bimodal (peaks at 12 and 34); no obvious transform makes it normal	rules out linear regression as the primary tool
03	scripts/02_correlation.mjs	done	corr(X, Y) = 0.31, n=41000, p<1e-9	correlation not causation; X and confounder W are also correlated at 0.42
04	scripts/03_effect_of_X_controlling_for_W.mjs	done	partial correlation 0.09, 95% CI [0.06, 0.12]	effect size much smaller than raw correlation suggested
05	scripts/04_robustness_stratified.mjs	dead-end	stratifying by W gave inconsistent effect direction across strata (Simpson-flavored)	primary finding is unstable — must caveat in report
06	scripts/05_dependent_variable_check.mjs	done	Y distribution stable across strata, no measurement artifact	rules out one alternative explanation for step 5
```

- **step** —— `01`、`02`… 单调递增。
- **script** —— 产出该发现的文件名。不是脚本产出的，就不算数 —— 不许有肉眼估出来的数字。
- **status** —— `done` / `dead-end` / `inconclusive` / `error`。每次尝试都要记，即使没成功。
- **finding** —— 一句话，尽可能量化。
- **caveat** —— 一句话，说明它为什么比看起来要弱。caveat 为空就很可疑。

## scripts 文件夹

- 按步骤编号（`00_audit.mjs`、`01_distributions.mjs`、…），读者才能按顺序重跑。
- 每个脚本：读原始数据、只做一件事、把图写到 `figures/`、打印它的发现（你把这段复制进日志）。脚本之间不共享可变状态 —— 除非你中间写出一个 parquet 再读回来。
- 不允许来自 Jupyter kernel 的隐藏全局变量 —— 只能在活 notebook 里跑的脚本不算可复现。

## 循环

循环：

1. 看分析的当前状态（日志、最近的发现、还没解决的子问题）。
2. 选出下一个信息量最大的步骤。典型分析的运算顺序：审计 → 单变量分布 → 双变量探索 → 用合适模型的假设检验 → 稳健性检查（子群、替代设定）→ 排除替代解释。
3. 写脚本。运行它，捕获打印出来的发现 + 图。
4. 追加到 `analysis_log.tsv`。如果是个 dead-end（假设不成立、变量不可用、一检查效应就消失），也记下来 —— dead-end 正是你证明结论为真的方式。
5. 如果发现暗示了一个**新**假设，写进日志的 caveat 列并加入队列。**不要**在分析中途更换主问题，除非数据让它变得无法回答 —— 那种情况下要显式记录这次变更。
6. 循环直到：问题被回答且带有量化的置信区间**并且**稳健性检查印证了它，或者数据被证明无力回答它。

## 判断准则

**效应量优先于 p 值。** p<0.001 而效应量只有 0.02 的相关，只是一个巨大的样本在告诉你一件没意思的事。报告效应量 + 置信区间；把 p 值当作平局时的裁断依据。

**每个发现都要至少尝试一种替代解释。** 如果 X 预测 Y，还有什么能预测 X？你考虑了哪些混杂因素？用什么东西排除了哪些？如果一个都没考虑，你就还没做完。

**不要 p-hack —— 你跑过的每个设定都要记。** 如果你试了 4 种回归设定而其中一种显著，日志必须显示全部 4 种。只报告显著的那一个就是造假。

**当答案是「用这份数据看不出来」时，就照实说。** 一个诚实的不确定结论，胜过伪造精度的结论。日志让这个立场站得住脚。

## 最终报告

见 SKILL.md 的「Reporting」。模式专属正文：

- **核心发现** —— 1–2 句，带上效应量和置信度。
- **我是怎么得到的** —— 3–6 个要点，指向 `analysis_log.tsv` 中具体的 step ID。
- **稳健性** —— 试过哪些替代设定，哪些存活了下来。
- **前提与局限（Caveats）** —— 这个发现可能出错、或比看起来更窄的三大原因。
- **往哪里看**：`analysis_log.tsv`、`scripts/`、`figures/`，以及那份审计。
