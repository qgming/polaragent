import type { Settings } from "@/types/config";
import type { MemoryApiConfig } from "./types";

export function memoryApiConfigFromSettings(settings: Settings): MemoryApiConfig | null {
  const embedding = settings.knowledge?.embedding;
  if (!embedding?.apiKey || !embedding.baseURL || !embedding.model) {
    return null;
  }
  return {
    embedding: {
      apiKey: embedding.apiKey,
      baseURL: embedding.baseURL,
      model: embedding.model,
      dimension: embedding.dimension,
    },
  };
}
