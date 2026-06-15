// IPC：内置 Office 导出能力
const { BrowserWindow } = require("electron");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const JSZip = require("jszip");

const { ensureDir } = require("../lib/fs-utils.cjs");

async function htmlToPdf({
  html,
  targetPath,
  baseDir,
  sourcePath,
  pageSize = "A4",
  landscape = false,
  margins,
}) {
  if (!String(html || "").trim() && !String(sourcePath || "").trim()) {
    throw new Error("HTML 内容或源文件路径不能为空");
  }
  if (!String(targetPath || "").trim()) {
    throw new Error("PDF 输出路径不能为空");
  }

  await ensureDir(path.dirname(targetPath));
  const win = new BrowserWindow({
    show: false,
    width: 1024,
    height: 1365,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  let renderPath = "";
  let shouldDeleteRenderPath = false;
  try {
    if (String(sourcePath || "").trim()) {
      renderPath = path.resolve(String(sourcePath));
    } else {
      const renderDir = baseDir
        ? path.resolve(baseDir)
        : path.dirname(path.resolve(targetPath));
      await ensureDir(renderDir);
      renderPath = path.join(
        renderDir,
        `.polaragent-pdf-render-${Date.now()}-${Math.random().toString(36).slice(2)}.html`,
      );
      await fsp.writeFile(renderPath, injectBaseHref(String(html), baseDir), "utf8");
      shouldDeleteRenderPath = true;
    }

    await win.loadFile(renderPath);
    await waitForResources(win);
    const pdf = await win.webContents.printToPDF({
      printBackground: true,
      pageSize,
      landscape: Boolean(landscape),
      margins: normalizePdfMargins(margins),
    });
    await fsp.writeFile(targetPath, pdf);
    return { path: targetPath, size: pdf.length };
  } finally {
    if (renderPath && shouldDeleteRenderPath) {
      await fsp.unlink(renderPath).catch(() => {});
    }
    if (!win.isDestroyed()) {
      win.close();
    }
  }
}

function normalizePdfMargins(margins) {
  if (!margins || typeof margins !== "object") {
    return { marginType: "default" };
  }
  const top = Number(margins.top);
  const right = Number(margins.right);
  const bottom = Number(margins.bottom);
  const left = Number(margins.left);
  if ([top, right, bottom, left].every((value) => Number.isFinite(value) && value >= 0)) {
    return { marginType: "custom", top, right, bottom, left };
  }
  return { marginType: "default" };
}

async function htmlToPptx({
  html,
  targetPath,
  baseDir,
  sourcePath,
}) {
  if (!String(html || "").trim() && !String(sourcePath || "").trim()) {
    throw new Error("HTML 内容或源文件路径不能为空");
  }
  if (!String(targetPath || "").trim()) {
    throw new Error("PPTX 输出路径不能为空");
  }

  await ensureDir(path.dirname(targetPath));
  const width = 1600;
  const height = 900;
  const win = new BrowserWindow({
    show: false,
    width,
    height,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  let renderPath = "";
  let shouldDeleteRenderPath = false;
  try {
    if (String(sourcePath || "").trim()) {
      renderPath = path.resolve(String(sourcePath));
    } else {
      const preparedHtml = injectBaseHref(String(html), baseDir);
      const renderDir = baseDir
        ? path.resolve(baseDir)
        : path.dirname(path.resolve(targetPath));
      await ensureDir(renderDir);
      renderPath = path.join(
        renderDir,
        `.polaragent-ppt-render-${Date.now()}-${Math.random().toString(36).slice(2)}.html`,
      );
      await fsp.writeFile(renderPath, preparedHtml, "utf8");
      shouldDeleteRenderPath = true;
    }

    await win.loadFile(renderPath);
    await waitForDeckReady(win, width, height);
    await waitForResources(win);

    const slideCount = await win.webContents.executeJavaScript(`
      Math.max(1, document.querySelectorAll('.slide').length)
    `);
    const screenshots = [];
    for (let index = 0; index < Number(slideCount || 1); index += 1) {
      await showSlide(win, index);
      const image = await win.webContents.capturePage({ x: 0, y: 0, width, height });
      screenshots.push(image.toPNG());
    }

    const title = await win.webContents
      .executeJavaScript(`document.title || "HTML PPT"`)
      .catch(() => titleFromHtml(String(html || "")));
    const pptx = await imageSlidesPptx(screenshots, title);
    await fsp.writeFile(targetPath, pptx);
    return { path: targetPath, slides: screenshots.length, size: pptx.length };
  } finally {
    if (renderPath && shouldDeleteRenderPath) {
      await fsp.unlink(renderPath).catch(() => {});
    }
    if (!win.isDestroyed()) {
      win.close();
    }
  }
}

function injectBaseHref(html, baseDir) {
  if (!baseDir || /<base\s/i.test(html)) return html;
  const href = pathToFileURL(path.resolve(baseDir)).href.replace(/\/?$/, "/");
  const base = `<base href="${escapeHtmlAttr(href)}">`;
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, (match) => `${match}\n${base}`);
  }
  return `${base}\n${html}`;
}

async function waitForDeckReady(win, width, height) {
  await win.webContents.executeJavaScript(`
    new Promise((resolve) => {
      const done = () => {
        const exportStyle = document.createElement('style');
        exportStyle.textContent = [
          '#nav,#hint,#overview,.nav,.controls,.progress{display:none!important}',
          'html,body{width:100vw!important;height:100vh!important;margin:0!important;overflow:hidden!important;background:#fff!important}',
          '#deck,.deck,.slide-deck{width:100vw!important;height:100vh!important;transform:none!important;transition:none!important;overflow:hidden!important}',
          '.slide{position:absolute!important;inset:0!important;width:100vw!important;height:100vh!important;overflow:hidden!important;transform:none!important;transition:none!important;animation:none!important;opacity:0!important;visibility:hidden!important}',
          '.slide[data-export-active="true"]{opacity:1!important;visibility:visible!important}',
          '.slide *{animation:none!important;transition:none!important}',
          '[data-anim],.animate-fade-up,.animate-scale,.animate-stagger>*{opacity:1!important;transform:none!important}'
        ].join('');
        document.head.appendChild(exportStyle);
        const deck = document.querySelector('#deck');
        if (deck) {
          deck.style.transition = 'none';
          deck.style.transform = 'none';
          deck.style.width = '100vw';
          deck.style.height = '100vh';
        }
        document.querySelectorAll('.slide').forEach((slide, index) => {
          slide.dataset.exportIndex = String(index);
          slide.dataset.exportActive = index === 0 ? 'true' : 'false';
          slide.style.width = '100vw';
          slide.style.height = '100vh';
        });
        resolve(true);
      };
      const startedAt = Date.now();
      const waitForSlides = () => {
        const hasSlides = document.querySelectorAll('.slide').length > 0;
        if (hasSlides || Date.now() - startedAt > 2500) {
          if (document.fonts && document.fonts.ready) {
            document.fonts.ready.then(() => setTimeout(done, 180));
          } else {
            setTimeout(done, 180);
          }
          return;
        }
        requestAnimationFrame(waitForSlides);
      };
      waitForSlides();
    })
  `);
  win.setSize(width, height);
}

async function waitForResources(win, timeoutMs = 8000) {
  await win.webContents.executeJavaScript(`
    new Promise((resolve) => {
      const delay = (ms) => new Promise((done) => setTimeout(done, ms));
      const withTimeout = (promise, ms) => Promise.race([promise, delay(ms)]);
      const imageReady = (img) => {
        if (img.complete && img.naturalWidth !== 0) return Promise.resolve();
        if (typeof img.decode === 'function') return img.decode().catch(() => {});
        return new Promise((done) => {
          img.addEventListener('load', done, { once: true });
          img.addEventListener('error', done, { once: true });
        });
      };
      const addBackgroundUrls = (target, urls) => {
        const value = getComputedStyle(target).backgroundImage;
        if (!value || value === 'none') return;
        const pattern = /url\\((['"]?)(.*?)\\1\\)/g;
        let match;
        while ((match = pattern.exec(value))) {
          if (match[2] && !match[2].startsWith('data:')) urls.add(match[2]);
        }
      };
      const loadUrl = (url) =>
        new Promise((done) => {
          const img = new Image();
          img.onload = done;
          img.onerror = done;
          img.src = url;
        });

      (async () => {
        await withTimeout(document.fonts?.ready || Promise.resolve(), Math.min(${timeoutMs}, 5000));
        const images = Array.from(document.images || []);
        await Promise.allSettled(images.map((img) => withTimeout(imageReady(img), ${timeoutMs})));

        const backgroundUrls = new Set();
        document.querySelectorAll('*').forEach((node) => addBackgroundUrls(node, backgroundUrls));
        await Promise.allSettled(
          Array.from(backgroundUrls).map((url) => withTimeout(loadUrl(url), ${timeoutMs})),
        );

        requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)));
      })().catch(() => resolve(false));
    })
  `);
}

async function showSlide(win, index) {
  await win.webContents.executeJavaScript(`
    new Promise((resolve) => {
      window.__currentSlideIndex = ${index};
      const deck = document.querySelector('#deck');
      if (deck) {
        deck.style.transition = 'none';
        deck.style.transform = 'none';
      }
      const slides = Array.from(document.querySelectorAll('.slide'));
      slides.forEach((item, itemIndex) => {
        item.dataset.exportActive = itemIndex === ${index} ? 'true' : 'false';
      });
      const slide = slides[${index}];
      if (slide) {
        const isLight = slide.dataset.theme === 'light' || slide.classList.contains('light');
        const isDark = slide.dataset.theme === 'dark' || slide.classList.contains('dark') || slide.classList.contains('accent');
        document.body.classList.toggle('light-bg', isLight);
        document.body.classList.toggle('dark-bg', isDark);
      }
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    })
  `);
  await waitForResources(win);
}

async function imageSlidesPptx(images, title) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", pptxImageContentTypes(images.length));
  zip.folder("_rels").file(".rels", packageRels("ppt/presentation.xml"));
  zip.folder("docProps").file("core.xml", coreProps(title));
  zip.folder("docProps").file("app.xml", appProps("PolarAgent Office"));

  const ppt = zip.folder("ppt");
  ppt.file("presentation.xml", pptPresentation(images.length));
  ppt.folder("_rels").file("presentation.xml.rels", pptPresentationRels(images.length));
  ppt.folder("theme").file("theme1.xml", pptTheme());
  ppt.folder("slideMasters").file("slideMaster1.xml", pptSlideMaster());
  ppt.folder("slideMasters").folder("_rels").file("slideMaster1.xml.rels", pptSlideMasterRels());
  ppt.folder("slideLayouts").file("slideLayout1.xml", pptSlideLayout());
  ppt.folder("slideLayouts").folder("_rels").file("slideLayout1.xml.rels", pptSlideLayoutRels());

  images.forEach((buffer, index) => {
    ppt.folder("media").file(`image${index + 1}.png`, buffer);
    ppt.folder("slides").file(`slide${index + 1}.xml`, pptImageSlideXml(index));
    ppt
      .folder("slides")
      .folder("_rels")
      .file(`slide${index + 1}.xml.rels`, pptImageSlideRels(index));
  });

  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

function titleFromHtml(html) {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return decodeHtml(match?.[1] || "HTML PPT");
}

function pptxImageContentTypes(slideCount) {
  const slides = Array.from({ length: slideCount }, (_, index) =>
    `<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`,
  ).join("\n  ");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
  <Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
  <Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
  ${slides}
</Types>`;
}

function packageRels(target) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${target}"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;
}

function coreProps(title) {
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

function appProps(appName) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>${escapeXml(appName)}</Application>
</Properties>`;
}

function pptPresentation(slideCount) {
  const slideIds = Array.from({ length: slideCount }, (_, index) =>
    `<p:sldId id="${256 + index}" r:id="rId${index + 2}"/>`,
  ).join("\n    ");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>
  <p:sldIdLst>
    ${slideIds}
  </p:sldIdLst>
  <p:sldSz cx="12192000" cy="6858000" type="screen16x9"/>
  <p:notesSz cx="6858000" cy="9144000"/>
</p:presentation>`;
}

function pptPresentationRels(slideCount) {
  const slides = Array.from({ length: slideCount }, (_, index) =>
    `<Relationship Id="rId${index + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${index + 1}.xml"/>`,
  ).join("\n  ");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>
  ${slides}
</Relationships>`;
}

function pptSlideMaster() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld>
  <p:sldLayoutIdLst><p:sldLayoutId id="1" r:id="rId1"/></p:sldLayoutIdLst>
  <p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles>
</p:sldMaster>`;
}

function pptSlideMasterRels() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>
</Relationships>`;
}

function pptSlideLayout() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1">
  <p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld>
</p:sldLayout>`;
}

function pptSlideLayoutRels() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>
</Relationships>`;
}

function pptImageSlideRels(index) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image${index + 1}.png"/>
</Relationships>`;
}

function pptImageSlideXml(index) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>
      <p:pic>
        <p:nvPicPr><p:cNvPr id="2" name="slide-${index + 1}.png"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>
        <p:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>
        <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="12192000" cy="6858000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
      </p:pic>
    </p:spTree>
  </p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sld>`;
}

function pptTheme() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="PolarAgent">
  <a:themeElements>
    <a:clrScheme name="PolarAgent"><a:dk1><a:srgbClr val="202421"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="2D332F"/></a:dk2><a:lt2><a:srgbClr val="F5F5F3"/></a:lt2><a:accent1><a:srgbClr val="002FA7"/></a:accent1><a:accent2><a:srgbClr val="9B6FE0"/></a:accent2><a:accent3><a:srgbClr val="D88C4A"/></a:accent3><a:accent4><a:srgbClr val="3A78A8"/></a:accent4><a:accent5><a:srgbClr val="6A8A4D"/></a:accent5><a:accent6><a:srgbClr val="B95D5D"/></a:accent6><a:hlink><a:srgbClr val="3A78A8"/></a:hlink><a:folHlink><a:srgbClr val="5B3A9E"/></a:folHlink></a:clrScheme>
    <a:fontScheme name="PolarAgent"><a:majorFont><a:latin typeface="Segoe UI"/><a:ea typeface="Microsoft YaHei"/></a:majorFont><a:minorFont><a:latin typeface="Segoe UI"/><a:ea typeface="Microsoft YaHei"/></a:minorFont></a:fontScheme>
    <a:fmtScheme name="PolarAgent"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme>
  </a:themeElements>
</a:theme>`;
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function escapeHtmlAttr(value) {
  return escapeXml(value);
}

function decodeHtml(value) {
  return String(value)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function register(ipcMain) {
  ipcMain.handle("office:html-to-pdf", (_event, { request }) =>
    htmlToPdf(request),
  );
  ipcMain.handle("office:html-to-pptx", (_event, { request }) =>
    htmlToPptx(request),
  );
}

module.exports = { register };
