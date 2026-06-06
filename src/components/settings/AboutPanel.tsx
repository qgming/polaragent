// 关于软件面板
// src/components/settings/AboutPanel.tsx

import { Info, Sparkles } from "lucide-react";

import { PageTitle } from "./shared";

export function AboutPanel() {
  return (
    <section>
      <PageTitle title="关于软件" description="PolarAgent 的版本与应用信息。" />

      <div className="mt-8 rounded-xl border border-border bg-card">
        <div className="px-5 py-5">
          <div className="flex items-center gap-2">
            <Info className="size-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold">PolarAgent</h3>
          </div>
          <p className="mt-2 text-sm text-muted-foreground">
            面向本地工作的 AI Agent 桌面应用，支持普通会话、团队协作、技能与工具扩展。
          </p>

          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            <InfoItem label="当前版本" value="0.1.0" />
            <InfoItem label="运行模式" value="本地桌面应用" />
          </div>
        </div>
      </div>

      <div className="mt-6 rounded-xl border border-border bg-card">
        <div className="px-5 py-5">
          <div className="flex items-center gap-2">
            <Sparkles className="size-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold">能力概览</h3>
          </div>
          <p className="mt-2 text-sm text-muted-foreground">
            聚合多模型 Provider、会话持久化、团队 Agent 协作、技能市场与本地文件工作流。
          </p>
        </div>
      </div>
    </section>
  );
}

function InfoItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-muted/30 px-3 py-2.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 truncate text-sm font-medium text-foreground">{value}</p>
    </div>
  );
}
