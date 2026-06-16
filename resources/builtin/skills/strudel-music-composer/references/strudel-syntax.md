# Strudel 语法速查参考

## 一、Mini-Notation（迷你记谱法）

### 序列与时间

| 语法 | 含义 | 示例 |
|------|------|------|
| `a b c d` | 空格分隔 = 序列，挤入一个 cycle | `sound("bd hh sd hh")` |
| `[a b c]` | 方括号 = 子序列，内容挤入一个事件时间 | `sound("bd [hh hh] sd")` |
| `<a b c d>` | 尖括号 = 每 cycle 播放一个元素 | `sound("<bd hh sd oh>")` |
| `[[a b] c]` | 嵌套子序列，任意深度 | `sound("bd [[rim rim] hh] cp")` |

### 速度控制

| 语法 | 含义 | 示例 |
|------|------|------|
| `*n` | 加速 n 倍 | `sound("hh*4")` |
| `/n` | 减速，内容跨 n 个 cycle | `note("[c d e f]/4")` |
| `<a b>*8` | 尖括号 + 乘法 | `sound("<bd hh rim oh>*8")` |
| `.fast(n)` | 函数式加速 | `sound("bd rim").fast(2)` |
| `.slow(n)` | 函数式减速 | `sound("bd rim").slow(2)` |

### 休止与延续

| 语法 | 含义 | 示例 |
|------|------|------|
| `~` 或 `-` | 休止符 | `sound("bd - sd -")` |
| `@n` | 延续权重（默认 @1） | `note("c@3 eb")` |
| `!n` | 重复但不加速 | `note("c!2 eb")` |
| `_` | 连线 | `note("c _ d")` |

### 并行与和弦

| 语法 | 含义 | 示例 |
|------|------|------|
| `a, b` | 逗号 = 同时播放 | `sound("hh hh, bd casio")` |
| `[a, b]` | 子序列内并行 = 和弦 | `note("[c, e, g]")` |
| 反引号 | 多行写法 | `` sound(`bd*2, hh*4`) `` |

### 随机性

| 语法 | 含义 | 示例 |
|------|------|------|
| `a?` | 50% 概率移除 | `note("c e g?")` |
| `a?0.1` | 10% 概率移除 | `note("c e g?0.1")` |
| `a \| b \| c` | 随机选择 | `note("[c \| e \| g]")` |

### 欧几里得节奏

`beats(segments, offset)` — 将节拍均匀分布：

```
s("bd(3,8)")     // 3 拍分布在 8 段上 = "Pop Clave"
s("bd(5,8)")     // 5 拍分布在 8 段上 = Aksak
s("bd(3,8,3)")   // 偏移 3
```

---

## 二、声音系统

### 采样音色 (sound / s)

**鼓组缩写：**
| 缩写 | 含义 |
|------|------|
| `bd` | Bass Drum 底鼓 |
| `sd` | Snare Drum 军鼓 |
| `hh` | Hi-Hat 踩镲 |
| `oh` | Open Hi-Hat 开镲 |
| `cp` | Clap 拍手 |
| `rim` | Rimshot 边击 |
| `lt` / `mt` / `ht` | Low/Mid/High Tom |
| `cb` | Cowbell 牛铃 |
| `cr` | Crash |
| `rd` | Ride |

**选择采样编号：** `sound("hh:0 hh:1 hh:2")`

**鼓机音色库：**
```
sound("bd sd").bank("RolandTR909")
```
常用：`RolandTR808` / `RolandTR909` / `RolandTR707` / `RolandTR505`

**其他音色：** `insect` / `wind` / `jazz` / `metal` / `east` / `crow` / `casio` / `space` / `numbers`

### 合成器波形

`sawtooth` / `square` / `triangle` / `sine` / `supersaw` / `z_square` / `pulse`

### GM 音色（General MIDI）

```
note("c e g").sound("piano")
note("c e g").sound("gm_synth_bass_1")
note("c e g").sound("gm_synth_strings_1")
note("c e g").sound("gm_lead_2_sawtooth")
note("c e g").sound("gm_pad_metallic")
note("c e g").sound("gm_pad_warm")
note("c e g").sound("gm_electric_guitar_muted")
note("c e g").sound("gm_electric_guitar_jazz")
note("c e g").sound("gm_acoustic_bass")
note("c e g").sound("gm_xylophone")
note("c e g").sound("gm_epiano1:1")
note("c e g").sound("gm_accordion:2")
```

### 音高控制

| 函数 | 含义 | 示例 |
|------|------|------|
| `note()` | 音名或 MIDI 编号 | `note("c e g")` 或 `note("48 52 55")` |
| `n()` + `.scale()` | 音阶内数字 | `n("0 2 4 6").scale("C:minor")` |
| `freq()` | 频率（Hz） | `freq("220 275 330 440")` |

**音名：** `c d e f g a b`，升降号 `db`/`c#`，八度 `c2 e3 g4`

### 音阶系统

```
n("0 2 4 6").scale("C:minor")
```

格式：`"根音:音阶名"` 或 `"根音八度:音阶名"`

常用：`major` / `minor` / `pentatonic` / `mixolydian` / `dorian` / `blues` / `chromatic`

可切换：`.scale("<C:major D:mixolydian>/4")`

### 和弦系统

```
chord("<Dm Dm Bb C>").anchor("D5").voicing()
```

- `.anchor("音名")` — 锚定根音位置
- `.voicing()` — 自动分配声部
- `.dict("ireal")` — 使用 iReal Pro 和弦字典
- `.arp("0 2 1 3")` — 琶音序列

---

## 三、效果器系统

### 滤波器

| 效果 | 含义 | 范围 | 示例 |
|------|------|------|------|
| `.lpf(freq)` | 低通滤波 | 0-20000 | `.lpf(800)` |
| `.lpq(q)` | 低通共振 | 0-50 | `.lpq(10)` |
| `.hpf(freq)` | 高通滤波 | 0-20000 | `.hpf(2000)` |
| `.hpq(q)` | 高通共振 | 0-50 | `.hpq(5)` |
| `.bpf(freq)` | 带通滤波 | center | `.bpf(1000)` |
| `.bpq(q)` | 带通共振 | q factor | `.bpq(2)` |
| `.vowel("a")` | 元音滤波 | a/e/i/o/u | `.vowel("<a e i o>")` |
| `.ftype(type)` | 滤波器类型 | 0=12db 1=ladder 2=24db | `.ftype("ladder")` |

简写：`.lpf("1000:10")` = lpf + lpq

### 振幅包络（ADSR）

| 参数 | 含义 | 示例 |
|------|------|------|
| `.attack(t)` | 起音时间（秒） | `.attack(.1)` |
| `.decay(t)` | 衰减时间（秒） | `.decay(.1)` |
| `.sustain(level)` | 持续电平（0-1） | `.sustain(.5)` |
| `.release(t)` | 释放时间（秒） | `.release(.2)` |
| `.adsr("a:d:s:r")` | 组合写法 | `.adsr(".1:.1:.5:.2")` |
| `.clip(t)` | 裁剪长度 | `.clip(.5)` |

### 音高包络

| 参数 | 含义 | 示例 |
|------|------|------|
| `.penv(semitones)` | 音高包络深度 | `.penv(12)` |
| `.pattack(t)` | 音高起音 | `.pattack(.02)` |
| `.pdecay(t)` | 音高衰减 | `.pdecay(.1)` |
| `.prelease(t)` | 音高释放 | `.prelease(.1)` |
| `.pcurve(type)` | 0=线性 1=指数 | `.pcurve(1)` |
| `.panchor(anchor)` | 包络锚点 | `.panchor(0)` |

### 滤波包络

| 参数 | 含义 | 简写 |
|------|------|------|
| `.lpa(t)` / `.lpattack(t)` | LP 起音 | |
| `.lpd(t)` / `.lpdecay(t)` | LP 衰减 | |
| `.lps(v)` / `.lpsustain(v)` | LP 持续 | |
| `.lpr(t)` / `.lprelease(t)` | LP 释放 | |
| `.lpenv(depth)` / `.lpe(depth)` | LP 包络深度 | |
| 同理 `hpa/hpd/hps/hpr/hpenv` 和 `bpa/bpd/bps/bpr/bpenv` | HP / BP | |

### 空间效果

| 效果 | 含义 | 范围 | 示例 |
|------|------|------|------|
| `.room(level)` | 混响量 | 0-1 | `.room(.5)` |
| `.roomsize(size)` / `.rsize()` | 房间大小 | 0-10 | `.roomsize(4)` |
| `.delay(level)` | 延迟量 | 0-1 | `.delay(.5)` |
| `.delaytime(t)` | 延迟时间（秒） | | `.delaytime(.25)` |
| `.delayfeedback(fb)` | 反馈 | 0-1 | `.delayfeedback(.5)` |
| `.delayspeed(s)` | 延迟速度倍率 | | `.delayspeed(2)` |
| `.pan(pos)` | 声像 | 0-1 | `.pan("0 0.3 .6 1")` |

简写：`.delay("0.65:0.25:0.9")` = delay:delaytime:delayfeedback
简写：`.room("0.9:4")` = room:roomsize

### 动态与失真

| 效果 | 含义 | 范围 | 示例 |
|------|------|------|------|
| `.gain(v)` | 增益 | 指数 | `.gain(".4 1")` |
| `.velocity(v)` | 力度 | 0-1 | `.velocity(".4 1")` |
| `.postgain(v)` | 后置增益 | | `.postgain(1.5)` |
| `.shape(v)` | 波形塑形 | 0-1 | `.shape(.3)` |
| `.distort(v)` | 失真 | 0-10+ | `.distort(3)` |
| `.crush(depth)` | 位深压缩 | 1-16 | `.crush(4)` |
| `.coarse(factor)` | 采样率降低 | 1=原样 | `.coarse(8)` |
| `.compressor("thr:ratio:knee:att:rel")` | 压缩器 | | `.compressor("-20:20:10:.002:.02")` |

### 调制效果

| 效果 | 含义 | 示例 |
|------|------|------|
| `.phaser(rate)` | 相位器 | `.phaser(4)` |
| `.tremolosync(cycles)` / `.tremsync()` | 颤音同步 | `.tremolosync("4")` |
| `.tremolodepth(d)` | 颤音深度 | `.tremolodepth(1)` |
| `.tremoloshape(shape)` | 颤音波形 | `.tremoloshape("sine")` |
| `.vib("rate:depth")` | 颤音 | `.vib("4:.1")` |
| `.vibmod(depth)` | 颤音调制深度 | `.vibmod(0.08)` |

### 信号调制（LFO）

用波形信号替代固定值：

```javascript
s("hh*16").gain(sine)                    // 正弦波控制增益
s("hh*16").lpf(saw.range(500, 2000))     // 锯齿波控制滤波
```

**波形：** `sine` / `saw` / `tri` / `square` / `rand` / `perlin`

**方法：**
- `.range(min, max)` — 设置范围
- `.slow(n)` / `.fast(n)` — 改变速度

### Ducking（侧链压缩）

```javascript
bass.duckorbit(1).duckdepth(0.5)  // 轨道 1 的 kick 会压低此声部
```

---

## 四、模式变换函数

| 函数 | 含义 | 示例 |
|------|------|------|
| `.rev` | 反转 | `sound("bd hh sd cp").rev` |
| `.jux(fn)` | 立体声分裂 | `.jux(rev)` |
| `.juxBy(width, fn)` | 可调宽度 | `.juxBy(.5, rev)` |
| `.iter(n)` | 迭代偏移 | `.iter(4)` |
| `.ply(n)` | 每事件重复 | `.ply(2)` |
| `.chunk(n, fn)` | 分块应用 | `.chunk(4, fast(2))` |
| `.rarely(fn)` | 偶尔应用 | `.rarely(ply("2"))` |
| `.sometimes(fn)` | 有时应用 | `.sometimes(add(note(12)))` |
| `.sometimesBy(p, fn)` | 按概率应用 | `.sometimesBy(0.3, x => x.fast(2))` |
| `.every(n, fn)` | 每 n 次应用 | `.every(4, x => x.fast(2))` |
| `.mask(pattern)` | 掩码/门控 | `.mask("<0 1 1 0>/16")` |
| `.early(n)` | 提前 | `.early(.5)` |
| `.late(n)` | 延后 | `.late("[0 .01]")` |
| `.off(n, fn)` | 偏移叠加 | `.off(1/8, add(note(7)))` |
| `.add(n)` | 音高加法 | `.add(note(12))` |
| `.sub(n)` | 音高减法 | `.sub(12)` |
| `.segment(n)` | 分段数 | `.segment(4)` |

---

## 五、Orbit（轨道）

同一 orbit 共享 delay 和 reverb：

```javascript
s("hh*6").delay(.5).orbit(1)
s("~ sd ~ sd").delay(.5).orbit(2)  // 不同 orbit = 独立效果
```

**规则：** 不同声部需要独立 delay/reverb 时，必须分配不同 orbit。

---

## 六、多声部并行

```javascript
$: sound("bd*4, [~ sd]*2").bank("RolandTR909")
$: note("<[c2 c3]*4>").sound("sawtooth").lpf(800)
$: n("0 2 4 6").scale("C:minor").sound("piano")
```

- `$:` — 新声部并行播放
- `_$:` — 静音该声部
- `.hush()` — 停止该声部

---

## 七、全局控制

| 函数 | 含义 | 示例 |
|------|------|------|
| `setcpm(n)` | 设置 cycles per minute | `setcpm(120/4)` |
| `arrange(...)` | 全局编排 | `arrange([8, intro], [16, main])` |
| `stack(a, b, c)` | 同时播放多个模式 | `stack(bass, drums, lead)` |

---

*基于 Strudel 官方文档：https://strudel.cc/*
