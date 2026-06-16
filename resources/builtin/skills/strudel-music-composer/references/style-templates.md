# 风格模板与参数参考

## 一、风格速配表

### 电子舞曲类

| 风格 | BPM | 音阶 | 鼓机 | 旋律音色 | lpf | room | 特征效果 |
|------|-----|------|------|----------|-----|------|----------|
| House | 120-130 | minor | TR909 | sawtooth / supersaw | 800-2000 | 0.2-0.4 | `.delay(.3)` |
| Techno | 130-150 | minor | TR909/TR808 | sawtooth | 400-1200 | 0.1-0.3 | `.distort(2)` |
| Trance | 135-145 | minor/major | TR909 | supersaw | 1200-3000 | 0.3-0.5 | `.delay(.4).phaser(2)` |
| DnB | 165-175 | minor | TR909 | sawtooth | 500-1000 | 0.1-0.3 | `.lpf(600)` |
| Trap | 130-160 | minor | TR808 | triangle / sine | 400-800 | 0.3-0.5 | `.vib("4:.1")` |
| Dubstep | 140 | minor | TR808 | sawtooth + distort | 200-600 | 0.2-0.4 | `.distort(4).shape(.3)` |

### 氛围/Chill 类

| 风格 | BPM | 音阶 | 鼓机 | 旋律音色 | lpf | room | 特征效果 |
|------|-----|------|------|----------|-----|------|----------|
| Lo-fi | 70-90 | minor/major | TR707 | piano / gm_epiano1 | 600-1500 | 0.5-0.8 | `.roomsize(6).crush(6)` |
| Ambient | 60-80 | major/pentatonic | — | gm_synth_strings | — | 0.7-1.0 | `.attack(1).release(2)` |
| Chillwave | 85-100 | major/dorian | TR707 | supersaw | 800-1800 | 0.4-0.7 | `.phaser(3).delay(.3)` |
| Vaporwave | 60-80 | major | — | gm_epiano1 | 1000-2500 | 0.6-0.9 | `.coarse(2)` |

### 摇滚/金属类

| 风格 | BPM | 音阶 | 鼓机 | 旋律音色 | lpf | room | 特征效果 |
|------|-----|------|------|----------|-----|------|----------|
| Rock | 110-140 | minor | TR909 | supersaw / gm_lead_2_sawtooth | 800-2000 | 0.2-0.4 | `.distort(0.2).shape(0.15)` |
| Metal | 120-180 | minor | TR909 | sawtooth | 600-1500 | 0.1-0.3 | `.distort(0.4).shape(0.2)` |
| Industrial | 100-130 | minor | TR909/TR808 | sawtooth + square | 400-1200 | 0.15-0.3 | `.distort(3).crush(6)` |

### 复古/Chiptune

| 风格 | BPM | 音阶 | 鼓机 | 旋律音色 | lpf | room | 特征效果 |
|------|-----|------|------|----------|-----|------|----------|
| Chiptune | 100-140 | minor | TR808 | square / z_square | — | 0-0.2 | `.penv(2).decay(.1).crush(4)` |
| Synthwave | 100-120 | minor | TR707/TR808 | supersaw | 1200-3000 | 0.3-0.5 | `.phaser(3).delay(.35)` |
| Disco | 110-120 | major | TR505 | gm_epiano1 | 1000-3000 | 0.2-0.4 | `.phaser(2)` |

### 爵士/拉丁

| 风格 | BPM | 音阶 | 鼓机 | 旋律音色 | lpf | room | 特征效果 |
|------|-----|------|------|----------|-----|------|----------|
| Jazz | 80-120 | mixolydian/dorian | — | piano / gm_electric_guitar_jazz | — | 0.4-0.7 | `.delay(.25).room(.5)` |
| Bossa Nova | 120-140 | major/mixolydian | — | gm_electric_guitar_jazz / piano | — | 0.3-0.5 | `.room(.4)` |
| Reggae | 65-80 | major | TR707 | gm_electric_guitar_muted | 800-1500 | 0.3-0.5 | `.delay(.5)` |

---

## 二、鼓模式模板库

### 基础节拍

```javascript
// 四四拍基础
"bd*4, [~ sd]*2, hh*8"

// House 经典
"bd*4, [~ sd:1]*2, [~ hh]*4"

// Breakbeat
"bd ~ [~ bd] ~, ~ sd ~ [sd ~ sd], hh*8"

// Shuffle / Swing
"<bd*2 [~ bd]>*2, [~ sd]*2, hh*8"
```

### 电子风格

```javascript
// Techno 驱动
"bd*4, ~ sd:1 ~ sd:1, [hh hh ~ hh]*4"

// Trap Hi-Hat 滚奏
"bd*2, [~ sd]*2, [hh hh hh hh:1]*4"

// DnB 两步
"bd ~ bd ~, ~ sd ~ sd, hh*16"

// Dubstep half-time
"bd ~ ~ ~, ~ ~ sd ~, [hh hh hh hh]*4"
```

### 摇滚风格

```javascript
// 摇滚基本
"bd ~ bd bd, ~ sd ~ sd, hh*8"

// 重摇滚
"bd bd ~ bd, ~ sd ~ sd, hh*8, cr ~ ~ ~"

// 摇滚碎鼓
"bd ~ [bd bd] ~, sd [~ sd] sd ~, [hh hh ~ hh]*4"
```

### 欧几里得节奏

```javascript
// Pop Clave
"bd(3,8)"

// Aksak
"bd(5,8)"

// Cuban Tresillo
"bd(3,4)"

// Ruchenitza
"bd(2,5)"

// 组合
"bd(3,8), sd(2,8,2), hh(5,8)"
```

---

## 三、经典和弦进行

| 名称 | 级数 | C 小调示例 | A 小调示例 | D 小调示例 | 风格 |
|------|------|-----------|-----------|-----------|------|
| i-VI-III-VII | 1-6-3-7 | `Cm Ab Eb Bb` | `Am F C G` | `Dm Bb F C` | 史诗/流行 |
| i-VII-VI-V | 1-7-6-5 | `Cm Bb Ab G` | `Am G F E` | `Dm C Bb A` | Andalusian |
| i-iv-v-i | 1-4-5-1 | `Cm Fm Gm Cm` | `Am Dm Em Am` | `Dm Gm Am Dm` | 蓝调/摇滚 |
| i-VI-iv-V | 1-6-4-5 | `Cm Ab Fm G` | `Am F Dm E` | `Dm Bb Gm A` | 流行摇滚 |
| I-V-vi-IV | 1-5-6-4 | `C G Am F` | — | — | 万能流行 |
| ii-V-I | 2-5-1 | `Dm7 G7 C` | — | — | 爵士标准 |
| i-iv-VII-III | 1-4-7-3 | `Cm Fm Bb Eb` | `Am Dm G C` | `Dm Gm C F` | 电子/氛围 |

---

## 四、Sub Bass 音型模板

```javascript
// 持续低音（Ambient/Lo-fi）
n("0 0 0 0").scale("C1:minor").sound("sine")
  .attack(0.005).decay(0.3).sustain(0.8).release(0.1)

// 八分音符驱动（House/Techno）
n("0 0 0 0 0 0 0 0").scale("C1:minor").sound("sine")
  .attack(0.003).decay(0.15).sustain(0.6).release(0.05)

// Riff 式（Rock/DnB）
n("0 0 12 0 7 0 10 0").scale("D1:minor").sound("sawtooth")
  .attack(0.002).decay(0.085).sustain(0.13).release(0.04)
  .lpf(sine.range(520, 1300).slow(8))
  .distort(0.34).shape(0.18)

// 强力过载（Metal/Industrial）
n("0 0 12 0 7 0 10 0 0 0 12 0 7 10 7 0").scale("D1:minor").sound("sawtooth")
  .attack(0.002).decay(0.07).sustain(0.1).release(0.035)
  .lpf(sine.range(450, 1600).slow(6))
  .distort(0.42).shape(0.24)
```

---

## 五、旋律音色模板

```javascript
// Supersaw Lead（Trance/House/Rock）
n("<音程序列>/2").scale("根音5:minor").sound("supersaw")
  .attack(0.018).decay(0.16).sustain(0.36).release(0.42)
  .hpf(700).lpf(4300)
  .vib(5).vibmod(0.08)
  .delay(0.42).delaytime(0.25).delayfb(0.34)
  .room(0.52).gain(0.3)

// Glass Arp（TRON/电子质感）
chord(prog).anchor("D5").voicing()
  .arp("0 2 1 3 0 4 2 5")
  .sound("square")
  .attack(0.003).decay(0.065).sustain(0.1).release(0.04)
  .hpf(1400).lpf(5600).lpq(12)
  .delay(0.32).delaytime(0.125).delayfb(0.42)
  .room(0.34).gain(0.34)
  .jux(x => x.rev().gain(0.7))

// Warm Pad（Ambient/Lo-fi）
chord(prog).anchor("D3").voicing()
  .sound("gm_pad_warm")
  .attack(0.6).release(2.2)
  .lpf(1100).room(0.82).roomsize(8)
  .gain(0.2)
  .duckorbit(1).duckdepth(0.36)

// Metallic Pad（电子/摇滚）
chord(prog).anchor("D3").voicing()
  .sound("gm_pad_metallic")
  .attack(0.45).release(1.8)
  .lpf(1600).room(0.72).roomsize(7)
  .gain(0.26)
  .duckorbit(1).duckdepth(0.32)
```

---

## 六、氛围/纹理模板

```javascript
// 粉噪底色
s("pink")
  .hpf(sine.range(800, 4400).slow(12))
  .lpf(7600)
  .gain(sine.range(0.025, 0.09).slow(8))
  .room(0.86).roomsize(8)
  .pan(sine.range(-0.45, 0.45).slow(5))

// 白噪声压力上升
s("white*16")
  .hpf(saw.range(600, 8000).slow(8))
  .gain(saw.range(0.025, 0.22).slow(8))
  .room(0.68)
  .pan(sine.range(-0.35, 0.35).slow(2))

// Laser Ticks（高频闪烁）
n("12 14 15 17 19 17 15 14")
  .scale("D6:minor").sound("z_square")
  .attack(0.001).decay(0.035).sustain(0.04).release(0.025)
  .hpf(3000).lpf(7800).crush(5)
  .delay(0.24).delaytime(0.0625).delayfb(0.26)
  .gain(0.14)
  .pan(sine.range(-0.6, 0.6).slow(2))

// Impact / Crash
s("tr808_bd:20 ~ ~ sus_cymbal:14")
  .gain(0.52).room(0.82).roomsize(7).lpf(4800)
```

---

## 七、段落构建模板

```javascript
// Intro — 稀疏开场
let intro = stack(
  pad.gain(0.15),
  atmosphere.gain(0.6),
  sub.gain(0.2)
)

// Verse — 加入节奏
let verse = stack(
  basicDrums,
  sub,
  bassRiff.gain(0.6),
  pad,
  arp.gain(0.2)
)

// Chorus — 全部铺满
let chorus = stack(
  fullDrums,
  sub,
  bassRiff,
  pad,
  lead,
  arp,
  atmosphere
)

// Break — 减少鼓，突出旋律
let breakSection = stack(
  breakDrums,
  sub.gain(0.4),
  pad.gain(0.3),
  lead.slow(2).room(0.8)
)

// Finale — 最强段落
let finale = stack(
  heavyDrums,
  sub.gain(0.75),
  overdriveBass,
  pad,
  lead.gain(0.35),
  arp.gain(0.5).every(4, x => x.fast(2)),
  impact
)

// Release — 尾音释放
let release = stack(
  minimalDrums,
  sub.gain(0.25),
  pad.lpf(900).room(0.9),
  lead.release(1.4).room(0.86).delayfb(0.5)
)
```

---

## 八、时间计算参考

| BPM | setcpm | 1 cycle 秒数 | 8 cycles | 16 cycles | 2分钟 cycles |
|-----|--------|-------------|----------|-----------|-------------|
| 80  | 20     | 3.0s        | 24s      | 48s       | 40          |
| 100 | 25     | 2.4s        | 19.2s    | 38.4s     | 50          |
| 120 | 30     | 2.0s        | 16s      | 32s       | 60          |
| 140 | 35     | 1.714s      | 13.7s    | 27.4s     | 70          |
| 160 | 40     | 1.5s        | 12s      | 24s       | 80          |
| 175 | 43.75  | 1.371s      | 11s      | 21.9s     | 87.5        |

公式：
- `setcpm = BPM / 4`
- 1 cycle 秒数 = `60 / setcpm = 240 / BPM`
- N 分钟总 cycles = `N × 60 × setcpm / 60 = N × setcpm`
- 结尾静音 cycles = `静音秒数 / 单cycle秒数`
