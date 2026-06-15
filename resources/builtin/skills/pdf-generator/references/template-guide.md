# Template Guide

Choose a template by document job, not by visual taste alone. Each template is a full HTML document with print CSS, design tokens, and reusable components.

## Selection Matrix (14 Templates)

| Template | Best for | Visual character | Avoid when |
|---|---|---|---|
| `assets/executive-brief.html` | leadership reports, strategy memos, business updates | quiet, spacious, premium | the document is mostly raw tables |
| `assets/data-report.html` | KPI reviews, research dashboards, operational reports | dense, structured, analytical | the document has little quantitative content |
| `assets/proposal.html` | scopes, plans, estimates, commercial proposals | polished, persuasive, action-oriented | neutral research is required |
| `assets/whitepaper.html` | long-form analysis, essays, policy notes, thought leadership | editorial, elegant, readable | the reader needs a compact board memo |
| `assets/academic.html` | research papers, theses, journal articles | serious, scholarly, citation-ready | informal or commercial content |
| `assets/minimal.html` | early drafts, internal notes, plain reading | stripped, pure typography, maximum whitespace | the document needs visual hierarchy or branding |
| `assets/classic.html` | long-form essays, archival records, literary analysis | warm paper, gold accents, book-like | modern data-driven reports |
| `assets/modern.html` | strategy docs, internal reports, data briefs | clean sans-serif, blue accent, sharp hierarchy | creative or narrative content |
| `assets/pdf-magazine.html` | feature stories, thought leadership, industry analysis | large headlines, editorial rhythm, narrative flow | dry reference or reference-only material |
| `assets/report.html` | board reports, quarterly reviews, formal investigations | structured tables, TOC, corporate brand bar | creative or informal documents |
| `assets/bento.html` | dashboards, scorecards, information-dense overviews | card-based, modular, multi-color accent | long-form linear reading |
| `assets/letter.html` | formal correspondence, cover letters, board communications | letter layout, signature area, warm paper | multi-page structured reports |
| `assets/tech.html` | technical docs, architecture reviews, security assessments | dark theme, cyan accent, terminal aesthetic | client-facing commercial proposals |
| `assets/notebook.html` | brainstorming, meeting notes, creative briefs | ruled lines, sticky notes, checklists, handcrafted feel | formal deliverables or executive presentations |

## Style Directions

### Executive Brief
Use for decision-makers who need the point quickly. Lead with an executive summary, three to five key findings, risks, and decisions needed. Use restrained contrast, wide margins, and only one accent color.

### Data Report
Use for evidence-heavy documents. Prioritize scanability: metric strips, chart slots, compact tables, source notes, and appendix blocks. Keep every number labeled with unit, period, and denominator.

### Proposal
Use when the document must move a deal or project forward. Include situation, recommended path, work plan, deliverables, investment, assumptions, and next steps. Use tasteful accent panels for value propositions and decision points.

### Whitepaper
Use for narrative credibility. Emphasize typography, section rhythm, pull quotes, references, figures, and a calm reading experience. Avoid slide-like card grids except for short summaries.

### Academic
Use for research-oriented writing. Structure around abstract, introduction, literature review, methodology, findings, discussion, and references. Use citation formatting, serif body text, and restrained red accent. Include an abstract box and numbered sections.

### Minimal
Use when visual distraction must be near zero. No background fills, no rounded corners, no decorative colors. Everything is typography and whitespace. Light font weight (300) and generous margins create a meditative reading experience.

### Classic
Use for material that benefits from a sense of permanence. Warm paper tone (#f5f0e8), serif throughout, subtle gold accent (#8a6e45). The cover centers an ornamental divider. Section headings are heavier serif with no underline.

### Modern
Use for clean, fast comprehension. Sans-serif throughout with a strong blue accent (#2563eb). Section headings carry a blue underline. Content is structured into clear visual zones with consistent spacing.

### Magazine
Use for narrative-driven content. Large serif headlines (36pt), italic dek, pull quotes, byline. The typographic scale and editorial rhythm reward sustained reading. Best for feature articles and thought leadership.

### Report
Use for formal, structured business documents. Includes brand bar, table of contents, metric row, structured tables with dark headers. The design signals rigor and completeness. Best for board-level and executive audiences.

### Bento
Use for information-dense, modular layouts. Card grid with flexible columns (2, 3, 2-1, 1-2). Three accent colors (amber, emerald, indigo) with matching fill variants. Cards have 12px rounded corners and subtle shadow. Best for dashboards and scorecards.

### Letter
Use for formal correspondence. Warm paper, serif body, classic letter layout: letterhead, recipient block, date, salutation, body, closing, signature area. Generous margins (28mm) create a luxurious feel.

### Tech
Use for developer and engineering audiences. Dark background (#0f172a), cyan accent (#06b6d4), monospace for code. Terminal-inspired cover with `>` prompt style. Code blocks with syntax-colored text. Best for technical reports and architecture docs.

### Notebook
Use for informal and creative contexts. Ruled-line background simulates physical notebook paper. Italic headings, dashed borders, sticky-note callouts (yellow/green/blue), sidebar annotations, checkbox lists. Best for notes and working drafts.

## Automatic Style Matching

When `pdfStyle` is not specified or set to `"auto"`, the system matches by content analysis:

- **Academic/research** → `academic`
- **Data-heavy** (metrics, charts, quantitative) → `data`
- **Proposals/scopes** → `proposal`
- **Technical/engineering** → `tech`
- **Long-form narrative** → `magazine`
- **Formal correspondence** → `letter`
- **Creative/early-stage** → `notebook`
- **Dashboard/overview** → `bento`
- **Minimal/internal** → `minimal`
- **Corporate formal** → `report`
- **Classic/archive** → `classic`
- **Default management brief** → `executive`

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
6. Render with `create_office_document` tool or `scripts/render-pdf.mjs` (standalone).
7. Inspect and adjust page breaks in HTML/CSS.
