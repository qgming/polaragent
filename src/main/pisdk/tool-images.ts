// 工具结果里的 image 内容块 → 渲染层要显示的图片本体（契约见 shared/contracts/session.ts 的 ToolPartImage）。
//
// 为什么需要这一层收口：**只有一部分工具的图该随 part 走**，两个理由都成立、方向相反 ——
//   · `browser_screenshot` 必须带：它的图只存在于这一次结果里。结果文本（视口尺寸那几行读数）
//     盖住了 content 里的 image 块，而截图没有任何可回读的路径（不像 read_image 有 path），
//     界面除了随 part 拿到它，别无办法。历史回读时从 pi 的 toolResult 条目里重新取出。
//   · `read_image` 刻意不带：它给的是 path，界面展开时用 `files.readImage` 现取一次
//     （见 tools/read-image.ts 的文件头）—— 几 MB 的 base64 不该常驻在渲染层的会话状态里。
//
// 判断放在一处、由**工具名**驱动，而不是让两条调用链（流式的 applyToolEnd 与历史回读的
// applyToolResult）各自决定：那种写法迟早会让「同一个工具在两条路径上给出不同形状的 part」，
// 而两边的差异只会在「刷新窗口之后图片不见了」这类时刻才被发现。

import { BROWSER_TOOL_NAMES } from "@/shared/contracts/browser";
import type { ToolPartImage } from "@/shared/contracts/session";

/**
 * 结果里的图片要进界面的工具。
 *
 * 新工具要加进来之前先问一句「它的图有没有可回读的路径」：有（像 read_image 那样给 path）
 * 就走按需读取，没有才加到这里 —— 这个集合每多一个成员，会话内存里就多一份 base64。
 */
const INLINE_IMAGE_TOOLS: readonly string[] = [BROWSER_TOOL_NAMES.screenshot];

/**
 * 随 part 走的图片总量上限（base64 字符数，约 12 MB）。
 *
 * 存在的理由：这份数据要过一次 IPC 结构化克隆、并常驻渲染层内存。截图正常在几百 KB，
 * 但一个满是照片的页面能出几 MB 的 PNG —— 超过上限时**放弃这张图**（界面只显示读数），
 * 而不是把一条消息撑到几十 MB。宁可少一张预览，也不要让整个会话界面卡住。
 */
const MAX_INLINE_BASE64_CHARS = 12 * 1024 * 1024;

/**
 * 取该工具结果里要显示给界面的图片。
 *
 * `content` 收 `unknown[]` 而不是 pi 的 `ImageContent[]`：调用方给的是**工具结果的
 * 内容块数组**（文本块与图片块混在一起，历史回读那条路过来的更是纯粹的 JSON），
 * 声明成图片数组只会让调用方多一次没有意义的断言。形状在这里现验 ——
 * 与渲染层验 details 是同一条纪律：从外部来的数据一律是 unknown。
 *
 * 不是「该带的工具」或一张图都没有时返回 undefined（而不是空数组）：
 * part 上多一个 `images: []` 会让「有没有图」这件事在渲染层多一种需要判断的情况。
 */
export function toolPartImages(
  toolName: string,
  content: readonly unknown[] | undefined,
): ToolPartImage[] | undefined {
  if (!INLINE_IMAGE_TOOLS.includes(toolName)) return undefined;
  if (!Array.isArray(content) || content.length === 0) return undefined;

  const images: ToolPartImage[] = [];
  let totalChars = 0;
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const candidate = block as { type?: unknown; data?: unknown; mimeType?: unknown };
    if (candidate.type !== "image") continue;
    const data = typeof candidate.data === "string" ? candidate.data : "";
    const mimeType = typeof candidate.mimeType === "string" ? candidate.mimeType : "";
    // 缺 data 或 mimeType 的块没法渲染（dataUrl 拼不出来）：跳过而不是编一个类型，
    // 编出来的类型会让 <img> 静默失败，而失败原因看起来像「图片坏了」。
    if (data === "" || mimeType === "") continue;
    totalChars += data.length;
    if (totalChars > MAX_INLINE_BASE64_CHARS) {
      console.warn(
        `工具 ${toolName} 的结果图片超过 ${Math.round(MAX_INLINE_BASE64_CHARS / 1024 / 1024)}MB，` +
          "本次不随 part 下发（界面只显示读数）",
      );
      return undefined;
    }
    images.push({ mimeType, dataUrl: `data:${mimeType};base64,${data}` });
  }
  return images.length === 0 ? undefined : images;
}
