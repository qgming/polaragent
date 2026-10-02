// 会话附件库与信封编解码的单测。
//
// 这一层值得单独钉住的理由：**附件是唯一一条「渲染层的字节 → 磁盘 → 模型上下文 → 再还原
// 成界面卡片」的往返链路**。链路上每一段都是纯数据变换，而错了不会报错：
//   · 信封编不出/解不出 → 刷新之后附件卡片变成一段怪文本；
//   · 内容寻址写错 → 同一张图每发一次就多存一份，会话目录越滚越大；
//   · 交错顺序错了 → 视频的帧配到别的附件上，模型看到的是「另一个文件的图」。

import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatAttachment } from "@/shared/contracts/attachment";
import {
  buildAttachmentEnvelope,
  buildUserContent,
  completeFromBytes,
  framesForModel,
  isAttachmentEnvelope,
  MAX_INLINE_TEXT_LINES,
  parseAttachmentEnvelope,
  removeSessionAttachments,
  sessionAttachmentsDir,
  storeAttachment,
  storeAttachmentBytes,
  truncateText,
} from "./attachments";

/** 1×1 PNG：能被魔数嗅探认出来的最小样本 */
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64",
);

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "oint-attachments-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("信封编解码", () => {
  const stored = { path: "D:\\proj\\.oint\\attachments\\s1\\abc123.png", bytes: 68 };

  it("图片信封：往返一致", () => {
    const attachment: ChatAttachment = {
      kind: "image",
      name: "shot.png",
      mimeType: "image/png",
      size: 68,
      images: [{ mimeType: "image/png", data: "AAAA" }],
      width: 1280,
      height: 720,
      downscaled: true,
    };
    const text = buildAttachmentEnvelope(1, stored, attachment);
    const parsed = parseAttachmentEnvelope(text);
    expect(parsed).toEqual({
      index: 1,
      kind: "image",
      name: "shot.png",
      mimeType: "image/png",
      bytes: 68,
      path: stored.path,
      frames: 1,
      width: 1280,
      height: 720,
      downscaled: true,
    });
  });

  it("视频信封：帧数与抽帧时间点都带上", () => {
    const attachment: ChatAttachment = {
      kind: "video",
      name: "demo.mp4",
      mimeType: "video/mp4",
      size: 1024,
      images: [
        { mimeType: "image/jpeg", data: "a" },
        { mimeType: "image/jpeg", data: "b" },
        { mimeType: "image/jpeg", data: "c" },
      ],
      frameTimes: [1.03, 3.1, 5.17],
      durationSeconds: 6.2,
      width: 1920,
      height: 1080,
    };
    const parsed = parseAttachmentEnvelope(buildAttachmentEnvelope(2, stored, attachment));
    expect(parsed?.frames).toBe(3);
    expect(parsed?.frameTimes).toEqual([1.03, 3.1, 5.17]);
    expect(parsed?.durationSeconds).toBe(6.2);
    expect(parsed?.width).toBe(1920);
    expect(parsed?.height).toBe(1080);
  });

  it("文本信封：正文与行数，截断时带 truncated", () => {
    const attachment: ChatAttachment = {
      kind: "text",
      name: "notes.md",
      mimeType: "text/markdown",
      size: 20,
      text: "第一行\n第二行",
    };
    const text = buildAttachmentEnvelope(3, stored, attachment);
    expect(text).toContain("第一行\n第二行");
    expect(parseAttachmentEnvelope(text)?.totalLines).toBe(2);
    expect(parseAttachmentEnvelope(text)?.textTruncated).toBeUndefined();
  });

  it("二进制信封：帧数为 0，正文段是「内容没有内联，按路径用工具读」", () => {
    const attachment: ChatAttachment = {
      kind: "file",
      name: "report.pdf",
      mimeType: "application/pdf",
      size: 4096,
    };
    const text = buildAttachmentEnvelope(4, stored, attachment);
    expect(parseAttachmentEnvelope(text)?.frames).toBe(0);
    expect(parseAttachmentEnvelope(text)?.kind).toBe("file");
    expect(text).toContain("not inlined");
    expect(text).toContain("path above is readable");
  });

  it("属性值里的引号、反斜杠与换行都被转义，解析后原样回来", () => {
    const attachment: ChatAttachment = {
      kind: "text",
      name: 'a "quoted" <name>\nwith newline.md',
      mimeType: "text/markdown",
      size: 1,
      text: "x",
    };
    const text = buildAttachmentEnvelope(5, stored, attachment);
    // 标签必须只占一行：换行被转义成实体，否则解析端切不出属性区
    expect(text.split("\n")[0]).toContain("&quot;quoted&quot;");
    expect(text.split("\n")[0]).toContain("&#10;");
    expect(parseAttachmentEnvelope(text)?.name).toBe('a "quoted" <name>\nwith newline.md');
  });

  it("不是信封的文本一律返回 null（旧会话里的普通消息必须照常显示）", () => {
    expect(parseAttachmentEnvelope("你好")).toBeNull();
    expect(parseAttachmentEnvelope("<attachment 缺少属性 />")).toBeNull();
    expect(parseAttachmentEnvelope("<attachment kind='image' />")).toBeNull();
    expect(parseAttachmentEnvelope('<attachment index="1" kind="video" />')).toBeNull();
    expect(
      parseAttachmentEnvelope(
        '<attachment index="1" kind="weird" name="a" mime="x" bytes="1" path="p" />',
      ),
    ).toBeNull();
    expect(isAttachmentEnvelope('<attachment index="1" />')).toBe(true);
  });
});

describe("文本截断", () => {
  it("行数超限时截断并给出总行数", () => {
    const text = Array.from({ length: MAX_INLINE_TEXT_LINES + 50 }, (_, i) => `line ${i}`).join(
      "\n",
    );
    const result = truncateText(text);
    expect(result.truncated).toBe(true);
    expect(result.totalLines).toBe(MAX_INLINE_TEXT_LINES + 50);
    expect(result.text.split("\n")).toHaveLength(MAX_INLINE_TEXT_LINES);
  });

  it("不超限时原样返回", () => {
    const result = truncateText("a\nb\nc");
    expect(result).toEqual({ text: "a\nb\nc", truncated: false, totalLines: 3 });
  });
});

describe("会话附件目录", () => {
  it("会话 id 里的分隔符与 .. 进不了路径", () => {
    const target = sessionAttachmentsDir("../../evil", dir);
    expect(path.dirname(path.dirname(target))).toBe(dir);
    expect(target.startsWith(path.join(dir, "attachments"))).toBe(true);
  });

  it("内容寻址：同一份字节重复写只留一个文件", async () => {
    const attachment: ChatAttachment = {
      kind: "image",
      name: "shot.png",
      mimeType: "image/png",
      size: PNG_BYTES.byteLength,
    };
    const first = await storeAttachmentBytes("s1", attachment, PNG_BYTES, dir);
    const second = await storeAttachmentBytes("s1", attachment, PNG_BYTES, dir);
    expect(second.path).toBe(first.path);
    const files = await readdir(sessionAttachmentsDir("s1", dir));
    expect(files).toHaveLength(1);
    // 路径是「摘要 + 原扩展名」，原文件名不进路径（它可能带空格、中文、重名）
    expect(files[0]).toMatch(/^[0-9a-f]{40}\.png$/);
  });

  it("从真实路径读字节落盘（渲染层不必先把文件 base64 一遍）", async () => {
    const source = path.join(dir, "src.png");
    await writeFile(source, PNG_BYTES);
    const attachment: ChatAttachment = {
      kind: "image",
      name: "src.png",
      mimeType: "image/png",
      size: PNG_BYTES.byteLength,
      path: source,
    };
    const stored = await storeAttachment("s1", attachment, dir);
    expect(stored.bytes).toBe(PNG_BYTES.byteLength);
    expect(await readFile(stored.path)).toEqual(PNG_BYTES);
  });

  it("空文件与既无路径又无内容的附件都被拒绝", async () => {
    const empty: ChatAttachment = { kind: "file", name: "e.bin", mimeType: "", size: 0 };
    await expect(storeAttachmentBytes("s1", empty, Buffer.alloc(0), dir)).rejects.toThrow(/空文件/);
    await expect(storeAttachment("s1", empty, dir)).rejects.toThrow(/没有路径也没有内容/);
  });

  it("删会话时整个附件目录被清掉", async () => {
    await storeAttachmentBytes(
      "s1",
      { kind: "image", name: "a.png", mimeType: "image/png", size: PNG_BYTES.byteLength },
      PNG_BYTES,
      dir,
    );
    await removeSessionAttachments("s1", dir);
    await expect(readdir(sessionAttachmentsDir("s1", dir))).rejects.toThrow();
  });
});

describe("buildUserContent：信封与它自己的图交错", () => {
  it("文本块在前，每条附件的图紧跟它自己的信封", async () => {
    const content = await buildUserContent(
      "s1",
      "看这两张图",
      [
        {
          kind: "image",
          name: "a.png",
          mimeType: "image/png",
          size: PNG_BYTES.byteLength,
          data: PNG_BYTES.toString("base64"),
        },
        {
          kind: "text",
          name: "b.md",
          mimeType: "text/markdown",
          size: 3,
          text: "hi",
          // 文本附件同样要落盘：模型能按路径再读，界面也能点开
          data: Buffer.from("hi\n", "utf8").toString("base64"),
        },
      ],
      dir,
    );

    // 用户文本 → 信封1 → 图1 → 信封2（文本附件没有图）
    expect(content).toHaveLength(4);
    expect(content[0]).toEqual({ type: "text", text: "看这两张图" });
    expect(parseAttachmentEnvelope((content[1] as { text: string }).text)?.name).toBe("a.png");
    expect(content[2]?.type).toBe("image");
    expect(parseAttachmentEnvelope((content[3] as { text: string }).text)?.name).toBe("b.md");
    // 落盘的路径是真的：模型拿到的路径必须能读
    const parsed = parseAttachmentEnvelope((content[1] as { text: string }).text);
    expect(await readFile(parsed?.path ?? "")).toEqual(PNG_BYTES);
  });

  it("什么都没有时给一个空文本块（交给内核按 empty 拒收，而不是造一个空请求体）", async () => {
    expect(await buildUserContent("s1", "", [], dir)).toEqual([{ type: "text", text: "" }]);
  });

  it("重新生成：只有路径、没有帧时，图片从磁盘补回来", async () => {
    const content = await buildUserContent(
      "s1",
      "",
      [
        {
          kind: "image",
          name: "a.png",
          mimeType: "image/png",
          size: PNG_BYTES.byteLength,
          data: PNG_BYTES.toString("base64"),
        },
      ],
      dir,
    );
    const storedPath = parseAttachmentEnvelope((content[0] as { text: string }).text)?.path ?? "";
    // 第二次发送只带路径（渲染层手里没有字节了）
    const resent = await buildUserContent(
      "s1",
      "",
      [
        {
          kind: "image",
          name: "a.png",
          mimeType: "image/png",
          size: PNG_BYTES.byteLength,
          path: storedPath,
        },
      ],
      dir,
    );
    expect(resent[1]).toEqual({
      type: "image",
      mimeType: "image/png",
      data: PNG_BYTES.toString("base64"),
    });
  });

  it("视频缺帧时信封如实说明「这次没有抽帧」", async () => {
    const content = await buildUserContent(
      "s1",
      "",
      [
        {
          kind: "video",
          name: "v.mp4",
          mimeType: "video/mp4",
          size: 10,
          data: Buffer.from("not-a-video").toString("base64"),
          durationSeconds: 12.5,
        },
      ],
      dir,
    );
    const envelope = (content[0] as { text: string }).text;
    expect(parseAttachmentEnvelope(envelope)?.frames).toBe(0);
    expect(envelope).toContain("could not be sampled into frames");
  });
});

describe("completeFromBytes", () => {
  it("图片缺 images 时按魔数补出正确的 mimeType", () => {
    const completed = completeFromBytes(
      { kind: "image", name: "a.png", mimeType: "", size: 0 },
      PNG_BYTES,
    );
    expect(completed.images).toEqual([
      { mimeType: "image/png", data: PNG_BYTES.toString("base64") },
    ]);
  });

  it("文本缺正文时按 UTF-8 读出来", () => {
    const completed = completeFromBytes(
      { kind: "text", name: "a.md", mimeType: "text/markdown", size: 0 },
      Buffer.from("中文内容", "utf8"),
    );
    expect(completed.text).toBe("中文内容");
  });

  it("已有的内容不被覆盖（渲染层抽的帧优先）", () => {
    const attachment: ChatAttachment = {
      kind: "video",
      name: "v.mp4",
      mimeType: "video/mp4",
      size: 1,
      images: [{ mimeType: "image/jpeg", data: "frame" }],
    };
    expect(completeFromBytes(attachment, PNG_BYTES)).toBe(attachment);
  });
});

describe("framesForModel", () => {
  it("抽帧数超过上限时只保留前 N 帧（信封报的也是这个数）", () => {
    const frames = Array.from({ length: 30 }, () => ({ mimeType: "image/jpeg", data: "x" }));
    expect(
      framesForModel({ kind: "video", name: "v", mimeType: "video/mp4", size: 1, images: frames }),
    ).toHaveLength(12);
  });
});
