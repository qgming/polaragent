"use client";

import "@assistant-ui/react-markdown/styles/dot.css";

import { useAuiState } from "@assistant-ui/react";
import { CheckIcon, CopyIcon } from "lucide-react";
import {
  Children,
  type FC,
  isValidElement,
  memo,
  type ReactElement,
  type ReactNode,
  useMemo,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { TooltipIconButton } from "@/renderer/components/assistant-ui/elements/tooltip-icon-button";
import { useCopyToClipboard } from "@/renderer/hooks/use-copy-to-clipboard";
import { splitStreamingMarkdown } from "@/renderer/lib/streaming-markdown";
import { cn } from "@/renderer/lib/utils";
import { MermaidDiagram } from "./mermaid-diagram";
import { SyntaxHighlighter } from "./shiki-highlighter";

/**
 * 消息正文的 Markdown 渲染。
 *
 * **不接 assistant-ui 的 MarkdownTextPrimitive**，直接用 react-markdown 自己拼：
 * 库自带的流式实现每帧对**整篇**文本重新解析（打字机动画按 rAF 推进显示文本），
 * 长回复到后半段时每帧的解析成本随文档长度线性上升，多路流并行时直接吃满主线程 ——
 * 表现就是「越流越卡、最后整个界面冻住」。这里换成分段渲染：
 *   · 已完成的块（空行 / 围栏闭合处切开）内容不再变化，memo 命中即跳过整次解析；
 *   · 只有尾段每次更新重新解析，而尾段被切得很短（一个段落 / 一个未闭合的代码围栏）；
 *   · 未闭合的围栏按纯代码渲染（不解释 markdown、不做语法高亮），闭合后才变成正式代码块。
 *
 * 消息跑完（part 不再是 running）后整篇一次性渲染，作为最终形态 —— 分段只服务流式期间。
 */

/** 代码块头部：语言名 + 复制按钮（沿用 Elements 的样式口径） */
const CodeHeader: FC<{ language?: string | undefined; code: string }> = ({ language, code }) => {
  const { isCopied, copyToClipboard } = useCopyToClipboard();
  const onCopy = () => {
    if (!code || isCopied) return;
    copyToClipboard(code);
  };

  return (
    <div className="aui-code-header-root border-border/50 bg-muted/50 mt-3 flex items-center justify-between rounded-t-xl border border-b-0 px-3.5 py-1.5 text-xs">
      <span className="aui-code-header-language text-muted-foreground font-medium lowercase">
        {language}
      </span>
      <TooltipIconButton tooltip="Copy" onClick={onCopy}>
        {!isCopied && <CopyIcon className="animate-in zoom-in-75 fade-in duration-150" />}
        {isCopied && <CheckIcon className="animate-in zoom-in-50 fade-in duration-200 ease-out" />}
      </TooltipIconButton>
    </div>
  );
};

/** 带语言的代码块：CodeHeader + 高亮本体（高亮器自带的容器样式见 shiki-highlighter） */
function CodeBlock({
  language,
  code,
  streaming,
}: {
  language?: string | undefined;
  code: string;
  streaming: boolean;
}) {
  if (language === "mermaid" && !streaming) {
    return <MermaidDiagram code={code} />;
  }
  return (
    <>
      <CodeHeader language={language} code={code} />
      <SyntaxHighlighter language={language} code={code} streaming={streaming} />
    </>
  );
}

/**
 * 块级代码的接管点。
 *
 * react-markdown 生成的块级代码是 `pre > code`；这里在 `pre` 上直接读子元素（code）的
 * props 拿到语言与正文，整块自己渲染（CodeHeader + 高亮器）——于是 `code` 组件只会被
 * 行内代码命中，不必再区分「是不是代码块」。这是 react-markdown v9 语义下的标准做法
 * （v9 已不再传 inline 标记）。
 */
const PreBlock: FC<{ children?: ReactNode }> = ({ children }) => {
  const child = Children.toArray(children).find(
    (node): node is ReactElement<{ className?: string; children?: ReactNode }> =>
      isValidElement(node),
  );
  if (child === undefined) {
    return (
      <pre className="aui-md-pre border-border/50 bg-muted/30 overflow-x-auto rounded-xl border p-3.5 text-[0.93em] leading-relaxed">
        {children}
      </pre>
    );
  }
  const className = typeof child.props.className === "string" ? child.props.className : "";
  const language = /language-([\w+.-]+)/.exec(className)?.[1];
  const code = String(child.props.children ?? "").replace(/\n$/, "");
  return <CodeBlock language={language} code={code} streaming={false} />;
};

/** 流式尾段里的未闭合围栏：纯代码展示，闭合后由上面那个完整代码块接管 */
const TailFence: FC<{ language?: string | undefined; code: string }> = ({ language, code }) => (
  <>
    <CodeHeader language={language} code={code} />
    <SyntaxHighlighter language={language} code={code} streaming />
  </>
);

/** 行内代码：块级代码已被 PreBlock 截走，这里只会拿到行内 code */
const InlineCode: FC<{ className?: string; children?: ReactNode }> = ({ className, children }) => (
  <code
    className={cn(
      "aui-md-inline-code bg-muted rounded-md px-1.5 py-0.5 font-mono text-[0.85em]",
      className,
    )}
  >
    {children}
  </code>
);

/**
 * 共享的 HTML 元素映射。
 * 同一张表同时供三段使用：流式块、流式尾段、报告（MarkdownBlock）——
 * 同一件事在对话与报告里长得不一样，是最早那版实现留下的坑。
 */
const markdownComponents = {
  h1: ({ className, ...props }: React.ComponentProps<"h1">) => (
    <h1
      className={cn(
        "aui-md-h1 mt-5 mb-2 scroll-m-20 text-xl font-semibold first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    />
  ),
  h2: ({ className, ...props }: React.ComponentProps<"h2">) => (
    <h2
      className={cn(
        "aui-md-h2 mt-5 mb-2 scroll-m-20 text-lg font-semibold first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    />
  ),
  h3: ({ className, ...props }: React.ComponentProps<"h3">) => (
    <h3
      className={cn(
        "aui-md-h3 mt-4 mb-1.5 scroll-m-20 text-base font-semibold first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    />
  ),
  h4: ({ className, ...props }: React.ComponentProps<"h4">) => (
    <h4
      className={cn(
        "aui-md-h4 mt-3.5 mb-1 scroll-m-20 text-base font-medium first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    />
  ),
  h5: ({ className, ...props }: React.ComponentProps<"h5">) => (
    <h5
      className={cn("aui-md-h5 mt-3 mb-1 text-sm font-semibold first:mt-0 last:mb-0", className)}
      {...props}
    />
  ),
  h6: ({ className, ...props }: React.ComponentProps<"h6">) => (
    <h6
      className={cn("aui-md-h6 mt-3 mb-1 text-sm font-medium first:mt-0 last:mb-0", className)}
      {...props}
    />
  ),
  // 段间距由界面密度驱动：舒适 16px / 紧凑 12px（--density-gap，见 index.css）。
  // 下面的列表、引用、分隔线、表格用同一个令牌，让整篇正文的纵向节奏一致。
  p: ({ className, ...props }: React.ComponentProps<"p">) => (
    <p
      className={cn("aui-md-p my-(--density-gap) leading-relaxed first:mt-0 last:mb-0", className)}
      {...props}
    />
  ),
  a: ({ className, ...props }: React.ComponentProps<"a">) => (
    <a
      className={cn(
        "aui-md-a text-primary hover:text-primary/80 underline underline-offset-2",
        className,
      )}
      {...props}
    />
  ),
  blockquote: ({ className, ...props }: React.ComponentProps<"blockquote">) => (
    <blockquote
      className={cn(
        "aui-md-blockquote border-muted-foreground/30 text-muted-foreground my-(--density-gap) border-s-2 ps-4",
        className,
      )}
      {...props}
    />
  ),
  ul: ({ className, ...props }: React.ComponentProps<"ul">) => (
    <ul
      className={cn(
        "aui-md-ul marker:text-muted-foreground my-(--density-gap) ms-5 list-disc [&>li]:mt-1",
        className,
      )}
      {...props}
    />
  ),
  ol: ({ className, ...props }: React.ComponentProps<"ol">) => (
    <ol
      className={cn(
        "aui-md-ol marker:text-muted-foreground my-(--density-gap) ms-5 list-decimal [&>li]:mt-1",
        className,
      )}
      {...props}
    />
  ),
  hr: ({ className, ...props }: React.ComponentProps<"hr">) => (
    <hr
      className={cn("aui-md-hr border-muted-foreground/20 my-(--density-gap)", className)}
      {...props}
    />
  ),
  table: ({ className, ...props }: React.ComponentProps<"table">) => (
    <div className="aui-md-table-wrapper my-(--density-gap) overflow-x-auto">
      <table
        className={cn("aui-md-table w-full border-separate border-spacing-0", className)}
        {...props}
      />
    </div>
  ),
  th: ({ className, ...props }: React.ComponentProps<"th">) => (
    <th
      className={cn(
        "aui-md-th bg-muted px-3 py-1.5 text-start font-medium first:rounded-ss-lg last:rounded-se-lg [[align=center]]:text-center [[align=right]]:text-right",
        className,
      )}
      {...props}
    />
  ),
  td: ({ className, ...props }: React.ComponentProps<"td">) => (
    <td
      className={cn(
        "aui-md-td border-muted-foreground/20 border-s border-b px-3 py-1.5 text-start last:border-e [[align=center]]:text-center [[align=right]]:text-right",
        className,
      )}
      {...props}
    />
  ),
  tr: ({ className, ...props }: React.ComponentProps<"tr">) => (
    <tr
      className={cn(
        "aui-md-tr m-0 border-b p-0 first:border-t [&:last-child>td:first-child]:rounded-es-lg [&:last-child>td:last-child]:rounded-ee-lg",
        className,
      )}
      {...props}
    />
  ),
  li: ({ className, ...props }: React.ComponentProps<"li">) => (
    <li className={cn("aui-md-li leading-relaxed", className)} {...props} />
  ),
  strong: ({ className, ...props }: React.ComponentProps<"strong">) => (
    <strong className={cn("aui-md-strong font-semibold", className)} {...props} />
  ),
  sup: ({ className, ...props }: React.ComponentProps<"sup">) => (
    <sup className={cn("aui-md-sup [&>a]:text-xs [&>a]:no-underline", className)} {...props} />
  ),
  pre: PreBlock,
  code: InlineCode,
};

/** 一次完整的 Markdown 解析（尾段每次更新走这里，块则被 memo 挡住） */
const MarkdownDocument: FC<{ text: string }> = ({ text }) => (
  <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
    {text}
  </ReactMarkdown>
);

/**
 * 已完成的块：文本值相等就跳过整次渲染（含 react-markdown 的解析）。
 * 比较用字符串值而不是引用：每次切分都会产生新的字符串实例，引用比较必不相等。
 */
const StableBlock = memo(MarkdownDocument, (previous, next) => previous.text === next.text);

/** 流式渲染：稳定块 memo + 尾段实时 */
const StreamingMarkdown: FC<{ text: string }> = ({ text }) => {
  /**
   * 块的身份用**前缀偏移**而不是数组下标：块是 append-only 的前缀（新块只会追加在后面，
   * 已有块的起点不变），偏移因此天然稳定且唯一，也不会落到「用下标当 key」的坑里。
   */
  const { blocks, tail } = useMemo(() => {
    const segments = splitStreamingMarkdown(text);
    let start = 0;
    const blocks = segments.blocks.map((block) => {
      const key = start;
      start += block.length;
      return { key, text: block };
    });
    return { blocks, tail: segments.tail };
  }, [text]);
  return (
    <>
      {blocks.map((block) => (
        <StableBlock key={block.key} text={block.text} />
      ))}
      {tail !== null &&
        (tail.kind === "code" ? (
          <TailFence language={tail.language} code={tail.code} />
        ) : (
          <MarkdownDocument text={tail.text} />
        ))}
    </>
  );
};

const MarkdownTextImpl: FC = () => {
  /**
   * 只订阅这一条 part：别的 part、别的消息的变化都不引起这里重渲染。
   * 用官方的 `s.part` 选择器（`useMessagePartText` 已标记废弃），返回 null 表示这一槽位
   * 不是文本 / 推理 part（正常不会发生），此时不渲染任何东西。
   */
  const part = useAuiState((s) =>
    s.part.type === "text" || s.part.type === "reasoning" ? s.part : null,
  );
  if (part === null) return null;
  // 运行中才分段；跑完整篇一次性渲染，给出与「历史回读」完全一致的最终形态
  const streaming = part.status.type === "running";

  return (
    <div className="aui-md">
      {streaming ? <StreamingMarkdown text={part.text} /> : <MarkdownDocument text={part.text} />}
    </div>
  );
};

export const MarkdownText = memo(MarkdownTextImpl);

/**
 * 渲染**任意** markdown 文本（不依赖 part 上下文）。
 *
 * 为什么需要它：`MarkdownText` 的正文是从 assistant-ui 的 part 上下文里读的 ——
 * 只有当它挂在某条消息的文本 part 里时才有内容。像「子智能体报告」这种**游离于消息之外**
 * 的文本（它挂在工具结果上）塞进去只会渲染出一个空壳。
 *
 * 这里直接用 react-markdown，并**复用同一张 markdownComponents**：报告因此与主对话长得
 * 完全一样（标题层级、代码高亮、表格、列表、引用都同一套样式），而不是两套近似的样式各走各的。
 * 报告是一次性文本、不流式，所以不需要分段。
 */
export const MarkdownBlock: FC<{ text: string; className?: string }> = ({ text, className }) => (
  <div className={cn("aui-md", className)}>
    <MarkdownDocument text={text} />
  </div>
);
