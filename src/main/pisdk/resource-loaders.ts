// Oint's resource catalog. pi-durable consumes prompt sections; filesystem discovery belongs to the host.

import path from "node:path";
import type { Context } from "@earendil-works/chord";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";

export type Skill = {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  disableModelInvocation?: boolean;
};
export type PromptTemplate = {
  name: string;
  description?: string;
  content: string;
  filePath: string;
};
export type ResourceDiagnostic = { code: string; message: string; path: string };

/** The metadata fields used by Oint are scalars, including YAML folded/literal descriptions. */
export function parseResourceMarkdown(raw: string): {
  metadata: Record<string, string>;
  content: string;
} {
  const text = raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  if (!text.startsWith("---\n")) return { metadata: {}, content: text.trim() };
  const lines = text.split("\n");
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end === -1) throw new Error("Frontmatter is missing its closing ---");
  const metadata: Record<string, string> = {};
  for (let index = 1; index < end; index += 1) {
    const match = /^([a-zA-Z][\w-]*):\s*(.*)$/.exec(lines[index] ?? "");
    if (!match?.[1]) continue;
    let value = (match[2] ?? "").trim();
    if (/^[>|][-+]?\s*$/.test(value)) {
      const folded = value.startsWith(">");
      const block: string[] = [];
      while (index + 1 < end && (/^\s/.test(lines[index + 1] ?? "") || lines[index + 1] === "")) {
        block.push((lines[++index] ?? "").trim());
      }
      value = block.join(folded ? " " : "\n").trim();
    } else if (value.startsWith('"') && value.endsWith('"')) {
      try {
        value = JSON.parse(value) as string;
      } catch {
        value = value.slice(1, -1);
      }
    } else if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1).replace(/''/g, "'");
    } else {
      value = value.replace(/\s+#.*$/, "");
    }
    metadata[match[1]] = value;
  }
  return {
    metadata,
    content: lines
      .slice(end + 1)
      .join("\n")
      .trim(),
  };
}

async function markdownFiles(
  env: ExecutionEnv,
  dirs: string | readonly string[],
  context: Context,
) {
  const files: string[] = [];
  const diagnostics: ResourceDiagnostic[] = [];
  const visit = async (dir: string, depth: number): Promise<void> => {
    context.abortSignal?.throwIfAborted();
    if (depth > 16) {
      diagnostics.push({
        code: "depth_limit",
        message: "Resource directory nesting exceeds 16",
        path: dir,
      });
      return;
    }
    const listed = await env.listDir(dir, context);
    if (!listed.ok) {
      if (listed.error.code !== "not_found")
        diagnostics.push({ code: listed.error.code, message: listed.error.message, path: dir });
      return;
    }
    for (const entry of [...listed.value].sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".")) continue;
      if (entry.kind === "file" && entry.name.toLowerCase().endsWith(".md")) files.push(entry.path);
      else if (entry.kind === "directory") await visit(entry.path, depth + 1);
    }
  };
  for (const dir of typeof dirs === "string" ? [dirs] : dirs) await visit(dir, 0);
  return { files, diagnostics };
}

export async function loadSkills(
  env: ExecutionEnv,
  dirs: string | readonly string[],
  context: Context,
): Promise<{ skills: Skill[]; diagnostics: ResourceDiagnostic[] }> {
  const { files, diagnostics } = await markdownFiles(env, dirs, context);
  const skills = new Map<string, Skill>();
  for (const filePath of files.filter((file) => path.basename(file).toLowerCase() === "skill.md")) {
    const read = await env.readTextFile(filePath, context);
    if (!read.ok) {
      diagnostics.push({ code: read.error.code, message: read.error.message, path: filePath });
      continue;
    }
    try {
      const { metadata } = parseResourceMarkdown(read.value);
      const name = metadata.name?.trim() || path.basename(path.dirname(filePath));
      const description = metadata.description?.trim();
      if (!description) {
        diagnostics.push({
          code: "missing_description",
          message: "Skill requires a description",
          path: filePath,
        });
        continue;
      }
      if (skills.has(name)) continue;
      skills.set(name, {
        name,
        description,
        filePath,
        baseDir: path.dirname(filePath),
        ...(metadata["disable-model-invocation"] === "true"
          ? { disableModelInvocation: true }
          : {}),
      });
    } catch (error) {
      diagnostics.push({ code: "invalid_frontmatter", message: String(error), path: filePath });
    }
  }
  return { skills: [...skills.values()], diagnostics };
}

export async function loadPromptTemplates(
  env: ExecutionEnv,
  dirs: string | readonly string[],
  context: Context,
): Promise<{ promptTemplates: PromptTemplate[]; diagnostics: ResourceDiagnostic[] }> {
  const { files, diagnostics } = await markdownFiles(env, dirs, context);
  const templates = new Map<string, PromptTemplate>();
  for (const filePath of files) {
    const read = await env.readTextFile(filePath, context);
    if (!read.ok) {
      diagnostics.push({ code: read.error.code, message: read.error.message, path: filePath });
      continue;
    }
    try {
      const { metadata, content } = parseResourceMarkdown(read.value);
      const name = path.basename(filePath, path.extname(filePath));
      if (templates.has(name)) continue;
      templates.set(name, {
        name,
        content,
        filePath,
        ...(metadata.description ? { description: metadata.description } : {}),
      });
    } catch (error) {
      diagnostics.push({ code: "invalid_frontmatter", message: String(error), path: filePath });
    }
  }
  return { promptTemplates: [...templates.values()], diagnostics };
}

const xml = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
export function formatSkillsForSystemPrompt(skills: readonly Skill[]): string {
  const visible = skills.filter((skill) => !skill.disableModelInvocation);
  if (visible.length === 0) return "";
  return [
    "Read the relevant SKILL.md before using a skill. Resolve its relative paths against its directory.",
    "<available_skills>",
    ...visible.map(
      (skill) =>
        `<skill>\n<name>${xml(skill.name)}</name>\n<description>${xml(skill.description)}</description>\n<location>${xml(skill.filePath)}</location>\n</skill>`,
    ),
    "</available_skills>",
  ].join("\n");
}
