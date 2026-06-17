// 对话列表项：点击进入对话；hover 出「更多」菜单（重命名/清空/删除）
import { Loader2, MoreHorizontal } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export function ThreadItem({
  active,
  onClear,
  onDelete,
  onClick,
  onRename,
  running,
  thread,
}: {
  active: boolean;
  onClear: () => void;
  onDelete: () => void;
  onClick: () => void;
  onRename: (title: string) => void;
  running: boolean;
  thread: { id: string; title: string; updatedAt: number };
}) {
  const { t } = useTranslation("common");
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const [draftTitle, setDraftTitle] = useState(thread.title);

  useEffect(() => {
    setDraftTitle(thread.title);
  }, [thread.title]);

  const handleRename = () => {
    onRename(draftTitle);
    setRenameOpen(false);
  };

  return (
    <>
      <div
        className={cn(
          "group grid h-9 w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-md px-3 text-left text-sm transition-colors",
          active
            ? "bg-black/[0.06] text-foreground dark:bg-white/[0.08]"
            : "text-sidebar-foreground hover:bg-muted hover:text-foreground",
        )}
      >
        <button
          className="min-w-0 truncate text-left font-medium"
          onClick={onClick}
          type="button"
        >
          {thread.title}
        </button>
        {/* 右侧操作区：运行中常驻旋转图标，hover 整行时「更多」按钮从其左侧滑出；
            未运行时仅 hover 才显示「更多」按钮（与原行为一致）。 */}
        <div className="flex items-center justify-end gap-0.5">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className={cn(
                  "flex size-7 items-center justify-center rounded-md text-muted-foreground transition-opacity hover:bg-background hover:text-foreground data-[state=open]:opacity-100",
                  "opacity-0 group-hover:opacity-100",
                )}
                type="button"
              >
                <MoreHorizontal className="size-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-32">
              <DropdownMenuItem onSelect={() => setRenameOpen(true)}>
	                {t("sidebar.rename")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setClearOpen(true)}>
	                {t("sidebar.clearChat")}
              </DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => setDeleteOpen(true)}
              >
	                {t("delete")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {running ? (
            <span
              className="flex size-7 shrink-0 items-center justify-center text-[#9b6fe0]"
	              title={t("sidebar.running")}
            >
              <Loader2 className="size-4 animate-spin" />
            </span>
          ) : null}
        </div>
      </div>

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent>
          <DialogHeader>
	            <DialogTitle>{t("sidebar.renameChatTitle")}</DialogTitle>
	            <DialogDescription>
	              {t("sidebar.renameChatDescription")}
	            </DialogDescription>
          </DialogHeader>
          <input
            autoFocus
            className="h-10 rounded-md border border-input bg-background px-3 text-sm outline-none focus:border-ring"
            onChange={(event) => setDraftTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                handleRename();
              }
            }}
            value={draftTitle}
          />
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" type="button">
	                {t("cancel")}
              </Button>
            </DialogClose>
            <Button onClick={handleRename} type="button">
	              {t("save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
	            <DialogTitle>{t("sidebar.deleteChatTitle")}</DialogTitle>
	            <DialogDescription>
	              {t("sidebar.deleteChatDescription", { title: thread.title })}
	            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" type="button">
	                {t("cancel")}
              </Button>
            </DialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                onDelete();
                setDeleteOpen(false);
              }}
              type="button"
            >
	              {t("delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={clearOpen} onOpenChange={setClearOpen}>
        <DialogContent>
          <DialogHeader>
	            <DialogTitle>{t("sidebar.clearChatTitle")}</DialogTitle>
	            <DialogDescription>
	              {t("sidebar.clearChatDescription", { title: thread.title })}
	            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" type="button">
	                {t("cancel")}
              </Button>
            </DialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                onClear();
                setClearOpen(false);
              }}
              type="button"
            >
	              {t("sidebar.clear")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
