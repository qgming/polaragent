import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  CodeBlock,
  List,
  ListItem,
  OrderedList,
  OrderedListItem,
  Paragraph,
  SectionTitle,
  TipCard,
  TutorialTitle,
} from "./tutorial-shared";

export type TutorialArticleSection =
  | "quickstart"
  | "chat"
  | "agent"
  | "skill"
  | "tool"
  | "team"
  | "knowledge"
  | "model"
  | "browseruse"
  | "computeruse"
  | "tips"
  | "faq";

type TutorialBlock = {
  type: "section" | "p" | "subheading" | "list" | "ol" | "tip" | "code";
  text?: string;
  items?: string[];
};

type TutorialArticleData = {
  title: string;
  description: string;
  blocks: TutorialBlock[];
};

const inlinePattern = /(\*\*[^*]+\*\*|`[^`]+`)/g;

export function TutorialArticle({ section }: { section: TutorialArticleSection }) {
  const { t } = useTranslation("tutorial");
  const article = t(`articles.${section}`, { returnObjects: true }) as TutorialArticleData;

  if (!article?.title || !Array.isArray(article.blocks)) return null;

  return (
    <section>
      <TutorialTitle title={article.title} description={article.description} />
      {article.blocks.map((block, index) => (
        <TutorialBlockView key={`${block.type}-${index}`} block={block} />
      ))}
    </section>
  );
}

function TutorialBlockView({ block }: { block: TutorialBlock }) {
  switch (block.type) {
    case "section":
      return <SectionTitle>{renderInline(block.text ?? "")}</SectionTitle>;
    case "subheading":
      return (
        <Paragraph className="mt-4 font-medium text-foreground">
          {renderInline(block.text ?? "")}
        </Paragraph>
      );
    case "p":
      return <Paragraph>{renderInline(block.text ?? "")}</Paragraph>;
    case "list":
      return (
        <List>
          {(block.items ?? []).map((item, index) => (
            <ListItem key={index}>{renderInline(item)}</ListItem>
          ))}
        </List>
      );
    case "ol":
      return (
        <OrderedList>
          {(block.items ?? []).map((item, index) => (
            <OrderedListItem key={index} number={index + 1}>
              {renderInline(item)}
            </OrderedListItem>
          ))}
        </OrderedList>
      );
    case "tip":
      return <TipCard>{renderInline(block.text ?? "")}</TipCard>;
    case "code":
      return <CodeBlock>{block.text ?? ""}</CodeBlock>;
    default:
      return null;
  }
}

function renderInline(text: string): ReactNode[] {
  return text.split(inlinePattern).filter(Boolean).map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      return (
        <code key={index} className="rounded bg-muted px-2 py-0.5 font-mono text-xs">
          {part.slice(1, -1)}
        </code>
      );
    }
    return part;
  });
}
