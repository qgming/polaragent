// Emoji 选择器组件
// src/components/ui/emoji-picker.tsx

import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalHeader,
  ModalTitle,
} from "@/components/ui/modal";
import { cn } from "@/lib/utils";

// 常用 emoji 分类
const EMOJI_CATEGORIES = [
  {
    key: "smile",
    emojis: [
      "😀", "😃", "😄", "😁", "😆", "😅", "🤣", "😂", "🙂", "🙃",
      "😉", "😊", "😇", "🥰", "😍", "🤩", "😘", "😗", "😚", "😙",
      "🥲", "😋", "😛", "😜", "🤪", "😝", "🤑", "🤗", "🤭", "🤫",
      "🤔", "🤐", "🤨", "😐", "😑", "😶", "😏", "😒", "🙄", "😬",
      "😌", "😔", "😪", "🤤", "😴", "😷", "🤒", "🤕", "🤢", "🤮",
    ],
  },
  {
    key: "gesture",
    emojis: [
      "👋", "🤚", "🖐", "✋", "🖖", "👌", "🤌", "🤏", "✌️", "🤞",
      "🤟", "🤘", "🤙", "👈", "👉", "👆", "🖕", "👇", "☝️", "👍",
      "👎", "✊", "👊", "🤛", "🤜", "👏", "🙌", "👐", "🤲", "🤝",
      "🙏", "✍️", "💅", "🤳", "💪", "🦾", "🦵", "🦿", "🦶", "👂",
      "🦻", "👃", "🧠", "🫀", "🫁", "🦷", "🦴", "👀", "👁️", "👅",
    ],
  },
  {
    key: "animal",
    emojis: [
      "🐶", "🐱", "🐭", "🐹", "🐰", "🦊", "🐻", "🐼", "🐨", "🐯",
      "🦁", "🐮", "🐷", "🐽", "🐸", "🐵", "🙈", "🙉", "🙊", "🐔",
      "🐧", "🐦", "🐤", "🐣", "🐥", "🦆", "🦅", "🦉", "🦇", "🐺",
      "🐗", "🐴", "🦄", "🐝", "🪱", "🐛", "🦋", "🐌", "🐞", "🐜",
      "🪰", "🪲", "🪳", "🦟", "🦗", "🕷️", "🕸️", "🦂", "🐢", "🐍",
    ],
  },
  {
    key: "food",
    emojis: [
      "🍎", "🍏", "🍊", "🍋", "🍌", "🍉", "🍇", "🍓", "🫐", "🍈",
      "🍒", "🍑", "🥭", "🍍", "🥥", "🥝", "🍅", "🍆", "🥑", "🥦",
      "🥬", "🥒", "🌶️", "🫑", "🌽", "🥕", "🫒", "🧄", "🧅", "🥔",
      "🍠", "🥐", "🥯", "🍞", "🥖", "🥨", "🧀", "🥚", "🍳", "🧈",
      "🥞", "🧇", "🥓", "🥩", "🍗", "🍖", "🦴", "🌭", "🍔", "🍟",
    ],
  },
  {
    key: "activity",
    emojis: [
      "⚽", "🏀", "🏈", "⚾", "🥎", "🎾", "🏐", "🏉", "🥏", "🎱",
      "🪀", "🏓", "🏸", "🏒", "🏑", "🥍", "🏏", "🪃", "🥅", "⛳",
      "🪁", "🏹", "🎣", "🤿", "🥊", "🥋", "🎽", "🛹", "🛼", "🛷",
      "⛸️", "🥌", "🎿", "⛷️", "🏂", "🪂", "🏋️", "🤼", "🤸", "🤺",
      "⛹️", "🤾", "🏌️", "🏇", "🧘", "🏊", "🏄", "🚣", "🧗", "🚴",
    ],
  },
  {
    key: "travel",
    emojis: [
      "🚗", "🚕", "🚙", "🚌", "🚎", "🏎️", "🚓", "🚑", "🚒", "🚐",
      "🛻", "🚚", "🚛", "🚜", "🦯", "🦽", "🦼", "🛴", "🚲", "🛵",
      "🏍️", "🛺", "🚨", "🚔", "🚍", "🚘", "🚖", "🚡", "🚠", "🚟",
      "🚃", "🚋", "🚞", "🚝", "🚄", "🚅", "🚈", "🚂", "🚆", "🚇",
      "🚊", "🚉", "✈️", "🛫", "🛬", "🛩️", "💺", "🚁", "🛰️", "🚀",
    ],
  },
  {
    key: "symbol",
    emojis: [
      "⚡", "🔥", "✨", "⭐", "🌟", "💫", "🔴", "🟠", "🟡", "🟢",
      "🔵", "🟣", "🟤", "⚫", "⚪", "🟥", "🟧", "🟨", "🟩", "🟦",
      "🟪", "🟫", "⬛", "⬜", "❤️", "🧡", "💛", "💚", "💙", "💜",
      "🤎", "🖤", "🤍", "💔", "❤️‍🔥", "❤️‍🩹", "💕", "💞", "💓", "💗",
      "💖", "💘", "💝", "💟", "☮️", "✝️", "☪️", "🕉️", "☸️", "✡️",
    ],
  },
  {
    key: "object",
    emojis: [
      "📱", "💻", "⌨️", "🖥️", "🖨️", "🖱️", "🖲️", "🕹️", "🗜️", "💽",
      "💾", "💿", "📀", "📼", "📷", "📸", "📹", "🎥", "📽️", "🎞️",
      "📞", "☎️", "📟", "📠", "📺", "📻", "🎙️", "🎚️", "🎛️", "🧭",
      "⏱️", "⏲️", "⏰", "🕰️", "⌛", "⏳", "📡", "🔋", "🔌", "💡",
      "🔦", "🕯️", "🪔", "🧯", "🛢️", "💸", "💵", "💴", "💶", "💷",
    ],
  },
  {
    key: "work",
    emojis: [
      "💼", "📁", "📂", "🗂️", "📅", "📆", "🗒️", "🗓️", "📇", "📈",
      "📉", "📊", "📋", "📌", "📍", "📎", "🖇️", "📏", "📐", "✂️",
      "🗃️", "🗄️", "🗑️", "🔒", "🔓", "🔏", "🔐", "🔑", "🗝️", "🔨",
      "🪓", "⛏️", "⚒️", "🛠️", "🗡️", "⚔️", "🔫", "🪃", "🏹", "🛡️",
      "🪚", "🔧", "🪛", "🔩", "⚙️", "🗜️", "⚖️", "🦯", "🔗", "⛓️",
    ],
  },
  {
    key: "flag",
    emojis: [
      "🏁", "🚩", "🎌", "🏴", "🏳️", "🏳️‍🌈", "🏳️‍⚧️", "🏴‍☠️", "🇨🇳", "🇺🇸",
      "🇬🇧", "🇯🇵", "🇰🇷", "🇫🇷", "🇩🇪", "🇮🇹", "🇪🇸", "🇷🇺", "🇨🇦", "🇦🇺",
      "🇮🇳", "🇧🇷", "🇲🇽", "🇦🇷", "🇨🇱", "🇨🇴", "🇵🇪", "🇻🇪", "🇪🇨", "🇺🇾",
    ],
  },
];

export function EmojiPicker({
  open,
  onClose,
  onSelect,
}: {
  open: boolean;
  onClose: () => void;
  onSelect: (emoji: string) => void;
}) {
  const { t } = useTranslation("common");
  const [activeCategory, setActiveCategory] = useState(0);

  const handleSelect = (emoji: string) => {
    onSelect(emoji);
    onClose();
  };

  return (
    <Modal open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <ModalContent size="md">
        <ModalHeader>
	          <ModalTitle>{t("emoji.title")}</ModalTitle>
        </ModalHeader>

        <ModalBody className="bg-background">
          {/* 分类标签 */}
          <div className="app-scrollbar mb-4 flex gap-2 overflow-x-auto pb-2">
            {EMOJI_CATEGORIES.map((category, index) => (
              <button
	                key={category.key}
                type="button"
                onClick={() => setActiveCategory(index)}
                className={cn(
                  "shrink-0 rounded-full px-3 py-1.5 text-xs font-medium transition-colors",
                  activeCategory === index
                    ? "bg-[#f1eafb] text-[#5b3a9e]"
                    : "bg-muted text-muted-foreground hover:bg-muted/80",
                )}
              >
	                {t(`emoji.categories.${category.key}`)}
              </button>
            ))}
          </div>

          {/* Emoji 网格 */}
          <div className="grid grid-cols-10 gap-1">
            {EMOJI_CATEGORIES[activeCategory].emojis.map((emoji) => (
              <button
                key={emoji}
                type="button"
                onClick={() => handleSelect(emoji)}
                className="flex size-10 items-center justify-center rounded-md text-2xl transition-colors hover:bg-muted"
                title={emoji}
              >
                {emoji}
              </button>
            ))}
          </div>
        </ModalBody>
      </ModalContent>
    </Modal>
  );
}
