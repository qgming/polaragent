import { Search } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import type { ChatMessage, ChatThread } from "@/stores/chat-store";
import { useChatStore } from "@/stores/chat-store";
import {
  type TeamMessage,
  type TeamThread,
  useTeamChatStore,
} from "@/stores/team-chat-store";
import { useTeamsStore } from "@/stores/teams-store";
import { cn } from "@/lib/utils";

type ChatSearchResult = {
  id: string;
  kind: "chat";
  title: string;
  excerpt: string;
  score: number;
  updatedAt: number;
  threadId: string;
};

type TeamSearchResult = {
  id: string;
  kind: "team";
  title: string;
  excerpt: string;
  score: number;
  teamId: string;
  teamName: string;
  threadId: string;
  updatedAt: number;
};

type SearchResult = ChatSearchResult | TeamSearchResult;

const easeOut = [0.16, 1, 0.3, 1] as const;
const easeInOut = [0.65, 0, 0.35, 1] as const;

const panelVariants = {
  closed: {
    height: 0,
    opacity: 0,
    transition: {
      height: { duration: 0.2, ease: easeInOut },
      opacity: { duration: 0.12, ease: easeOut },
    },
  },
  open: {
    height: "auto",
    opacity: 1,
    transition: {
      height: { duration: 0.26, ease: easeOut },
      opacity: { duration: 0.14, ease: easeOut },
    },
  },
} as const;

const contentVariants = {
  hidden: {
    opacity: 0,
    y: -4,
    transition: { duration: 0.1, ease: easeOut },
  },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.16, ease: easeOut, delay: 0.04 },
  },
} as const;

export function GlobalSessionSearch({
  onOpenChange,
  onOpenTeamThread,
  onOpenThread,
  open,
}: {
  onOpenChange: (open: boolean) => void;
  onOpenTeamThread: (teamId: string, threadId: string) => void;
  onOpenThread: (threadId: string) => void;
  open: boolean;
}) {
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const threads = useChatStore((state) => state.threads);
  const teamThreads = useTeamChatStore((state) => state.threads);
  const teams = useTeamsStore((state) => state.teams);

  const trimmedQuery = query.trim();

  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }

    const timer = window.setTimeout(() => {
      inputRef.current?.focus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    if (!open || !trimmedQuery) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        const chatStore = useChatStore.getState();
        const teamStore = useTeamChatStore.getState();
        const unloadedThreads = chatStore.threads.filter((thread) => !thread.loaded);
        const unloadedTeamThreads = teamStore.threads.filter(
          (thread) => !thread.loaded,
        );

        if (unloadedThreads.length === 0 && unloadedTeamThreads.length === 0) {
          return;
        }

        setLoading(true);
        await Promise.all([
          ...unloadedThreads.map((thread) =>
            chatStore.loadThreadMessages(thread.id),
          ),
          ...unloadedTeamThreads.map((thread) =>
            teamStore.loadTeamThreadMessages(thread.id),
          ),
        ]);

        if (!cancelled) {
          setLoading(false);
        }
      })();
    }, 120);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, trimmedQuery]);

  const results = useMemo(
    () => buildResults(trimmedQuery, threads, teamThreads, teams),
    [teamThreads, teams, threads, trimmedQuery],
  );

  const handleSelect = (result: SearchResult) => {
    onOpenChange(false);
    if (result.kind === "chat") {
      onOpenThread(result.threadId);
      return;
    }
    onOpenTeamThread(result.teamId, result.threadId);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="top-[14vh] max-h-[78vh] max-w-[min(1040px,calc(100vw-2rem))] translate-y-0 overflow-hidden rounded-2xl border-border/80 bg-card/95 p-0 shadow-2xl backdrop-blur data-[state=open]:slide-in-from-top-4 data-[state=closed]:slide-out-to-top-4"
        showCloseButton={false}
      >
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ type: "spring", stiffness: 520, damping: 38 }}
          className="w-full min-w-0 overflow-hidden"
        >
          <DialogTitle className="sr-only">全局会话搜索</DialogTitle>
          <DialogDescription className="sr-only">
            搜索普通会话和团队会话中的内容。
          </DialogDescription>

          <div className="flex h-16 items-center gap-3 border-b border-border px-5">
            <Search className="size-5 shrink-0 text-muted-foreground" />
            <input
              ref={inputRef}
              className="h-full min-w-0 flex-1 bg-transparent text-lg text-foreground outline-none placeholder:text-muted-foreground"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索会话内容..."
              value={query}
            />
          </div>

          <AnimatePresence initial={false}>
            {trimmedQuery ? (
              <motion.div
                key="results-panel"
                variants={panelVariants}
                initial="closed"
                animate="open"
                exit="closed"
                className="w-full min-w-0 overflow-hidden"
              >
                <motion.div
                  variants={contentVariants}
                  initial="hidden"
                  animate="visible"
                  exit="hidden"
                  className="w-full min-w-0 overflow-y-auto px-3 py-2"
                >
                  {results.length > 0 ? (
                    <div className="w-full min-w-0 space-y-0.5 overflow-hidden">
                      {results.map((result) => (
                        <button
                          key={result.id}
                          className="group block w-full max-w-full overflow-hidden rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-muted"
                          onClick={() => handleSelect(result)}
                          type="button"
                        >
                          <span className="block w-full min-w-0 overflow-hidden">
                            <span className="flex w-full min-w-0 items-center gap-2 overflow-hidden">
                              <span className="block min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-sm font-medium text-foreground">
                                {result.title}
                              </span>
                              {result.kind === "team" ? (
                                <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground group-hover:bg-background">
                                  {result.teamName}
                                </span>
                              ) : null}
                            </span>
                            <span
                              className={cn(
                                "mt-1 block w-full min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-xs leading-5 text-muted-foreground",
                                !result.excerpt && "italic",
                              )}
                            >
                              {result.excerpt || "标题匹配"}
                            </span>
                          </span>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="flex h-44 items-center justify-center text-sm text-muted-foreground">
                      {loading ? "搜索中..." : "未找到匹配的会话"}
                    </div>
                  )}
                </motion.div>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </motion.div>
      </DialogContent>
    </Dialog>
  );
}

function buildResults(
  query: string,
  threads: ChatThread[],
  teamThreads: TeamThread[],
  teams: Array<{ id: string; name: string }>,
): SearchResult[] {
  if (!query) {
    return [];
  }

  const teamNames = new Map(teams.map((team) => [team.id, team.name]));
  const chatResults = threads
    .map((thread) => scoreThread(query, thread))
    .filter((result): result is ChatSearchResult => result !== null);
  const teamResults = teamThreads
    .map((thread) => {
      const scored = scoreTeamThread(query, thread);
      if (!scored) {
        return null;
      }
      return {
        ...scored,
        teamName: teamNames.get(thread.teamId) ?? "团队",
      };
    })
    .filter((result): result is TeamSearchResult => result !== null);

  return [...chatResults, ...teamResults]
    .sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt)
    .slice(0, 30);
}

function scoreThread(query: string, thread: ChatThread): ChatSearchResult | null {
  const scored = scoreConversation(query, thread.title, thread.messages);
  if (!scored) {
    return null;
  }

  return {
    id: `chat-${thread.id}`,
    kind: "chat",
    threadId: thread.id,
    title: thread.title,
    updatedAt: thread.updatedAt,
    ...scored,
  };
}

function scoreTeamThread(
  query: string,
  thread: TeamThread,
): TeamSearchResult | null {
  const scored = scoreConversation(query, thread.title, thread.messages);
  if (!scored) {
    return null;
  }

  return {
    id: `team-${thread.id}`,
    kind: "team",
    teamId: thread.teamId,
    teamName: "团队",
    threadId: thread.id,
    title: thread.title,
    updatedAt: thread.updatedAt,
    ...scored,
  };
}

function scoreConversation(
  query: string,
  title: string,
  messages: Array<ChatMessage | TeamMessage>,
): { excerpt: string; score: number } | null {
  const normalizedQuery = normalize(query);
  const terms = normalizedQuery.split(/\s+/).filter(Boolean);
  const normalizedTitle = normalize(title);
  let score = 0;

  if (normalizedTitle.includes(normalizedQuery)) {
    score += normalizedTitle === normalizedQuery ? 120 : 70;
    if (normalizedTitle.startsWith(normalizedQuery)) {
      score += 25;
    }
  }

  for (const term of terms) {
    if (normalizedTitle.includes(term)) {
      score += 35;
    }
  }

  let bestExcerpt = "";
  let bestMessageScore = 0;
  let firstHit = Number.POSITIVE_INFINITY;

  for (const message of messages) {
    const text = messageText(message);
    const normalizedText = normalize(text);
    if (!normalizedText) {
      continue;
    }

    const fullCount = countMatches(normalizedText, normalizedQuery);
    const termCount = terms.reduce(
      (total, term) => total + countMatches(normalizedText, term),
      0,
    );
    if (fullCount === 0 && termCount === 0) {
      continue;
    }

    const index = normalizedText.indexOf(
      fullCount > 0 ? normalizedQuery : terms.find((term) => normalizedText.includes(term)) ?? "",
    );
    const positionBonus = index >= 0 ? Math.max(0, 25 - Math.floor(index / 80)) : 0;
    const roleBonus = message.role === "user" ? 8 : 0;
    const messageScore = fullCount * 45 + termCount * 14 + positionBonus + roleBonus;

    if (messageScore > bestMessageScore) {
      bestMessageScore = messageScore;
      bestExcerpt = createExcerpt(text, query);
    }
    if (index >= 0) {
      firstHit = Math.min(firstHit, index);
    }
  }

  score += bestMessageScore;
  if (Number.isFinite(firstHit)) {
    score += Math.max(0, 20 - Math.floor(firstHit / 120));
  }

  if (score === 0) {
    return null;
  }

  return { excerpt: bestExcerpt, score };
}

function messageText(message: ChatMessage | TeamMessage): string {
  const segmentText =
    message.segments
      ?.filter((segment) => segment.kind === "text" || segment.kind === "thinking")
      .map((segment) => ("text" in segment ? segment.text : ""))
      .join("\n") ?? "";
  return [message.content, segmentText].filter(Boolean).join("\n");
}

function normalize(value: string): string {
  return value.toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

function countMatches(source: string, needle: string): number {
  if (!needle) {
    return 0;
  }

  let count = 0;
  let index = source.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = source.indexOf(needle, index + needle.length);
  }
  return count;
}

function createExcerpt(text: string, query: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) {
    return "";
  }

  const normalizedCompact = normalize(compact);
  const normalizedQuery = normalize(query);
  const index = normalizedCompact.indexOf(normalizedQuery);
  const start = Math.max(0, index === -1 ? 0 : index - 36);
  const end = Math.min(compact.length, start + 110);
  return `${start > 0 ? "..." : ""}${compact.slice(start, end)}${
    end < compact.length ? "..." : ""
  }`;
}
