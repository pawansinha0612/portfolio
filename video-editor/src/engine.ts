// Pure helpers: timeline maths, silence detection, subtitle parsing, layout.
// No DOM access here, so the tests can run it in Node (see test/engine.test.ts).

export interface Clip {
  id: string
  assetId: string
  in: number // seconds into the source file
  out: number
  speed?: number // playback speed, 0.25..4 (default 1). The clip lasts (out - in) / speed on the timeline
  volume?: number // 0..2 (default 1), multiplies the voice volume while this clip plays
  zoom?: number // 1..2 (default 1), punch-in around the frame centre
}

export interface Cue {
  start: number // source-file seconds
  end: number
  text: string
}

export interface Range {
  start: number
  end: number
}

export type Aspect = '16:9' | '9:16' | '1:1' | '4:5'

export const MIN_CLIP = 0.1

let idCounter = 0
export const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(idCounter++).toString(36)}`

export const clipSpeed = (c: Clip) => (c.speed && c.speed > 0 ? c.speed : 1)

/** Seconds the clip lasts on the timeline. */
export const clipLength = (c: Clip) => (c.out - c.in) / clipSpeed(c)

export function totalDuration(clips: Clip[]): number {
  return clips.reduce((sum, c) => sum + clipLength(c), 0)
}

export function clipStarts(clips: Clip[]): number[] {
  const starts: number[] = []
  let t = 0
  for (const c of clips) {
    starts.push(t)
    t += clipLength(c)
  }
  return starts
}

export interface Located {
  index: number
  clip: Clip
  start: number // timeline time the clip starts at
  srcTime: number // matching time inside the source file
}

/** Which clip plays at timeline time t (clips sit back to back, no gaps). */
export function locate(clips: Clip[], t: number): Located | null {
  let start = 0
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i]
    const len = clipLength(c)
    if (t < start + len || (i === clips.length - 1 && t <= start + len)) {
      const into = Math.max(0, Math.min(t - start, len))
      return { index: i, clip: c, start, srcTime: c.in + into * clipSpeed(c) }
    }
    start += len
  }
  return null
}

/** Split the clip under timeline time t into two. Returns the same array if t is at an edge. */
export function splitAt(clips: Clip[], t: number): Clip[] {
  const loc = locate(clips, t)
  if (!loc) return clips
  const { clip, srcTime, index } = loc
  if (srcTime - clip.in < MIN_CLIP || clip.out - srcTime < MIN_CLIP) return clips
  const left: Clip = { ...clip, id: uid('clip'), out: srcTime }
  const right: Clip = { ...clip, id: uid('clip'), in: srcTime }
  return [...clips.slice(0, index), left, right, ...clips.slice(index + 1)]
}

/**
 * Remove source-time ranges of one asset from every clip that uses it.
 * A clip that loses its middle becomes two clips; pieces shorter than MIN_CLIP are dropped.
 */
export function removeRanges(clips: Clip[], assetId: string, ranges: Range[]): Clip[] {
  if (!ranges.length) return clips
  const sorted = [...ranges].sort((a, b) => a.start - b.start)
  const out: Clip[] = []
  for (const c of clips) {
    if (c.assetId !== assetId) {
      out.push(c)
      continue
    }
    let cursor = c.in
    const pieces: Clip[] = []
    for (const r of sorted) {
      if (r.end <= cursor || r.start >= c.out) continue
      if (r.start > cursor) pieces.push({ ...c, id: uid('clip'), in: cursor, out: Math.min(r.start, c.out) })
      cursor = Math.max(cursor, r.end)
      if (cursor >= c.out) break
    }
    if (cursor < c.out) pieces.push({ ...c, id: uid('clip'), in: cursor, out: c.out })
    const kept = pieces.filter((p) => clipLength(p) >= MIN_CLIP)
    // Keep the original id when nothing was cut, so selection survives.
    if (kept.length === 1 && kept[0].in === c.in && kept[0].out === c.out) out.push(c)
    else out.push(...kept)
  }
  return out
}

// --- Audio analysis -------------------------------------------------------

export const HOP = 0.02 // seconds per loudness window

/** Loudness envelope in dBFS, one value per HOP seconds, from the decoded channels. */
export function computeEnvelope(channels: Float32Array[], sampleRate: number, hop = HOP): Float32Array {
  const win = Math.max(1, Math.round(sampleRate * hop))
  const length = channels[0]?.length ?? 0
  const n = Math.ceil(length / win)
  const env = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const from = i * win
    const to = Math.min(length, from + win)
    let sum = 0
    for (const ch of channels) {
      for (let j = from; j < to; j++) sum += ch[j] * ch[j]
    }
    const rms = Math.sqrt(sum / ((to - from) * channels.length || 1))
    env[i] = rms > 0 ? 20 * Math.log10(rms) : -120
  }
  return env
}

/**
 * Quiet stretches longer than minSilence, shrunk by `pad` at each end so cuts
 * don't clip the first or last syllable.
 */
export function findSilences(
  env: Float32Array,
  thresholdDb: number,
  minSilence: number,
  pad: number,
  hop = HOP
): Range[] {
  const ranges: Range[] = []
  let runStart = -1
  const close = (endIdx: number) => {
    const start = runStart * hop
    const end = endIdx * hop
    if (end - start >= minSilence) {
      // Silence at the very start/end of a file needs no padding on the outer side.
      const s = runStart === 0 ? 0 : start + pad
      const e = endIdx >= env.length ? end : end - pad
      if (e - s >= MIN_CLIP) ranges.push({ start: s, end: e })
    }
    runStart = -1
  }
  for (let i = 0; i < env.length; i++) {
    if (env[i] < thresholdDb) {
      if (runStart < 0) runStart = i
    } else if (runStart >= 0) close(i)
  }
  if (runStart >= 0) close(env.length)
  return ranges
}

/** Silence ranges that fall inside the parts of the file actually on the timeline. */
export function rangesInUse(ranges: Range[], clips: Clip[], assetId: string): Range[] {
  const used: Range[] = []
  for (const c of clips) {
    if (c.assetId !== assetId) continue
    for (const r of ranges) {
      const s = Math.max(r.start, c.in)
      const e = Math.min(r.end, c.out)
      if (e - s >= MIN_CLIP) used.push({ start: s, end: e })
    }
  }
  return used
}

// --- Subtitles ------------------------------------------------------------

function parseStamp(s: string): number | null {
  const m = s.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/)
  if (!m) return null
  const [, h, mi, se, ms] = m
  return (Number(h || 0) * 3600) + Number(mi) * 60 + Number(se) + (ms ? Number(ms.padEnd(3, '0')) / 1000 : 0)
}

/** Parse SRT or WebVTT text into cues. Tags like <i> and {\an8} are stripped. */
export function parseSubtitles(text: string): Cue[] {
  const cues: Cue[] = []
  const blocks = text.replace(/\r/g, '').replace(/^﻿/, '').split(/\n{2,}/)
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim() !== '')
    const ti = lines.findIndex((l) => l.includes('-->'))
    if (ti < 0) continue
    const [a, b] = lines[ti].split('-->')
    const start = parseStamp(a)
    const end = parseStamp(b.trim().split(/\s+/)[0])
    if (start === null || end === null || end <= start) continue
    const body = lines
      .slice(ti + 1)
      .join('\n')
      .replace(/<[^>]+>/g, '')
      .replace(/\{\\[^}]*\}/g, '')
      .trim()
    if (body) cues.push({ start, end, text: body })
  }
  return cues.sort((x, y) => x.start - y.start)
}

export function cueAt(cues: Cue[] | undefined, t: number): Cue | null {
  if (!cues) return null
  for (const c of cues) {
    if (t >= c.start && t < c.end) return c
    if (c.start > t) break
  }
  return null
}

// --- Layout ---------------------------------------------------------------

export function outputSize(aspect: Aspect, res: 720 | 1080): { w: number; h: number } {
  if (aspect === '9:16') return { w: res, h: Math.round((res * 16) / 9) }
  if (aspect === '1:1') return { w: res, h: res }
  if (aspect === '4:5') return { w: res, h: Math.round((res * 5) / 4) }
  return { w: Math.round((res * 16) / 9), h: res }
}

/**
 * Where to draw a source frame. 'cover' fills the frame and crops (panX/panY
 * from -1 to 1 choose which part is kept: -1 = left/top edge, 1 = right/bottom); 'contain' shows the whole frame.
 */
export function fitRect(
  sw: number,
  sh: number,
  dw: number,
  dh: number,
  fit: 'cover' | 'contain',
  panX = 0,
  panY = 0
): { x: number; y: number; w: number; h: number } {
  const scale = fit === 'cover' ? Math.max(dw / sw, dh / sh) : Math.min(dw / sw, dh / sh)
  const w = sw * scale
  const h = sh * scale
  const x = (dw - w) / 2 - (fit === 'cover' ? (panX * (w - dw)) / 2 : 0)
  const y = (dh - h) / 2 - (fit === 'cover' ? (panY * (h - dh)) / 2 : 0)
  return { x, y, w, h }
}

/** Greedy word wrap using a measuring function (ctx.measureText in the app). */
export function wrapText(text: string, maxWidth: number, measure: (s: string) => number): string[] {
  const out: string[] = []
  for (const para of text.split('\n')) {
    let line = ''
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word
      if (line && measure(next) > maxWidth) {
        out.push(line)
        line = word
      } else line = next
    }
    if (line) out.push(line)
  }
  return out
}

export interface Grade {
  preset: 'none' | 'warm' | 'cool' | 'punchy' | 'film' | 'bw'
  brightness: number // -50..50
  contrast: number
  saturation: number
}

const PRESETS: Record<Grade['preset'], string> = {
  none: '',
  warm: 'sepia(18%) saturate(115%)',
  cool: 'hue-rotate(-10deg) saturate(95%)',
  punchy: 'contrast(115%) saturate(125%)',
  film: 'contrast(110%) saturate(90%) sepia(10%)',
  bw: 'grayscale(100%) contrast(110%)'
}

export function filterString(g: Grade): string {
  const parts = [PRESETS[g.preset]]
  if (g.brightness) parts.push(`brightness(${100 + g.brightness}%)`)
  if (g.contrast) parts.push(`contrast(${100 + g.contrast}%)`)
  if (g.saturation) parts.push(`saturate(${100 + g.saturation}%)`)
  return parts.filter(Boolean).join(' ') || 'none'
}

/** Threshold a little above the file's noise floor (10th percentile loudness). */
export function suggestThreshold(env: Float32Array): number {
  if (!env.length) return -40
  const sorted = Array.from(env).sort((a, b) => a - b)
  const floor = sorted[Math.floor(sorted.length * 0.1)]
  return Math.round(Math.max(-60, Math.min(-20, floor + 10)))
}

/** Timeline time where a source time of an asset is shown, or null if that part was cut. */
export function sourceToTimeline(clips: Clip[], assetId: string, src: number): number | null {
  let start = 0
  for (const c of clips) {
    if (c.assetId === assetId && src >= c.in && src < c.out) return start + (src - c.in) / clipSpeed(c)
    start += clipLength(c)
  }
  return null
}

export function formatTime(t: number, withFraction = true): string {
  const safe = Math.max(0, t)
  const m = Math.floor(safe / 60)
  const s = Math.floor(safe % 60)
  const base = `${m}:${s.toString().padStart(2, '0')}`
  return withFraction ? `${base}.${Math.floor((safe % 1) * 10)}` : base
}
