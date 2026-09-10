// 关于软件面板
// src/components/settings/AboutPanel.tsx

import { PageTitle } from "./settings-shared";
import logo from "@/assets/logo.png";

export function AboutPanel() {
  const version = "0.6.0";

  return (
    <section>
      <PageTitle title="关于" description="版本与产品信息" />

      {/* 主卡片 - Logo 和基本信息 */}
      <div className="mt-8 rounded-xl border border-border bg-gradient-to-br from-card to-muted/20">
        <div className="px-8 py-8">
          {/* Logo 和名称布局 */}
          <div className="flex items-center gap-6">
            {/* 左侧 Logo - 纯 logo，无边框无背景 */}
            <div className="size-20 shrink-0">
              <img
                src={logo}
                alt="PolarAgent Logo"
                className="size-full object-contain"
              />
            </div>

            {/* 右侧名称和版本 */}
            <div className="flex flex-1 items-center gap-3">
              <h2 className="text-2xl font-bold tracking-tight">PolarAgent</h2>
              <span className="inline-flex items-center rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
                {version}
              </span>
            </div>
          </div>

          {/* 下方介绍 - 无背景卡片 */}
          <div className="mt-6">
            <p className="text-sm leading-relaxed text-muted-foreground">
              基于 pi-agent-core 的本地桌面 Agent 工作台。对话由 pisdk 会话仓库持久化，
              工具面为 pisdk 原生四件套（bash / read / write / edit）。
            </p>
          </div>
        </div>
      </div>

      {/* 底部版权 */}
      <div className="mt-8 text-center">
        <p className="text-xs text-muted-foreground">
          © 2026 PolarAgent. All rights reserved.
        </p>
      </div>
    </section>
  );
}
