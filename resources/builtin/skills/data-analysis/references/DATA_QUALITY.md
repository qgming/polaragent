# 数据质量评估参考

判断「数据能不能用」的系统方法。数据质量维度框架最早由 Richard Y. Wang 与 Diane M. Strong 在 1996 年论文《Beyond Accuracy: What Data Quality Means to Data Consumers》中提出（原有 15 个维度），如今业界普遍收敛为 6–10 个核心维度。

## 六个核心维度

### 1. 准确性（Accuracy）
数据在多大程度上如实反映现实中的对象、事件或公认来源。
- 例：客户街道地址正确，但邮编对不上 → 准确性不足。
- 检查法：统计分析、数据画像、一致性检查、抽样比对、人工点检。

### 2. 完整性（Completeness）
所需的记录与字段是否齐全、无缺失。
- 例：若 95% 的客户记录字段填全，则完整性约 95%。
- 检查法：统计必填字段空值/缺失值；区分「真的没有」与「未记录」。

### 3. 一致性（Consistency）
同一数据在多个系统/同一数据集内是否一致、无矛盾，包含：
- 值一致（同一元素跨系统取值相同）
- 格式一致（日期格式、计量单位统一）
- 结构一致（数据结构与关系兼容）
- 时间一致（随时间保持连贯）
- 例：员工离职日期在 HR 与薪资系统不一致 → 数据不一致。

### 4. 时效性（Timeliness）
数据是否足够新、是否覆盖到分析所需的时间范围。
- 检查法：查看最后更新时间、数据截止日，判断是否过时。

### 5. 有效性（Validity）
取值是否符合规定的取值域/格式。
- 检查法：用业务规则约束（取值范围、默认值、枚举、格式）。

### 6. 唯一性（Uniqueness）
是否存在重复记录。
- 检查法：按主键/关键字段去重并统计重复比例。

> 部分框架还会补充：现势性（Currency）、符合性（Conformity）、完整无损（Integrity）、精度（Precision），凑成 10 个维度。许多人把「Integrity 完整无损」视为「准确+一致+完整」管理得当后的总体结果，而非单独维度。

## 评估的工作方法

1. **先定要求与基准**：在分析规划阶段就明确「合格数据」的标准，常以阈值/最低分表示（如关键字段填充率 ≥99%）。把这些写成可校验的数据质量规则。
2. **画像与测试**：用数据画像、抽样、属性画像识别问题；准确性问题常源于上游来源冲突、数据过时、分析代码缺陷。
3. **具体校验项**：必填字段/空值/缺失检查（完整性）；格式检查（一致性）；取值范围/默认值（有效性）；最近更新时间（时效性）；行/列/取值/符合性检查（完整无损）。

## 最佳实践

- **按业务需要取舍维度**：实时分析最看重时效性；合规场景最看重准确性与有效性。
- **设可量化的目标**：不要「让数据更好」这种空话，而是「重复客户记录减少 50%」「关键字段填充率 99%」。
- **定期跨维度审计**，并建立监控暴露各维度的缺口。
- **明确数据 Owner**：没有数据管家/责任人，质量难以长期维持。

## 来源

- [What Are Data Quality Dimensions? — IBM](https://www.ibm.com/think/topics/data-quality-dimensions)
- [The 6 Data Quality Dimensions with Examples — Collibra](https://www.collibra.com/blog/the-6-dimensions-of-data-quality)
- [6 Data Quality Dimensions — iceDQ](https://icedq.com/6-data-quality-dimensions)
- [The 6 Data Quality Dimensions (Plus 1) — Monte Carlo](https://www.montecarlodata.com/blog-6-data-quality-dimensions-examples/)
- Wang, R. Y., & Strong, D. M. (1996). *Beyond Accuracy: What Data Quality Means to Data Consumers.* Journal of Management Information Systems.
