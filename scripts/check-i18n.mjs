// i18n 词条对账门禁：抓「代码用了但语言包里没有」的键。
//
// **为什么需要它**：审计发现 `chat.showMore` / `chat.showLess` 两个键在两个语言包里
// 都不存在，却被 ToolParts.tsx 使用 —— 而 i18next 缺键时**原样返回键名**，
// 于是按钮的 aria-label 在界面上直接显示字面量 "chat.showMore"。
// 这类缺陷没有任何既有测试能抓到：组件渲染成功、断言也能过，只有肉眼看界面才发现。
//
// 判定方式：**用真实的 locale 模块逐条解析**，而不是正则比对字符串。
// 朴素比对会被 i18next 的复数后缀骗到：代码写 `t("chat.editDiscards", { count })`
// 而资源里存的是 `editDiscards_one` / `editDiscards_other`，key 本身并不存在。
// 只有真正调一次 t() 才知道它解析得出还是解析不出。
//
// 用法：node scripts/check-i18n.mjs [--json]
// 退出码：0 = 没有缺失键；1 = 存在缺失键（或脚本自身出错）。

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");
const LOCALES = path.join(SRC, "shared/i18n/locales");
const LANGS = ["zh-CN", "en-US"];
const MODULE_EXTS = [".ts", ".tsx"];
const TEST_RE = /\.test\.tsx?$/;
const JSON_OUT = process.argv.includes("--json");

/** 统一输出 posix 风格相对路径，跨平台稳定 */
function relPosix(from, to) {
  return path.relative(from, to).split(path.sep).join("/");
}

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (MODULE_EXTS.some((ext) => entry.name.endsWith(ext))) out.push(full);
  }
  return out.sort();
}

/**
 * 抓代码里用到的词条键。
 *
 * 两类来源：
 *   1. `t("a.b.c")` 字面量调用（含 `t('...')` 与模板串形式）；
 *   2. `labelKey: "a.b.c"` 这类**按键名间接调用**的字段 —— 它们会被
 *      `t(section.labelKey)` 消费，光看 t() 调用点抓不到。
 *      内置指令的 `descriptionKey` / `hintKey`（shared/contracts/commands.ts）与
 *      输入框提示的 `messageKey`（features/chat/commands.ts）都是同一形态，
 *      必须一并收进来，否则加一条指令 / 一条提示时漏了词条没人发现。
 *
 * 带 `{ count }` 的调用要按复数解析（见文件头）。
 */
const CALL_RE = /\bt\(\s*["'`]([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)["'`]\s*(?:,\s*(\{[^}]*\}))?/g;
const KEY_FIELD_RE =
  /\b(?:labelKey|resting|active|descriptionKey|hintKey|messageKey)\s*:\s*["'`]([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)["'`]/g;

function collectUsedKeys() {
  const used = new Map();
  for (const file of walk(SRC)) {
    if (TEST_RE.test(file)) continue;
    const text = fs.readFileSync(file, "utf8");
    const where = relPosix(ROOT, file);
    for (const match of text.matchAll(CALL_RE)) {
      const key = match[1];
      const hasCount = (match[2] ?? "").includes("count");
      record(key, hasCount, where);
    }
    for (const match of text.matchAll(KEY_FIELD_RE)) {
      record(match[1], false, where);
    }
  }
  return used;

  function record(key, hasCount, where) {
    const existing = used.get(key);
    if (existing === undefined) used.set(key, { files: new Set([where]), hasCount });
    else {
      existing.files.add(where);
      existing.hasCount = existing.hasCount || hasCount;
    }
  }
}

/** 动态加载 locale 模块（TS 由 Node 的类型剥离处理，无需构建） */
async function loadLocale(lang) {
  const file = path.join(LOCALES, `${lang}.ts`);
  const mod = await import(pathToFileURL(file).href);
  const value = mod.default ?? Object.values(mod)[0];
  if (typeof value !== "object" || value === null) {
    throw new Error(`${relPosix(ROOT, file)} 没有导出词条对象`);
  }
  return value;
}

/** 极简的 i18next 兼容解析：只处理本仓用到的「点分键 + 复数后缀」两种形态 */
function resolve(resources, lang, key, hasCount) {
  const read = (candidate) => {
    let node = resources;
    for (const segment of candidate.split(".")) {
      if (typeof node !== "object" || node === null) return undefined;
      node = node[segment];
    }
    return typeof node === "string" ? node : undefined;
  };
  if (!hasCount) return read(key);
  // 复数：i18next 按 count 选后缀；这里只关心「有没有任一形态」，故两者都试
  return read(`${key}_other`) ?? read(`${key}_one`) ?? read(key);
}

async function main() {
  const used = collectUsedKeys();
  const resources = {};
  for (const lang of LANGS) resources[lang] = await loadLocale(lang);

  const missing = [];
  for (const [key, info] of used) {
    const absent = LANGS.filter(
      (lang) => resolve(resources[lang], lang, key, info.hasCount) === undefined,
    );
    if (absent.length > 0) {
      missing.push({ key, langs: absent, files: [...info.files].sort() });
    }
  }
  missing.sort((left, right) => left.key.localeCompare(right.key));

  if (JSON_OUT) {
    console.log(JSON.stringify({ scannedKeys: used.size, missing }, null, 2));
  } else if (missing.length === 0) {
    console.log(`[check-i18n] ${used.size} 个词条键在 ${LANGS.join(" / ")} 中都存在 ✔`);
  } else {
    console.error(`[check-i18n] ${missing.length} 个词条键缺失：`);
    for (const item of missing) {
      console.error(`  ✖ ${item.key}（缺 ${item.langs.join(" / ")}）`);
      console.error(`      用在: ${item.files.join(", ")}`);
    }
    console.error(
      "[check-i18n] i18next 缺键时会原样返回键名 —— 界面上会出现这个字面量。请补词条。",
    );
  }
  process.exitCode = missing.length > 0 ? 1 : 0;
}

await main();
