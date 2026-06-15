import type { SkillConfig } from "@/types/config";

export type SkillType = "builtin" | "custom";

export interface SkillMdFrontmatter {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  "allowed-tools"?: string;
}

export function parseSkillMdContent(
  content: string,
  options: {
    path: string;
    dirName: string;
    type?: SkillType;
  },
): SkillConfig {
  const frontmatterMatch = content.match(
    /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/,
  );
  if (!frontmatterMatch) {
    throw new Error("Invalid SKILL.md format: missing frontmatter");
  }

  const [, frontmatterText, body] = frontmatterMatch;
  const frontmatter = parseSimpleYaml(frontmatterText);

  if (!frontmatter.name || !frontmatter.description) {
    throw new Error("SKILL.md must have 'name' and 'description' fields");
  }

  if (!/^[a-z0-9-]+$/.test(frontmatter.name)) {
    throw new Error(`Invalid skill name: ${frontmatter.name}`);
  }

  if (options.dirName && frontmatter.name !== options.dirName) {
    console.warn(
      `Skill name '${frontmatter.name}' doesn't match directory '${options.dirName}'`,
    );
  }

  return {
    id: frontmatter.name,
    name: capitalize(frontmatter.name.replace(/-/g, " ")),
    description: frontmatter.description,
    version: frontmatter.metadata?.version || "1.0.0",
    type: options.type ?? "builtin",
    enabled: true,
    tools: [],
    filePath: options.path,
    permissions: parsePermissions(frontmatter.compatibility || ""),
    settings: {
      license: frontmatter.license,
      compatibility: frontmatter.compatibility,
      metadata: frontmatter.metadata,
      allowedTools: frontmatter["allowed-tools"],
      instructions: body.trim(),
    },
  };
}

export function validateSkillMdContent(content: string): string[] {
  const errors: string[] = [];

  if (!content.match(/^---\s*\n[\s\S]*?\n---\s*\n/)) {
    errors.push("Missing or invalid frontmatter in SKILL.md");
  }

  try {
    const config = parseSkillMdContent(content, {
      path: "SKILL.md",
      dirName: "",
    });
    if (!config.id || !config.description) {
      errors.push("Missing required fields: name or description");
    }
  } catch (error) {
    errors.push(`Parse error: ${error}`);
  }

  return errors;
}

function parseSimpleYaml(yaml: string): SkillMdFrontmatter {
  const result: Record<string, unknown> = {};
  const lines = yaml.split("\n");
  let currentObject: Record<string, string> | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    if (trimmed.endsWith(":") && !trimmed.includes(" ")) {
      currentObject = {};
      result[trimmed.slice(0, -1)] = currentObject;
      continue;
    }

    const colonIndex = trimmed.indexOf(":");
    if (colonIndex <= 0) continue;

    const key = trimmed.slice(0, colonIndex).trim();
    let rawValue = trimmed.slice(colonIndex + 1);
    let value = rawValue.trim();

    if (value === "|") {
      const blockLines: string[] = [];
      const baseIndent = line.length - trimmed.length;
      for (let j = i + 1; j < lines.length; j++) {
        const nextLine = lines[j];
        if (nextLine.trim() === "") {
          blockLines.push("");
          continue;
        }
        const nextIndent = nextLine.length - nextLine.trim().length;
        if (nextIndent <= baseIndent && nextLine.trim().length > 0) break;
        blockLines.push(nextLine.trimEnd());
        i = j;
      }
      value = blockLines.join("\n").trimEnd();
    } else {
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
    }

    if (currentObject && line.startsWith("  ")) {
      currentObject[key] = value;
    } else {
      result[key] = value;
      currentObject = null;
    }
  }

  return result as unknown as SkillMdFrontmatter;
}

function parsePermissions(compatibility: string): string[] {
  const permissions: string[] = [];
  const lower = compatibility.toLowerCase();

  if (lower.includes("internet") || lower.includes("network")) {
    permissions.push("network");
  }
  if (lower.includes("file")) {
    permissions.push("file_system");
  }
  if (
    lower.includes("python") ||
    lower.includes("code") ||
    lower.includes("execute")
  ) {
    permissions.push("code_execution");
  }

  return permissions;
}

function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}
