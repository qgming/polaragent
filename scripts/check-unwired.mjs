// 零引用组件检查：让「已建好但没接线」变成可见事实。
//
// 扫描对象：src/renderer/components/assistant-ui/elements 下的 .ts / .tsx 文件。
//
// 判定分三层，避免把「活的间接依赖」误报成死代码：
//   1. 已接线   —— 有 elements/ 之外的直接导入者
//   2. 间接接线 —— 自己没有被外部直接导入，但沿着 import 链能被某个「已接线」文件走到
//   3. 未接线   —— 其余全部，即真正的死代码（零导入者，或只在死簇内部互相引用）
//
// 第 2 层是必须的：markdown-text.tsx 被应用直接引用，那么它引用的 mermaid-diagram.aui.tsx
// 也就是活的；只按「有无直接外部导入者」判定会把这类全部误报为孤立。
// 反向同理：零导入者的死簇即使内部互相引用也依然是死的 —— 判活必须用从外部入口出发的有向可达性。
//
// 未接线再按 scripts/unwired-allowlist.json 分成两拨（结构：{ "文件名": "为什么允许它未接线" }）：
//   - 已知待接线：在 allowlist 里，有明确接线计划或数据源缺口的暂缓项 —— 通过，只提示数量；
//   - 新增未接线：不在 allowlist 里，属于新产生的死代码 —— 失败。
// 反向校验：allowlist 里列了某个文件，但它现在已经不是未接线（已接线 / 间接接线 / 文件不存在），
// 说明清单腐烂了 —— 失败，并提示删除该条目。
//
// 退出码：
//   0 —— 没有新增未接线，且 allowlist 没有失效条目；
//   1 —— 存在新增未接线，或存在失效的 allowlist 条目（allowlist 文件缺失 / 损坏同样判失败）。
// 用法：node scripts/check-unwired.mjs [--json]

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");
const ELEMENTS = path.join(SRC, "renderer/components/assistant-ui/elements");
const ALLOWLIST = path.join(ROOT, "scripts/unwired-allowlist.json");
const MODULE_EXTS = [".ts", ".tsx"];
/** 测试文件不参与接线判定：既不算组件，也不算导入者 */
const TEST_RE = /\.test\.tsx?$/;
const JSON_OUT = process.argv.includes("--json");

/** 统一输出 posix 风格相对路径，跨平台稳定 */
function relPosix(from, to) {
  return path.relative(from, to).split(path.sep).join("/");
}

/** 递归收集指定扩展名的文件（缺失目录返回空数组） */
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

function stripExt(p) {
  for (const ext of MODULE_EXTS) {
    if (p.endsWith(ext)) return p.slice(0, -ext.length);
  }
  return p;
}

/** 模块身份：相对 src 的 posix 路径（去掉扩展名），用于把 import 说明符对应回文件 */
function moduleKey(file) {
  return stripExt(relPosix(SRC, file));
}

// 只认 `from "spec"` 与 `import("spec")`；以 // * /* 开头的整行注释直接跳过，
// 避免把文档示例里的 import 当成真实引用（例如 message-timing.aui.tsx 的 JSDoc 示例）。
const IMPORT_RE = /(?:from\s*|import\s*\(\s*)(["'])([^"']+)\1/g;

function importSpecifiers(file) {
  const specs = [];
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
    for (const match of line.matchAll(IMPORT_RE)) specs.push(match[2]);
  }
  return specs;
}

/** 把说明符解析成 src 内的模块身份；包名等外部模块返回 null */
function resolveSpecifier(file, spec) {
  const clean = stripExt(spec);
  let target;
  if (clean.startsWith("@/")) target = path.join(SRC, clean.slice(2));
  else if (clean.startsWith(".")) target = path.resolve(path.dirname(file), clean);
  else return null;
  return moduleKey(target);
}

/**
 * 读取 allowlist（{ "文件名": "原因" }）；缺失或损坏直接判失败，
 * 不给 CI 留下「删掉清单就静默放行」的口子。
 */
function readAllowlist() {
  let raw;
  try {
    // PowerShell 5.1 的 Out-File / Set-Content 会带 BOM，这里剥掉以保证 JSON.parse 稳定
    raw = fs.readFileSync(ALLOWLIST, "utf8").replace(/^\uFEFF/, "");
  } catch {
    console.error(`[check-unwired] allowlist 缺失：${relPosix(ROOT, ALLOWLIST)}`);
    console.error('[check-unwired] 请创建该文件（结构：{ "文件名": "原因" }），不要靠删清单绕过门禁');
    process.exit(1);
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error('顶层必须是 { "文件名": "原因" } 对象');
    }
    for (const [file, reason] of Object.entries(parsed)) {
      if (typeof reason !== "string" || reason.trim() === "") {
        throw new Error(`条目「${file}」缺少非空的原因字符串`);
      }
    }
    return parsed;
  } catch (error) {
    console.error(`[check-unwired] allowlist 解析失败：${relPosix(ROOT, ALLOWLIST)}`);
    console.error(`[check-unwired] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

if (!fs.existsSync(ELEMENTS)) {
  console.error(`目标目录不存在：${relPosix(ROOT, ELEMENTS)}`);
  process.exitCode = 1;
} else {
  const allowlist = readAllowlist();
  const srcFiles = walk(SRC);
  // 排除测试文件：它们是组件的消费者而非组件本身
  const elementFiles = walk(ELEMENTS).filter((file) => !TEST_RE.test(file));
  const elementByKey = new Map(elementFiles.map((file) => [moduleKey(file), file]));

  /** elementKey → { external, internal }，两个集合里放的是导入者文件绝对路径 */
  const importers = new Map(
    elementFiles.map((file) => [moduleKey(file), { external: new Set(), internal: new Set() }]),
  );

  for (const file of srcFiles) {
    // 测试文件不构成「接线」：只被测试引用的组件在应用里依然是死的
    if (TEST_RE.test(file)) continue;
    const fromElements = file.startsWith(`${ELEMENTS}${path.sep}`);
    for (const spec of importSpecifiers(file)) {
      const targetKey = resolveSpecifier(file, spec);
      if (targetKey === null) continue;
      const bucket = importers.get(targetKey);
      // 排除 X 自身（含文档注释里的自引用示例）
      if (!bucket || elementByKey.get(targetKey) === file) continue;
      (fromElements ? bucket.internal : bucket.external).add(file);
    }
  }

  /** 依赖边：导入者 → 被导入者。判活沿这个方向扩散 */
  const deps = new Map(elementFiles.map((file) => [moduleKey(file), new Set()]));
  /** 簇 = internal 引用构成的连通分量（无向），仅用于输出时把同一簇聚合展示 */
  const adjacency = new Map(elementFiles.map((file) => [moduleKey(file), new Set()]));

  for (const [targetKey, bucket] of importers) {
    for (const importer of bucket.internal) {
      const importerKey = moduleKey(importer);
      deps.get(importerKey).add(targetKey);
      adjacency.get(targetKey).add(importerKey);
      adjacency.get(importerKey).add(targetKey);
    }
  }

  // 判活：从「有外部直接导入者」的元素出发，沿依赖边做有向可达
  const live = new Set(
    elementFiles
      .map((file) => moduleKey(file))
      .filter((key) => importers.get(key).external.size > 0),
  );
  const queue = [...live];
  while (queue.length > 0) {
    for (const next of deps.get(queue.pop()) ?? []) {
      if (live.has(next)) continue;
      live.add(next);
      queue.push(next);
    }
  }

  function clusterOf(startKey) {
    const seen = new Set([startKey]);
    const stack = [startKey];
    while (stack.length > 0) {
      for (const next of adjacency.get(stack.pop()) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        stack.push(next);
      }
    }
    return [...seen].sort();
  }

  /** elementKey → elements 内的文件名（带扩展名） */
  function elementName(key) {
    const file = elementByKey.get(key);
    return file === undefined ? key : relPosix(ELEMENTS, file);
  }

  const toDetails = (files) => [...files].map((file) => relPosix(ROOT, file)).sort();

  const wired = [];
  const indirect = [];
  const unwired = [];

  for (const file of elementFiles) {
    const key = moduleKey(file);
    const bucket = importers.get(key);
    const entry = {
      file: relPosix(ELEMENTS, file),
      externalImporters: toDetails(bucket.external),
      internalImporters: [...bucket.internal].map((f) => relPosix(ELEMENTS, f)).sort(),
    };
    if (bucket.external.size > 0) {
      wired.push(entry);
      continue;
    }
    if (live.has(key)) {
      entry.reachedVia = [...deps.keys()]
        .filter((importerKey) => deps.get(importerKey).has(key) && live.has(importerKey))
        .map(elementName)
        .sort();
      indirect.push(entry);
      continue;
    }
    entry.cluster = clusterOf(key).map(elementName);
    unwired.push(entry);
  }

  // 门禁分组：未接线里在 allowlist 上的算「已知待接线」，其余是「新增未接线」
  const knownUnwired = [];
  const newUnwired = [];
  for (const entry of unwired) {
    const allowReason = allowlist[entry.file];
    if (typeof allowReason === "string") knownUnwired.push({ ...entry, allowReason });
    else newUnwired.push(entry);
  }

  /** 每个被扫描文件的实际状态，用于反向校验 allowlist 是否腐烂 */
  const statusByFile = new Map();
  for (const entry of wired) statusByFile.set(entry.file, "已接线");
  for (const entry of indirect) statusByFile.set(entry.file, "间接接线");
  for (const entry of unwired) statusByFile.set(entry.file, "未接线");

  const staleAllowlist = Object.entries(allowlist)
    .filter(([file]) => statusByFile.get(file) !== "未接线")
    .map(([file, allowReason]) => ({
      file,
      allowReason,
      actualStatus: statusByFile.get(file) ?? "不在扫描结果中（文件不存在，或测试文件被排除）",
    }))
    .sort((a, b) => a.file.localeCompare(b.file));

  // 门禁判定：新增死代码与腐烂的 allowlist 条目都算失败
  const failed = newUnwired.length > 0 || staleAllowlist.length > 0;
  process.exitCode = failed ? 1 : 0;

  const counts = {
    scanned: elementFiles.length,
    wired: wired.length,
    indirect: indirect.length,
    knownUnwired: knownUnwired.length,
    newUnwired: newUnwired.length,
    staleAllowlist: staleAllowlist.length,
  };

  if (JSON_OUT) {
    console.log(
      JSON.stringify(
        {
          elementsDir: relPosix(ROOT, ELEMENTS),
          counts,
          wired,
          indirect,
          newUnwired,
          staleAllowlist,
          knownUnwired: knownUnwired.map(({ file, allowReason }) => ({ file, allowReason })),
          exitCode: process.exitCode,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(`==== 零引用组件检查 · ${relPosix(ROOT, ELEMENTS)} ====`);
    console.log(
      `扫描 ${counts.scanned} 个文件 | 已接线 ${counts.wired} | 间接接线 ${counts.indirect} | 已知待接线 ${counts.knownUnwired}（allowlist 通过）| 新增未接线 ${counts.newUnwired} | 失效 allowlist 条目 ${counts.staleAllowlist}`,
    );

    console.log(`\n-- 已接线（有 elements/ 之外的直接导入者）: ${counts.wired} --`);
    for (const entry of wired) {
      console.log(`  ✔ ${entry.file}`);
      console.log(`      外部导入者: ${entry.externalImporters.join(", ")}`);
    }

    console.log(`\n-- 间接接线（沿 import 链可达已接线文件，属活代码）: ${counts.indirect} --`);
    for (const entry of indirect) {
      console.log(`  ○ ${entry.file}`);
      console.log(`      引用它的活文件: ${entry.reachedVia.join(", ") || "(仅自身)"}`);
    }

    console.log(`\n-- 新增未接线（不在 allowlist 内，失败）: ${counts.newUnwired} --`);
    if (newUnwired.length === 0) console.log("  （无）");
    for (const entry of newUnwired) {
      const sources =
        entry.internalImporters.length === 0
          ? "零导入者"
          : `仅被死簇内引用: ${entry.internalImporters.join(", ")}`;
      console.log(`  ✖ ${entry.file}`);
      console.log(`      ${sources}`);
      console.log("      处置：接线，或加入 scripts/unwired-allowlist.json 并写明原因");
    }

    console.log(`\n-- 失效的 allowlist 条目（失败，请删除）: ${counts.staleAllowlist} --`);
    if (staleAllowlist.length === 0) console.log("  （无）");
    for (const entry of staleAllowlist) {
      console.log(`  ✖ ${entry.file} —— 实际状态：${entry.actualStatus}`);
      console.log(`      allowlist 原因: ${entry.allowReason}`);
    }
    if (staleAllowlist.length > 0) {
      console.log("  allowlist 有失效条目，请删除：这些文件已经不是未接线状态了");
    }

    console.log(`\n-- 已知待接线（allowlist 通过，仅统计）: ${counts.knownUnwired} --`);
    console.log(`  明细与原因见 ${relPosix(ROOT, ALLOWLIST)}`);

    console.log(
      `\n结论：新增未接线 ${counts.newUnwired} | 失效 allowlist 条目 ${counts.staleAllowlist} | 已知待接线 ${counts.knownUnwired}（退出码 ${process.exitCode}）`,
    );
  }
}
