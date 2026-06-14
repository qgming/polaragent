// 文档读取工具 —— 使用 mammoth 和 pdfjs-dist 提取 docx 和 pdf 的文本内容
import mammoth from "mammoth";
import * as pdfjsLib from "pdfjs-dist";
import { readBase64File } from "@/lib/electron/electron-api";

// 配置 PDF.js worker（使用本地打包的 worker，避免 CDN 依赖）
if (typeof window !== "undefined") {
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/build/pdf.worker.min.mjs",
    import.meta.url,
  ).toString();
}

/**
 * 读取 DOCX 文件并提取纯文本内容
 * @param path 文件绝对路径
 * @returns 提取的文本内容
 */
async function readDocx(path: string): Promise<string> {
  try {
    // 读取文件为 base64
    const base64 = await readBase64File(path);

    // 将 base64 转为 ArrayBuffer
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    // 使用 mammoth 提取文本
    const result = await mammoth.extractRawText({ arrayBuffer: bytes.buffer });

    if (result.messages.length > 0) {
      console.warn("DOCX 解析警告:", result.messages);
    }

    return result.value || "";
  } catch (error) {
    console.error("读取 DOCX 文件失败:", error);
    throw new Error(`无法读取 DOCX 文件: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * 读取 PDF 文件并提取纯文本内容
 * @param path 文件绝对路径
 * @returns 提取的文本内容
 */
async function readPdf(path: string): Promise<string> {
  try {
    // 读取文件为 base64
    const base64 = await readBase64File(path);

    // 将 base64 转为 Uint8Array
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    // 加载 PDF 文档
    const loadingTask = pdfjsLib.getDocument({ data: bytes });
    const pdf = await loadingTask.promise;

    const textParts: string[] = [];

    // 遍历所有页面提取文本
    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const textContent = await page.getTextContent();

      // 将文本项拼接成字符串
      const pageText = textContent.items
        .map((item) => {
          if ("str" in item) {
            return item.str;
          }
          return "";
        })
        .join(" ");

      textParts.push(pageText);
    }

    return textParts.join("\n\n");
  } catch (error) {
    console.error("读取 PDF 文件失败:", error);
    throw new Error(`无法读取 PDF 文件: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * 根据文件扩展名读取文档内容
 * @param path 文件绝对路径
 * @returns 提取的文本内容
 */
export async function readDocument(path: string): Promise<string> {
  const extension = path.toLowerCase().split(".").pop();

  if (extension === "pdf") {
    return readPdf(path);
  }

  if (extension === "docx") {
    return readDocx(path);
  }

  throw new Error(`不支持的文档格式: ${extension}`);
}
