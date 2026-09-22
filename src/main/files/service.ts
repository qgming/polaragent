// 右侧面板「文件」的主进程实现：列一层目录、读一个文件。
//
// **安全边界在 root 的来源上**：root 由 ipc/files.ts 从**会话索引**里解析出来
//（会话绑定的工作目录），渲染层只能给 sessionId、给不了路径。本文件收到的 root
// 因此是可信的，只负责「requested 落在 root 内」这一层判断。
//
// 这里刻意**不再**对 root 自身做 validatePathAccess：那种写法的典型形态是
// `validatePathAccess(root, [root])`，而「路径在它自己内部」恒为真 —— 它看起来像一道
// 校验，实际永远通过。真正的边界必须是「root 从哪来」，而不是「root 是不是等于自己」。
//
// 一处**已知且刻意保留**的边界：validatePathAccess 是纯路径判断，不做 realpath 解析，
// 所以 root 内一个指向外部的符号链接被点开时，内容会被列出来（实测确认）。
// 这与模型侧的文件工具完全一致 —— exec-env 用的是同一个 validatePathAccess，
// 也没有 realpath（全仓只有 search 工具做了 realpath 复检）。要收紧应当同时改两处
// 并对「链接是否算越界」做一次产品决定，而不是在这里单独加一层（那会让面板与模型
// 看到的世界不一致）。

import { open, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { imageDimensions, sniffMediaType } from "@/main/pisdk/tools/image-meta";
import { normalizePath, validatePathAccess } from "@/main/security/path-guard";
import type {
  DirectoryListing,
  FileContent,
  FileTreeEntry,
  ImageContent,
} from "@/shared/contracts/files";

/** 单次列目录返回的最大条目数：node_modules 那种几万条的子目录不该把 IPC 打爆 */
const MAX_ENTRIES = 2000;
/** 单次读文件的最大字节数：预览用，够看几千行代码；更大的一律截断并提示 */
const MAX_FILE_BYTES = 512 * 1024;
/**
 * 单张图片预览的字节上限（32 MiB）。
 *
 * 比 read_image 工具那条（16 MiB）宽：那边要过 IPC 落进 part，这边只在用户展开详情时
 * 走一次、且不进会话库。但仍然要有上限 —— dataUrl 是 base64（比原字节大 1/3），
 * 而它是**同步**在渲染进程里解码的一张位图。
 */
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
/**
 * 判定「看起来是二进制」的字节数上限。
 * 只嗅探开头这一小段：真正的二进制文件（图片、可执行文件）在前几百字节里就会出现 NUL，
 * 而全部读一遍既慢又没必要。
 */
const SNIFF_BYTES = 4096;

/** 目录项排序：目录在前、同类按名字（与各家文件管理器一致，扫一眼就能找到目标） */
function compareEntries(a: FileTreeEntry, b: FileTreeEntry): number {
  if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
}

/**
 * 列一层目录。
 *
 * root 由调用方（IPC 层）从会话索引解析后传入，本函数不再校验它的「合法性」——
 * 只保证 requested 落在 root 内。
 *
 * 用 withFileTypes 一次拿到类型，避免对每个条目再来一次 stat：
 * 一个几百条的目录会因此少几百次系统调用。符号链接要额外 lstat 才知道指向什么，
 * 所以只对链接项做一次（且失败不致命 —— 断链的 symlink 照样列出来）。
 */
export async function listDirectory(request: {
  root: string;
  path?: string;
}): Promise<DirectoryListing> {
  const root = normalizePath(request.root);

  const targetCheck = validatePathAccess(request.path ?? root, [root]);
  if (!targetCheck.ok) throw new Error(targetCheck.reason);
  const target = targetCheck.resolved;

  const dirents = await readdir(target, { withFileTypes: true });

  const entries: FileTreeEntry[] = [];
  for (const dirent of dirents.slice(0, MAX_ENTRIES)) {
    const full = path.join(target, dirent.name);
    const entry: FileTreeEntry = {
      path: normalizePath(full),
      name: dirent.name,
      kind: dirent.isDirectory() ? "directory" : "file",
      symlink: dirent.isSymbolicLink(),
    };

    if (entry.kind === "file") {
      // 文件才补 size / mtime：目录的大小没有意义，而且 stat 每个目录会明显变慢
      const info = await stat(full).catch(() => null);
      if (info !== null) {
        entry.size = info.size;
        entry.mtime = info.mtimeMs;
        // 链接指向目录时按目录显示，否则点进去会报「不是目录」
        if (info.isDirectory()) entry.kind = "directory";
      }
    }

    entries.push(entry);
  }

  entries.sort(compareEntries);

  // 上一级：到 root 就为止（面板据此禁用「返回上级」），不允许从面板往 root 上面走
  const parentPath = path.dirname(target);
  const parent =
    target === root || parentPath === target
      ? null
      : validatePathAccess(parentPath, [root]).ok
        ? normalizePath(parentPath)
        : null;

  return {
    path: target,
    root,
    parent,
    entries,
    truncated: dirents.length > MAX_ENTRIES,
  };
}

/**
 * 读一个文件用于等宽预览。
 *
 * root 的来源与 listDirectory 相同（IPC 层从会话索引解析）。
 *
 * 二进制嗅探：含 NUL 字节就判定为二进制，返回空 text + binary 标记，
 * 让面板显示「这是二进制文件」而不是把乱码糊满屏幕。
 * 用 open + read 而不是 readFile 全文：大文件只读前面一段，不做无谓的磁盘读取。
 */
export async function readFileContent(request: {
  root: string;
  path: string;
}): Promise<FileContent> {
  const check = validatePathAccess(request.path, [normalizePath(request.root)]);
  if (!check.ok) throw new Error(check.reason);
  const target = check.resolved;

  const info = await stat(target);
  if (info.isDirectory()) throw new Error("这是一个目录，不能作为文件预览");

  const size = info.size;
  // 只读到上限为止：预览不需要全文，而 200 MB 的日志文件全文读进来会直接顶爆主进程
  const wantBytes = Math.min(size, MAX_FILE_BYTES);
  const buffer = Buffer.alloc(wantBytes);

  let handle: Awaited<ReturnType<typeof open>> | null = null;
  let readBytes = 0;
  try {
    handle = await open(target, "r");
    let offset = 0;
    // read 可能短读，循环到填满或读到 EOF
    while (offset < wantBytes) {
      const { bytesRead } = await handle.read(buffer, offset, wantBytes - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    readBytes = offset;
  } finally {
    await handle?.close().catch(() => undefined);
  }

  const content = buffer.subarray(0, readBytes);
  // NUL 字节是二进制最可靠的信号（UTF-16 文本也会有大量 NUL，一并按二进制处理：
  // 面板是 UTF-8 预览，显示 UTF-16 只会是乱码）
  const binary = content.subarray(0, Math.min(SNIFF_BYTES, readBytes)).includes(0);
  const truncated = size > MAX_FILE_BYTES;

  if (binary) {
    return { path: target, text: "", truncated, size, binary: true };
  }

  return { path: target, text: content.toString("utf8"), truncated, size, binary: false };
}

/**
 * 读一张图片用于界面显示（返回可直接塞进 `<img src>` 的 dataUrl）。
 *
 * root 的来源与另外两个函数相同（IPC 层从会话索引解析），并且同样先过路径守卫 ——
 * 这是**唯一**能让渲染层拿到图片字节的通道，所以守卫必须在这里，而不是指望调用方。
 *
 * 与 readFileContent 的分工：那个把字节当 UTF-8 文本解（图片会命中它的二进制分支、
 * 只回一句「这是二进制」）；这个把字节当图片（判格式、读尺寸、编 dataUrl）。
 *
 * 格式按**内容**判定（扩展名可能是错的），尺寸读不出来时不编：
 * 界面宁可少显示一行读数，也不要一个错的 width 被模型拿去算坐标。
 */
export async function readImageContent(request: {
  root: string;
  path: string;
}): Promise<ImageContent> {
  const check = validatePathAccess(request.path, [normalizePath(request.root)]);
  if (!check.ok) throw new Error(check.reason);
  const target = check.resolved;

  const info = await stat(target);
  if (info.isDirectory()) throw new Error("这是一个目录，不是图片文件");
  if (info.size === 0) throw new Error("这个文件是空的");
  if (info.size > MAX_IMAGE_BYTES) {
    throw new Error(`图片有 ${info.size} 字节，超过 ${MAX_IMAGE_BYTES} 字节的上限，无法预览`);
  }

  const bytes = await readFile(target);
  const data = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const mediaType = sniffMediaType(data);
  if (mediaType === undefined) {
    throw new Error("这个文件的内容不是 PNG / JPEG / WebP / GIF 图片");
  }

  const dimensions = imageDimensions(data, mediaType);
  return {
    path: target,
    mediaType,
    bytes: info.size,
    ...(dimensions === undefined ? {} : { width: dimensions.width, height: dimensions.height }),
    dataUrl: `data:${mediaType};base64,${bytes.toString("base64")}`,
  };
}
