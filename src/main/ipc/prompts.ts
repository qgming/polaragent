// 提示模板通道：列表扫描 + 数据目录模板的新建 / 读取 / 删除。
//
// 面板只操作**数据目录**的 prompts/（项目级 .oint/prompts 跟着会话 cwd 走，由斜杠菜单侧消费）。
// 目录来源与顺序统一由 resources.ts 解析，逐目录独立扫描，最后按 name 去重。

import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { BACKGROUND_CONTEXT, loadPromptTemplates } from "@earendil-works/pi-agent-core";
import { dataDir } from "@/main/app/paths";
import { createExecEnv } from "@/main/pisdk/exec-env";
import { resolvePromptTemplateDirs } from "@/main/pisdk/resources";
import { IPC } from "@/shared/contracts/ipc";
import type { PromptTemplateInfo, PromptTemplateWriteRequest } from "@/shared/contracts/prompts";
import { normalizePromptName, PROMPT_NAME_PATTERN } from "@/shared/contracts/prompts";
import { handle } from "./handler";

/** 数据目录下的全局模板目录（新建与删除的作用范围） */
function globalPromptsDir(): string {
  return path.join(dataDir(), "prompts");
}

function promptFilePath(name: string): string {
  return path.join(globalPromptsDir(), `${name}.md`);
}

/** 校验并规范化名称；不合法直接拒绝（不做「猜用户想写什么」的容错） */
function requireValidName(raw: string): string {
  const name = normalizePromptName(raw);
  if (!PROMPT_NAME_PATTERN.test(name)) throw new Error(`非法的魔法提示名：${raw}`);
  return name;
}

/**
 * 序列化成内核认得的 .md：描述写进 frontmatter，正文原样跟在后面。
 *
 * 描述用 JSON.stringify 加引号：YAML 的双引号标量是 JSON 字符串的超集，
 * 描述里带冒号、引号或 `#` 时不会被 YAML 解析成别的意思。
 */
function serializePromptMarkdown(description: string, content: string): string {
  const trimmed = description.trim();
  const body = content.replace(/\s+$/, "");
  if (trimmed === "") return `${body}\n`;
  return `---\ndescription: ${JSON.stringify(trimmed)}\n---\n\n${body}\n`;
}

/** 扫描单个目录；失败只告警并返回空（单个目录坏掉不影响其余目录） */
async function scanPromptDir(dir: string): Promise<PromptTemplateInfo[]> {
  try {
    // 每个目录一个 env：allowedRoots 必须已包含该目录，否则 listDir / readTextFile 会被
    // 路径守卫拒绝，而内核只把它记成 diagnostics 警告 —— 接口上看起来就是「这个目录没有模板」。
    const env = await createExecEnv({ cwd: dir, allowedRoots: [dir] });
    const { promptTemplates, diagnostics } = await loadPromptTemplates(
      env,
      dir,
      BACKGROUND_CONTEXT,
    );
    for (const diagnostic of diagnostics) {
      console.warn(
        `提示模板加载警告（${diagnostic.code}）：${diagnostic.message}（${diagnostic.path}）`,
      );
    }
    return promptTemplates.map(
      (template): PromptTemplateInfo => ({
        name: template.name,
        // 内核里 description 可选，契约统一成字符串
        description: template.description ?? "",
        content: template.content,
        source: "user",
        dir,
      }),
    );
  } catch (error) {
    console.warn(`扫描提示模板目录失败 ${dir}: ${String(error)}`);
    return [];
  }
}

export function registerPromptsIpc(): void {
  handle(
    IPC.prompts.list,
    "读取魔法提示列表",
    async (request?: { workingDir?: string }): Promise<PromptTemplateInfo[]> => {
      // 目录来源与顺序统一由 resources.ts 解析：数据目录 → 项目目录
      const dirs = resolvePromptTemplateDirs(request?.workingDir);
      const results = await Promise.all(dirs.map((dir) => scanPromptDir(dir)));
      // 同名模板按「先出现者优先」去重，保持列表稳定
      const seen = new Set<string>();
      const merged: PromptTemplateInfo[] = [];
      for (const template of results.flat()) {
        if (seen.has(template.name)) continue;
        seen.add(template.name);
        merged.push(template);
      }
      return merged;
    },
  );

  handle(
    IPC.prompts.write,
    "保存魔法提示",
    async (request: PromptTemplateWriteRequest): Promise<PromptTemplateInfo> => {
      const name = requireValidName(request.name);
      const content = request.content.trim();
      if (content === "") throw new Error("正文不能为空");
      await mkdir(globalPromptsDir(), { recursive: true });
      await writeFile(
        promptFilePath(name),
        serializePromptMarkdown(request.description, content),
        "utf8",
      );
      // 重命名：先写新文件再删旧文件，中途失败最多留下一份重复，而不是把用户的内容弄丢
      const original =
        request.originalName === undefined ? undefined : normalizePromptName(request.originalName);
      if (original !== undefined && original !== name && PROMPT_NAME_PATTERN.test(original)) {
        await unlink(promptFilePath(original)).catch(() => undefined);
      }
      // 回读磁盘上那一行：列表显示的是内核解析结果（描述缺省时会用首行兜底），这里给它同一个值
      const saved = (await scanPromptDir(globalPromptsDir())).find((item) => item.name === name);
      if (saved === undefined) throw new Error(`魔法提示写入后无法读取：${name}`);
      return saved;
    },
  );

  handle(IPC.prompts.remove, "删除魔法提示", async (request: { name: string }): Promise<void> => {
    const name = requireValidName(request.name);
    try {
      await unlink(promptFilePath(name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`魔法提示不存在：${name}`);
      }
      throw error;
    }
  });
}
