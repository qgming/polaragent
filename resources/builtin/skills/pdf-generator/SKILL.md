---
name: pdf-generator
description: 生成专业 PDF 文档的内置技能。用于报告、方案、白皮书、管理层简报、数据分析报告、商业提案、一页纸材料等 PDF 交付物。必须先设计语义化 HTML，再通过 PolarAgent 的 HTML-to-PDF 能力导出 PDF；禁止把 Markdown、纯文本或默认排版直接转成 PDF。支持 14 种专业模板风格，可手动指定或按内容自动匹配。
---

# PDF Generator

## 核心原则

PDF 不是 Markdown 的打印版。先把内容组织成有版式意图的 HTML，再导出 PDF。

- 不要直接 Markdown-to-PDF。
- 不要只把正文塞进默认浏览器页面。
- 先生成完整 HTML：`@page`、打印样式、标题层级、卡片、表格、图表占位、页眉页脚、分页控制。
- 再调用 PolarAgent 的 `create_office_document` 工具生成 PDF。
- 生成 PDF 时同时保留同名 `.html` 工作稿，方便后续改版式。

## 风格总览（14种）

| 风格 | 适用场景 | 视觉特征 | 字体 |
|------|---------|---------|------|
| `executive` | 管理层简报、董事会 memo、战略报告 | 安静、宽敞、高端，墨绿强调色 | Heading: Georgia 衬线 / Body: 无衬线 |
| `data` | KPI 报告、数据分析、运营复盘 | 密集、结构化、分析性强，深蓝强调色 | 无衬线 + 等宽体数字 |
| `proposal` | 商业方案、项目计划、报价 | 精致、有说服力，酒红强调色 | 无衬线 + Display 标题 |
| `whitepaper` | 白皮书、长文研究、政策分析 | 编辑感、优雅、可读性强，墨绿强调色 | 全篇 Georgian 衬线 |
| `academic` | 学术论文、研究手稿、期刊文章 | 严肃、文献感，暗红强调色 | 全篇衬线 + 摘要框 + 参考文献格式 |
| `minimal` | 内部草稿、早期版本、纯粹阅读 | 极致留白、无装饰、极简网格 | 轻量无衬线 300字重 |
| `classic` | 长篇散文、年鉴、档案文献 | 暖黄纸色、金色装饰线、古书排版 | 全篇衬线 + 装饰封面 |
| `modern` | 战略文档、内部报告、数据简报 | 干净利落、蓝色强调、清晰层级 | 全篇无衬线 + 蓝色下边栏 |
| `magazine` | 深度特稿、思想领导力、行业分析 | 大标题、编辑感、叙事节奏 | Title: 衬线 / Body: 衬线 |
| `report` | 董事会报告、季报、正式调研 | 严格表格系统、目录、正式品牌栏 | 全篇无衬线 + 深蓝强调 |
| `bento` | 信息图、仪表盘、卡片式概览 | 圆角卡片网格、多色强调、模块化 | 全篇无衬线 + 卡面色条 |
| `letter` | 正式信函、推荐信、客户函件 | 信纸布局、签名区、古典书信排版 | 全篇衬线 + 宽边距 |
| `tech` | 技术文档、架构报告、安全评估 | 暗色主题、青色强调、终端风格 | 无衬线 + 等宽代码字体 |
| `notebook` | 头脑风暴、会议笔记、创意简报 | 横线背景、手帐感、便签贴、清单 | Heading: 衬线斜体 / Body: 无衬线 |

### 自动风格选择逻辑

当用户未指定 `pdfStyle` 时，按以下规则自动匹配：

- **学术/研究类**（含论文、期刊、文献综述）→ `academic`
- **数据密集类**（含指标、KPI、图表、量化分析）→ `data`
- **提案/方案类**（含项目计划、报价、SOW）→ `proposal`
- **技术/工程类**（含架构、代码、系统设计）→ `tech`
- **长篇叙事/特稿类**（含分析文章、深度报道）→ `magazine`
- **正式信函类**（含公函、推荐信、客户函）→ `letter`
- **创意/早期阶段类**（含笔记、头脑风暴、草稿）→ `notebook`
- **信息图/概览类**（含仪表盘、概览、卡片式）→ `bento`
- **极简/内部类**（含草稿、快速笔记、纯文本）→ `minimal`
- **企业正式报告类**（含董事会报告、季度报告）→ `report`
- **古典/存档类**（含年鉴、长篇散文、历史文档）→ `classic`
- **管理层简报类** → `executive`（兜底默认）

## PolarAgent 工作流

1. 判断 PDF 类型与受众，选择模板风格（或用自动匹配）。
2. 如果用户给的是 Markdown 或零散要点，先重写为语义 HTML 结构，不要原样转换。
3. 调用 `create_office_document`：

```json
{
  "format": "pdf",
  "title": "文档标题",
  "markdown": "仅作为内容来源，不直接转 PDF",
  "pdfStyle": "modern",
  "path": "output/report.pdf"
}
```

4. 如果已经生成了完整 HTML，优先传 `html`：

```json
{
  "format": "pdf",
  "title": "文档标题",
  "html": "<!doctype html>...",
  "pdfStyle": "academic",
  "path": "output/paper.pdf"
}
```

5. 如果用户要求把现有 HTML 原样导出 PDF，传 `sourceHtmlPath`：

```json
{
  "format": "pdf",
  "sourceHtmlPath": "output/report.html",
  "path": "output/report.pdf"
}
```

6. 不指定 `pdfStyle` 时系统按内容自动匹配；用户也可显式指定 `pdfStyle: "auto"` 触发自动选择。

## 模板资源

需要从模板开始时，读取并复制 `assets/*.html` 作为种子文件：

### 商务类
- `assets/executive-brief.html`：管理简报 / 决策 memo
- `assets/data-report.html`：数据报告 / KPI 复盘
- `assets/proposal.html`：商业方案 / 项目报价
- `assets/report.html`：企业正式报告 / 董事会报告

### 研究类
- `assets/whitepaper.html`：白皮书 / 长文研究
- `assets/academic.html`：学术论文 / 期刊文章
- `assets/pdf-magazine.html`：杂志特稿 / 深度报道

### 风格类
- `assets/modern.html`：现代商务 / 战略报告
- `assets/classic.html`：古典优雅 / 档案文献
- `assets/minimal.html`：极简纯粹 / 内部草稿
- `assets/bento.html`：卡片信息图 / 概览
- `assets/letter.html`：正式信函 / 公函
- `assets/tech.html`：科技风 / 技术文档
- `assets/notebook.html`：手帐风 / 创意笔记

读取 `references/template-guide.md` 选择模板；读取 `references/layout-patterns.md` 获取页面结构、组件和分页策略。

## 版式要求

- 使用 A4 打印语义：`@page { size: A4; margin: ... }`。
- 表格必须设置 `thead { display: table-header-group; }`。
- 卡片、图表、关键段落使用 `break-inside: avoid`。
- 长表格、附录和引用要能跨页阅读。
- 所有颜色通过 CSS 变量或模板 token 管理。
- 字体优先使用系统字体栈，避免依赖网络字体。
- 图表优先用稳定的 SVG/HTML/CSS；如果使用 canvas，确保导出前已经渲染完成。

## 质量检查

- PDF 是由 HTML 导出的，且产物旁边有 HTML 工作稿。
- 首页标题、日期、作者/组织、文档状态正确。
- 没有文字被裁切、重叠、溢出滚动容器。
- 表格宽度适配页面，长表格表头重复。
- 图片、图标、图表在 PDF 中可见。
- 样式明显属于所选专业模板，而不是默认网页排版。

## 脚本说明

`scripts/render-pdf.mjs` 是独立环境下的备用 HTML-to-PDF 脚本。PolarAgent 应用内优先使用 `create_office_document`，不要把这个脚本作为主路径。
