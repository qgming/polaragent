import type { PluggableList } from "unified";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

import { markdownSanitizeSchema } from "./sanitize";

export const markdownRemarkPlugins: PluggableList = [
  remarkGfm,
  remarkMath,
  remarkBreaks,
];

export const markdownRehypePlugins: PluggableList = [rehypeKatex];

export const markdownHtmlRehypePlugins: PluggableList = [
  rehypeRaw,
  [rehypeSanitize, markdownSanitizeSchema],
  rehypeKatex,
];

export { rehypeKatex, rehypeRaw, rehypeSanitize, remarkBreaks, remarkGfm, remarkMath };
