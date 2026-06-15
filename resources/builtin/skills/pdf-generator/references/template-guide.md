# Template Guide

Choose a template by document job, not by visual taste alone. Each template is a full HTML document with print CSS, design tokens, and reusable components.

## Selection Matrix

| Template | Best for | Visual character | Avoid when |
|---|---|---|---|
| `assets/executive-brief.html` | leadership reports, strategy memos, business updates | quiet, spacious, premium | the document is mostly raw tables |
| `assets/data-report.html` | KPI reviews, research dashboards, operational reports | dense, structured, analytical | the document has little quantitative content |
| `assets/proposal.html` | scopes, plans, estimates, commercial proposals | polished, persuasive, action-oriented | neutral research is required |
| `assets/whitepaper.html` | long-form analysis, essays, policy notes, thought leadership | editorial, elegant, readable | the reader needs a compact board memo |

## Style Directions

### Executive Brief

Use for decision-makers who need the point quickly. Lead with an executive summary, three to five key findings, risks, and decisions needed. Use restrained contrast, wide margins, and only one accent color.

### Data Report

Use for evidence-heavy documents. Prioritize scanability: metric strips, chart slots, compact tables, source notes, and appendix blocks. Keep every number labeled with unit, period, and denominator.

### Proposal

Use when the document must move a deal or project forward. Include situation, recommended path, work plan, deliverables, investment, assumptions, and next steps. Use tasteful accent panels for value propositions and decision points.

### Whitepaper

Use for narrative credibility. Emphasize typography, section rhythm, pull quotes, references, figures, and a calm reading experience. Avoid slide-like card grids except for short summaries.

## Customization Rules

- Replace sample content completely; do not leave generic headings such as "Section Title" or "Lorem ipsum".
- Keep the CSS token block at the top and customize colors through variables first.
- Keep `@media print`, `@page`, `break-inside`, and table header rules intact.
- For brand work, update `--accent`, `--accent-soft`, `--ink`, `--muted`, and `--paper` before changing component CSS.
- If source material is Markdown, transform it into HTML components rather than preserving Markdown's heading/list shape.
- Prefer local image assets or inline SVG for logos and diagrams; remote assets can fail in restricted render environments.

## Template Editing Sequence

1. Copy the selected HTML template beside the user's project output files.
2. Rename the file for the deliverable, such as `q2-board-brief.html`.
3. Update `<title>`, document metadata, cover, footer labels, and page-level notes.
4. Replace content section by section.
5. Add or remove component blocks from `references/layout-patterns.md`.
6. Render with `scripts/render-pdf.mjs`.
7. Inspect and adjust page breaks in HTML/CSS.
