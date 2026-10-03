import { useAui } from "@assistant-ui/react";
import {
  Bug,
  ClipboardList,
  FileSearch,
  GitCommitHorizontal,
  Map as MapIcon,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  EmptyStateGreeting,
  EmptyStateSuggestion,
  EmptyStateSuggestions,
} from "@/renderer/components/assistant-ui/elements/empty-state";
import { Composer } from "./Composer";
import { insertSlashCommand } from "./slash-commands";
import { pickStarterPrompts } from "./starter-prompts";
import { useActiveWorkingDir, useSlashCommands } from "./use-slash-commands";

/**
 * 新会话页（**没有选中任何会话，或刚新建了一个空会话**时的那一屏）。
 *
 * 这一屏与「对话中」共用同一个 Composer，只是换了摆法（`variant="hero"`）：
 * 输入框从贴底挪到画面中间，顶上多一行「跑在哪个项目里」，下面挂一排起手提示。
 *
 * 为什么把空态做成**独立的一屏**而不是在消息流里插一段占位：消息流的滚动、贴底、
 * 消息地图那一整套在「一条消息都没有」时全都不成立，硬塞进去只会得到一堆空转的逻辑
 * （见 Thread 里对空态的分支）。
 *
 * 顺序自上而下是刻意的：品牌标记 → 问候 → 输入框 → 起手提示。问候与标记回答
 * 「这是哪儿」，输入框是这一屏唯一的动作，起手提示是「不知道写什么」时的下一步。
 */
export function WelcomeView(): React.JSX.Element {
  const { t } = useTranslation();

  return (
    // min-h-full + 居中：撑满视口高度（Thread 里那条 min-h-full 的容器），内容在垂直方向居中
    <div
      data-slot="welcome"
      className="flex min-h-full w-full flex-col items-center justify-center px-6 py-10"
    >
      <div className="flex w-full max-w-(--thread-max-width) flex-col items-center gap-8">
        <div className="flex flex-col items-center gap-6">
          {/*
            品牌标记：与侧栏顶部、favicon 同一份资源（public/oint-logo.png，透明底那份）。

            低不透明度把它压成**水印**而不是一枚图标 —— 这一屏的主语是下面那句问候，
            标记只负责「这是哪儿」。图形本身已经是墨色，不需要再灰度化；
            暗色下反相成浅色，否则黑字形落在深色页面上等于不存在。

            比侧栏那枚大得多：它在这里是画面的一部分，不是列表行里的一枚图标。
            aria-hidden：它是装饰，旁边的问候语已经承担了「这是哪儿」的语义。
          */}
          <img
            src="./oint-logo.png"
            alt=""
            aria-hidden="true"
            draggable={false}
            data-slot="welcome-mark"
            className="size-36 shrink-0 object-contain opacity-[0.1] select-none dark:opacity-[0.18] dark:invert"
          />
          <div className="flex flex-col items-center gap-2">
            <EmptyStateGreeting className="text-3xl">{t("chat.welcome")}</EmptyStateGreeting>
            <p className="text-center text-sm leading-relaxed text-ink-3">
              {t("chat.welcomeSubtitle")}
            </p>
          </div>
        </div>

        <Composer variant="hero" />
        <WelcomeSuggestions />
      </div>
    </div>
  );
}

/**
 * 起手提示 chip：把一条模板的正文填进输入框（与斜杠菜单选中模板同一个动作）。
 *
 * 只**填**不**发**：模板正文常常需要用户补一句上下文（改哪个模块、复现步骤），
 * 直接发出去等于替用户按下发送键。填进去之后光标就在末尾，接着写就行。
 */
function WelcomeSuggestions(): React.JSX.Element | null {
  const { t } = useTranslation();
  const aui = useAui();
  const workingDir = useActiveWorkingDir();
  const commands = useSlashCommands(workingDir);
  const starters = useMemo(() => pickStarterPrompts(commands), [commands]);

  // 一条模板都没有（数据目录与内置层都读不到）时整排消失，不留一条空行
  if (starters.length === 0) return null;

  return (
    <EmptyStateSuggestions aria-label={t("chat.welcomeSuggestions")}>
      {starters.map((starter, index) => (
        <EmptyStateSuggestion
          key={starter.command.name}
          index={index}
          title={starter.command.description}
          onClick={() => aui.composer.setText(insertSlashCommand(starter.command))}
        >
          <StarterIcon name={starter.command.name} />
          {t(starter.labelKey)}
        </EmptyStateSuggestion>
      ))}
    </EmptyStateSuggestions>
  );
}

/**
 * chip 上的图标：按模板名给，认不出来的（用户自己加的模板不会走到这里，
 * 但内置层将来加一条就会）回落到一个通用字形，而不是留个空位。
 */
function StarterIcon({ name }: { name: string }): React.JSX.Element {
  const className = "size-3.5 shrink-0 opacity-70";
  switch (name.toLowerCase()) {
    case "plan":
      return <ClipboardList className={className} />;
    case "debug":
      return <Bug className={className} />;
    case "review":
      return <FileSearch className={className} />;
    case "verify":
      return <ShieldCheck className={className} />;
    case "commit":
      return <GitCommitHorizontal className={className} />;
    case "map":
      return <MapIcon className={className} />;
    default:
      return <Sparkles className={className} />;
  }
}
