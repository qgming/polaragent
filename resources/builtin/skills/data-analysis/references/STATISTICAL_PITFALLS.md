# 统计陷阱与规避参考

这些陷阱的共同根源：**对看不见的东西下结论**——忽略了混淆变量、缺失的数据点或不具代表性的样本。常见的补救手段是：运用领域知识、把「提出假设」与「验证假设」分开、对数据适当分层、用对照实验确立因果。

## 1. 相关 ≠ 因果（Correlation vs. Causation）
相关只是统计关联，因果是一个变量直接引起另一个变化。
- 经典例：夏天冰淇淋销量与犯罪率都上升——不是冰淇淋导致犯罪，而是「高温」这个第三方混淆因素同时影响两者。
- 规避：先怀疑是否存在第三变量或巧合；用领域知识判断因果是否合理；要真正确立因果，通常需要对照实验隔离单一变量的影响。

## 2. 抽样偏差（Sampling Bias）
样本不能代表你想推断的总体，结论就不可推广，且估计可能系统性失真。
- 例：长度偏倚抽样（length-biased sampling）会让某些样本被过度采集，导致生存时间估计被误导。
- 规避：先弄清「这批数据是怎么选出来的」，评估它对目标总体的代表性。

## 3. 幸存者偏差（Survivorship Bias）
只关注「通过了某筛选过程」的对象，忽略了没通过、因而不可见的那些。
- 经典例：二战工程师只统计返航飞机的弹孔，原想加固弹孔多的部位；实际应加固返航飞机「没有弹孔」的部位——因为被打中那里的飞机根本没飞回来。
- 规避：追问「哪些数据没有出现在表里」。

## 4. 辛普森悖论（Simpson's Paradox）
分组（子群）内部的关联趋势，在不分层合并后可能整体反转。
- 经典例：伯克利研究生招生案——女性整体录取率更低，看似歧视；分院系看却各院系女性录取率不低，原因是更多女性报考了竞争更激烈、整体录取率低的院系（未被计入的混淆变量）。
- 注意：连续数据同样会出现，不限于计数数据；也不能简单靠随机化避免。
- 规避：涉及分组数据时，先按关键维度分层观察，再考虑是否合并。

## 5. 数据钓鱼 / 多重比较 / 德州神枪手谬误
在同一份数据里反复尝试，总能「凑」出某个看似显著的关系（spurious correlation 伪相关）。
- 规避：**先提出假设，再用数据检验**；不要用同一份数据既构造假设又验证假设。

## 来源

- [Common Pitfalls in Data Analysis and How to Avoid Them — Medium](https://medium.com/@yasmeenosama5550/common-pitfalls-in-data-analysis-and-how-to-avoid-them-1bdc56ed8ccd)
- [Correlation vs. Causation: A Data Scientist's Guide — Medium](https://medium.com/@kirti07arora/correlation-vs-causation-a-data-scientists-guide-a3c1fdd82abd)
- [Hidden Data and Surviving a Sinking Ship: Simpson's Paradox — Select Statistical Consultants](https://select-statistics.co.uk/blog/hidden-data-and-surviving-a-sinking-ship-simpsons-paradox/)
- [Common pitfalls in statistical analysis: correlation — PMC/NCBI](https://pmc.ncbi.nlm.nih.gov/articles/PMC5079093/)
- [A Quick Guide to Statistical Fallacies — Litera](https://www.litera.com/blog/quick-guide-statistical-fallacies-and-how-avoid-them)
