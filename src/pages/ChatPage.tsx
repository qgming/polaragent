// 对话页：assistant-ui Thread
// src/pages/ChatPage.tsx

import { Thread } from "@/components/assistant-ui/elements/thread.aui";
import { PolarAgentToolFallback } from "@/components/assistant-ui/extensions/PolarAgentToolFallback";
import { PolarComposerExtras } from "@/components/assistant-ui/extensions/PolarComposerExtras";

export function ChatPage({ threadId }: { threadId: string }) {
  return (
    <div className="flex h-full min-h-0 w-full">
      <div className="flex min-w-0 flex-1 flex-col">
        {threadId ? <PolarComposerExtras threadId={threadId} /> : null}
        <div className="min-h-0 flex-1">
          <Thread
            components={{
              ToolFallback: PolarAgentToolFallback,
            }}
          />
        </div>
      </div>
    </div>
  );
}
