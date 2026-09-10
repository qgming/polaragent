// AGENTS.md 设置面板：仅内容编辑
// src/components/settings/AgentsMdPanel.tsx

import { useEffect, useState } from "react";
import { FileText, Loader2, Save } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { readAgentsMd, writeAgentsMd } from "@/lib/electron/electron-api";
import { invalidateAgentsMdCache } from "@/ai/agents-md";
import { PageTitle } from "./settings-shared";

export function AgentsMdPanel({ embedded }: { embedded?: boolean }) {
  const [content, setContent] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [status, setStatus] = useState("");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setIsLoading(true);
      try {
        const text = await readAgentsMd();
        if (!cancelled) setContent(text);
      } catch (error) {
        if (!cancelled) {
          console.warn("读取 AGENTS.md 失败:", error);
          setContent("");
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSave = async () => {
    setIsSaving(true);
    setStatus("");
    try {
      await writeAgentsMd(content);
      invalidateAgentsMdCache();
      setStatus("已保存");
    } catch (error) {
      console.error("保存 AGENTS.md 失败:", error);
      setStatus("保存失败，请重试");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-8">
      {!embedded ? (
        <PageTitle
          title="个性化"
          description="自定义 AGENTS.md 指令，作为系统提示词注入每一轮对话"
        />
      ) : (
        <h3 className="text-sm font-semibold text-muted-foreground">个性化</h3>
      )}

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <p className="flex items-center gap-2 text-sm font-medium">
              <FileText className="size-4" />
              AGENTS.md 内容
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              保存在数据目录下，保存后对新一轮对话立即生效
            </p>
          </div>
          <Button size="sm" disabled={isSaving || isLoading} onClick={() => void handleSave()}>
            {isSaving ? (
              <Loader2 className="mr-1.5 size-3.5 animate-spin" />
            ) : (
              <Save className="mr-1.5 size-3.5" />
            )}
            保存
          </Button>
        </div>
        {isLoading ? (
          <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
            <Loader2 className="mr-2 size-4 animate-spin" />
            加载中...
          </div>
        ) : (
          <Textarea
            value={content}
            onChange={(event) => setContent(event.target.value)}
            placeholder="在这里写下希望 Agent 始终遵守的指令..."
            className="app-scrollbar min-h-[360px] font-mono text-sm"
          />
        )}
        {status ? <p className="text-xs text-muted-foreground">{status}</p> : null}
      </section>
    </div>
  );
}
