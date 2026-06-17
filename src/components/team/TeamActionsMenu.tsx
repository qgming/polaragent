// 团队操作菜单：hover「更多」下拉 + 清空会话/删除确认弹窗
// 供「团队管理页卡片」与「侧边栏团队项」共用，保证两处操作功能一致

import { MoreHorizontal } from "lucide-react";
import { useState } from "react";
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

export function TeamActionsMenu({
  teamName,
  onEdit,
  onClear,
  onDelete,
  className,
}: {
  teamName: string;
  onEdit: () => void;
  onClear: () => void;
  onDelete: () => void;
  // 触发按钮的额外样式（如侧边栏的 hover 显隐）
  className?: string;
}) {
  const { t } = useTranslation("team");
  const [clearOpen, setClearOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={cn(
              "flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-background hover:text-foreground data-[state=open]:bg-background data-[state=open]:text-foreground",
              className,
            )}
            // 阻止冒泡，避免点击「更多」时触发卡片/列表项的进入会话
            onClick={(event) => event.stopPropagation()}
          >
            <MoreHorizontal className="size-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-32">
          <DropdownMenuItem onSelect={onEdit}>{t("actions.edit")}</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setClearOpen(true)}>
            {t("actions.clearSessions")}
          </DropdownMenuItem>
          <DropdownMenuItem
            variant="destructive"
            onSelect={() => setDeleteOpen(true)}
          >
            {t("actions.delete")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={clearOpen} onOpenChange={setClearOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("clear.title")}</DialogTitle>
            <DialogDescription>
              {t("clear.description", { name: teamName })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" type="button">
                {t("actions.cancel")}
              </Button>
            </DialogClose>
            <Button
              variant="destructive"
              type="button"
              onClick={() => {
                onClear();
                setClearOpen(false);
              }}
            >
              {t("actions.clear")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("delete.title")}</DialogTitle>
            <DialogDescription>
              {t("delete.description", { name: teamName })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" type="button">
                {t("actions.cancel")}
              </Button>
            </DialogClose>
            <Button
              variant="destructive"
              type="button"
              onClick={() => {
                onDelete();
                setDeleteOpen(false);
              }}
            >
              {t("actions.delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
