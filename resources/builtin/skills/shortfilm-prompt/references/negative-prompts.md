# 反向提示词 + 各模型分流规则

> 部分模型有独立的反向提示词（negative prompt）输入框，部分没有。
> 按目标模型分流处理。

---

## 标准反向提示词前缀

适合有独立输入框的模型（Seedance、可灵、Veo、海螺、Wan、Pika 2.5）：

```
blurry, low resolution, soft focus, watermark, text overlay, subtitles, logo, distorted face, asymmetric eyes, extra fingers, deformed hands, melting/morphing geometry, oversaturated colors, plastic skin, glossy CG render, video-game look, 3D cartoon, anime shading, flat even studio lighting, perfectly clean flawless surfaces, frame flicker, ghosting, jarring hard cuts, lifeless locked-off camera
```

### 使用注意

- 条目保持为**逗号分隔的纯名词/短语**
- Veo 和可灵会**拒绝**框内的 `no…` / `don't…` 命令式写法
- 不要在标准前缀里加 `no` 前缀，纯名词短语即可

---

## 按模型分流

### 有独立输入框的模型

| 模型 | 注意事项 |
|---|---|
| Seedance 2.0（火山引擎/即梦网页） | 直接粘贴标准前缀 |
| Seedance 2.0（**豆包 App**） | ⚠️ 输入框不可靠出现 → 把否定写进正向提示词 |
| 可灵 2.x / 3.0 | 标准前缀 + 可补充特定瑕疵词：`slippery walk, extra fingers, body morphing` |
| Veo 3 / 3.1 | 标准前缀，但**禁止 `no…` 命令式**，只写名词短语 |
| 海螺 / MiniMax | 少量使用，针对具体瑕疵（`distorted face, extra fingers`），不要塞太多通用词 |
| Wan 2.x | 标准前缀，反向框效果较强，可放心使用 |
| Pika 2.5 | 标准前缀。Pika 2.2 请在 App 内确认是否有输入框 |

### 没有独立输入框的模型

| 模型 | 处理方式 |
|---|---|
| **Sora 2 / 2 Pro** | 把否定写进**正向提示词**，用显式 `no ___` 句式。例：`original character design only, no logos, no text overlay, no morphing geometry` |
| **Runway Gen-4 / 4.5** | ⚠️ `no X` 反而会**召唤出 X**。只描述「应该出现什么」。例：不写 `no text overlay`，改写 `clean frame, visual storytelling only` |

---

## 各类型追加反向词

在标准前缀基础上，按视频类型追加：

| 类型 | 追加项 |
|---|---|
| 变身 / 机甲 | `perfect smooth skin, shiny new armor, clean undamaged surfaces` |
| 多分镜叙事 | `jarring transitions, mismatched lighting between shots, inconsistent character appearance` |
| 情感叙事 | `melodramatic expressions, exaggerated tears, staged emotional moments` |
| 产品广告 | `distracting background, unbranded look, cheap material appearance` |
| 赛博城市 | `daytime, natural lighting, rural, clean streets` |
| 食物 ASMR | `cold food, unappetizing colors, plastic food, artificial looking steam` |
| 竖屏短剧 | `amateur look, vlog style, unprofessional framing` |
| 动物拟人 | `human expressions on animal, anthropomorphic poses, walking on two legs` |
| 定格/黏土 | `smooth motion, photorealistic, CGI look, motion blur` |
| 恐怖/伪纪录 | `clean footage, perfect lighting, steady camera, professional film look` |

---

## 保存独立文件指引

如果目标模型有独立反向框，在用 `write_file` 保存提示词时：

1. 主提示词存为 `output/{主题}-prompt.md`
2. 反向提示词另存为 `output/{主题}-negative.txt` —— **纯文本**，仅含逗号分隔的反向词列表，不含格式标记，方便用户直接粘贴到输入框

---

## 豆包 App 特别注意

豆包 App 版 Seedance 的反向提示词输入框**不可靠地出现**。如果用户使用豆包 App：

- 把核心否定写进**正向提示词**体中
- 句式用 `no ___` 显式否定（Sora 格式）
- 或询问用户："你用的是豆包 App 还是即梦网页版？豆包 App 没有反向提示词输入框，我会把否定写进主提示词。"
