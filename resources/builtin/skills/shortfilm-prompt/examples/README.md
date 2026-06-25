# shortfilm-prompt 示例集

> 既是**回归测试集**，也是 **Agent 参考范例**。

---

## 作为 Agent 参考范例

当你不确定某类视频的输出格式时，用 `read_skill_file` 读取对应 case：

| 你在写什么 | 推荐读取 | 参考价值 |
|---|---|---|
| 单镜头变身（写法 A） | `examples/02-skill-output-sample.md` | 完整输出范例，10 条 checklist 全过 |
| 单镜头变身（输入格式） | `examples/01-mecha-energy-shield.md` | 用户输入格式参考 + 翻车点 |
| 多分镜叙事（写法 B） | `examples/03-multi-shot-cat-encounter.md` | 按镜头切片 + 4 件套 + 空镜 |
| 武器充能 + 打斗（分段） | `examples/04-weapon-charge-combat.md` | 两段独立结构 + 后期剪辑建议 |
| IP 名冲突处理 | `examples/05-ip-name-forced.md` | 照写 + 末尾提醒 + 给替换方案 |
| 情感叙事（克制催泪） | `examples/06-emotional-pet-farewell.md` | 克制美学 + 一致性锁 + 空位告别 |

每份示例包含"必须有"和"必须避免"两种约束，可以在写提示词前快速扫描以避免典型翻车点。

---

## 作为回归测试集

如果你修改了 SKILL.md 或 references/，用以下方法验证 skill 仍然生效。

### 方法 1：手动验证

1. 打开新的对话
2. **不要** 加载 shortfilm-prompt skill
3. 把 `01-mecha-energy-shield.md` 里的用户输入复制给 Agent
4. 观察输出 —— 大概率会犯 7 条规则里的几条（这是基线，记录下来）
5. 加载 skill 后再跑一次同样的输入
6. 对比：7 条规则是否全过

### 方法 2：自动验证（如果你想做 CI）

在 SKILL.md 里加 evaluation 段，用 LLM-as-judge 跑每个 example，看输出是否命中所有期望特征。

---

## 测试 Case 列表

共 5 个 case，分布在 6 个文件里（Case 01 含「用户输入」与「Skill 输出范例」两份）：

| 文件 | Case | 视频类型 | 检验目标 | 关键参考点 |
|---|---|---|---|---|
| `01-mecha-energy-shield.md` | Case 01 | 单镜头变身 | 不抄原始库题材，5 段式骨架完整 | 输入格式 |
| `02-skill-output-sample.md` | Case 01 | 单镜头变身 | 10 条 checklist 全过的完整输出 | 输出范例 |
| `03-multi-shot-cat-encounter.md` | Case 02 | 多分镜叙事 | 切换到写法 B，不死守写法 A | 4 件套 + 空镜 |
| `04-weapon-charge-combat.md` | Case 03 | 武器充能 + 打斗 | 识别分段套路，两段独立 + 剪辑建议 | 双段结构 |
| `05-ip-name-forced.md` | Case 04 | IP 名冲突 | 照写 + 末尾拦截提示 + 替换方案 | 边界处理 |
| `06-emotional-pet-farewell.md` | Case 05 | 情感叙事 | 识别情感类型 + 三条适配规则 | 克制 + 一致性锁 |

---

## 评分标准（10 条 checklist）

跑完输出后用这个核对（详见 [references/checklist.md](../references/checklist.md) 分层版）：

- [ ] 5 段结构齐全
- [ ] 摄影机型号 + 镜头型号
- [ ] "如呼吸般的镜头浮动" 完整句式
- [ ] "声音：不需要配乐，仅保留同期声"
- [ ] ≥2 处瑕疵描述
- [ ] 结尾不堆特效（不出现 "光芒万丈/爆炸/胜利姿态"）
- [ ] 无空泛词（不出现 "完美/震撼/史诗/帅气/4K/质感拉满"）
- [ ] 无 IP 名 OR 有 IP 名时末尾有拦截提示
- [ ] 单镜头≤15s / 多镜头≤8 分镜
- [ ] 末尾给目标模型兼容性建议

≥9 条通过 = skill 合规。
