#!/usr/bin/env node
// 校验一个智能体技能文件夹是否符合 Oint 的技能规范。
//
// 用法：node validate_skill.mjs <技能文件夹路径>
//
// 退出码：0 = PASS（允许有 warning），1 = FAIL（有 error），2 = 用法错误。
//
// ## 为什么是 Node，而且只留这一份实现
//
// 上游（mimocode）那份是 Python 脚本。这里用 Node 重写并**把 Python 版删掉**，
// 理由有两条，都是「技能里写的命令必须真的能跑」：
//
// 1. **Oint 自己就是 Electron 应用，Node 一定在**（Electron 内置）。Python 不保证：
//    Windows 上 `python3` 常常是 Microsoft Store 的占位 stub —— 命令存在、
//    执行却返回 9009 且**没有任何输出**（本机实测如此）。技能里写一条跑不通的命令，
//    比没有这条命令更糟：模型会反复重试同一个错。
// 2. **两份等价实现是纯粹的维护负担**：任何规则调整都要改两遍，
//    而它们一旦漂移，「校验通过」就不再等于「内核会装载」—— 那是这个脚本最不该出的错。
//    所以只留 Node 这一份。
//
// ## 打包后的可执行性
//
// 技能随包分发时住在 asar 归档里，**外部解释器打不开归档内路径**
//（Electron 的 fs 补丁只对它自己的进程生效）。解法在 electron-builder.yml：
// `resources/**` 整个 asarUnpack 拆出来，resolveBuiltinSkillDir() 返回解包后的真实路径。
//
// ## 严重级别
//
// 严格对齐内核 @earendil-works/pi-agent-core 的真实行为
//（见 README 与 references/frontmatter.md）—— 报重了给假红灯，
// 报轻了会让用户以为技能能用而其实不能（缺 description 就是后者：**静默丢弃**）。

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const KEBAB_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const RESERVED = ["claude", "anthropic"];
// 与内核的 MAX_NAME_LENGTH / MAX_DESCRIPTION_LENGTH 对齐
const MAX_NAME = 64;
const MAX_DESCRIPTION = 1024;
const MAX_BODY_WORDS = 5000;

const errors = [];
const warnings = [];

/**
 * 极简 frontmatter 解析：只取 `键: 值`，续行并入上一个键。
 *
 * 刻意不引 YAML 依赖：技能 frontmatter 是手写的极小子集，
 * 为它装一个解析器不值得，而且解析差异会让「校验通过」与「内核装载」
 * 对不上 —— 那是这个脚本最不该出的错。
 */
function parseFrontmatter(text) {
  if (!text.startsWith("---")) return null;
  const match = /^---\s*\n([\s\S]*?)\n---\s*\n?/.exec(text);
  if (match === null) return null;
  const fields = {};
  let currentKey = null;
  for (const line of match[1].split("\n")) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    if (line.startsWith(" ") || line.startsWith("\t")) {
      if (currentKey !== null) fields[currentKey] += ` ${line.trim()}`;
      continue;
    }
    const colon = line.indexOf(":");
    if (colon === -1) {
      warnings.push(`frontmatter 有一行没有键：${JSON.stringify(line)}`);
      continue;
    }
    currentKey = line.slice(0, colon).trim();
    fields[currentKey] = line
      .slice(colon + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
  }
  return { fields, body: text.slice(match[0].length) };
}

function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1) {
    console.log("用法：node validate_skill.mjs <技能文件夹路径>");
    return 2;
  }
  const skillDir = path.resolve(args[0]);
  if (!existsSync(skillDir) || !statSync(skillDir).isDirectory()) {
    console.log(`ERROR: 不是一个目录：${skillDir}`);
    return 2;
  }

  const folder = path.basename(skillDir);
  const entries = readdirSync(skillDir);

  if (!KEBAB_RE.test(folder)) {
    errors.push(`文件夹名 ${JSON.stringify(folder)} 不是 kebab-case（只能小写字母、数字、连字符）`);
  }

  // 大小写精确检查走 readdir：这样在大小写不敏感的文件系统上也有效
  if (!entries.includes("SKILL.md")) {
    const near = entries.find((entry) => entry.toLowerCase() === "skill.md");
    errors.push(
      near === undefined
        ? "缺少 SKILL.md"
        : `发现 ${JSON.stringify(near)} —— 必须正好叫 'SKILL.md'（大小写敏感）`,
    );
    return report();
  }

  if (entries.some((entry) => entry.toLowerCase() === "readme.md")) {
    errors.push("技能文件夹里不能放 README.md（文档写进 SKILL.md 或 references/）");
  }

  const text = readFileSync(path.join(skillDir, "SKILL.md"), "utf8");
  const parsed = parseFrontmatter(text);
  if (parsed === null) {
    errors.push("frontmatter 缺失或格式错误：SKILL.md 必须以 '---' 分隔的 YAML 开头");
    return report();
  }
  const { fields, body } = parsed;

  const fmBlock = text.split("---").length >= 3 ? text.split("---")[1] : "";
  if (fmBlock.includes("<") || fmBlock.includes(">")) {
    errors.push("frontmatter 里有尖括号（< >）—— 它会被注入系统提示，禁止出现");
  }

  const name = fields.name ?? "";
  if (name === "") {
    errors.push("frontmatter 缺少必填字段 'name'");
  } else {
    if (!KEBAB_RE.test(name)) errors.push(`name ${JSON.stringify(name)} 不是 kebab-case`);
    if (name !== folder) warnings.push(`name ${JSON.stringify(name)} 与文件夹名 ${JSON.stringify(folder)} 不一致`);
    if (RESERVED.some((word) => name.toLowerCase().includes(word))) {
      errors.push(`name ${JSON.stringify(name)} 含保留字（${RESERVED.join("/")}）`);
    }
    // 内核在 name 超长时只记 warning、仍然装载（name 也照用），所以这里是 warn
    if (name.length > MAX_NAME) {
      warnings.push(`name 是 ${name.length} 字符（建议上限 ${MAX_NAME}；内核只记 warning，仍会装载）`);
    }
  }

  const description = fields.description ?? "";
  if (description === "") {
    // 这是**唯一**会让内核静默丢弃整个技能的情况：文件还在，
    // 但模型完全看不到它，唯一线索是一行 `description is required` 的 warning
    errors.push("frontmatter 缺少必填字段 'description'（内核会静默丢弃整个技能，模型看不到它）");
  } else {
    if (description.length > MAX_DESCRIPTION) {
      // 超长**不会**丢弃技能（内核只记 warning 仍装载）—— 所以是 warn
      warnings.push(
        `description 是 ${description.length} 字符（建议上限 ${MAX_DESCRIPTION}；` +
          "内核只记 warning 仍会装载，但它每轮都占 token）",
      );
    }
    if (description.length < 40) {
      warnings.push(`description 很短（${description.length} 字符）—— 大概率太泛，触发不起来`);
    }
    // 中英两套「什么时候用」的线索都要认：内置技能是中文的，
    // 只查 "use when" 会让每一条中文 description 都误报
    const lowered = description.toLowerCase();
    const cues = [
      "use when",
      "use this",
      "use for",
      "trigger",
      "use it when",
      "使用时",
      "什么时候用",
      "用在",
      "当用户",
      "当你",
      "适用于",
    ];
    if (!cues.some((cue) => lowered.includes(cue))) {
      warnings.push("description 里看不出「什么时候用」的线索（例如 '当用户…时使用'）—— 补上触发条件");
    }
  }

  // 只有这三个键会被内核解析，其余写了也不生效
  const KNOWN_KEYS = new Set(["name", "description", "disable-model-invocation"]);
  const unknown = Object.keys(fields).filter((key) => !KNOWN_KEYS.has(key));
  if (unknown.length > 0) {
    warnings.push(`这些 frontmatter 字段 Oint 不会解析（写了也不生效，仅作文档）：${unknown.join(", ")}`);
  }

  const wordCount = body.split(/\s+/).filter((word) => word !== "").length;
  if (wordCount > MAX_BODY_WORDS) {
    warnings.push(`SKILL.md 正文 ${wordCount} 词（建议上限 ${MAX_BODY_WORDS}）—— 把细节挪进 references/`);
  }

  // 引用完整性：SKILL.md 提到的附属文件必须真的存在
  for (const match of body.matchAll(/(?:scripts|references|assets)\/[\w./-]*\w/g)) {
    const rel = match[0];
    if (!existsSync(path.join(skillDir, rel))) {
      warnings.push(`SKILL.md 引用了 ${JSON.stringify(rel)}，但技能文件夹里没有这个文件`);
    }
  }

  return report();
}

function report() {
  for (const msg of errors) console.log(`ERROR: ${msg}`);
  for (const msg of warnings) console.log(`WARNING: ${msg}`);
  console.log(`${errors.length > 0 ? "FAIL" : "PASS"}: ${errors.length} error(s), ${warnings.length} warning(s)`);
  return errors.length > 0 ? 1 : 0;
}

process.exit(main());
