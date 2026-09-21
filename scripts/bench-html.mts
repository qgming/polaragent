// HTML→文本转换的性能基准，用于守住「病态输入不会卡住主线程」这条不变式。
//
// 用法：npx tsx scripts/bench-html.mts
//
// 为什么不放进 npm test：它是**时间敏感**的测量（机器负载会影响读数），
// 而单测里的时间断言只用于挡住数量级的退化（见 html.test.ts 的配平守卫一节）。
// 改 html.ts 的守卫阈值或正则时，跑一次这个脚本看读数。
import { extractPageText, MAX_INPUT_CHARS, MAX_TAG_COUNT } from "../src/main/web/html";

const cases: [string, string][] = [
  ["正常页面（1000 个段落）", `<body>${"<p>段落内容</p>".repeat(1000)}</body>`],
  ["大量短标签（200k 个 <i>）", `<body>${"<i></i>".repeat(100_000)}<p>正文</p></body>`],
  ["未闭合 script 洪水", `<body>${"<script>".repeat(20_000)}<p>正文</p></body>`],
  ["未闭合注释洪水", `<body>${"<!--".repeat(50_000)}<p>正文</p></body>`],
  ["深嵌套 div（5 万层）", `<body>${"<div>".repeat(50_000)}文本${"</div>".repeat(50_000)}</body>`],
  ["纯文本 2M 字符（无标签）", `<body><p>${"字".repeat(MAX_INPUT_CHARS)}</p></body>`],
  ["超长单行", `<body><p>${"a".repeat(MAX_INPUT_CHARS)}</p></body>`],
];

console.log(`MAX_INPUT_CHARS=${MAX_INPUT_CHARS}  MAX_TAG_COUNT=${MAX_TAG_COUNT}\n`);
let slow = 0;
for (const [name, html] of cases) {
  const started = performance.now();
  const result = extractPageText(html, 1000);
  const elapsed = Math.round(performance.now() - started);
  // 500ms 是「用户能感觉到的卡顿」量级；超过就说明守卫漏了某类输入
  const flagged = elapsed > 500;
  if (flagged) slow += 1;
  console.log(
    `${String(elapsed).padStart(6)}ms  ${name.padEnd(34)} 出参 ${String(result.content.length).padStart(6)} 字符${flagged ? "  <-- 慢" : ""}`,
  );
}
console.log(slow === 0 ? "\n无慢用例" : `\n${slow} 个用例超过 500ms —— 检查守卫`);
process.exit(slow === 0 ? 0 : 1);
