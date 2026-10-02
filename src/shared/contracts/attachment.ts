// 用户附件的契约：渲染层采集 → 主进程落盘 → 组装成模型能看的内容块。
//
// ## 为什么要有这一层
//
// assistant-ui 把附件放在 `AppendMessage.attachments`（与 `content` 分开），而 pi 只认
// `TextContent | ImageContent` 两种内容块。两边都表达不了「视频」「文本文件」「PDF」这些
// 用户真正会拖进来的东西。于是中间需要一份**与两个框架都无关**的附件契约：
// 渲染层负责把 File 变成「模型能消费的形态」（图片内联、视频抽帧、文本读出正文），
// 主进程负责落盘并把它们拼成 pi 的消息内容。
//
// ## 为什么图片与视频都要落盘
//
// 模型侧只需要字节，但**界面与后续轮次需要路径**：
//   · 用户回头看这条消息时要能点开原图（抽帧只是给模型看的，原图得在盘上）；
//   · 模型下一轮想「再看一眼这张图」时要能用 `read_image` 按路径重读；
//   · 视频、PDF 这类 pi 没有内容块的类型，只能靠路径 + 工具读。
// 所以每个附件一律落盘到会话附件目录，路径随信封一起进消息。

/** 附件的类别：决定它怎么进模型（内联字节 / 抽帧 / 内联正文 / 只给路径） */
export type ChatAttachmentKind =
  /** 图片：本体作为 image 内容块内联（模型必须真的看到） */
  | "image"
  /** 视频：按时间均匀抽帧，帧作为 image 内容块内联，本体落盘 */
  | "video"
  /** 文本/代码：正文内联进消息（有上限，超限截断），本体落盘 */
  | "text"
  /** 其余二进制（PDF / 音频 / 压缩包…）：只给路径，由模型自己挑工具读 */
  | "file";

/**
 * 单条附件的字节上限（64 MiB）。
 *
 * 两侧共用同一个数：渲染层用它挡「拿不到路径又没有上限」的场合（那种情况把整个文件
 * 读进渲染进程只会把它拖垮），主进程用它挡落盘。两个数不一致的话，界面会先接受、
 * 再在发送时失败 —— 而失败发生在用户已经看不见附件列表的那一刻。
 */
export const MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024;

/** 模型直接看的图（图片本体，或视频抽帧）；`data` 是裸 base64，与 pi 的 ImageContent 一致 */
export interface ChatAttachmentImage {
  mimeType: string;
  data: string;
}

/**
 * 一条附件的完整描述（渲染层 → 主进程）。
 *
 * 字节来源二选一：
 * - `path`：拖拽 / 文件选择器给的**真实磁盘路径**（Electron 的 `webUtils.getPathForFile`）。
 *   主进程自己读盘 —— 一个 200 MB 的视频不必先 base64 一遍再走 IPC。
 * - `data`：裸 base64。剪贴板粘贴的图、以及拿不到路径的场合走这条。
 *
 * `path` 与 `data` 都缺的附件会被主进程拒绝：没有字节就没有可落盘的东西。
 */
export interface ChatAttachment {
  kind: ChatAttachmentKind;
  /** 原始文件名（含扩展名）；落盘时用来定扩展名，也作为给模型的显示名 */
  name: string;
  /** 浏览器给出的 MIME；可能为空串（拖拽的未知类型），主进程会按扩展名/魔数补 */
  mimeType: string;
  /** 字节数（渲染层从 File.size 得到；走 data 时以实际长度为准） */
  size: number;
  /** 真实磁盘路径（可读来源之一） */
  path?: string;
  /** 裸 base64 字节（可读来源之一） */
  data?: string;
  /**
   * 模型要看的图：
   * - `image`：本体（超限时是渲染层降采样后的版本）
   * - `video`：抽帧，按时间升序
   * - 其余类别为空
   */
  images?: ChatAttachmentImage[];
  /** 抽帧对应的时间点（秒），与 `images` 一一对应 */
  frameTimes?: number[];
  /** 视频/音频时长（秒） */
  durationSeconds?: number;
  /** 像素尺寸（图片本体或视频画面） */
  width?: number;
  height?: number;
  /** 渲染层已读出的文本正文（`kind === "text"` 时）；主进程不再读盘 */
  text?: string;
  /** 正文因超限被截断 */
  textTruncated?: boolean;
  /** 原始行数（文本文件；用于截断提示） */
  totalLines?: number;
  /** 渲染层把图片降采样过（信封里要如实说明，免得模型以为看到的是原图） */
  downscaled?: boolean;
}

/**
 * 用户消息里的一条附件（主进程 → 渲染层的消息 part）。
 *
 * 与 `ChatAttachment` 的分工：这是**展示态**，只带界面要画的东西。原始文件字节不在里面
 * （模型要的原文件由主进程按 `path` 自己读），但**模型看到的那些图留着**：
 *   · 界面要拿第一帧当缩略图；
 *   · 「重新生成 / 编辑重发」要能把这次请求原样再发一遍 —— 视频帧在主进程里是抽不出来的
 *     （没有解码器），只能从这份里带回去。
 */
export interface AttachmentPart {
  type: "attachment";
  /** 同一条消息内的序号（从 1 开始），与给模型的信封一一对应 */
  index: number;
  kind: ChatAttachmentKind;
  name: string;
  mimeType: string;
  size: number;
  /** 落盘后的绝对路径；模型可以用 read / read_image 再读它 */
  path?: string;
  /**
   * 模型实际看到的图（图片本体 / 视频抽帧），与信封里的 `frames` 一一对应。
   * 界面用 `frames[0]` 当缩略图；`file` 类没有。
   */
  frames?: { mimeType: string; dataUrl: string }[];
  /** 视频/音频时长（秒） */
  durationSeconds?: number;
  width?: number;
  height?: number;
  /** 视频抽帧数量 */
  frameCount?: number;
  /** 文本文件的行数 */
  totalLines?: number;
  /** 文本正文被截断（模型只看到前面一段） */
  textTruncated?: boolean;
  /** 图片被降采样后才发给模型 */
  downscaled?: boolean;
}
