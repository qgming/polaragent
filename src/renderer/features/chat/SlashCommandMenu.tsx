import { LayoutTemplate, ListTodo, SquareSlash } from "lucide-react";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  type ComposerCommand,
  ComposerCommandItem,
  ComposerMenu,
} from "@/renderer/components/assistant-ui/elements/composer";
import { typeEyebrow } from "@/renderer/components/assistant-ui/type";
import { cn } from "@/renderer/lib/utils";
import { optionKey, orderSlashCommands, SLASH_GROUPS, type SlashCommand } from "./slash-commands";

/** 三栏各自的行图标与眉题词条；SLASH_GROUPS 的顺序即渲染顺序 */
const GROUP_META = {
  command: { icon: SquareSlash, labelKey: "chat.slashCommands" },
  skill: { icon: ListTodo, labelKey: "chat.slashSkills" },
  template: { icon: LayoutTemplate, labelKey: "chat.slashTemplates" },
} as const satisfies Record<SlashCommand["kind"], { icon: typeof ListTodo; labelKey: string }>;

/** 展开后的高度上限：再长就内部滚动，不把输入框顶出屏幕 */
const MENU_CONTENT = "max-h-[min(16rem,36vh)]";

/**
 * 输入框上方的斜杠命令菜单：斜杠一敲出来就贴在 composer 上沿。
 *
 * 复用 Elements 的三件套 —— ComposerMenu（浮层位置与开关动效）、ComposerMenuItem、
 * ComposerCommandItem（行外观：图标 + `/名称` + 描述）—— 这里只补两栏分组、空态与
 * listbox 语义，不另造一套外观。
 *
 * 键盘（上下 / Enter / Esc）由 Composer 接管：菜单是纯展示，不抢 textarea 的焦点，
 * textarea 始终持有焦点，菜单通过 aria-activedescendant 指示当前行。
 */
export function SlashCommandMenu({
  listId,
  matches,
  activeKey,
  onSelect,
  blockedReason,
}: {
  /** listbox 的 id：输入框要靠它做 aria-controls / aria-activedescendant，由 Composer 持有 */
  listId: string;
  /** 已按查询词筛过的清单；渲染顺序由 orderSlashCommands 定 */
  matches: readonly SlashCommand[];
  /** 当前高亮行的 optionKey（kind + name），null = 没有高亮行 */
  activeKey: string | null;
  onSelect: (command: SlashCommand) => void;
  /**
   * 这条命令现在**为什么不能执行**（i18n 后的文案）；返回 null 表示可用。
   *
   * 只影响呈现与提示：置灰的行仍然可以被高亮与选中（选中只是把命令名填进输入框，
   * 真正执行在发送时判定），这样用户能看到命令存在、也能看到不能用的原因 ——
   * 直接从菜单里藏掉会让人以为没有这个功能。
   */
  blockedReason?: (command: SlashCommand) => string | null;
}) {
  const { t } = useTranslation();
  const optionId = (command: SlashCommand) => `${listId}-${optionKey(command)}`;
  const scrollRef = useRef<HTMLDivElement>(null);

  // aria-activedescendant 只挪高亮不挪焦点，焦点不动就不会自动滚动：这里替它滚。
  // 用 getElementById 而不是拼选择器 —— 命令名来自磁盘上的目录名，里面可能带引号或反斜杠，
  // 直接插进 CSS 选择器会让 querySelector 抛错（而调用点在 effect 里，会打崩整个组件）。
  useEffect(() => {
    if (activeKey === null) return;
    document.getElementById(`${listId}-${activeKey}`)?.scrollIntoView({ block: "nearest" });
  }, [activeKey, listId]);

  /** 分栏渲染的顺序与 orderSlashCommands 必须一致，否则上下键会跳栏 */
  const byKind = (kind: SlashCommand["kind"]) =>
    orderSlashCommands(matches).filter((command) => command.kind === kind);

  return (
    <ComposerMenu open align="start" className="w-[22rem] p-1.5">
      {/*
        空态放在 listbox **外面**：listbox 的直接子级只能是 option 或 group，
        夹一个提示文本进去，读屏可能压根不念它。
      */}
      {matches.length === 0 ? (
        <span className="text-ink-4 block px-2.5 py-4 text-center text-xs break-words">
          {t("chat.slashEmpty")}
        </span>
      ) : (
        <div
          ref={scrollRef}
          id={listId}
          role="listbox"
          aria-label={t("chat.slashSwitch")}
          className={cn(MENU_CONTENT, "app-scrollbar flex flex-col overflow-y-auto")}
        >
          {SLASH_GROUPS.map((kind) => {
            const items = byKind(kind);
            if (items.length === 0) return null;
            const meta = GROUP_META[kind];
            return (
              // biome-ignore lint/a11y/useSemanticElements: listbox 的直接子级只能是 option 或 group；fieldset 在这里既不是选项，也无法参与 aria-activedescendant
              <div key={kind} role="group" aria-label={t(meta.labelKey)} className="flex flex-col">
                <span aria-hidden className={cn(typeEyebrow, "px-2.5 pt-2 pb-1")}>
                  {t(meta.labelKey)}
                </span>
                {items.map((command) => {
                  const blocked = blockedReason?.(command) ?? null;
                  return (
                    <ComposerCommandItem
                      key={optionKey(command)}
                      id={optionId(command)}
                      // 焦点必须留在 textarea 上（combobox 模式）：Tab 不该走进 listbox，
                      // 否则菜单一收起焦点就掉到 body
                      tabIndex={-1}
                      command={toCommandItem(command, meta.icon, blocked)}
                      active={optionKey(command) === activeKey}
                      // 置灰只是视觉与读屏提示：选中仍然允许（见 blockedReason 的说明）
                      aria-disabled={blocked !== null}
                      onMouseDown={(event) => {
                        // preventDefault：别让按钮抢走 textarea 的焦点（菜单一关光标就丢）
                        // stopPropagation：Root 会接管「点空白处聚焦输入框」，而菜单在它外面
                        event.preventDefault();
                        event.stopPropagation();
                      }}
                      onClick={() => onSelect(command)}
                    />
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
    </ComposerMenu>
  );
}

/**
 * SlashCommand → Elements 的行数据模型；图标不进数据层，由菜单按栏决定。
 *
 * 不可用时把原因**替换**掉描述：用户此刻需要知道的是「为什么不能用」，
 * 而不是这条命令本来做什么（描述已经在别处看过一次）。
 */
function toCommandItem(
  command: SlashCommand,
  icon: typeof ListTodo,
  blocked: string | null,
): ComposerCommand {
  return {
    name: command.name,
    description: blocked ?? command.description,
    icon,
    ...(blocked === null ? {} : { blocked: true }),
  };
}
