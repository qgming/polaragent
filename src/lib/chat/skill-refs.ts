import type { SkillConfig } from "@/types/config";
import type { ChatSkillRef } from "./types";

export function buildSkillRefs(
  skillIds: string[],
  skills: SkillConfig[],
): ChatSkillRef[] {
  if (skillIds.length === 0) return [];

  const namesById = new Map(skills.map((skill) => [skill.id, skill.name]));
  const seen = new Set<string>();
  const refs: ChatSkillRef[] = [];

  for (const id of skillIds) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    refs.push({
      id,
      name: namesById.get(id) ?? id,
    });
  }

  return refs;
}
