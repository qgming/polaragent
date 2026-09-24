// 提示模板通道：列表扫描 + 数据目录模板的新建 / 读取 / 删除。
//
// 面板只**写**数据目录的 prompts/（项目级 .oint/prompts 跟会话 cwd 走、内置层随包分发，
// 两者都只读列出）。目录来源与顺序统一由 resources.ts 解析，逐目录独立扫描，最后按 name 去重。

import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { BACKGROUND_CONTEXT, loadPromptTemplates } from "@earendil-works/pi-agent-core";
import { app } from "electron";
import { dataDir } from "@/main/app/paths";
import { createExecEnv } from "@/main/pisdk/exec-env";
import { resolveBuiltinPromptDir, resolvePromptTemplateDirs } from "@/main/pisdk/resources";
import { isPluginContributionDir } from "@/main/plugins/contributions";
import { IPC } from "@/shared/contracts/ipc";
import type { PromptTemplateInfo, PromptTemplateWriteRequest } from "@/shared/contracts/prompts";
import { normalizePromptName, PROMPT_NAME_PATTERN } from "@/shared/contracts/prompts";
import type { SkillSource } from "@/shared/contracts/skills";
import { handle } from "./handler";

/** 数据目录下的全局模板目录（新建与删除的作用范围） */
function globalPromptsDir(): string {
  return path.join(dataDir(), "prompts");
}

/** 随包分发的内置模板目录（只读） */
function builtinPromptsDir(): string {
  return resolveBuiltinPromptDir(app.getAppPath());
}

/**
 * 这个模板目录属于哪一类来源。
 *
 * 判据是**路径**而不是「第几个目录」，理由与 skills.ts 的同名函数一致：目录清单本身可增可减
 *（appPath 缺失时会少一个），按位置判断会在某天悄悄把内置模板标成用户的，而那种错误没有
 * 任何地方会报 —— 界面上只会表现为「系统页签莫名其妙空了」。
 */
function sourceOfDir(dir: string): SkillSource {
  return path.resolve(dir) === path.resolve(builtinPromptsDir()) ? "builtin" : "user";
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
async function scanPromptDir(dir: string, source: SkillSource): Promise<PromptTemplateInfo[]> {
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
        source,
        dir,
      }),
    );
  } catch (error) {
    console.warn(`扫描提示模板目录失败 ${dir}: ${String(error)}`);
    return [];
  }
}

/**
 * 内置模板里是否已经有这个名字。
 *
 * 只用于「删除失败时给一句有指向性的报错」：内置模板住在**应用目录**里，删它等于改应用自身，
 * 那从来不是这个 IPC 通道该做的事（与 ipc/skills.ts 的内置技能同一条原则）。
 */
async function hasBuiltinPrompt(name: string): Promise<boolean> {
  const found = await scanPromptDir(builtinPromptsDir(), "builtin");
  return found.some((template) => template.name === name);
}

export function registerPromptsIpc(): void {
  handle(
    IPC.prompts.list,
    "读取魔法提示列表",
    async (request?: { workingDir?: string }): Promise<PromptTemplateInfo[]> => {
      // 目录来源与顺序统一由 resources.ts 解析：数据目录 → 项目目录 → 内置（顺序即优先级）
      // 与技能同一个口径：插件贡献的模板归插件管，设置里不显示（模型照样读得到）
      const dirs = resolvePromptTemplateDirs(request?.workingDir, app.getAppPath()).filter(
        (dir) => !isPluginContributionDir(dir),
      );
      const results = await Promise.all(dirs.map((dir) => scanPromptDir(dir, sourceOfDir(dir))));
      // 同名模板按「先出现者优先」去重，保持列表稳定。
      // 于是内置模板被用户/项目的同名模板遮住时，列表里只留下生效的那一个 ——
      // 「面板里显示的」与「实际能用的」因此永远是同一份。
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
      const saved = (await scanPromptDir(globalPromptsDir(), "user")).find(
        (item) => item.name === name,
      );
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
        /**
         * 内置模板不可删除 —— 给出明确报错并告诉他该怎么办，而不是一句「不存在」。
         *
         * 与「内置技能不可删除」同一条原则：内置模板随应用升级整包替换，删掉它只会在下次升级时
         * 又冒出来，而用户真正的诉求通常是「改一改它的措辞」→ 那是新建一份同名模板覆盖它
         *（同名时数据目录那一份胜出，见 list 的去重顺序）。
         */
        if (await hasBuiltinPrompt(name)) {
          throw new Error(`内置魔法提示不可删除，新建同名提示即可覆盖它：${name}`);
        }
        throw new Error(`魔法提示不存在：${name}`);
      }
      throw error;
    }
  });
}
