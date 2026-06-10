// 页面头部 Hero：大标题 + 介绍卡片（右上角带图标角标）
// 五个资源页面（技能 / 助手 / 工具 / 团队 / 知识库）共用此组件。
import type { IconComponent } from "@/lib/navigation";
import { cn } from "@/lib/utils";

export function PageHero({
  title,
  bannerTitle,
  bannerDescription,
  icon: Icon,
  kitLabel,
  rotate = "right",
}: {
  // 页面大标题
  title: string;
  // 介绍卡片标题
  bannerTitle: string;
  // 介绍卡片描述
  bannerDescription: string;
  // 右上角角标图标
  icon: IconComponent;
  // 右上角角标文字（如 Skill Kit）
  kitLabel: string;
  // 角标卡片倾斜方向，默认向右(10°)，部分页面向左(-12°)
  rotate?: "left" | "right";
}) {
  return (
    <>
      <h1 className="text-3xl font-semibold tracking-normal">{title}</h1>
      <div className="mt-6 overflow-hidden rounded-lg bg-accent">
        <div className="relative min-h-[116px] px-7 py-7">
          <h2 className="text-lg font-semibold">{bannerTitle}</h2>
          <p className="mt-3 max-w-[600px] text-sm text-muted-foreground">
            {bannerDescription}
          </p>
          <div
            className={cn(
              "absolute right-10 top-4 hidden rounded-md border border-border bg-card px-5 py-4 shadow-sm md:block",
              rotate === "left" ? "rotate-[-12deg]" : "rotate-[10deg]",
            )}
          >
            <Icon className="size-7" />
            <p className="mt-2 text-xs font-medium">{kitLabel}</p>
          </div>
        </div>
      </div>
    </>
  );
}
