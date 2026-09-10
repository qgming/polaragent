import type { TextMessagePartComponent } from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import type { ComponentProps } from "react";

// react-markdown 的组件覆写：只收敛代码块 / 行内码 / 链接的样式，其余走默认排版。
// 代码块：document 圆角 + --secondary 底 + mono，无阴影；行内码：--muted 底。
const markdownComponents = {
  // pre 仅承载代码块（react-markdown 中行内码不走 pre）
  pre: (props: ComponentProps<"pre">) => (
    <pre
      {...props}
      className="my-2 overflow-x-auto rounded-sm bg-secondary p-3 font-mono text-[13px] leading-relaxed"
    />
  ),
  // inline 为 true 时是行内码，否则是代码块内的码（pre 已负责底色）
  code: (props: ComponentProps<"code"> & { inline?: boolean }) => {
    const { inline, className, ...rest } = props;
    if (inline) {
      return (
        <code {...rest} className="rounded-sm bg-muted px-1 py-0.5 font-mono text-[0.875em]" />
      );
    }
    return <code {...rest} className={`${className ?? ""} font-mono`} />;
  },
  // 链接：品牌色小字（E2 落点 ⑥），下划线克制
  a: (props: ComponentProps<"a">) => (
    <a
      {...props}
      className="text-brand-text underline decoration-brand-border underline-offset-2"
    />
  ),
} satisfies NonNullable<React.ComponentProps<typeof MarkdownTextPrimitive>["components"]>;

/**
 * 助手正文的 Markdown 渲染（Text part 组件）。
 * 文本由 MarkdownTextPrimitive 从当前 part scope 读取（useMessagePartText），
 * 无需经 props 传入；smooth 打字机动画由库处理并尊重 prefers-reduced-motion。
 */
export const MarkdownText: TextMessagePartComponent = () => {
  return (
    <MarkdownTextPrimitive
      components={markdownComponents}
      className="text-sm leading-[1.7]"
      containerProps={{
        style: { fontFamily: "var(--chat-font)", fontSize: "var(--chat-font-size)" },
      }}
    />
  );
};
