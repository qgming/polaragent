export type OfficeKind = "word" | "ppt" | "pdf";

export interface OfficeChatMessage {
  id: string;
  role: "assistant" | "user";
  content: string;
}

export interface OfficeBlock {
  type: "heading" | "paragraph" | "bullet";
  level?: number;
  text: string;
}

export interface OfficeSlide {
  title: string;
  subtitle?: string;
  bullets: string[];
  notes?: string;
}

export interface OfficeProject {
  kind: OfficeKind;
  title: string;
  subtitle?: string;
  source: string;
  blocks: OfficeBlock[];
  slides: OfficeSlide[];
  updatedAt: number;
}

const DEFAULT_WORD_SOURCE = `# 季度工作报告

## 核心结论
本季度围绕增长、效率和协作推进，整体节奏稳定，关键项目进入可交付阶段。

## 进展
- 完成重点需求梳理与排期
- 建立跨团队同步机制
- 输出阶段性数据复盘

## 下一步
- 收敛优先级
- 推进上线验收
- 补齐风险预案`;

const DEFAULT_PPT_SOURCE = `# 项目复盘

## 目标与背景
- 明确项目目标
- 对齐业务约束
- 确认交付范围

## 关键进展
- 完成核心功能
- 验证主要链路
- 收集首轮反馈

## 下一步计划
- 优化体验细节
- 补齐数据指标
- 准备发布材料`;

export function createOfficeProject(kind: OfficeKind, source?: string): OfficeProject {
  const nextSource = source || (kind === "ppt" ? DEFAULT_PPT_SOURCE : DEFAULT_WORD_SOURCE);
  return projectFromSource(kind, nextSource);
}

export function projectFromPrompt(kind: OfficeKind, prompt: string): OfficeProject {
  const title = extractTitle(prompt) || (kind === "ppt" ? "办公演示" : "办公文档");
  if (kind === "ppt") {
    return projectFromSource(
      "ppt",
      `# ${title}

## 背景
- ${prompt || "梳理主题背景"}
- 明确目标读者
- 对齐输出口径

## 方案
- 拆解核心问题
- 给出可执行路径
- 标注资源和风险

## 交付
- 总结关键结论
- 明确下一步行动
- 形成可复用材料`,
    );
  }

  return projectFromSource(
    kind,
    `# ${title}

## 背景
${prompt || "围绕当前办公主题整理背景、目标与约束。"}

## 正文
- 核心信息一
- 核心信息二
- 核心信息三

## 结论
建议先确认范围，再推进内容完善与格式导出。`,
  );
}

export function projectFromAi(kind: OfficeKind, prompt: string, content: string): OfficeProject {
  const parsed = parseJsonObject(content);
  if (parsed) {
    const title = pickString(parsed, ["title", "name"]) || extractTitle(prompt);
    const subtitle = pickString(parsed, ["subtitle", "description"]);
    const markdown = pickString(parsed, ["markdown", "content", "source"]);
    if (kind === "ppt") {
      const slides = Array.isArray(parsed.slides)
        ? parsed.slides
            .map((slide): OfficeSlide | null => {
              if (!slide || typeof slide !== "object") return null;
              const raw = slide as Record<string, unknown>;
              const bullets = Array.isArray(raw.bullets)
                ? raw.bullets.map(String).filter(Boolean)
                : [];
              return {
                title: String(raw.title || "未命名页面"),
                subtitle: typeof raw.subtitle === "string" ? raw.subtitle : undefined,
                bullets,
                notes: typeof raw.notes === "string" ? raw.notes : undefined,
              };
            })
            .filter((slide): slide is OfficeSlide => slide !== null)
        : [];
      if (slides.length > 0) {
        const source = slidesToMarkdown(title || "办公演示", subtitle, slides);
        return {
          kind,
          title: title || "办公演示",
          subtitle,
          source,
          blocks: parseMarkdownBlocks(source),
          slides,
          updatedAt: Date.now(),
        };
      }
    }
    if (markdown) {
      const project = projectFromSource(kind, markdown);
      return {
        ...project,
        title: title || project.title,
        subtitle: subtitle || project.subtitle,
      };
    }
  }

  return projectFromSource(kind, content.trim() || projectFromPrompt(kind, prompt).source);
}

export function projectFromSource(kind: OfficeKind, source: string): OfficeProject {
  const blocks = parseMarkdownBlocks(source);
  const title =
    blocks.find((block) => block.type === "heading" && block.level === 1)?.text ||
    (kind === "ppt" ? "办公演示" : "办公文档");
  const subtitle =
    blocks.find((block) => block.type === "paragraph" && block.text.trim())?.text;
  const slides = kind === "ppt" ? parseSlides(source, title) : [];
  return {
    kind,
    title,
    subtitle,
    source,
    blocks,
    slides,
    updatedAt: Date.now(),
  };
}

export function officeExtension(kind: OfficeKind): "docx" | "pptx" | "pdf" {
  if (kind === "ppt") return "pptx";
  if (kind === "pdf") return "pdf";
  return "docx";
}

export function safeOfficeFileName(project: OfficeProject): string {
  const suffix = new Date(project.updatedAt)
    .toISOString()
    .slice(0, 16)
    .replace(/[-:T]/g, "");
  const base = project.title
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `${base || "office"}-${suffix}.${officeExtension(project.kind)}`;
}

export async function generateDocxBase64(project: OfficeProject): Promise<string> {
  const zip = await createZip();
  zip.file("[Content_Types].xml", docxContentTypes());
  zip.folder("_rels")?.file(".rels", packageRels("word/document.xml"));
  zip.folder("docProps")?.file("core.xml", coreProps(project.title));
  zip.folder("docProps")?.file("app.xml", appProps("PolarAgent Office"));
  const word = zip.folder("word");
  word?.file("document.xml", docxDocument(project));
  word?.file("styles.xml", docxStyles());
  word?.file("settings.xml", docxSettings());
  word?.folder("_rels")?.file("document.xml.rels", emptyRelationships());
  return zip.generateAsync({ type: "base64", compression: "DEFLATE" });
}

export function renderOfficeHtml(project: OfficeProject): string {
  const body =
    project.kind === "ppt"
      ? project.slides.map(renderSlideHtml).join("")
      : renderBlocksHtml(project.blocks);

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(project.title)}</title>
  <style>
    @page { size: A4; margin: 18mm; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: #f5f5f2;
      color: #202421;
      font-family: "Segoe UI", "Microsoft YaHei UI", sans-serif;
      line-height: 1.65;
    }
    .page {
      width: 210mm;
      min-height: 297mm;
      margin: 0 auto 18px;
      background: #fff;
      padding: 22mm 20mm;
      box-shadow: 0 12px 36px rgba(30, 32, 30, 0.12);
    }
    h1 { margin: 0 0 18px; font-size: 30px; line-height: 1.25; }
    h2 { margin: 28px 0 10px; font-size: 20px; }
    h3 { margin: 20px 0 8px; font-size: 16px; }
    p { margin: 8px 0; }
    ul { margin: 8px 0 8px 20px; padding: 0; }
    .slide {
      aspect-ratio: 16 / 9;
      width: 100%;
      margin: 0 auto 18px;
      padding: 42px 52px;
      border: 1px solid #e5e7e3;
      background: linear-gradient(135deg, #ffffff 0%, #f4f7f6 58%, #edf5f1 100%);
      page-break-inside: avoid;
    }
    .slide h2 { margin: 0 0 18px; font-size: 30px; }
    .slide p { color: #5f6861; }
    .slide li { margin: 9px 0; font-size: 18px; }
    @media print {
      body { background: white; }
      .page { box-shadow: none; margin: 0; }
    }
  </style>
</head>
<body>
  <main class="page">${body}</main>
</body>
</html>`;
}

function renderBlocksHtml(blocks: OfficeBlock[]) {
  return blocks
    .map((block) => {
      const text = escapeHtml(block.text);
      if (block.type === "heading") {
        const level = Math.min(Math.max(block.level || 2, 1), 3);
        return `<h${level}>${text}</h${level}>`;
      }
      if (block.type === "bullet") {
        return `<ul><li>${text}</li></ul>`;
      }
      return `<p>${text}</p>`;
    })
    .join("\n");
}

function renderSlideHtml(slide: OfficeSlide) {
  const bullets = slide.bullets.map((bullet) => `<li>${escapeHtml(bullet)}</li>`).join("");
  return `<section class="slide">
  <h2>${escapeHtml(slide.title)}</h2>
  ${slide.subtitle ? `<p>${escapeHtml(slide.subtitle)}</p>` : ""}
  <ul>${bullets}</ul>
</section>`;
}

function parseMarkdownBlocks(source: string): OfficeBlock[] {
  const blocks: OfficeBlock[] = [];
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1].length, text: heading[2].trim() });
      continue;
    }
    const bullet = /^[-*+]\s+(.+)$/.exec(line) || /^\d+[.)]\s+(.+)$/.exec(line);
    if (bullet) {
      blocks.push({ type: "bullet", text: bullet[1].trim() });
      continue;
    }
    blocks.push({ type: "paragraph", text: line });
  }
  return blocks.length > 0 ? blocks : [{ type: "paragraph", text: source.trim() || "空白文档" }];
}

function parseSlides(source: string, fallbackTitle: string): OfficeSlide[] {
  const lines = source.split(/\r?\n/);
  const slides: OfficeSlide[] = [];
  let current: OfficeSlide | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("# ")) continue;

    const slideHeading = /^##\s+(.+)$/.exec(line);
    if (slideHeading) {
      if (current) slides.push(current);
      current = { title: slideHeading[1].trim(), bullets: [] };
      continue;
    }

    if (!current) {
      current = { title: fallbackTitle || "页面", bullets: [] };
    }

    const bullet = /^[-*+]\s+(.+)$/.exec(line) || /^\d+[.)]\s+(.+)$/.exec(line);
    if (bullet) {
      current.bullets.push(bullet[1].trim());
    } else if (!current.subtitle) {
      current.subtitle = line;
    } else {
      current.notes = [current.notes, line].filter(Boolean).join("\n");
    }
  }

  if (current) slides.push(current);
  return slides.length > 0
    ? slides
    : [{ title: fallbackTitle || "办公演示", bullets: ["梳理主题", "补齐要点", "形成交付"] }];
}

function slidesToMarkdown(title: string, subtitle: string | undefined, slides: OfficeSlide[]) {
  const head = [`# ${title}`, subtitle || ""].filter(Boolean).join("\n\n");
  return `${head}\n\n${slides
    .map((slide) => {
      const lines = [`## ${slide.title}`];
      if (slide.subtitle) lines.push(slide.subtitle);
      lines.push(...slide.bullets.map((bullet) => `- ${bullet}`));
      if (slide.notes) lines.push(slide.notes);
      return lines.join("\n");
    })
    .join("\n\n")}`;
}

function parseJsonObject(content: string): Record<string, unknown> | null {
  const trimmed = content.trim();
  const candidates = [
    trimmed,
    trimmed.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim(),
    trimmed.slice(trimmed.indexOf("{"), trimmed.lastIndexOf("}") + 1),
  ];
  for (const candidate of candidates) {
    if (!candidate || !candidate.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // try next candidate
    }
  }
  return null;
}

function pickString(obj: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function extractTitle(prompt: string) {
  const trimmed = prompt.trim();
  if (!trimmed) return "";
  const titleMatch = /(?:标题|主题|题目)[:：]\s*([^\n，。]+)/.exec(trimmed);
  if (titleMatch) return titleMatch[1].trim().slice(0, 40);
  return trimmed.replace(/[。！？\n].*$/s, "").slice(0, 28);
}

async function createZip() {
  const JSZipModule = await import("jszip");
  return new JSZipModule.default();
}

function docxContentTypes() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>
</Types>`;
}

function packageRels(target: string) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${target}"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;
}

function coreProps(title: string) {
  const now = new Date().toISOString();
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>${escapeXml(title)}</dc:title>
  <dc:creator>PolarAgent</dc:creator>
  <cp:lastModifiedBy>PolarAgent</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>`;
}

function appProps(appName: string) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>${escapeXml(appName)}</Application>
</Properties>`;
}

function emptyRelationships() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`;
}

function docxDocument(project: OfficeProject) {
  const paragraphs = project.blocks.map(docxParagraph).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${paragraphs}
    <w:sectPr>
      <w:pgSz w:w="11906" w:h="16838"/>
      <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>
    </w:sectPr>
  </w:body>
</w:document>`;
}

function docxParagraph(block: OfficeBlock) {
  const style =
    block.type === "heading"
      ? `<w:pStyle w:val="Heading${Math.min(block.level || 1, 3)}"/>`
      : "";
  const prefix = block.type === "bullet" ? "• " : "";
  return `<w:p>
  <w:pPr>${style}</w:pPr>
  <w:r><w:t xml:space="preserve">${escapeXml(prefix + block.text)}</w:t></w:r>
</w:p>`;
}

function docxStyles() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
    <w:name w:val="Normal"/>
    <w:rPr><w:rFonts w:ascii="Segoe UI" w:eastAsia="Microsoft YaHei"/></w:rPr>
  </w:style>
  ${[1, 2, 3]
    .map(
      (level) => `<w:style w:type="paragraph" w:styleId="Heading${level}">
    <w:name w:val="heading ${level}"/>
    <w:basedOn w:val="Normal"/>
    <w:uiPriority w:val="${9 + level}"/>
    <w:qFormat/>
    <w:rPr><w:b/><w:sz w:val="${level === 1 ? 36 : level === 2 ? 30 : 26}"/></w:rPr>
  </w:style>`,
    )
    .join("")}
</w:styles>`;
}

function docxSettings() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:zoom w:percent="100"/>
</w:settings>`;
}

function escapeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function escapeHtml(value: string) {
  return escapeXml(value).replace(/\n/g, "<br />");
}
