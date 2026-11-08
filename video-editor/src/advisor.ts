// Suggestions: looks at measurements of the video (frame brightness and colour, voice loudness, pauses) and the
// current edit, and returns plain-English advice, each with an optional one-click fix.
// Pure functions only, so the rules can be unit-tested in Node.

import type { Aspect, Grade } from './engine'

export interface FrameStats {
  luma: number // mean brightness 0..255
  spread: number // p95 - p5 brightness, 0..255 (a rough measure of contrast)
  sat: number // mean saturation 0..1
}

export interface VoiceStats {
  speechDb: number // typical loudness while talking, dBFS (20 ms RMS windows)
  peakDb: number // loudest 20 ms window, dBFS
}

export interface AdviceInput {
  duration: number
  aspect: Aspect
  res: 720 | 1080
  sourceW: number
  sourceH: number
  frames: FrameStats[]
  grade: Grade
  voice: VoiceStats | null
  voiceVolume: number
  pauses: { count: number; seconds: number }
  leadSilence: number
  tailSilence: number
  hasCaptions: boolean
  hasOverlays: boolean
  hasMusic: boolean
  musicVolume: number
  duck: boolean
}

export type AdviceAction =
  | { kind: 'grade'; patch: Partial<Grade> }
  | { kind: 'voice'; volume: number }
  | { kind: 'cutPauses' }
  | { kind: 'trimEdges' }
  | { kind: 'aspect'; aspect: Aspect }
  | { kind: 'res'; res: 720 | 1080 }
  | { kind: 'music'; volume: number; duck: boolean }
  | { kind: 'tab'; tab: 'captions' | 'text' | 'audio' }

export interface Advice {
  id: string
  level: 'fix' | 'tip' | 'good'
  title: string
  detail: string
  action?: { label: string; do: AdviceAction }
}

const TARGET_LUMA = 118
const SPEECH_TARGET_DB = -20
const SHORTS_MAX = 180 // YouTube Shorts can be up to 3 minutes

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const round5 = (v: number) => Math.round(v / 5) * 5

/** Per-frame stats from RGBA pixels (e.g. a small canvas). */
export function frameStats(rgba: Uint8ClampedArray): FrameStats {
  const hist = new Uint32Array(256)
  let sum = 0
  let satSum = 0
  const n = rgba.length / 4
  for (let i = 0; i < rgba.length; i += 4) {
    const r = rgba[i]
    const g = rgba[i + 1]
    const b = rgba[i + 2]
    const y = Math.round(0.299 * r + 0.587 * g + 0.114 * b)
    hist[y]++
    sum += y
    const mx = Math.max(r, g, b)
    const mn = Math.min(r, g, b)
    satSum += mx ? (mx - mn) / mx : 0
  }
  const pctl = (q: number) => {
    let acc = 0
    const want = q * n
    for (let v = 0; v < 256; v++) {
      acc += hist[v]
      if (acc >= want) return v
    }
    return 255
  }
  return { luma: n ? sum / n : 0, spread: pctl(0.95) - pctl(0.05), sat: n ? satSum / n : 0 }
}

/** Typical speech level and peak from a loudness envelope (dBFS per window), given the silence threshold. */
export function voiceStats(env: Float32Array, thresholdDb: number): VoiceStats | null {
  const speech: number[] = []
  let peak = -120
  for (const v of env) {
    if (v > peak) peak = v
    if (v > thresholdDb) speech.push(v)
  }
  if (speech.length < 10) return null
  speech.sort((a, b) => a - b)
  return { speechDb: speech[Math.floor(speech.length * 0.5)], peakDb: peak }
}

/** Seconds of quiet from the start (or, with fromEnd, the end) of a window of the envelope. */
export function quietRun(env: Float32Array, thresholdDb: number, fromSec: number, toSec: number, hop: number, fromEnd = false): number {
  const a = Math.max(0, Math.floor(fromSec / hop))
  const b = Math.min(env.length, Math.ceil(toSec / hop))
  let n = 0
  if (!fromEnd) {
    for (let i = a; i < b && env[i] <= thresholdDb; i++) n++
  } else {
    for (let i = b - 1; i >= a && env[i] <= thresholdDb; i--) n++
  }
  return n * hop
}

export function advise(x: AdviceInput): Advice[] {
  const out: Advice[] = []

  // --- Picture ---
  if (x.frames.length) {
    const luma = mean(x.frames.map((f) => f.luma))
    const spread = mean(x.frames.map((f) => f.spread))
    const sat = mean(x.frames.map((f) => f.sat))
    let pictureOk = true
    if (luma < 90) {
      const want = clamp(round5((TARGET_LUMA / Math.max(luma, 20) - 1) * 100 * 0.7), 10, 40)
      if (x.grade.brightness < want) {
        pictureOk = false
        out.push({
          id: 'dark',
          level: 'fix',
          title: 'The video looks dark',
          detail: `Average brightness is ${Math.round((luma / 255) * 100)}%. Faces read better a little brighter, especially on phones in daylight.`,
          action: { label: `Brighten by ${want}`, do: { kind: 'grade', patch: { brightness: want } } }
        })
      }
    } else if (luma > 190) {
      const want = -clamp(round5((1 - TARGET_LUMA / luma) * 100 * 0.7), 5, 30)
      if (x.grade.brightness > want) {
        pictureOk = false
        out.push({
          id: 'bright',
          level: 'fix',
          title: 'The video looks overexposed',
          detail: `Average brightness is ${Math.round((luma / 255) * 100)}%. Bright areas lose detail, and white backgrounds glare on phones.`,
          action: { label: `Darken by ${-want}`, do: { kind: 'grade', patch: { brightness: want } } }
        })
      }
    }
    if (spread < 110 && x.grade.contrast < 15) {
      pictureOk = false
      out.push({
        id: 'flat',
        level: 'tip',
        title: 'The picture looks flat',
        detail: 'Darks and lights are close together, which often happens with window light or a webcam. A little contrast makes it look sharper.',
        action: { label: 'Add contrast', do: { kind: 'grade', patch: { contrast: 15 } } }
      })
    }
    if (sat < 0.12 && x.grade.preset !== 'bw' && x.grade.saturation < 15) {
      pictureOk = false
      out.push({
        id: 'dull',
        level: 'tip',
        title: 'Colours look washed out',
        detail: 'Colour is low across the video. A small saturation boost makes skin tones and backgrounds look healthier.',
        action: { label: 'Boost colour', do: { kind: 'grade', patch: { saturation: 20 } } }
      })
    }
    if (pictureOk) out.push({ id: 'picture-ok', level: 'good', title: 'Brightness and colour look good', detail: 'Nothing to fix in the picture.' })
  }

  // --- Sound ---
  if (x.voice) {
    const gainDb = 20 * Math.log10(Math.max(x.voiceVolume, 0.01))
    const level = x.voice.speechDb + gainDb
    if (level < SPEECH_TARGET_DB - 6) {
      const vol = clamp(Math.round(Math.pow(10, (SPEECH_TARGET_DB - x.voice.speechDb) / 20) * 20) / 20, 0.05, 2)
      // Don't push the loudest moments into distortion.
      const safe = Math.min(vol, Math.floor(Math.pow(10, (-1 - x.voice.peakDb) / 20) * 20) / 20)
      if (safe > x.voiceVolume + 0.04) {
        out.push({
          id: 'quiet',
          level: 'fix',
          title: 'Your voice is quiet',
          detail: 'Viewers turn the volume up for a quiet video, then the next one blasts them. Most social video is mixed louder than this.',
          action: { label: `Set voice to ${Math.round(safe * 100)}%`, do: { kind: 'voice', volume: safe } }
        })
      } else {
        out.push({
          id: 'quiet-max',
          level: 'tip',
          title: 'Still quiet at this volume',
          detail: 'The recording itself is quiet, and turning it up further would distort or raise the room noise. Next time, record closer to the microphone, or use a clip-on mic.'
        })
      }
    } else if (x.voice.peakDb + gainDb > -1) {
      const vol = clamp(Math.floor(Math.pow(10, (-2 - x.voice.peakDb) / 20) * 20) / 20, 0.05, 2)
      out.push({
        id: 'loud',
        level: 'fix',
        title: 'The loudest moments may distort',
        detail: 'Some peaks reach full scale at this voice volume, which sounds harsh after export.',
        action: { label: `Set voice to ${Math.round(vol * 100)}%`, do: { kind: 'voice', volume: vol } }
      })
    } else {
      out.push({ id: 'voice-ok', level: 'good', title: 'Voice level is good', detail: 'Loud enough to hear on a phone without distorting.' })
    }
  }

  if (x.leadSilence >= 1) {
    out.push({
      id: 'lead',
      level: 'fix',
      title: `${x.leadSilence.toFixed(1)} s of silence before you start talking`,
      detail: 'Viewers decide in the first two seconds whether to keep watching. Start on the first word.',
      action: { label: 'Trim the start and end', do: { kind: 'trimEdges' } }
    })
  } else if (x.tailSilence >= 1.5) {
    out.push({
      id: 'tail',
      level: 'tip',
      title: `${x.tailSilence.toFixed(1)} s of silence at the end`,
      detail: 'Ending soon after the last word keeps the video tight and helps it loop on Shorts and Reels.',
      action: { label: 'Trim the end', do: { kind: 'trimEdges' } }
    })
  }

  if (x.pauses.count >= 2 && x.pauses.seconds >= 1.5) {
    out.push({
      id: 'pauses',
      level: 'fix',
      title: `${x.pauses.count} pauses add up to ${x.pauses.seconds.toFixed(1)} s`,
      detail: 'Cutting the gaps between sentences keeps the pace up, the "jump cut" style used in most talking videos. You can undo it.',
      action: { label: 'Cut the pauses', do: { kind: 'cutPauses' } }
    })
  }

  // --- Words on screen ---
  if (!x.hasCaptions && x.voice) {
    out.push({
      id: 'captions',
      level: 'tip',
      title: 'Add captions',
      detail: 'Many people watch social video with the sound off. Captions keep them watching. Load an .srt file from YouTube, CapCut or a transcription tool.',
      action: { label: 'Open Captions', do: { kind: 'tab', tab: 'captions' } }
    })
  }
  if (!x.hasOverlays) {
    out.push({
      id: 'title',
      level: 'tip',
      title: 'Add a title or name banner',
      detail: 'A few words on screen in the first seconds tell viewers what the video is about, before they decide to scroll.',
      action: { label: 'Open Text', do: { kind: 'tab', tab: 'text' } }
    })
  }

  // --- Music ---
  if (x.hasMusic) {
    if (x.musicVolume > 0.5 && x.voice) {
      out.push({
        id: 'music-loud',
        level: 'fix',
        title: 'Music may cover your voice',
        detail: 'Background music works best well under the voice. Around 30% with ducking on is a safe start.',
        action: { label: 'Music 30%, duck on', do: { kind: 'music', volume: 0.3, duck: true } }
      })
    } else if (!x.duck && x.voice) {
      out.push({
        id: 'duck',
        level: 'tip',
        title: 'Lower the music while you talk',
        detail: 'Ducking dips the music under speech and brings it back in the pauses.',
        action: { label: 'Turn on ducking', do: { kind: 'music', volume: x.musicVolume, duck: true } }
      })
    }
  } else if (x.duration >= 15) {
    out.push({
      id: 'music',
      level: 'tip',
      title: 'Add quiet background music',
      detail: 'A soft music bed makes a talking video feel finished. The free library tracks are made by this editor, so they are safe for YouTube.',
      action: { label: 'Open Audio', do: { kind: 'tab', tab: 'audio' } }
    })
  }

  // --- Format ---
  if (x.aspect === '16:9' && x.duration <= SHORTS_MAX) {
    out.push({
      id: 'shorts',
      level: 'tip',
      title: 'Short enough for Shorts and Reels',
      detail: `At ${Math.round(x.duration)} s this also works as a vertical Short or Reel. Export one 16:9 version for YouTube, then switch and export a 9:16 one.`,
      action: { label: 'Switch to 9:16', do: { kind: 'aspect', aspect: '9:16' } }
    })
  }
  if (x.aspect === '9:16' && x.duration > SHORTS_MAX) {
    out.push({
      id: 'too-long',
      level: 'fix',
      title: 'Too long for a YouTube Short',
      detail: `Shorts can be up to 3 minutes and this is ${Math.floor(x.duration / 60)}:${String(Math.round(x.duration % 60)).padStart(2, '0')}. Trim it, or export it as a normal 16:9 video.`
    })
  }
  if (Math.min(x.sourceW, x.sourceH) < 1000 && x.res === 1080) {
    out.push({
      id: 'res',
      level: 'tip',
      title: 'Export at 720p',
      detail: `The source is ${x.sourceW}×${x.sourceH}. Exporting at 1080p makes a bigger file without adding detail.`,
      action: { label: 'Use 720p', do: { kind: 'res', res: 720 } }
    })
  }

  const order = { fix: 0, tip: 1, good: 2 }
  return out.sort((a, b) => order[a.level] - order[b.level])
}
