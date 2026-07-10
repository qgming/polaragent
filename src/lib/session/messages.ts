import { GUIDANCE_ENTRY } from "./entries";
import {
  openOrCreateScheduleSession,
  openOrCreateSession,
} from "./lifecycle";

export async function appendGuidanceMessage(
  sessionId: string,
  text: string,
): Promise<void> {
  try {
    const session = await openOrCreateSession(sessionId);
    await session.appendCustomEntry(GUIDANCE_ENTRY, {
      text,
      createdAt: Date.now(),
    });
  } catch (error) {
    console.error(`写入会话引导失败 ${sessionId}:`, error);
  }
}

export async function appendScheduleGuidanceMessage(
  sessionId: string,
  text: string,
): Promise<void> {
  try {
    const session = await openOrCreateScheduleSession(sessionId);
    await session.appendCustomEntry(GUIDANCE_ENTRY, {
      text,
      createdAt: Date.now(),
    });
  } catch (error) {
    console.error(`写入定时任务会话引导失败 ${sessionId}:`, error);
  }
}
