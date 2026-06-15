# Layout Patterns

Use these static page structures inside `assets/export-template.html`.

## Cover

```html
<section class="slide cover">
  <div class="chrome"><span>Company</span><span>2026</span></div>
  <div class="hero-copy">
    <p class="kicker">Strategy Brief</p>
    <h1>Presentation Title</h1>
    <p class="lead">One sentence explaining the purpose.</p>
  </div>
</section>
```

## Statement

```html
<section class="slide statement">
  <p class="kicker">Key Message</p>
  <h2>One sharp conclusion the audience should remember.</h2>
</section>
```

## Three Cards

```html
<section class="slide">
  <div class="section-head"><p class="kicker">Framework</p><h2>Three part model</h2></div>
  <div class="grid three">
    <article class="card"><span>01</span><h3>First</h3><p>Explanation.</p></article>
    <article class="card"><span>02</span><h3>Second</h3><p>Explanation.</p></article>
    <article class="card"><span>03</span><h3>Third</h3><p>Explanation.</p></article>
  </div>
</section>
```

## Metric Row

```html
<section class="slide">
  <div class="section-head"><p class="kicker">Performance</p><h2>Quarterly signal</h2></div>
  <div class="metrics">
    <article><span>ARR</span><strong>$12.4M</strong><em>+18%</em></article>
    <article><span>Retention</span><strong>91%</strong><em>-1 pt</em></article>
    <article><span>NPS</span><strong>48</strong><em>+6</em></article>
  </div>
</section>
```

## Comparison

```html
<section class="slide split">
  <article class="panel"><p class="kicker">Before</p><h2>Current state</h2><p>Describe constraint.</p></article>
  <article class="panel accent"><p class="kicker">After</p><h2>Recommended path</h2><p>Describe change.</p></article>
</section>
```

## Timeline

```html
<section class="slide">
  <div class="section-head"><p class="kicker">Roadmap</p><h2>Execution plan</h2></div>
  <div class="timeline">
    <article><time>Q1</time><h3>Discover</h3><p>Baseline and design.</p></article>
    <article><time>Q2</time><h3>Build</h3><p>Ship pilot.</p></article>
    <article><time>Q3</time><h3>Scale</h3><p>Expand rollout.</p></article>
  </div>
</section>
```

## Static Style Pairings

- `magazine`, `ink`, and `forest` pair well with statement, split, and text-led section pages. Use fewer cards and stronger editorial hierarchy.
- `swiss-blue` and `lemon-grid` pair well with metric rows, comparison matrices, architecture diagrams, and dense operating plans.
- `kraft` works best with retrospectives, workshop outputs, sticky-note-like cards, and human-readable process pages.
- `porcelain` suits research, strategy, and technical narratives where calm spacing and refined contrast matter.
- `safety-orange` should be reserved for decisive action pages, launch plans, risk summaries, and executive calls to action.
