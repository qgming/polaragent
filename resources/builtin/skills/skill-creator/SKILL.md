---
name: skill-creator
description: 创建或优化 PolarAgent 本地自定义技能：先通过网络调研和需求澄清确定技能边界，再在应用数据目录的 skills/custom 下创建完整技能文件夹、SKILL.md、references/scripts/assets 等内容，并验证该技能能被后续助手正确发现和使用。当用户说想创建新技能、封装工作流、把某类能力沉淀成技能、改进已有技能时使用。
license: MIT
allowed-tools: web_search, web_fetch, list_directory, create_directory, read_file, write_file, edit_file
metadata:
  author: PolarAgent Team
  version: "1.0.0"
  category: 创作
---

# 技能创建

这项技能指导你把用户的一类重复任务沉淀成一个可复用的本地 Skill。目标不是写一篇说明文，而是在本地 `skills/custom/<skill-name>` 创建一个能被 PolarAgent 加载、后续助手能按需读取的完整技能文件夹。

## 工作流程

1. **澄清目标**  
   确认用户想让技能解决什么问题、触发场景是什么、典型输入/输出是什么。需求很清楚时直接推进；不清楚时只问 1-3 个关键问题。

2. **必要时网络调研**  
   如果技能涉及外部工具、框架、平台规则、最佳实践或近期变化，先用 `web_search` 检索，再用 `web_fetch` 阅读权威来源。优先使用官方文档、规范、项目仓库、论文或可信资料。把调研结论转成技能中需要的流程、约束和参考链接。

3. **设计技能结构**  
   先确定技能名，必须使用小写字母、数字和连字符，例如 `pdf-report-builder`。默认创建到本地应用数据目录：
   - 读取本技能时，系统提示会给出当前 `SKILL.md` 的绝对路径。
   - 将路径中的 `skills/builtin/skill-creator/SKILL.md` 替换为 `skills/custom/<skill-name>/`，即可得到目标目录。
   - 如果用户明确给了其它目标路径，按用户路径创建。

4. **创建文件夹和文件**  
   使用 `create_directory` 创建技能目录。至少写入：
   - `SKILL.md`：必需，包含 YAML frontmatter 和正文说明。
   - `references/`：当需要较长背景、规范、示例、调研笔记时创建。
   - `scripts/`：当有可重复、容易出错、需要确定性的操作时创建脚本。
   - `assets/`：当技能需要模板、图片、示例项目、字体等输出素材时创建。

5. **写 SKILL.md**  
   frontmatter 必须包含：
   - `name`: 与文件夹名完全一致，只用小写字母、数字、连字符。
   - `description`: 写清楚“做什么”和“什么时候触发”，不要只写泛泛介绍。

   正文只保留执行该技能所需的核心流程。详细资料放入 `references/`，并在正文中说明何时读取。

6. **验证**  
   创建后用 `list_directory` 检查目录结构，用 `read_file` 读取 `SKILL.md` 自查。确认：
   - `SKILL.md` 存在且 frontmatter 以 `---` 包裹。
   - `name` 与目录名一致。
   - `description` 能覆盖用户期望的触发词。
   - references/scripts/assets 不是空洞摆设，每个文件都有明确用途。

## 编写原则

- 默认用中文写技能，除非用户要求其它语言。
- 保持 `SKILL.md` 精简；复杂背景放到 `references/`。
- 只创建必要文件，不创建 README、CHANGELOG、安装指南等无关文件。
- 不要把调研原文大段复制进技能；提炼成可执行规则，并保留来源链接。
- 技能应该指导未来助手“怎么做”，而不是对用户解释“这个技能是什么”。

## 参考资料

- [技能目录与内容设计](references/SKILL_DESIGN.md)
- [创建后的校验清单](references/VALIDATION.md)
