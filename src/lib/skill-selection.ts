export const ALL_SKILLS_ID = "*";

export function hasAllSkills(enabledSkills?: readonly string[]): boolean {
  return enabledSkills?.includes(ALL_SKILLS_ID) ?? false;
}

export function normalizeSkillSelection(
  enabledSkills?: readonly string[],
): string[] {
  if (hasAllSkills(enabledSkills)) {
    return [ALL_SKILLS_ID];
  }

  return Array.from(
    new Set((enabledSkills ?? []).map((id) => id.trim()).filter(Boolean)),
  );
}

export function resolveSkillSelection(
  enabledSkills: readonly string[],
  allSkillIds: readonly string[],
): string[] {
  if (hasAllSkills(enabledSkills)) {
    return Array.from(new Set(allSkillIds));
  }

  return normalizeSkillSelection(enabledSkills);
}
