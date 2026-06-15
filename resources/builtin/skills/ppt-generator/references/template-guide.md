# Template Guide

Choose a template by presentation job and audience.

| Style | Best for | Visual character |
|---|---|---|
| `board` | leadership updates, strategy reviews, board packs | quiet, premium, decisive |
| `studio` | product stories, design reviews, brand narratives | visual, spacious, editorial |
| `data` | operating reviews, analytics, KPI reports | dense, structured, evidence-led |
| `pitch` | sales decks, investor decks, proposals | persuasive, high contrast, action-oriented |
| `magazine` | industry essays, trend reports, founder narratives | editorial, oversized type, warm paper tone |
| `ink` | opinion talks, policy briefs, rigorous summaries | monochrome, disciplined, literary |
| `kraft` | workshops, retrospectives, exploration decks | tactile, informal, hand-made energy |
| `porcelain` | research reports, international business, technology strategy | refined blue-white, calm, precise |
| `forest` | sustainability, culture, long-term strategy | deep green, grounded, institutional |
| `swiss-blue` | engineering reviews, design systems, data-driven plans | grid-led, modernist, sharp blue accents |
| `lemon-grid` | product updates, dashboards, growth experiments | bright, energetic, modular information design |
| `safety-orange` | launch plans, incident reviews, urgent action decks | assertive, high-signal, command-focused |
| `executive` | enterprise reviews, board presentations, formal strategy | deep navy, structured, authoritative |
| `academic` | thesis defenses, research presentations, conference talks | clean white, crimson accent, serif headings |
| `minimal` | early drafts, internal reviews, pure-content talks | monochrome, light weight, maximum whitespace |
| `modern` | general-purpose, consulting, professional services | neutral grey, clean sans-serif, understated |
| `classic` | keynote speeches, heritage topics, literary talks | warm parchment, gold accent, serif elegance |
| `tech` | developer conferences, architecture reviews, demos | dark indigo, indigo accent, terminal aesthetic |
| `vintage` | storytelling, brand heritage, cultural presentations | warm brown, textured, nostalgic feel |
| `bold` | product launches, creative pitches, brand reveals | deep purple, hot pink accent, high drama |

## Style Families (20 total)

The 20 styles are organized into three families:

- **Core Business (4)** — `board`, `studio`, `data`, `pitch`. Polished and restrained. For professional business presentations.
- **Guizang-Inspired (8)** — `magazine`, `ink`, `kraft`, `porcelain`, `forest`, `swiss-blue`, `lemon-grid`, `safety-orange`. Static visual languages with distinctive textures, patterns, and color systems.
- **Classic Series (8)** — `executive`, `academic`, `minimal`, `modern`, `classic`, `tech`, `vintage`, `bold`. Additional versatile styles covering enterprise, academic, minimalist, and high-impact visual directions.

## Style Rules

- All styles are static visual languages only. Use their palette, typography rhythm, dividers, textures, and composition cues, but do not add playback controls, animated reveal states, or runtime effects.
- Keep one style per deck. If the content needs a dramatic emphasis page, vary layout density and scale inside the same `data-ppt-style` instead of switching styles mid-deck.

## Editing Sequence

1. Decide the page list before writing HTML.
2. Use `assets/export-template.html` as the shell.
3. Replace `<!-- SLIDES_HERE -->` with static `<section class="slide">` pages.
4. Set `<body data-ppt-style="...">`.
5. Export with `create_office_document(format:"ppt")`.

## Do Not Include

- Runtime animation libraries.
- Navigation controls.
- Hidden overview pages.
- CSS animations required for final state.
- WebGL backgrounds that must keep rendering during capture.
