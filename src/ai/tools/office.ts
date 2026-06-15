import { Type, type Static } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";

import {
  htmlToPptx,
  htmlToPdf,
  readFile,
  writeFile,
  writeBase64File,
} from "@/lib/electron/electron-api";
import {
  generateDocxBase64,
  officeExtension,
  projectFromPrompt,
  projectFromSource,
  safeOfficeFileName,
  type OfficeKind,
  type OfficeProject,
} from "@/lib/office";
import { useTaskMonitorStore } from "@/stores/task-monitor-store";
import { useTeamMonitorStore } from "@/stores/team/team-monitor-store";
import { fileName, resolvePath, text, type ToolContext } from "./tool-context";
import pptExportTemplate from "../../../resources/builtin/skills/ppt-generator/assets/export-template.html?raw";

const officeSlideParams = Type.Object({
  title: Type.String({ description: "幻灯片标题" }),
  subtitle: Type.Optional(Type.String({ description: "可选副标题" })),
  bullets: Type.Optional(
    Type.Array(Type.String(), { description: "页面要点，建议 3-6 条" }),
  ),
  notes: Type.Optional(Type.String({ description: "可选备注" })),
});

const createOfficeDocumentParams = Type.Object({
  format: Type.Union(
    [Type.Literal("word"), Type.Literal("ppt"), Type.Literal("pdf")],
    { description: "输出格式：word 生成 .docx，ppt 生成 .pptx，pdf 生成 .pdf" },
  ),
  path: Type.Optional(
    Type.String({
      description:
        "输出文件路径，相对工作目录或绝对路径。可省略，工具会根据标题自动命名。",
    }),
  ),
  title: Type.Optional(Type.String({ description: "文档或演示标题" })),
  subtitle: Type.Optional(Type.String({ description: "可选副标题" })),
  markdown: Type.Optional(
    Type.String({
      description:
        "Word/PDF 正文。PPT 不要只传 markdown；仅在没有 HTML 时作为兜底大纲。",
    }),
  ),
  html: Type.Optional(
    Type.String({
      description:
        "PPT/PDF 首选：完整 HTML。PPT 必须包含多个 <section class=\"slide ...\"> 页面；PDF 必须是带 @page/print CSS 的完整 HTML 文档或语义化正文片段。",
    }),
  ),
  sourceHtmlPath: Type.Optional(
    Type.String({
      description:
        "已有 HTML 文件路径（例如 index.html/report.html）。当用户要求把现有 HTML 原样导出为 PPTX/PDF 时优先传此项，工具会按该 HTML 所在目录加载图片、脚本、字体等资源。",
    }),
  ),
  htmlSlides: Type.Optional(
    Type.String({
      description:
        "PPT 首选：仅 <section class=\"slide ...\"> 静态页面片段。工具会注入内置 ppt-generator 导出模板后执行 HTML→PPTX。",
    }),
  ),
  pptStyle: Type.Optional(
    Type.Union(
      [
        Type.Literal("board"),
        Type.Literal("studio"),
        Type.Literal("data"),
        Type.Literal("pitch"),
        Type.Literal("magazine"),
        Type.Literal("ink"),
        Type.Literal("kraft"),
        Type.Literal("porcelain"),
        Type.Literal("forest"),
        Type.Literal("swiss-blue"),
        Type.Literal("lemon-grid"),
        Type.Literal("safety-orange"),
      ],
      {
        description:
          "PPT HTML 模板风格。board=管理层汇报，studio=产品/设计叙事，data=数据汇报，pitch=路演/提案；magazine/ink/kraft/porcelain/forest/swiss-blue/lemon-grid/safety-orange 为 Guizang 启发的静态导出风格。默认 board。",
      },
    ),
  ),
  pdfStyle: Type.Optional(
    Type.Union(
      [
        Type.Literal("executive"),
        Type.Literal("data"),
        Type.Literal("proposal"),
        Type.Literal("whitepaper"),
      ],
      {
        description:
          "PDF 模板风格。executive=管理简报，data=数据报告，proposal=商业方案，whitepaper=长文白皮书。默认 executive。",
      },
    ),
  ),
  slides: Type.Optional(
    Type.Array(officeSlideParams, {
      description:
        "PPT 兜底：结构化页面列表。仅在无法直接产出 html/htmlSlides 时使用，工具会先转成内置 HTML deck 再生成 PPTX。",
    }),
  ),
  final: Type.Optional(
    Type.Boolean({
      description: "是否作为最终交付文件登记。默认 true。",
    }),
  ),
});

export function createOfficeDocumentTool(
  ctx: ToolContext,
): AgentTool<typeof createOfficeDocumentParams> {
  return {
    name: "create_office_document",
    label: "创建办公文档",
    description:
      "直接创建可交付的 Word(.docx)、PowerPoint(.pptx) 或 PDF(.pdf) 文件并登记为会话产物。" +
      "当用户要求写报告、方案、合同、简历、PPT、演示稿、PDF 材料等办公文件时，优先使用此工具。" +
      "当用户提供已有 HTML 网页 PPT/index.html 并要求导出 PPTX 时，必须传 sourceHtmlPath，避免重新生成导致内容、图片、布局不一致。" +
      "生成 PPT 时不要走 Markdown→PPT；请先生成 ppt-generator 静态 HTML：优先传 html 或 htmlSlides，" +
      "htmlSlides 写多个 <section class=\"slide ...\">，不要包含导航、动效、data-anim、播放脚本或 WebGL 运行时。" +
      "生成 PDF 时也必须先形成专业 HTML：优先传 html 或 sourceHtmlPath；没有 HTML 时工具会按 pdfStyle 生成模板化 HTML 工作稿后再导出 PDF，避免 Markdown 直出。" +
      "无需外部 Office 或 OfficeCLI，生成后用户可在独立预览窗口查看。",
    parameters: createOfficeDocumentParams,
    execute: async (_id, params: Static<typeof createOfficeDocumentParams>) => {
      const kind = params.format as OfficeKind;
      const source = buildOfficeSource(params);
      const requestedTitle = resolveTitle(params);
      const project = source.trim()
        ? projectFromSource(kind, source)
        : projectFromPrompt(kind, requestedTitle || "办公文档");
      const titledProject = {
        ...project,
        title: requestedTitle || project.title,
        subtitle: params.subtitle?.trim() || project.subtitle,
      };
      const extension = officeExtension(kind);
      const target = resolvePath(
        ctx,
        ensureOfficeExtension(
          params.path?.trim() || safeOfficeFileName(titledProject),
          extension,
        ),
      );

      if (kind === "word") {
        await writeBase64File(target, await generateDocxBase64(titledProject));
      } else if (kind === "ppt") {
        const sourceHtmlPath = params.sourceHtmlPath?.trim()
          ? resolvePath(ctx, params.sourceHtmlPath.trim())
          : "";
        const html = sourceHtmlPath
          ? await buildPptHtmlFromSourceFile(
              sourceHtmlPath,
              params.title?.trim() || "",
            )
          : buildPptHtml(params, titledProject.title, titledProject.subtitle);
        const htmlPath = replaceExtension(target, "html");
        await writeFile(htmlPath, html);
        addArtifact(ctx, {
          path: htmlPath,
          name: fileName(htmlPath),
          kind: "working",
        });
        await htmlToPptx({
          html,
          sourcePath: htmlPath,
          targetPath: target,
          baseDir: sourceHtmlPath ? dirName(sourceHtmlPath) : dirName(htmlPath),
        });
      } else {
        const sourceHtmlPath = params.sourceHtmlPath?.trim()
          ? resolvePath(ctx, params.sourceHtmlPath.trim())
          : "";
        const htmlPath = sourceHtmlPath || replaceExtension(target, "html");
        const html = sourceHtmlPath
          ? await buildPdfHtmlFromSourceFile(
              sourceHtmlPath,
              params.title?.trim() || titledProject.title,
            )
          : buildPdfHtml(params, titledProject);
        if (!sourceHtmlPath) {
          await writeFile(htmlPath, html);
          addArtifact(ctx, {
            path: htmlPath,
            name: fileName(htmlPath),
            kind: "working",
          });
        }
        await htmlToPdf({
          html,
          sourcePath: htmlPath,
          targetPath: target,
          baseDir: dirName(htmlPath),
          pageSize: "A4",
        });
      }

      const artifact = {
        path: target,
        name: fileName(target),
        kind: params.final === false ? "working" : "final",
      } as const;

      addArtifact(ctx, artifact);

      return {
        content: text(
          `已创建 ${artifact.name}，文件已加入会话产物，可在独立预览窗口打开。`,
        ),
        details: {
          path: target,
          format: kind,
          title: titledProject.title,
          markdown: titledProject.source,
          htmlPath:
            kind === "ppt"
              ? replaceExtension(target, "html")
              : kind === "pdf"
                ? params.sourceHtmlPath?.trim() || replaceExtension(target, "html")
                : undefined,
          sourceHtmlPath:
            kind === "ppt" || kind === "pdf"
              ? params.sourceHtmlPath?.trim() || undefined
              : undefined,
        },
      };
    },
  };
}

function addArtifact(
  ctx: ToolContext,
  artifact: { path: string; name: string; kind: "final" | "working" },
) {
  if (ctx.isTeam) {
    useTeamMonitorStore.getState().addArtifact(ctx.threadId, artifact);
  } else {
    useTaskMonitorStore.getState().addArtifact(ctx.threadId, artifact);
  }
}

function buildOfficeSource(
  params: Static<typeof createOfficeDocumentParams>,
): string {
  if (params.format === "ppt" && params.slides?.length) {
    return slidesToMarkdown(
      params.title || "办公演示",
      params.subtitle,
      params.slides,
    );
  }

  const markdown = params.markdown?.trim() || "";
  if (!markdown) return "";
  if (/^#\s+/m.test(markdown)) return markdown;

  const heading = [`# ${params.title || "办公文档"}`];
  if (params.subtitle?.trim()) heading.push(params.subtitle.trim());
  return `${heading.join("\n\n")}\n\n${markdown}`;
}

function buildPptHtml(
  params: Static<typeof createOfficeDocumentParams>,
  title: string,
  subtitle?: string,
): string {
  const explicitHtml = params.html?.trim();
  if (explicitHtml) {
    return preparePptExportHtml(hasHtmlDocument(explicitHtml)
      ? ensureHtmlTitle(explicitHtml, title)
      : deckFromSlideSections(explicitHtml, title, params.pptStyle));
  }

  const htmlSlides = params.htmlSlides?.trim();
  if (htmlSlides) {
    return preparePptExportHtml(deckFromSlideSections(htmlSlides, title, params.pptStyle));
  }

  const slides =
    params.slides && params.slides.length > 0
      ? params.slides
      : outlineToFallbackSlides(params.markdown || "", title);
  return preparePptExportHtml(
    deckFromSlideSections(
      fallbackPptSections(title, subtitle, slides, params.pptStyle || "board"),
      title,
      params.pptStyle || "board",
    ),
  );
}

async function buildPdfHtmlFromSourceFile(
  sourceHtmlPath: string,
  titleOverride: string,
): Promise<string> {
  const sourceHtml = await readFile(sourceHtmlPath);
  return titleOverride ? ensureHtmlTitle(sourceHtml, titleOverride) : sourceHtml;
}

function buildPdfHtml(
  params: Static<typeof createOfficeDocumentParams>,
  project: OfficeProject,
): string {
  const explicitHtml = params.html?.trim();
  const style = params.pdfStyle || "executive";
  if (explicitHtml) {
    return hasHtmlDocument(explicitHtml)
      ? ensureHtmlTitle(explicitHtml, project.title)
      : pdfDocumentFromBody(project.title, explicitHtml, style);
  }

  return pdfDocumentFromBody(
    project.title,
    renderPdfBlocks(project, style),
    style,
  );
}

function renderPdfBlocks(
  project: OfficeProject,
  style: NonNullable<Static<typeof createOfficeDocumentParams>["pdfStyle"]>,
): string {
  const blocks = project.blocks.filter(
    (block) => !(block.type === "heading" && block.level === 1),
  );
  const lead = project.subtitle
    ? `<p class="lead">${escapeHtml(project.subtitle)}</p>`
    : "";
  const headings = blocks.filter((block) => block.type === "heading").length || 1;
  const bulletCount = blocks.filter((block) => block.type === "bullet").length || 3;
  const metrics =
    style === "data"
      ? `<section class="metric-strip">
  <article><span>Sections</span><strong>${headings}</strong><em>content groups</em></article>
  <article><span>Signals</span><strong>${bulletCount}</strong><em>key points</em></article>
  <article><span>Status</span><strong>Draft</strong><em>ready to refine</em></article>
</section>`
      : "";
  const sections: string[] = [];
  let current = "";

  for (const block of blocks) {
    if (block.type === "heading") {
      if (current.trim()) sections.push(`<section class="doc-section">${current}</section>`);
      current = `<span class="eyebrow">Section</span><h2>${escapeHtml(block.text)}</h2>`;
      continue;
    }
    if (block.type === "bullet") {
      current += `<div class="point"><span></span><p>${escapeHtml(block.text)}</p></div>`;
      continue;
    }
    current += `<p>${escapeHtml(block.text)}</p>`;
  }

  if (current.trim()) sections.push(`<section class="doc-section">${current}</section>`);
  if (sections.length === 0) {
    sections.push(`<section class="doc-section"><h2>正文</h2><p>${escapeHtml(project.source)}</p></section>`);
  }

  const summaryCards = blocks
    .filter((block) => block.type === "bullet")
    .slice(0, 3)
    .map(
      (block, index) => `<article class="summary-card">
  <span class="eyebrow">Point ${String(index + 1).padStart(2, "0")}</span>
  <p>${escapeHtml(block.text)}</p>
</article>`,
    )
    .join("");

  return `<section class="cover">
  <div>
    <span class="kicker">${pdfStyleLabel(style)}</span>
    <h1>${escapeHtml(project.title)}</h1>
    ${lead}
  </div>
  <div class="cover-meta">
    <span>PolarAgent Office</span>
    <span>${new Date().toISOString().slice(0, 10)}</span>
  </div>
</section>
${metrics}
${summaryCards ? `<section class="summary-grid">${summaryCards}</section>` : ""}
${sections.join("\n")}`;
}

function pdfDocumentFromBody(
  title: string,
  body: string,
  style: NonNullable<Static<typeof createOfficeDocumentParams>["pdfStyle"]>,
): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>${pdfTemplateCss(style)}</style>
</head>
<body data-pdf-style="${style}">
  <main>${body}</main>
</body>
</html>`;
}

function pdfStyleLabel(
  style: NonNullable<Static<typeof createOfficeDocumentParams>["pdfStyle"]>,
): string {
  if (style === "data") return "Data Report";
  if (style === "proposal") return "Proposal";
  if (style === "whitepaper") return "Whitepaper";
  return "Executive Brief";
}

function pdfTemplateCss(
  style: NonNullable<Static<typeof createOfficeDocumentParams>["pdfStyle"]>,
): string {
  const palette = {
    executive: {
      paper: "#f8f7f3",
      surface: "#ffffff",
      ink: "#20242c",
      muted: "#667085",
      line: "#d7d9dd",
      accent: "#0f766e",
      heading: '"Georgia", "Times New Roman", "Microsoft YaHei", serif',
    },
    data: {
      paper: "#fbfcfd",
      surface: "#ffffff",
      ink: "#1f2937",
      muted: "#667085",
      line: "#d8dee8",
      accent: "#256d85",
      heading: '"Aptos Display", "Segoe UI", "Microsoft YaHei UI", sans-serif',
    },
    proposal: {
      paper: "#f7f8fa",
      surface: "#ffffff",
      ink: "#22252b",
      muted: "#697386",
      line: "#d9dde5",
      accent: "#8a1538",
      heading: '"Aptos Display", "Segoe UI", "Microsoft YaHei UI", sans-serif',
    },
    whitepaper: {
      paper: "#fcfcfb",
      surface: "#ffffff",
      ink: "#1f2328",
      muted: "#687076",
      line: "#dadde1",
      accent: "#315c48",
      heading: '"Georgia", "Times New Roman", "Microsoft YaHei", serif',
    },
  }[style];

  return `
@page { size: A4; margin: 18mm 16mm 20mm; }
* { box-sizing: border-box; }
body {
  margin: 0;
  color: ${palette.ink};
  background: ${palette.paper};
  font: 10.5pt/1.62 "Aptos", "Segoe UI", "Microsoft YaHei UI", Arial, sans-serif;
  letter-spacing: 0;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
main { max-width: 184mm; margin: 0 auto; }
h1, h2, h3, p { margin: 0; }
h1, h2 { font-family: ${palette.heading}; line-height: 1.12; }
h1 { font-size: 32pt; max-width: 150mm; }
h2 { font-size: 17pt; margin-bottom: 5mm; padding-bottom: 3mm; border-bottom: 1px solid ${palette.line}; }
p { margin-bottom: 3.8mm; color: #344054; }
.cover {
  min-height: 232mm;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  padding-top: 8mm;
  break-after: page;
}
.lead { margin-top: 7mm; max-width: 132mm; font-size: 13pt; line-height: 1.5; color: #475467; }
.kicker, .eyebrow {
  display: block;
  color: ${palette.accent};
  font-size: 8pt;
  font-weight: 800;
  text-transform: uppercase;
  letter-spacing: 0;
  margin-bottom: 2mm;
}
.cover-meta {
  display: flex;
  justify-content: space-between;
  border-top: 1px solid ${palette.line};
  padding-top: 4mm;
  color: ${palette.muted};
  font-size: 8.5pt;
  text-transform: uppercase;
}
.summary-grid, .metric-strip {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 5mm;
  margin: 0 0 12mm;
}
.summary-card, .metric-strip article, .doc-section {
  background: ${palette.surface};
  border: 1px solid ${palette.line};
  border-radius: 8px;
  padding: 6mm;
  break-inside: avoid;
}
.metric-strip article strong {
  display: block;
  font-size: 21pt;
  line-height: 1.1;
  margin: 1mm 0;
  color: ${palette.ink};
}
.metric-strip article span, .metric-strip article em {
  display: block;
  color: ${palette.muted};
  font-size: 8pt;
  font-style: normal;
  text-transform: uppercase;
}
.doc-section { margin-bottom: 9mm; }
.point {
  display: grid;
  grid-template-columns: 4mm 1fr;
  gap: 3mm;
  padding: 2.5mm 0;
  border-bottom: 1px solid ${palette.line};
  break-inside: avoid;
}
.point:last-child { border-bottom: 0; }
.point span {
  width: 3mm;
  height: 3mm;
  border-radius: 999px;
  background: ${palette.accent};
  margin-top: 2mm;
}
.point p { margin: 0; }
body[data-pdf-style="whitepaper"] .doc-section {
  border: 0;
  border-top: 2px solid ${palette.ink};
  border-radius: 0;
  background: transparent;
  padding: 6mm 0 0;
}
body[data-pdf-style="proposal"] .summary-card { border-top: 4px solid ${palette.accent}; }
body[data-pdf-style="data"] .doc-section { border-left: 5px solid ${palette.accent}; }
@media print {
  a { color: inherit; text-decoration: none; }
  h1, h2, h3 { break-after: avoid; }
  .summary-card, .doc-section, .point { break-inside: avoid; }
}`;
}

async function buildPptHtmlFromSourceFile(
  sourceHtmlPath: string,
  titleOverride: string,
): Promise<string> {
  const sourceHtml = await readFile(sourceHtmlPath);
  const titledHtml = titleOverride
    ? ensureHtmlTitle(sourceHtml, titleOverride)
    : sourceHtml;
  return preparePptExportHtml(ensureBaseHref(titledHtml, dirName(sourceHtmlPath)));
}

function deckFromSlideSections(
  sections: string,
  title: string,
  style: Static<typeof createOfficeDocumentParams>["pptStyle"],
): string {
  const selectedStyle = style || "board";
  return injectSlidesIntoTemplate(
    ensureHtmlTitle(
      pptExportTemplate.replace(
        /<body\b([^>]*)data-ppt-style=["'][^"']+["']([^>]*)>/i,
        `<body$1data-ppt-style="${selectedStyle}"$2>`,
      ),
      title,
    ),
    sections,
  );
}

function preparePptExportHtml(html: string): string {
  const exportCss = `<style id="polaragent-ppt-export-static">
*,*::before,*::after{animation:none!important;transition:none!important}
[data-anim],.animate-fade-up,.animate-scale,.animate-stagger>*{opacity:1!important;transform:none!important}
#nav,#hint,#overview,.nav,.controls,.progress{display:none!important}
</style>`;
  const withoutDataAnim = html.replace(/\sdata-anim=(["']).*?\1/g, "");
  if (/<\/head>/i.test(withoutDataAnim)) {
    return withoutDataAnim.replace(/<\/head>/i, `${exportCss}\n</head>`);
  }
  return `${exportCss}\n${withoutDataAnim}`;
}

function hasHtmlDocument(value: string): boolean {
  return /<!doctype\s+html|<html[\s>]/i.test(value);
}

function ensureHtmlTitle(html: string, title: string): string {
  if (/<title[\s>]/i.test(html)) {
    return html.replace(/<title[^>]*>[\s\S]*?<\/title>/i, `<title>${escapeHtml(title)}</title>`);
  }
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, (match) => `${match}\n<title>${escapeHtml(title)}</title>`);
  }
  return html;
}

function injectSlidesIntoTemplate(template: string, sections: string): string {
  const slides = `${sections.trim()}\n`;
  if (/<!--\s*SLIDES_HERE[\s\S]*?-->/i.test(template)) {
    return template.replace(/<!--\s*SLIDES_HERE[\s\S]*?-->/i, slides);
  }
  if (/<main\b[^>]*id=["']deck["'][^>]*>/i.test(template)) {
    return template.replace(/(<main\b[^>]*id=["']deck["'][^>]*>)/i, `$1\n${slides}`);
  }
  return template.replace(/<body([^>]*)>/i, `<body$1>\n<main id="deck">\n${slides}</main>`);
}

function ensureBaseHref(html: string, baseDir: string): string {
  if (!baseDir || /<base\s/i.test(html)) return html;
  const normalized = baseDir.replace(/\\/g, "/").replace(/\/?$/, "/");
  const href = /^file:\/\//i.test(normalized)
    ? normalized
    : `file:///${encodeFileUrlPath(normalized).replace(/^\/+/, "")}`;
  const base = `<base href="${escapeHtml(href)}">`;
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, (match) => `${match}\n${base}`);
  }
  return `${base}\n${html}`;
}

function encodeFileUrlPath(value: string): string {
  return value
    .split("/")
    .map((part, index) =>
      index === 0 && /^[a-zA-Z]:$/.test(part) ? part : encodeURIComponent(part),
    )
    .join("/");
}

function resolveTitle(params: Static<typeof createOfficeDocumentParams>): string {
  const explicit = params.title?.trim();
  if (explicit) return explicit;
  if (params.format === "ppt") {
    return (
      extractHtmlTitle(params.html) ||
      extractHtmlTitle(params.htmlSlides) ||
      params.slides?.[0]?.title?.trim() ||
      ""
    );
  }
  return "";
}

function extractHtmlTitle(value?: string): string {
  const html = value?.trim();
  if (!html) return "";
  const title =
    /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ||
    /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1] ||
    /<h2[^>]*>([\s\S]*?)<\/h2>/i.exec(html)?.[1] ||
    "";
  return decodeHtml(stripTags(title)).replace(/\s+/g, " ").trim().slice(0, 80);
}

function outlineToFallbackSlides(outline: string, fallbackTitle: string) {
  const lines = outline.split(/\r?\n/);
  const slides: Array<{ title: string; subtitle?: string; bullets?: string[]; notes?: string }> = [];
  let current: { title: string; subtitle?: string; bullets: string[]; notes?: string } | null = null;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || /^#\s+/.test(line)) continue;
    const heading = /^##\s+(.+)$/.exec(line);
    if (heading) {
      if (current) slides.push(current);
      current = { title: heading[1].trim(), bullets: [] };
      continue;
    }
    if (!current) current = { title: fallbackTitle, bullets: [] };
    const bullet = /^[-*+]\s+(.+)$/.exec(line) || /^\d+[.)]\s+(.+)$/.exec(line);
    if (bullet) current.bullets.push(bullet[1].trim());
    else if (!current.subtitle) current.subtitle = line;
    else current.notes = [current.notes, line].filter(Boolean).join("\n");
  }
  if (current) slides.push(current);
  return slides.length > 0 ? slides : [{ title: fallbackTitle, bullets: ["梳理主题", "明确结构", "形成交付"] }];
}

function fallbackPptSections(
  title: string,
  subtitle: string | undefined,
  slides: Array<{ title: string; subtitle?: string; bullets?: string[]; notes?: string }>,
  style: NonNullable<Static<typeof createOfficeDocumentParams>["pptStyle"]>,
): string {
  const contentSlides = slides.slice(0, 12);
  const styleLabel = pptStyleLabel(style);
  const cover = `<section class="slide cover">
  <div class="chrome"><span>PolarAgent Office</span><span>${escapeHtml(styleLabel)}</span></div>
  <div class="hero-copy">
    <p class="kicker">HTML to PPTX</p>
    <h1>${escapeHtml(title)}</h1>
    ${subtitle ? `<p class="lead">${escapeHtml(subtitle)}</p>` : ""}
  </div>
  <div class="chrome"><span>Static export deck</span><span>${new Date().toISOString().slice(0, 10)}</span></div>
</section>`;

  const body = contentSlides
    .map((slide, index) => {
      const bullets = (slide.bullets && slide.bullets.length > 0 ? slide.bullets : ["补充要点"])
        .slice(0, 3)
        .map(
          (bullet, bulletIndex) => `<article class="card">
  <span>${String(bulletIndex + 1).padStart(2, "0")}</span>
  <h3>${escapeHtml(shortenText(bullet, 24))}</h3>
  <p>${escapeHtml(bullet)}</p>
</article>`,
        )
        .join("");
      return `<section class="slide">
  <div class="section-head">
    <div>
      <p class="kicker">Section ${String(index + 1).padStart(2, "0")}</p>
      <h2>${escapeHtml(slide.title)}</h2>
    </div>
    ${slide.subtitle ? `<p>${escapeHtml(slide.subtitle)}</p>` : `<p>${escapeHtml(title)}</p>`}
  </div>
  <div class="grid three">${bullets}</div>
</section>`;
    })
    .join("\n\n");

  const closing = `<section class="slide split">
  <article class="panel accent">
    <p class="kicker">Takeaway</p>
    <h2>谢谢</h2>
    <p>静态 HTML 已导出为可预览、可交付的 PPTX。</p>
  </article>
  <article class="panel">
    <p class="kicker">Next</p>
    <h2>后续动作</h2>
    <p>确认内容口径，补齐数据与素材，继续迭代 HTML 工作稿。</p>
  </article>
</section>`;

  return [cover, body, closing].filter(Boolean).join("\n\n");
}

function pptStyleLabel(
  style: NonNullable<Static<typeof createOfficeDocumentParams>["pptStyle"]>,
): string {
  if (style === "studio") return "Studio";
  if (style === "data") return "Data Report";
  if (style === "pitch") return "Pitch";
  return "Board Brief";
}

function shortenText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}

function slidesToMarkdown(
  title: string,
  subtitle: string | undefined,
  slides: NonNullable<Static<typeof createOfficeDocumentParams>["slides"]>,
): string {
  const head = [`# ${title}`, subtitle || ""].filter(Boolean).join("\n\n");
  const body = slides
    .map((slide) => {
      const lines = [`## ${slide.title}`];
      if (slide.subtitle) lines.push(slide.subtitle);
      lines.push(...(slide.bullets ?? []).map((bullet) => `- ${bullet}`));
      if (slide.notes) lines.push(slide.notes);
      return lines.join("\n");
    })
    .join("\n\n");
  return `${head}\n\n${body}`;
}

function ensureOfficeExtension(path: string, extension: string): string {
  const normalizedExtension = extension.toLowerCase();
  if (path.toLowerCase().endsWith(`.${normalizedExtension}`)) return path;
  const separatorIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const dotIndex = path.lastIndexOf(".");
  if (dotIndex > separatorIndex) {
    return `${path.slice(0, dotIndex)}.${normalizedExtension}`;
  }
  return `${path}.${normalizedExtension}`;
}

function replaceExtension(path: string, extension: string): string {
  const separatorIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const dotIndex = path.lastIndexOf(".");
  const normalizedExtension = extension.replace(/^\./, "");
  if (dotIndex > separatorIndex) {
    return `${path.slice(0, dotIndex)}.${normalizedExtension}`;
  }
  return `${path}.${normalizedExtension}`;
}

function dirName(path: string): string {
  const separatorIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (separatorIndex <= 0) return ".";
  return path.slice(0, separatorIndex);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function stripTags(value: string): string {
  return value.replace(/<[^>]*>/g, " ");
}

function decodeHtml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&");
}
