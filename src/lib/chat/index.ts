export type {
  ChatAttachment,
  ChatMessage,
  ChatMessageMetadata,
  ChatMessagePart,
  ChatMessageStatus,
  ChatRole,
  ChatThread,
  GuidancePart,
  MessageFinishMetadata,
  ReasoningPart,
  TextPart,
  ToolCallPart,
} from "./types";

export { hasVisibleText, partsToPlainText } from "./types";
export { extractMessageParts, type ToolResultSummary } from "./parts";
export {
  convertLegacyChatMessage,
  convertLegacyChatMessages,
  convertLegacySegments,
  isLegacyChatMessage,
} from "./legacy-convert";
