import { defaultSchema } from "rehype-sanitize";
import type { Options as SanitizeSchema } from "rehype-sanitize";

const defaultAttributes = defaultSchema.attributes ?? {};
const defaultTagNames = defaultSchema.tagNames ?? [];

export const markdownSanitizeSchema: SanitizeSchema = {
  ...defaultSchema,
  tagNames: [
    ...defaultTagNames,
    "details",
    "summary",
    "mark",
    "kbd",
    "samp",
    "sub",
    "sup",
  ],
  attributes: {
    ...defaultAttributes,
    "*": [
      ...(defaultAttributes["*"] ?? []),
      "className",
      "title",
      "aria-label",
      "aria-hidden",
      "role",
    ],
    a: [
      ...(defaultAttributes.a ?? []),
      "href",
      "target",
      "rel",
      "title",
    ],
    img: [
      ...(defaultAttributes.img ?? []),
      "src",
      "alt",
      "title",
      "width",
      "height",
      "loading",
      "referrerPolicy",
      "crossOrigin",
    ],
    code: [...(defaultAttributes.code ?? []), "className"],
    pre: [...(defaultAttributes.pre ?? []), "className"],
    span: [...(defaultAttributes.span ?? []), "className"],
    div: [...(defaultAttributes.div ?? []), "className"],
    table: [...(defaultAttributes.table ?? []), "className"],
    th: [...(defaultAttributes.th ?? []), "align", "className"],
    td: [...(defaultAttributes.td ?? []), "align", "className"],
  },
  protocols: {
    ...defaultSchema.protocols,
    href: ["http", "https", "mailto", "file"],
    src: ["http", "https", "data", "blob", "file"],
  },
  clobberPrefix: "md-",
};
