# YAML Frontmatter 参考

frontmatter **永远**会被加载进智能体的系统提示。它是渐进式披露的第一层，
也是智能体判断「要不要加载这个技能」时**唯一**能看到的东西。

> **它写错了，技能就永远不会被加载** —— 而且通常没有任何报错。

## 必填字段

```yaml
---
name: skill-name-in-kebab-case
description: 它做什么、什么时候用。写上用户真会说的触发说法。
---
```

### name

- **只能 kebab-case**：`notion-project-setup` —— 不能有空格、下划线、大写字母；
- 应与文件夹名一致；
- **不超过 64 字符**；
- 保留字：含 `claude` 或 `anthropic` 的名字会被拒绝。

### description

- **必须同时包含「做什么」与「什么时候用」**（触发条件）；
- **不超过 1024 字符**。超了内核会**记一条 warning 但仍然装载** ——
  也就是说技能能用，只是描述冗长、每轮都白付 token。所以它是建议上限，不是硬闸；
- **不能有尖括号 `<` `>`**；
- 写上用户可能说出的具体说法；相关时提文件类型。

结构：`[它做什么] + [什么时候用] + [关键能力 / 否定触发]`

> **Oint 唯一的静默失败是「缺 description」**：那种技能会被**直接丢弃**，
> 模型完全看不到它（只留一条 `description is required` 的 warning 在诊断里，
> 而诊断默认只打到控制台）。所以 description 宁可写得不完美，也**绝不能空着**。

> description 是**每个请求都付 token** 的（它进技能索引）。
> 1024 是建议上限，但写得接近上限通常意味着你该把细节挪进正文或 `references/` 了。

## 可选字段

```yaml
disable-model-invocation: true    # 只给用户用：模型看不到它，但 /技能名 仍可用
license: MIT                      # 开源技能
compatibility: 需要联网与 Python 3.10+   # 1–500 字符，环境要求
metadata:                         # 任意自定义键值对
  author: 公司名
  version: 1.0.0
  category: productivity
  tags: [project-management, automation]
```

> ⚠️ **Oint 目前只解析 `name`、`description`、`disable-model-invocation` 三个键。**
> 其余键写了不会报错，但**也不会生效** —— 它们与内核的 `Skill` 类型对不上。
> 所以 `compatibility` / `allowed-tools` 这类字段可以写（当作给人看的文档），
> 但**不要让技能的行为依赖它们**：把环境要求写进正文，模型才真的会看到。

### disable-model-invocation

它控制的是**模型能不能看见**，不是权限。设成 `true` 后：

| 位置 | 行为 |
|------|------|
| 系统提示里的技能索引 | **不出现**（模型不知道有这个技能） |
| 模型主动加载 | 不可能 —— 它根本不知道名字 |
| 用户敲 `/技能名` | 照常可用 |

用在**流程长、会打断、有副作用**、时机该由用户掌握的场景
（多阶段编排、部署、任何会改外部状态的事）。

**默认是关闭的 —— 一个模型看不见的技能，是它没法主动提议的技能。**

真正的权限是另一回事：设置面板里的**逐条禁用**会让这个技能对所有人不可用（包括用户）。
