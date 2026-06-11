// 网络搜索设置 —— 配置卡共享组件
// 各服务商配置卡共用的卡片外壳、保存按钮与复选项块，
// 基础字段（ApiKeyField / TextField）复用自 settings/shared-fields。

import { type ReactNode } from "react";
import { Check, Loader2, Save, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { openExternal } from "@/lib/electron/electron-api";

export { ApiKeyField, TextField, labelClass } from "../shared-fields";

export type SaveState = "idle" | "saving" | "saved";

// 配置卡外壳：图标 + 标题 + 说明文字 + 内容区
export function ConfigCard({
  title,
  description,
  children,
}: {
  title: string;
  description: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border bg-card">
      <div className="px-5 py-5">
        <div className="flex items-center gap-2">
          <Search className="size-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">{title}</h3>
        </div>
        <p className="mt-2 text-sm text-muted-foreground">{description}</p>
        <div className="mt-4 space-y-4">{children}</div>
      </div>
    </div>
  );
}

// 文本链接按钮（打开外部页面）
export function ExternalLink({ url, children }: { url: string; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={() => void openExternal(url)}
      className="text-primary hover:underline cursor-pointer"
    >
      {children}
    </button>
  );
}

// 复选框项
export function CheckboxRow({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: ReactNode;
}) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="size-4"
      />
      <span>{children}</span>
    </label>
  );
}

// 「完整内容选项」分组块（带标题与底部提示）
export function ContentOptionsGroup({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-muted/30 px-4 py-3">
      <h4 className="mb-3 text-xs font-semibold text-foreground">
        完整内容选项（增强搜索结果）
      </h4>
      <div className="space-y-2">{children}</div>
      <p className="mt-2 text-xs text-muted-foreground">
        注意：启用这些选项会返回更多内容，但会消耗更多 token。
      </p>
    </div>
  );
}

// 底部保存按钮（统一三态展示）
export function SaveButton({ state, onSave }: { state: SaveState; onSave: () => void }) {
  return (
    <div className="flex justify-end pt-2">
      <Button onClick={() => void onSave()} disabled={state === "saving"}>
        {state === "saving" ? (
          <Loader2 className="size-4 animate-spin" />
        ) : state === "saved" ? (
          <Check className="size-4" />
        ) : (
          <Save className="size-4" />
        )}
        保存配置
      </Button>
    </div>
  );
}
