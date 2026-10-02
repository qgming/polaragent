import type { ChatMessage, SessionSummary } from "@/shared/contracts";

/** A provisional display only: never writes over the generated or manual title. */
export function sessionDisplayTitle(
  session: Pick<SessionSummary, "title">,
  messages: readonly ChatMessage[] | undefined,
  fallback: string,
): string {
  if (session.title?.trim()) return session.title;
  const first = messages?.find((message) => message.role === "user");
  const text = first?.parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join(" ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!text) return fallback;
  const chars = Array.from(text);
  return chars.length > 40 ? `${chars.slice(0, 40).join("")}…` : text;
}

export function selectSessionTitles(state: {
  sessions: SessionSummary[];
  messagesBySession: Record<string, ChatMessage[]>;
}): Record<string, string> {
  return Object.fromEntries(
    state.sessions.map((session) => [
      session.id,
      sessionDisplayTitle(session, state.messagesBySession[session.id], ""),
    ]),
  );
}
