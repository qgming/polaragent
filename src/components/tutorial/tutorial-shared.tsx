// 教程页面共享组件
// src/components/tutorial/tutorial-shared.tsx

import { cn } from "@/lib/utils";

// 教程页面标题
export function TutorialTitle({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-normal">{title}</h1>
      <p className="mt-3 text-sm text-muted-foreground">{description}</p>
    </div>
  );
}

// 教程章节标题
export function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mt-8 text-lg font-semibold text-foreground">
      {children}
    </h2>
  );
}

// 教程段落
export function Paragraph({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <p className={cn("mt-4 text-sm leading-relaxed text-muted-foreground", className)}>
      {children}
    </p>
  );
}

// 教程列表
export function List({ children }: { children: React.ReactNode }) {
  return (
    <ul className="mt-4 space-y-2">
      {children}
    </ul>
  );
}

export function ListItem({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex gap-2 text-sm text-muted-foreground">
      <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary" />
      <span className="flex-1">{children}</span>
    </li>
  );
}

// 有序列表
export function OrderedList({ children }: { children: React.ReactNode }) {
  return (
    <ol className="mt-4 space-y-2">
      {children}
    </ol>
  );
}

export function OrderedListItem({ number, children }: { number: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-3 text-sm text-muted-foreground">
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-medium text-primary">
        {number}
      </span>
      <span className="flex-1">{children}</span>
    </li>
  );
}

// 提示卡片
export function TipCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-4 rounded-lg border border-primary/20 bg-primary/5 px-4 py-3">
      <div className="flex gap-2">
        <span className="text-xs font-medium text-primary">💡 提示</span>
      </div>
      <div className="mt-2 text-sm leading-relaxed text-muted-foreground">
        {children}
      </div>
    </div>
  );
}

// 代码块
export function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="mt-4 overflow-x-auto rounded-lg border border-border bg-muted px-4 py-3">
      <code className="text-sm text-foreground">{children}</code>
    </pre>
  );
}
