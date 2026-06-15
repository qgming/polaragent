---
name: ppt-generator
description: 生成专业 PowerPoint/PPTX 的内置技能。用于商业演示、路演稿、产品发布、数据汇报、项目复盘、培训课件、管理层汇报等 PPT 交付物。必须先设计静态 HTML slide deck，再通过 PolarAgent 的 HTML-to-PPTX 能力导出；禁止 Markdown 直接转 PPT，禁止依赖播放动效、翻页脚本或运行时动画。支持 board、studio、data、pitch 四类核心商务风格，以及 magazine、ink、kraft、porcelain、forest、swiss-blue、lemon-grid、safety-orange 等 Guizang 启发的静态导出风格。
---

# PPT Generator

## 核心原则

PPTX 由静态 HTML 页面导出。每个 slide 必须在 1600x900 视口中独立完整呈现，导出器会逐页截图并打包为 PPTX。

- 不要 Markdown-to-PPT。
- 不要依赖 Motion One、CSS 入场动画、翻页脚本、滚轮导航、WebGL 背景或播放态状态。
- 每页用 `<section class="slide">...</section>`，所有内容在当前 slide 内自洽。
- 使用 `create_office_document` 的 `format: "ppt"`，优先传 `html` 或 `htmlSlides`。
- 生成时保留同名 `.html` 工作稿，方便后续微调和再次导出。

## PolarAgent 工作流

1. 判断演示类型、受众、页数、信息密度和是否需要数据页。
2. 选择模板风格：
   - `board`：管理层汇报、战略简报、董事会材料。
   - `studio`：产品介绍、设计展示、品牌/创意叙事。
   - `data`：运营复盘、指标报告、分析型汇报。
   - `pitch`：融资路演、销售提案、项目方案。
   - `magazine`：杂志感行业观察、人文叙事、趋势分享。
   - `ink`：墨水经典、严肃观点、简洁有力的演讲。
   - `kraft`：手作感、工作坊、复盘、探索性方案。
   - `porcelain`：瓷蓝、稳重科技、研究报告、国际化商业材料。
   - `forest`：森林墨绿、可持续、组织文化、长期主义主题。
   - `swiss-blue`：瑞士网格、工程/设计/数据驱动演示。
   - `lemon-grid`：高能信息图、指标看板、年轻化产品汇报。
   - `safety-orange`：发布会、警示/行动计划、强冲击结论页。
3. 先写 slide 结构，再写 HTML。每页只表达一个清晰意图。
4. 调用 `create_office_document`：

```json
{
  "format": "ppt",
  "title": "演示标题",
  "pptStyle": "board",
  "htmlSlides": "<section class=\"slide\">...</section>",
  "path": "output/deck.pptx"
}
```

5. 如果已经有完整 HTML，传 `html`；如果用户要求从现有 HTML 导出，传 `sourceHtmlPath`。

## 模板资源

- `assets/export-template.html`：静态 HTML-to-PPTX 基础模板，支持多种 `data-ppt-style`，包含核心商务风格和 Guizang 启发风格。
- `references/template-guide.md`：模板选择和内容策略。
- `references/layout-patterns.md`：封面、分节、指标、对比、时间线、结尾等布局模式。

## HTML 要求

- 页面尺寸按 16:9 设计，目标视口 1600x900。
- 所有 slide 必须是 `.slide`，不要发明其他根类。
- 不使用 `data-anim`、`.animate-*`、`setInterval`、自动翻页或播放控制。
- 不要把导航按钮、进度条、演讲者提示放进导出 HTML。
- 图片使用本地相对路径或 data URI；需要保证导出时能从 HTML 所在目录加载。
- 字体使用系统字体栈，避免网络字体导致导出不稳定。
- 文本不要贴边，使用安全边距；按钮、卡片、表格内文字不能溢出。

## 质量检查

- PPTX 是由 HTML 导出的，旁边有同名 HTML 工作稿。
- 每页单独截图时完整、无动画初始态、无透明未显示元素。
- 无导航 UI、进度条、键盘提示或演示运行时残留。
- 表格、图表、图片、图标在导出的 PPTX 中可见。
- 文本不重叠、不裁切，所有页面在 16:9 中构图稳定。
- 风格符合所选模板，而不是默认网页排版。
