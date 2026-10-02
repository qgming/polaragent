import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterEach, describe, expect, it } from "vitest";
import { createExecEnv } from "./exec-env";
import {
  formatSkillsForSystemPrompt,
  loadPromptTemplates,
  loadSkills,
  parseResourceMarkdown,
} from "./resource-loaders";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (path.dirname(path.resolve(root)) !== path.resolve(tmpdir()))
      throw new Error("Unsafe resource fixture cleanup");
    await rm(root, { recursive: true, force: true });
  }
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "oint-resource-"));
  roots.push(root);
  const write = async (file: string, content: string) => {
    const target = path.join(root, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
    return target;
  };
  return { root, write, env: await createExecEnv({ cwd: root }) };
}

describe("Oint resource discovery over native durable env", () => {
  it("parses quoted and folded metadata while preserving markdown body", () => {
    expect(
      parseResourceMarkdown(
        "---\nname: demo\ndescription: >-\n  first line\n  second line\n---\n# Body\n\n---\nmore",
      ),
    ).toEqual({
      metadata: { name: "demo", description: "first line second line" },
      content: "# Body\n\n---\nmore",
    });
    expect(parseResourceMarkdown('---\ndescription: "hello"\n---\nbody').metadata.description).toBe(
      "hello",
    );
    expect(() => parseResourceMarkdown("---\nname: broken")).toThrow("closing");
  });

  it("keeps directory precedence, reports invalid skills and excludes hidden paths", async () => {
    const { root, write, env } = await fixture();
    await write("first/demo/SKILL.md", "---\nname: demo\ndescription: first\n---\nPRIVATE BODY");
    await write("second/demo/SKILL.md", "---\nname: demo\ndescription: second\n---\nbody");
    await write("second/bad/SKILL.md", "---\nname: bad\n---\nbody");
    await write("second/.hidden/SKILL.md", "---\nname: hidden\ndescription: hidden\n---\nbody");
    const result = await loadSkills(
      env,
      [path.join(root, "first"), path.join(root, "second")],
      BACKGROUND_CONTEXT,
    );
    expect(result.skills.map((skill) => [skill.name, skill.description])).toEqual([
      ["demo", "first"],
    ]);
    expect(result.diagnostics.map((item) => item.code)).toEqual(["missing_description"]);
    const index = formatSkillsForSystemPrompt(result.skills);
    expect(index).toContain("<location>");
    expect(index).not.toContain("PRIVATE BODY");
  });

  it("uses native path guards and keeps disabled skills out of the model index", async () => {
    const { root, write, env } = await fixture();
    await write(
      "skills/hidden/SKILL.md",
      "---\nname: hidden\ndescription: user only\ndisable-model-invocation: true\n---\nbody",
    );
    await write("skills/visible/SKILL.md", "---\nname: a<b\ndescription: x & y\n---\nbody");
    const result = await loadSkills(env, path.join(root, "skills"), BACKGROUND_CONTEXT);
    expect(result.skills).toHaveLength(2);
    const index = formatSkillsForSystemPrompt(result.skills);
    expect(index).not.toContain("user only");
    expect(index).toContain("a&lt;b");
    expect(index).toContain("x &amp; y");
    const denied = await loadSkills(env, path.dirname(root), BACKGROUND_CONTEXT);
    expect(denied.skills).toEqual([]);
    expect(denied.diagnostics[0]?.code).toBe("permission_denied");
  });

  it("loads template bodies and descriptions and tolerates an absent directory", async () => {
    const { root, write, env } = await fixture();
    await write("prompts/explain.md", "---\ndescription: Explain code\n---\nExplain $ARGUMENTS");
    const result = await loadPromptTemplates(env, path.join(root, "prompts"), BACKGROUND_CONTEXT);
    expect(result.promptTemplates).toMatchObject([
      { name: "explain", description: "Explain code", content: "Explain $ARGUMENTS" },
    ]);
    expect(await loadSkills(env, path.join(root, "absent"), BACKGROUND_CONTEXT)).toEqual({
      skills: [],
      diagnostics: [],
    });
  });
});
