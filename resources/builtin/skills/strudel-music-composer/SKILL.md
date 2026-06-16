---
name: strudel-music-composer
description: 基于 Strudel（Tidal Cycles JS 版）生成可运行的音乐代码。当用户要求生成音乐、创作电子音乐、写一个 Strudel 曲子、做一首 XXX 风格的歌、用代码作曲、生成 BGM/背景音乐、或者提到 Strudel/Tidal Cycles 时使用。支持多种风格（House、Techno、Lo-fi、Ambient、DnB、Chiptune、Rock、Orchestral 等），输出完整可运行的 Strudel 代码。
---

# Strudel 音乐创作技能

本技能指导助手生成**完整可运行**的 Strudel 音乐代码。目标是让用户拿到代码后直接粘贴到 [Strudel REPL](https://strudel.cc/mini-repl/) 即可播放。

## 工作流程

### 第一步：澄清需求

如果用户没有明确以下信息，用 1-3 个问题确认：

| 参数 | 必须? | 说明 |
|------|-------|------|
| **风格** | ✅ | House / Techno / Lo-fi / Ambient / DnB / Rock / Chiptune / 爵士 / 用户自述 |
| **BPM** | 可选 | 默认按风格推荐；用户可指定 |
| **时长** | 可选 | 默认约 2 分钟；用户可指定秒数或分钟数 |
| **情绪/调性** | 可选 | 如「黑暗」「明亮」「紧张」「放松」，助手自行选择调式 |
| **结构偏好** | 可选 | 「直接铺满」「有 intro」「有 breakdown」「渐进式」等 |

### 第二步：确定参数

根据风格，从 [references/style-templates.md](references/style-templates.md) 中选取：

1. **速度** — BPM → `setcpm(BPM/4)`
2. **调性** — 根音 + 音阶（minor / major / pentatonic / mixolydian 等）
3. **鼓机** — RolandTR909 / RolandTR808 / RolandTR707 等
4. **鼓模式** — 基础节奏型 + 变体
5. **低音** — 音色 + 音型 + 滤波
6. **旋律/和弦** — 音色 + 和弦进行 + 琶音
7. **效果** — 滤波 / 混响 / 延迟 / 失真 / LFO 调制
8. **结构** — 段落划分 + arrange 编排

### 第三步：生成代码

按以下层次编写，每一层用 `let` 命名变量，便于用户理解和修改：

```
1. setcpm()           — 全局速度
2. let prog = ...     — 和弦进行
3. 鼓组变量           — kick / snare / hihat / cymbals / toms / perc
4. 鼓段落变量         — fullDrums / breakDrums / battleDrums 等
5. 低音变量           — sub / bassRiff / overdriveBass 等
6. 旋律变量           — lead / answer / arp / ticks 等
7. 氛围变量           — pad / atmosphere / noise 等
8. 段落变量           — intro / verse / chorus / break / finale 等
9. arrange()          — 最终编排
```

### 第四步：交付

输出完整代码，附带简要说明：
- 代码结构概述（几句话）
- 预计时长
- 如何修改（提示用户改哪些变量可以调整风格）

## 核心编写规则

### 代码风格

- 使用 `let` 声明变量，命名语义化（如 `rockKick`、`glassArp`、`darkPad`）
- 每个变量上方用 `//` 注释说明用途
- 效果链换行对齐，便于阅读
- 段落之间用 `// -----` 分隔线
- 使用 `stack()` 组合同层声部
- 使用 `arrange()` 编排全局结构

### 声部层次

一个完整的曲子通常包含以下层次（可按风格增减）：

| 层次 | 作用 | 典型音色 |
|------|------|----------|
| Kick | 节奏根基 | tr909_bd / tr808_bd |
| Snare/Clap | 反拍骨架 | tr909_sd / cp |
| HiHat | 细节律动 | tr808_hh / oh |
| Cymbals | 段落标记/推力 | cr / rd |
| Tom Fills | 过门 | tr808_lt/mt/ht |
| Perc | 纹理 | rim / cb / 数字采样 |
| Sub Bass | 超低频地板 | sine |
| Bass Riff | 主低音线条 | sawtooth + distort |
| Lead | 主旋律 | supersaw / gm_lead_* |
| Arp | 琶音纹理 | square / piano |
| Pad | 和声底色 | gm_pad_* / sawtooth |
| Atmosphere | 空间感 | pink / white / space |
| FX | 冲击/过渡 | impact / riser |

### 效果使用原则

- **每个轨道用 `.orbit(n)` 隔离**，避免 delay/reverb 互相干扰
- **ducking**：低音和 pad 使用 `.duckorbit(1).duckdepth(0.3-0.6)` 让 kick 穿透
- **滤波**：lpf 控制明暗，hpf 清除低频浑浊
- **LFO 调制**：用 `sine.range(min,max).slow(n)` 让参数活起来
- **动态**：`.gain("模式")` 制造律动感，避免所有声部都满增益
- **总增益**：各声部增益控制在 0.1-0.8，避免削波

### 结构编排

使用 `arrange()` 函数，格式为 `[cycles数, 变量名]`：

```javascript
arrange(
  [8, intro],        // 每个数字 = cycle 数
  [16, mainSection],
  [8, breakdown],
  [16, finale],
  [4, release]
)
```

时间计算：
- 1 cycle 时长(秒) = 60 / cpm = 120 / BPM
- 例：140 BPM → 1 cycle ≈ 0.857s → `setcpm(140/4)` → 35 cpm → 1 cycle ≈ 1.714s

## 参考资料

- [Strudel 语法速查](references/strudel-syntax.md) — Mini-Notation、音色、效果器完整参考
- [风格模板与参数](references/style-templates.md) — 10+ 种风格的参数速配表和鼓模式模板
- [参考示例](references/reference-example.js) — 完整的 Grid Rock Overdrive 示例代码

## 调试提示

如果用户反馈代码不工作：
1. 检查 `setcpm()` 是否在最前面
2. 检查 `arrange()` 的 cycles 总数是否正确
3. 检查 `stack()` 内是否有语法错误（逗号、括号匹配）
4. 检查 `chord()` 是否需要 `.dict("ireal")` 或 `.voicing()`
5. 建议用户逐层取消注释定位问题
