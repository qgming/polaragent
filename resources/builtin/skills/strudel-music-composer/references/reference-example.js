// =====================================================
// REFERENCE EXAMPLE: GRID ROCK OVERDRIVE
// TRON / End of Line inspired
// 140 BPM, ~2 minutes, with 2 sec silence ending
// =====================================================
// 这是一个完整的 Strudel 曲子示例，展示了：
// - 多层次鼓组（kick/snare/hihat/cymbals/toms/perc）
// - 摇滚式鼓结构变体（rockCore/battle/break/final）
// - Sub Bass + Overdrive Bass 双低音层
// - 主旋律 + 回答句 + 琶音 + 高频 ticks
// - Pad + Atmosphere 氛围层
// - Ducking 侧链压缩
// - arrange() 全局编排
// =====================================================

setcpm(140/4) // 140 BPM，2分钟≈70 cycles

let prog = "<Dm Dm Bb C>"

// 140 BPM 下：1 cycle ≈ 1.714s
// 2秒 ≈ 1.1667 cycles
let silence2s = s("~")

// -----------------------------------------------------
// Kick / Sidechain Core
// -----------------------------------------------------

let kick = s("tr909_bd*4")
  .gain(1.04)
  .distort(0.1)
  .shape(0.1)
  .orbit(1)

let rockKick = s("tr909_bd ~ tr909_bd tr909_bd")
  .gain("1.1 0.9 1.0 0.95")
  .distort(0.14)
  .shape(0.16)
  .orbit(1)

let heavyKick = s("tr909_bd tr909_bd ~ tr909_bd")
  .gain("1.15 0.95 0.8 1.05")
  .distort(0.18)
  .shape(0.2)
  .orbit(1)

// -----------------------------------------------------
// Rock-Structured Drums
// -----------------------------------------------------

let rockCoreDrums = stack(
  rockKick,

  s("~ tr909_sd ~ tr909_sd")
    .gain(0.78)
    .room(0.16)
    .distort(0.04),

  s("tr808_hh*8")
    .gain("0.18 0.1 0.15 0.09")
    .hpf(6200)
    .pan(sine.range(-0.25, 0.25).slow(4)),

  s("~ ~ tr808_oh ~")
    .gain(0.28)
    .hpf(5200)
    .room(0.2)
)

// crash / ride 层
let cymbalDrive = stack(
  s("cr ~ ~ ~")
    .gain(0.34)
    .hpf(4200)
    .room(0.45)
    .roomsize(5),

  s("rd*8")
    .gain("0.16 0.08 0.12 0.07")
    .hpf(6500)
    .room(0.22)
    .pan(sine.range(-0.35, 0.35).slow(3)),

  s("tr909_rd*16?")
    .gain(0.07)
    .hpf(7600)
    .pan(rand.range(-0.6, 0.6))
)

// tom 过门
let tomFillA = s("~ ~ tr808_lt:2 tr808_mt:2 tr808_ht:2 tr808_mt:2 tr808_lt:4 ~")
  .gain(0.3)
  .lpf(2600)
  .room(0.28)
  .sometimesBy(0.3, x => x.fast(2))

let tomFillB = s("tr808_lt:2 tr808_mt:2 tr808_ht:2 tr808_ht:4 tr808_mt:4 tr808_lt:4 tr808_sd:8 tr808_sd:12")
  .gain(0.32)
  .lpf(3000)
  .room(0.32)
  .sometimesBy(0.25, x => x.rev())

// snare roll
let snareRolls = s("~ ~ ~ tr909_sd*4")
  .gain(0.3)
  .hpf(900)
  .room(0.25)
  .sometimesBy(0.35, x => x.fast(2))

// 电子打击乐
let cyberPerc = stack(
  s("rim*4?")
    .gain(0.12)
    .hpf(2400)
    .room(0.2)
    .pan(sine.range(0.4, -0.4).slow(3)),

  s("cb*4?")
    .gain(0.09)
    .hpf(1800)
    .room(0.2),

  s("tr808_sd:8? ~ tr808_sd:12? ~")
    .gain(0.18)
    .hpf(1300)
    .room(0.3)
)

// 满编摇滚鼓
let fullRockDrums = stack(
  rockCoreDrums,
  cymbalDrive,
  cyberPerc,
  tomFillA.gain(0.8)
)

// 战斗摇滚鼓
let battleRockDrums = stack(
  heavyKick,

  s("~ tr909_sd ~ tr909_sd")
    .gain(0.86)
    .room(0.13)
    .distort(0.06),

  s("tr808_hh*8")
    .gain("0.17 0.09 0.14 0.08")
    .hpf(6800)
    .pan(sine.range(-0.35, 0.35).slow(2)),

  cymbalDrive.gain(1.1),

  cyberPerc,

  tomFillA,

  snareRolls
)

// 中段 break
let rockBreakDrums = stack(
  s("tr909_bd ~ tr909_bd tr909_bd")
    .gain(0.95)
    .distort(0.12)
    .orbit(1),

  s("~ tr909_sd tr909_sd ~")
    .gain(0.72)
    .room(0.18),

  s("tr808_hh*16")
    .gain("0.11 0.05 0.13 0.05")
    .hpf(7200)
    .pan(rand.range(-0.6, 0.6)),

  s("rd*8")
    .gain(0.12)
    .hpf(6500)
    .room(0.25),

  tomFillB,

  snareRolls.gain(1.15)
)

// 最强段落鼓
let finalRockDrums = stack(
  heavyKick,

  s("~ tr909_sd ~ tr909_sd")
    .gain(0.9)
    .distort(0.08)
    .room(0.14),

  s("tr808_hh*16")
    .gain("0.14 0.06 0.11 0.05")
    .hpf(7200)
    .pan(sine.range(-0.45, 0.45).slow(2)),

  s("cr ~ ~ cr")
    .gain(0.36)
    .hpf(4200)
    .room(0.5)
    .roomsize(6),

  s("rd*8")
    .gain("0.18 0.08 0.14 0.07")
    .hpf(6800)
    .room(0.25),

  cyberPerc,

  tomFillA
    .gain(1.15)
    .sometimesBy(0.3, x => x.fast(2)),

  snareRolls
    .gain(1.25)
    .sometimesBy(0.3, x => x.fast(2))
)

// -----------------------------------------------------
// Bass
// -----------------------------------------------------

let sub = n("0 0 0 0")
  .scale("D1:minor")
  .sound("sine")
  .attack(0.003)
  .decay(0.22)
  .sustain(0.75)
  .release(0.08)
  .gain(0.55)
  .duckorbit(1)
  .duckdepth(0.55)

let bassRiff = n("0 0 12 0 7 0 10 0")
  .scale("D1:minor")
  .sound("sawtooth")
  .attack(0.002)
  .decay(0.085)
  .sustain(0.13)
  .release(0.04)
  .lpf(sine.range(520, 1300).slow(8))
  .lpq(14)
  .distort(0.34)
  .shape(0.18)
  .gain(0.68)
  .duckorbit(1)
  .duckdepth(0.52)

let overdriveBass = n("0 0 12 0 7 0 10 0 0 0 12 0 7 10 7 0")
  .scale("D1:minor")
  .sound("sawtooth")
  .attack(0.002)
  .decay(0.07)
  .sustain(0.1)
  .release(0.035)
  .lpf(sine.range(450, 1600).slow(6))
  .lpq(16)
  .distort(0.42)
  .shape(0.24)
  .gain(0.74)
  .duckorbit(1)
  .duckdepth(0.6)

// -----------------------------------------------------
// Melody / High Contrast
// -----------------------------------------------------

let gridLead = n("<12 15 14 10 12 17 15 14>/2")
  .scale("D5:minor")
  .sound("supersaw")
  .attack(0.018)
  .decay(0.16)
  .sustain(0.36)
  .release(0.42)
  .hpf(700)
  .lpf(4300)
  .vib(5)
  .vibmod(0.08)
  .delay(0.42)
  .delaytime(0.25)
  .delayfb(0.34)
  .room(0.52)
  .roomsize(5)
  .gain(0.3)

let answerLead = n("<19 17 14 15 12 10 12 14>/2")
  .scale("D5:minor")
  .sound("gm_lead_2_sawtooth")
  .attack(0.015)
  .decay(0.14)
  .sustain(0.3)
  .release(0.35)
  .hpf(900)
  .lpf(4800)
  .delay(0.36)
  .delaytime(0.1875)
  .delayfb(0.38)
  .room(0.55)
  .gain(0.22)
  .sometimesBy(0.25, x => x.ply(2))

let glassArp = chord(prog)
  .anchor("D5")
  .voicing()
  .arp("0 2 1 3 0 4 2 5")
  .sound("square")
  .attack(0.003)
  .decay(0.065)
  .sustain(0.1)
  .release(0.04)
  .hpf(1400)
  .lpf(5600)
  .lpq(12)
  .delay(0.32)
  .delaytime(0.125)
  .delayfb(0.42)
  .room(0.34)
  .gain(0.34)
  .jux(x => x.rev().gain(0.7))

let laserTicks = n("12 14 15 17 19 17 15 14")
  .scale("D6:minor")
  .sound("z_square")
  .attack(0.001)
  .decay(0.035)
  .sustain(0.04)
  .release(0.025)
  .hpf(3000)
  .lpf(7800)
  .crush(5)
  .delay(0.24)
  .delaytime(0.0625)
  .delayfb(0.26)
  .gain(0.14)
  .pan(sine.range(-0.6, 0.6).slow(2))

// -----------------------------------------------------
// Pads / Atmosphere
// -----------------------------------------------------

let metalPad = chord(prog)
  .anchor("D3")
  .voicing()
  .sound("gm_pad_metallic")
  .attack(0.45)
  .release(1.8)
  .lpf(1600)
  .room(0.72)
  .roomsize(7)
  .gain(0.26)
  .duckorbit(1)
  .duckdepth(0.32)

let darkPad = chord(prog)
  .anchor("D2")
  .voicing()
  .sound("gm_pad_warm")
  .attack(0.6)
  .release(2.2)
  .lpf(1100)
  .room(0.82)
  .roomsize(8)
  .gain(0.2)
  .duckorbit(1)
  .duckdepth(0.36)

let neonAir = s("pink")
  .hpf(sine.range(800, 4400).slow(12))
  .lpf(7600)
  .gain(sine.range(0.025, 0.09).slow(8))
  .room(0.86)
  .roomsize(8)
  .pan(sine.range(-0.45, 0.45).slow(5))

let pressureRise = s("white*16")
  .hpf(saw.range(600, 8000).slow(8))
  .gain(saw.range(0.025, 0.22).slow(8))
  .room(0.68)
  .pan(sine.range(-0.35, 0.35).slow(2))

let impact = s("tr808_bd:20 ~ ~ sus_cymbal:14")
  .gain(0.52)
  .room(0.82)
  .roomsize(7)
  .lpf(4800)

// -----------------------------------------------------
// Sections
// -----------------------------------------------------

let fullOpen = stack(
  fullRockDrums,
  sub,
  bassRiff,
  metalPad,
  darkPad,
  glassArp,
  gridLead.gain(0.24),
  laserTicks.gain(0.1),
  neonAir,
  impact
)

let driveA = stack(
  battleRockDrums,
  sub,
  bassRiff.gain(1.05),
  metalPad,
  darkPad,
  glassArp.gain(0.38),
  gridLead,
  laserTicks,
  neonAir
)

let driveB = stack(
  battleRockDrums,
  sub,
  overdriveBass,
  metalPad,
  darkPad,
  glassArp
    .gain(0.42)
    .every(4, x => x.fast(2)),
  gridLead.gain(0.3),
  answerLead.gain(0.18),
  laserTicks.gain(0.17),
  pressureRise,
  impact
)

let combatBreak = stack(
  rockBreakDrums,
  sub.gain(0.45),
  bassRiff.gain(0.78),
  metalPad.gain(0.22),
  glassArp
    .slow(2)
    .gain(0.26)
    .lpf(2600),
  gridLead
    .slow(2)
    .gain(0.22)
    .room(0.78),
  neonAir.gain(1.25)
)

let finalOverdrive = stack(
  finalRockDrums,

  sub.gain(0.74),

  overdriveBass
    .every(4, x => x.fast(2))
    .sometimesBy(0.3, x => x.ply(2))
    .gain(0.82),

  metalPad,

  darkPad,

  glassArp
    .gain(0.48)
    .every(4, x => x.fast(2)),

  gridLead.gain(0.34),

  answerLead
    .gain(0.24)
    .sometimesBy(0.25, x => x.ply(2)),

  laserTicks
    .gain(0.22)
    .sometimesBy(0.35, x => x.rev()),

  impact
)

let tailRelease = stack(
  s("tr909_bd ~ ~ ~")
    .gain(0.38)
    .distort(0.08)
    .orbit(1),

  s("~ ~ tr909_sd ~")
    .gain(0.28)
    .room(0.35),

  s("cr ~ ~ ~")
    .gain(0.22)
    .hpf(4200)
    .room(0.8)
    .roomsize(8),

  sub.gain(0.28),

  metalPad
    .gain(0.3)
    .lpf(900)
    .room(0.9),

  darkPad
    .gain(0.24)
    .lpf(750)
    .room(0.92),

  glassArp
    .gain(0.16)
    .lpf(1800)
    .delayfb(0.58),

  gridLead
    .gain(0.16)
    .release(1.4)
    .room(0.86)
    .delayfb(0.5),

  neonAir.gain(1.05)
)

// -----------------------------------------------------
// Arrangement
// -----------------------------------------------------
// 140 BPM: 2分钟 ≈ 70 cycles
// 结构：直接满开 → 摇滚鼓推进 → 高频加压 → 鼓 break → 最终高潮 → 尾音 → 静音

arrange(
  [8, fullOpen],          // 0:00 - 0:13.7
  [10, driveA],           // 0:13.7 - 0:30.9
  [12, driveB],           // 0:30.9 - 0:51.4
  [8, combatBreak],       // 0:51.4 - 1:05.1
  [18, finalOverdrive],   // 1:05.1 - 1:36.0
  [12.8333, tailRelease], // 1:36.0 - 1:58.0
  [1.1667, silence2s]     // 1:58.0 - 2:00.0
)
