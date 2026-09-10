import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import { GUIDANCE_ENTRY } from "./entries";
import { openOrCreateSession } from "./lifecycle";

export async function appendGuidanceMessage(
  sessionId: string,
  text: string,
): Promise<void> {
  try {
    const session = await openOrCreateSession(sessionId);
    const branch = await session.branch("main", BACKGROUND_CONTEXT);
    if (!branch) return;
    await branch.appendCustomEntry(GUIDANCE_ENTRY, {
      text,
      createdAt: Date.now(),
    }, BACKGROUND_CONTEXT);
  } catch (error) {
    console.error(`写入会话引导失败 ${sessionId}:`, error);
  }
}
