// CLI 工具检测面板
// src/components/settings/CliToolsPanel.tsx

import { useEffect, useState } from "react";
import { MessageSquare, Code2, GitBranch, Smartphone, CheckCircle2, AlertTriangle, ExternalLink, XCircle, ArrowUpCircle, LucideIcon } from "lucide-react";
import { detectCliBatch, getCliVersions, openExternal } from "@/lib/electron/electron-api";
import { PageTitle } from "./settings-shared";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/useToast";

type CliTool = {
  name: string;
  displayName: string;
  description: string;
  url: string;
  icon: LucideIcon;
};

type EnvTool = {
  name: string;
  displayName: string;
  updateCommand?: string;
};

const CLI_TOOLS: CliTool[] = [
  {
    name: "lark-cli",
    displayName: "Lark CLI",
    description: "飞书 API 命令行工具，支持 200+ 命令和 20+ AI Agent 技能",
    url: "https://github.com/larksuite/cli",
    icon: MessageSquare,
  },
  {
    name: "dingtalk-cli",
    displayName: "DingTalk CLI",
    description: "钉钉工作台 CLI，为 AI Agent 设计的命令行工具",
    url: "https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli",
    icon: Smartphone,
  },
  {
    name: "gh",
    displayName: "GitHub CLI",
    description: "GitHub 官方命令行工具，从终端直接操作 PR、Issues 等",
    url: "https://cli.github.com",
    icon: Code2,
  },
  {
    name: "git",
    displayName: "Git",
    description: "分布式版本控制系统，管理代码版本和协作开发",
    url: "https://git-scm.com",
    icon: GitBranch,
  },
];

const ENV_TOOLS: EnvTool[] = [
  { name: "node", displayName: "Node.js", updateCommand: "https://nodejs.org" },
  { name: "npm", displayName: "npm", updateCommand: "npm install -g npm@latest" },
  { name: "npx", displayName: "npx" },
  { name: "python", displayName: "Python", updateCommand: "https://www.python.org/downloads/" },
  { name: "python3", displayName: "Python 3", updateCommand: "https://www.python.org/downloads/" },
  { name: "pip", displayName: "pip", updateCommand: "python -m pip install --upgrade pip" },
  { name: "uv", displayName: "uv", updateCommand: "pip install --upgrade uv" },
];

export function CliToolsPanel() {
  const [toolStatus, setToolStatus] = useState<Map<string, "installed" | "error" | "unknown">>(new Map());
  const [toolVersions, setToolVersions] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const { success } = useToast();

  useEffect(() => {
    const checkTools = async () => {
      try {
        const allCommands = [...CLI_TOOLS.map(t => t.name), ...ENV_TOOLS.map(t => t.name)];
        const results = await detectCliBatch(allCommands);
        const statusMap = new Map<string, "installed" | "error" | "unknown">();
        results.forEach(r => {
          statusMap.set(r.command, r.exists ? "installed" : "unknown");
        });
        setToolStatus(statusMap);

        const versions = await getCliVersions(allCommands);
        const versionMap = new Map<string, string>();
        versions.forEach(v => {
          if (v.version) {
            versionMap.set(v.command, v.version);
          }
        });
        setToolVersions(versionMap);
      } catch {
        setToolStatus(new Map());
        setToolVersions(new Map());
      } finally {
        setLoading(false);
      }
    };
    void checkTools();
  }, []);

  const handleCardClick = (url: string) => {
    openExternal(url);
  };

  const handleUpdate = (updateCommand: string) => {
    navigator.clipboard.writeText(updateCommand);
    success("复制命令成功");
  };

  return (
    <section>
      <PageTitle title="CLI 工具" description="推荐的 AI Agent 命令行工具，点击访问官网了解更多。" />

      <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {CLI_TOOLS.map((tool) => {
          const status = toolStatus.get(tool.name) || "unknown";
          const Icon = tool.icon;

          return (
            <button
              key={tool.name}
              onClick={() => handleCardClick(tool.url)}
              className="group flex min-h-[116px] flex-col rounded-xl border border-border bg-card p-4 text-left transition-all hover:border-[#9b6fe0]/30 hover:shadow-sm"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex min-w-0 items-start gap-3">
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted">
                    <Icon className="size-5 text-muted-foreground" />
                  </div>
                  <div className="min-w-0">
                    <h3 className="truncate text-sm font-semibold">{tool.displayName}</h3>
                    <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                      {!loading && status === "installed" && (
                        <CheckCircle2 className="size-3 text-green-600" />
                      )}
                      {!loading && status === "error" && (
                        <AlertTriangle className="size-3 text-yellow-600" />
                      )}
                      <code>{tool.name}</code>
                    </p>
                  </div>
                </div>
                <ExternalLink className="size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground" />
              </div>

              <p className="mt-3 line-clamp-2 min-h-[40px] text-sm leading-5 text-muted-foreground">
                {tool.description}
              </p>
            </button>
          );
        })}
      </div>

      <div className="mt-12">
        <h3 className="text-sm font-semibold text-foreground">环境检测</h3>

        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {ENV_TOOLS.map((tool) => {
            const status = toolStatus.get(tool.name) || "unknown";
            const version = toolVersions.get(tool.name);

            return (
              <div
                key={tool.name}
                className="flex h-[90px] flex-col rounded-xl border border-border bg-card p-3"
              >
                <div className="flex items-start justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      {!loading && status === "installed" && (
                        <CheckCircle2 className="size-4 shrink-0 text-green-600" />
                      )}
                      {!loading && status === "unknown" && (
                        <XCircle className="size-4 shrink-0 text-muted-foreground" />
                      )}
                      {!loading && status === "error" && (
                        <AlertTriangle className="size-4 shrink-0 text-yellow-600" />
                      )}
                      <h4 className="truncate text-sm font-semibold">{tool.displayName}</h4>
                    </div>
                  </div>
                  {status === "installed" && tool.updateCommand && (
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-7 shrink-0"
                      onClick={() => handleUpdate(tool.updateCommand!)}
                    >
                      <ArrowUpCircle className="size-3.5" />
                    </Button>
                  )}
                </div>

                <div className="mt-auto space-y-1">
                  {version && (
                    <div className="flex items-center justify-between gap-2 text-xs">
                      <span className="shrink-0 text-muted-foreground">当前版本</span>
                      <span className="truncate font-mono">{version}</span>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
