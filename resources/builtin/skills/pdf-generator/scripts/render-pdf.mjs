#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const USAGE = `
Usage:
  node scripts/render-pdf.mjs <input.html|url> <output.pdf> [options]

Options:
  --format <A4|Letter|Legal>     Page format, default A4
  --margin <css-size>            Margin for all sides, default 14mm
  --landscape                    Render landscape
  --scale <number>               Playwright PDF scale, default 1
  --title <text>                 Header title, defaults to document title
  --wait <ms>                    Extra wait before printing, default 400
  --wait-for <selector>          Wait for a selector before printing
  --no-header-footer             Disable Chromium header/footer
`;

function readOption(args, name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  if (index === args.length - 1) {
    throw new Error(`${name} requires a value`);
  }
  return args[index + 1];
}

function hasFlag(args, name) {
  return args.includes(name);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function inputToUrl(input) {
  if (/^https?:\/\//i.test(input)) return input;
  const absolute = path.resolve(input);
  await fs.access(absolute);
  return pathToFileURL(absolute).href;
}

async function main() {
  const args = process.argv.slice(2);
  if (hasFlag(args, "--help") || hasFlag(args, "-h")) {
    console.log(USAGE.trim());
    process.exit(0);
  }
  if (args.length < 2) {
    console.log(USAGE.trim());
    process.exit(1);
  }

  const [input, output] = args;
  const format = readOption(args, "--format", "A4");
  const margin = readOption(args, "--margin", "14mm");
  const waitMs = Number(readOption(args, "--wait", "400"));
  const scale = Number(readOption(args, "--scale", "1"));
  const waitForSelector = readOption(args, "--wait-for", "");
  const explicitTitle = readOption(args, "--title", "");
  const landscape = hasFlag(args, "--landscape");
  const displayHeaderFooter = !hasFlag(args, "--no-header-footer");

  if (!Number.isFinite(waitMs) || waitMs < 0) {
    throw new Error("--wait must be a non-negative number");
  }
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new Error("--scale must be a positive number");
  }

  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch (error) {
    console.error("Missing dependency: playwright.");
    console.error("Install it in the working project with: npm install -D playwright");
    console.error("Then install Chromium if needed with: npx playwright install chromium");
    process.exit(1);
  }

  const sourceUrl = await inputToUrl(input);
  const outputPath = path.resolve(output);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1800 } });

  try {
    await page.emulateMedia({ media: "print" });
    await page.goto(sourceUrl, { waitUntil: "networkidle" });

    if (waitForSelector) {
      await page.waitForSelector(waitForSelector, { state: "visible", timeout: 15000 });
    }
    if (waitMs > 0) {
      await page.waitForTimeout(waitMs);
    }

    const documentTitle =
      explicitTitle ||
      (await page.title()) ||
      path.basename(input, path.extname(input));
    const safeTitle = escapeHtml(documentTitle);
    const generatedDate = new Date().toISOString().slice(0, 10);

    const headerTemplate = `
      <style>
        section { width: 100%; padding: 0 10mm; color: #667085; font: 8px Arial, sans-serif; }
      </style>
      <section>${safeTitle}</section>`;
    const footerTemplate = `
      <style>
        section { width: 100%; padding: 0 10mm; color: #667085; font: 8px Arial, sans-serif; display: flex; justify-content: space-between; }
      </style>
      <section><span>${generatedDate}</span><span>Page <span class="pageNumber"></span> / <span class="totalPages"></span></span></section>`;

    await page.pdf({
      path: outputPath,
      format,
      landscape,
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter,
      headerTemplate: displayHeaderFooter ? headerTemplate : undefined,
      footerTemplate: displayHeaderFooter ? footerTemplate : undefined,
      margin: { top: margin, right: margin, bottom: margin, left: margin },
      scale,
    });
  } finally {
    await browser.close();
  }

  const stats = await fs.stat(outputPath);
  console.log(`Wrote ${outputPath} (${Math.round(stats.size / 1024)} KB)`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
