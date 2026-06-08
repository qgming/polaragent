// 富文本对话输入框 —— contentEditable + 行内 chip（技能 / 文件）
//
// 用 contentEditable 替代原始 textarea，使「技能标记 / 文件标记」作为不可编辑的
// 行内元素，像富文本一样与文字逐字混排。对外以三个维度暴露：
//   - 文字内容通过 onChange(text) 回传（chip 不计入文本）
//   - 已选技能通过 onSkillsChange(ids) 回传（按出现顺序、去重）
//   - 已选附件通过 onFilesChange(files) 回传（按出现顺序、去重）
//
// 插入 chip：在当前光标处插入一个 chip（光标丢失时追加到末尾）。
// 删除 chip：contentEditable 原生退格即可删除整个 chip（不可编辑、原子）。
//
// chip 视觉区分：
//   技能 chip —— bg-accent，前缀 "# "
//   文件 chip —— 绿色系底，左侧文件图标，显示文件名

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  type KeyboardEvent,
} from "react";
import { Hash } from "lucide-react";
import { cn } from "@/lib/utils";

export interface ComposerAttachment {
  path: string;
  name: string;
  kind: "text" | "image";
}

export interface SkillComposerHandle {
  // 在当前光标处插入一个技能 chip（重复技能忽略）
  insertSkill: (skill: { id: string; name: string }) => void;
  // 在当前光标处插入普通文本（用于 @成员 等轻量补全文本）
  insertText: (text: string) => void;
  // 在当前光标处插入一个文件 chip（重复文件路径忽略）
  insertFile: (file: ComposerAttachment) => void;
  // 清空全部内容（文字、技能、文件）
  clear: () => void;
  // 聚焦编辑区
  focus: () => void;
}

interface SkillComposerInputProps {
  // 受控的纯文本值（仅文字，不含 chip）
  value: string;
  placeholder?: string;
  className?: string;
  onChange: (text: string) => void;
  onSkillsChange: (skillIds: string[]) => void;
  onFilesChange: (files: ComposerAttachment[]) => void;
  onEnter?: () => void;
}

const SKILL_ATTR = "data-skill-id";
const FILE_ATTR = "data-file-path";
const FILE_KIND_ATTR = "data-file-kind";

// 文件 chip 左侧的文件图标（内联 SVG，lucide FileText 的轮廓），与技能 "#" 区分
const FILE_ICON_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="12" height="12" style="flex-shrink:0"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/></svg>';
const IMAGE_ICON_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="12" height="12" style="flex-shrink:0"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/></svg>';

// 从编辑区 DOM 提取纯文本（chip 不计入），保留换行
function extractText(root: HTMLElement): string {
  let text = "";
  const walk = (node: Node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        text += child.textContent ?? "";
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const el = child as HTMLElement;
        if (el.hasAttribute(SKILL_ATTR) || el.hasAttribute(FILE_ATTR)) {
          // 技能 / 文件 chip：不计入文本
          continue;
        }
        if (el.tagName === "BR") {
          text += "\n";
          continue;
        }
        if (el.tagName === "DIV" && text && !text.endsWith("\n")) {
          // contentEditable 里换行常以 <div> 包裹，补一个换行
          text += "\n";
        }
        walk(el);
      }
    }
  };
  walk(root);
  return text;
}

// 按出现顺序收集某属性的值（去重），用于技能 id / 文件路径
function extractAttrValues(root: HTMLElement, attr: string): string[] {
  const values: string[] = [];
  const seen = new Set<string>();
  root.querySelectorAll(`[${attr}]`).forEach((el) => {
    const value = el.getAttribute(attr);
    if (value && !seen.has(value)) {
      seen.add(value);
      values.push(value);
    }
  });
  return values;
}

function extractFiles(root: HTMLElement): ComposerAttachment[] {
  const values: ComposerAttachment[] = [];
  const seen = new Set<string>();
  root.querySelectorAll(`[${FILE_ATTR}]`).forEach((el) => {
    const path = el.getAttribute(FILE_ATTR);
    if (!path || seen.has(path)) return;
    seen.add(path);
    values.push({
      path,
      name: (el as HTMLElement).dataset.fileName || path.split(/[\\/]/).pop() || path,
      kind: el.getAttribute(FILE_KIND_ATTR) === "image" ? "image" : "text",
    });
  });
  return values;
}

// 构造一个技能 chip 元素（不可编辑、原子）
function createSkillChip(skill: { id: string; name: string }): HTMLElement {
  const chip = document.createElement("span");
  chip.setAttribute(SKILL_ATTR, skill.id);
  chip.setAttribute("contenteditable", "false");
  chip.dataset.skillName = skill.name;
  chip.className =
    "mx-0.5 inline-flex select-none items-center gap-1 rounded-md bg-accent px-1.5 py-0.5 align-middle text-xs font-medium text-accent-foreground";
  chip.textContent = `# ${skill.name}`;
  return chip;
}

// 构造一个文件 chip 元素（不可编辑、原子）：绿色系底 + 文件图标 + 文件名
function createFileChip(file: ComposerAttachment): HTMLElement {
  const chip = document.createElement("span");
  chip.setAttribute(FILE_ATTR, file.path);
  chip.setAttribute(FILE_KIND_ATTR, file.kind);
  chip.setAttribute("contenteditable", "false");
  chip.dataset.fileName = file.name;
  chip.title = file.path;
  chip.className =
    file.kind === "image"
      ? "mx-0.5 inline-flex select-none items-center gap-1 rounded-md bg-sky-500/15 px-1.5 py-0.5 align-middle text-xs font-medium text-sky-700 dark:text-sky-400"
      : "mx-0.5 inline-flex select-none items-center gap-1 rounded-md bg-emerald-500/15 px-1.5 py-0.5 align-middle text-xs font-medium text-emerald-700 dark:text-emerald-400";
  // 图标 + 文件名（图标用内联 SVG，文件名用文本节点避免 XSS）
  chip.innerHTML = file.kind === "image" ? IMAGE_ICON_SVG : FILE_ICON_SVG;
  chip.appendChild(document.createTextNode(file.name));
  return chip;
}

export const SkillComposerInput = forwardRef<
  SkillComposerHandle,
  SkillComposerInputProps
>(function SkillComposerInput(
  {
    value,
    placeholder,
    className,
    onChange,
    onSkillsChange,
    onFilesChange,
    onEnter,
  },
  ref,
) {
  const editorRef = useRef<HTMLDivElement>(null);

  // 把当前 DOM 的文本 / 技能 / 文件回传给上层
  const emit = useCallback(() => {
    const root = editorRef.current;
    if (!root) return;
    onChange(extractText(root));
    onSkillsChange(extractAttrValues(root, SKILL_ATTR));
    onFilesChange(extractFiles(root));
  }, [onChange, onSkillsChange, onFilesChange]);

  // 外部 value 被清空（如发送后）时，同步清空编辑区 DOM。
  // 仅在「外部为空但 DOM 非空」时介入，避免每次输入都覆盖光标。
  useEffect(() => {
    const root = editorRef.current;
    if (!root) return;
    if (value === "" && extractText(root) !== "" && root.querySelectorAll(`[${SKILL_ATTR}], [${FILE_ATTR}]`).length === 0) {
      root.innerHTML = "";
      onSkillsChange([]);
      onFilesChange([]);
    }
  }, [value, onSkillsChange, onFilesChange]);

  // 在当前光标处插入 chip 元素（光标不在编辑区时追加到末尾）
  const insertChip = useCallback(
    (chip: HTMLElement) => {
      const root = editorRef.current;
      if (!root) return;
      root.focus();
      const space = document.createTextNode(" ");

      const selection = window.getSelection();
      const inEditor =
        selection &&
        selection.rangeCount > 0 &&
        root.contains(selection.getRangeAt(0).startContainer);

      if (inEditor) {
        const range = selection.getRangeAt(0);
        range.deleteContents();
        range.insertNode(space);
        range.insertNode(chip);
        // 光标移到插入内容之后
        range.setStartAfter(space);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
      } else {
        // 光标不在编辑区：追加到末尾
        root.appendChild(chip);
        root.appendChild(space);
      }
      emit();
    },
    [emit],
  );

  useImperativeHandle(
    ref,
    () => ({
      insertSkill: (skill) => {
        const root = editorRef.current;
        if (!root) return;
        // 重复技能忽略
        if (root.querySelector(`[${SKILL_ATTR}="${CSS.escape(skill.id)}"]`)) {
          return;
        }
        insertChip(createSkillChip(skill));
      },
      insertText: (text) => {
        const root = editorRef.current;
        if (!root || !text) return;
        root.focus();
        const textNode = document.createTextNode(text);
        const selection = window.getSelection();
        const inEditor =
          selection &&
          selection.rangeCount > 0 &&
          root.contains(selection.getRangeAt(0).startContainer);

        if (inEditor) {
          const range = selection.getRangeAt(0);
          range.deleteContents();
          range.insertNode(textNode);
          range.setStartAfter(textNode);
          range.collapse(true);
          selection.removeAllRanges();
          selection.addRange(range);
        } else {
          root.appendChild(textNode);
        }
        emit();
      },
      insertFile: (file) => {
        const root = editorRef.current;
        if (!root) return;
        // 重复文件路径忽略
        if (root.querySelector(`[${FILE_ATTR}="${CSS.escape(file.path)}"]`)) {
          return;
        }
        insertChip(createFileChip(file));
      },
      clear: () => {
        const root = editorRef.current;
        if (root) root.innerHTML = "";
        onChange("");
        onSkillsChange([]);
        onFilesChange([]);
      },
      focus: () => editorRef.current?.focus(),
    }),
    [insertChip, onChange, onSkillsChange, onFilesChange],
  );

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      onEnter?.();
    }
  };

  return (
    <div
      ref={editorRef}
      role="textbox"
      aria-multiline="true"
      contentEditable
      suppressContentEditableWarning
      data-placeholder={placeholder}
      onInput={emit}
      onKeyDown={handleKeyDown}
      className={cn(
        // 空内容时用 data-placeholder 显示占位（见 index.css 的 [contenteditable] 规则）
        "composer-editable w-full whitespace-pre-wrap break-words outline-none",
        className,
      )}
    />
  );
});

// 行内技能 chip 的图标（导出供选择弹层复用展示）
export function SkillChipIcon() {
  return <Hash className="size-3" />;
}
