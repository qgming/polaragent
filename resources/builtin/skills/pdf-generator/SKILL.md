---
name: pdf-generator
description: 生成专业 PDF 文档的内置技能。用于报告、方案、白皮书、管理层简报、数据分析报告、商业提案、一页纸材料等 PDF 交付物。必须先设计语义化 HTML，再通过 PolarAgent 的 HTML-to-PDF 能力导出 PDF；禁止把 Markdown、纯文本或默认排版直接转成 PDF。支持 executive、data、proposal、whitepaper 四类专业模板风格。
---

# PDF Generator

## 核心原则

PDF 不是 Markdown 的打印版。先把内容组织成有版式意图的 HTML，再导出 PDF。

- 不要直接 Markdown-to-PDF。
- 不要只把正文塞进默认浏览器页面。
- 先生成完整 HTML：`@page`、打印样式、标题层级、卡片、表格、图表占位、页眉页脚、分页控制。
- 再调用 PolarAgent 的 `create_office_document` 工具生成 PDF。
- 生成 PDF 时同时保留同名 `.html` 工作稿，方便后续改版式。

## PolarAgent 工作流

1. 判断 PDF 类型与受众：管理层、客户、投资人、内部运营、研究读者等。
2. 选择模板风格：
   - `executive`：管理层简报、董事会 memo、战略报告。
   - `data`：KPI 报告、数据分析、运营复盘。
   - `proposal`：商业方案、项目计划、报价、交付范围。
   - `whitepaper`：白皮书、长文研究、政策/行业分析。
3. 如果用户给的是 Markdown 或零散要点，先重写为语义 HTML 结构，不要原样转换。
4. 调用 `create_office_document`：

```json
{
  "format": "pdf",
  "title": "文档标题",
  "markdown": "仅作为内容来源，不直接转 PDF",
  "pdfStyle": "executive",
  "path": "output/report.pdf"
}
```

5. 如果已经生成了完整 HTML，优先传 `html`：

```json
{
  "format": "pdf",
  "title": "文档标题",
  "html": "<!doctype html>...",
  "pdfStyle": "proposal",
  "path": "output/proposal.pdf"
}
```

6. 如果用户要求把现有 HTML 原样导出 PDF，传 `sourceHtmlPath`，让导出器按 HTML 所在目录加载相对图片、字体和样式：

```json
{
  "format": "pdf",
  "sourceHtmlPath": "output/report.html",
  "path": "output/report.pdf"
}
```

## 模板资源

需要从模板开始时，读取并复制 `assets/*.html` 作为种子文件：

- `assets/executive-brief.html`：管理简报 / 决策 memo。
- `assets/data-report.html`：数据报告 / KPI 复盘。
- `assets/proposal.html`：商业方案 / 项目报价。
- `assets/whitepaper.html`：白皮书 / 长文研究。

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
