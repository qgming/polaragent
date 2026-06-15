# Layout Patterns

Reusable PDF page structures inspired by presentation layout discipline, adapted for printable documents.

## Page Patterns

| Pattern | Use for | Notes |
|---|---|---|
| Cover | first impression, title, date, author | Include a concrete subtitle and document status |
| Executive Summary | top findings and decisions | Use 3-5 short insight cards |
| Narrative Section | long-form explanation | Use readable measure, headings, and side notes |
| Metric Spread | KPI summary | Use unit labels, trend indicators, and source notes |
| Evidence Page | chart/table plus interpretation | Put "what it means" close to the data |
| Comparison Matrix | options, vendors, strategies | Keep criteria mutually exclusive |
| Timeline | roadmap, milestones, rollout | Use dates, owners, and dependencies |
| Risk Register | risks, mitigations, status | Use severity labels and clear ownership |
| Proposal Scope | deliverables and exclusions | Separate included, optional, and out of scope |
| Appendix | details, sources, definitions | Reduce visual weight and preserve referenceability |

## HTML Components

### Page Break

```html
<div class="page-break"></div>
```

```css
.page-break { break-before: page; }
```

### Insight Grid

```html
<section class="insight-grid">
  <article class="insight-card">
    <span class="eyebrow">Finding 01</span>
    <h3>Short conclusion</h3>
    <p>One paragraph explaining why it matters.</p>
  </article>
</section>
```

Use three cards for leadership pages, four to six for operational summaries.

### Metric Strip

```html
<section class="metric-strip">
  <article>
    <span class="metric-label">Pipeline</span>
    <strong>$4.8M</strong>
    <span class="metric-note">+18% QoQ</span>
  </article>
</section>
```

Always include a unit and comparison period.

### Figure With Caption

```html
<figure class="figure-block">
  <div class="chart-placeholder">Chart or inline SVG</div>
  <figcaption>Figure 1. Source and interpretation.</figcaption>
</figure>
```

Keep figures on one page with `break-inside: avoid`.

### Long Table

```html
<table class="data-table">
  <thead>
    <tr><th>Metric</th><th>Current</th><th>Target</th><th>Status</th></tr>
  </thead>
  <tbody>
    <tr><td>Activation</td><td>42%</td><td>50%</td><td>Watch</td></tr>
  </tbody>
</table>
```

Use `thead { display: table-header-group; }` so headers repeat across pages.

### Pull Quote

```html
<blockquote class="pull-quote">
  "The decision is less about adding scope and more about protecting adoption."
</blockquote>
```

Use sparingly: one quote per 4-6 pages.

## Print CSS Essentials

```css
@page {
  size: A4;
  margin: 18mm 16mm;
}

@media print {
  body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  a { color: inherit; text-decoration: none; }
  .avoid-break, figure, table, .insight-card { break-inside: avoid; }
  h1, h2, h3 { break-after: avoid; }
  thead { display: table-header-group; }
  tfoot { display: table-footer-group; }
}
```

## Pagination Heuristics

- Keep cover, executive summary, and first evidence page visually distinct.
- Avoid starting a page with an orphaned table continuation unless the table header repeats.
- Move a final one-line paragraph to the previous page by tightening spacing or rewriting.
- Split dense sections into a short interpretation block and a data block.
- Use appendices for raw detail instead of forcing every table into the main narrative.
