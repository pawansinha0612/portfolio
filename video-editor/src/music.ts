// Built-in music library.
//
// Every track here is composed and synthesised in the browser by the code in this file: oscillators, filtered
// noise and a generated reverb. No samples and no third-party recordings are used, so nobody else holds rights
// to the audio. Tracks render on first use (about a second) and are cached for the session.

export interface LibraryTrack {
  id: string
  name: string
  mood: string
  bpm: number
}

const SR = 44100
const TAIL = 3 // seconds rendered past the loop end, then folded back onto the start so the loop is seamless

// ---------- pure helpers (unit-tested) ----------

export function midiToHz(m: number): number {
  return 440 * Math.pow(2, (m - 69) / 12)
}

/** Small seeded PRNG (mulberry32) so a track sounds the same every time it renders. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Mix everything after `loop` samples back onto the start, so reverb tails and held notes wrap round the loop. */
export function foldTail(data: Float32Array, loop: number): Float32Array {
  const out = data.slice(0, loop)
  for (let i = loop; i < data.length; i++) out[(i - loop) % loop] += data[i]
  return out
}

/** Gain that brings the mix to a similar loudness for every track without the peaks clipping. */
export function loudnessGain(channels: Float32Array[], targetRms = 0.16, ceiling = 0.92): number {
  let sum = 0
  let n = 0
  let peak = 0
  for (const c of channels) {
    for (let i = 0; i < c.length; i++) {
      const v = c[i]
      sum += v * v
      const a = v < 0 ? -v : v
      if (a > peak) peak = a
    }
    n += c.length
  }
  if (!peak || !n) return 1
  return Math.min(targetRms / Math.sqrt(sum / n), ceiling / peak)
}

/** 16-bit PCM WAV. */
export function encodeWav(channels: Float32Array[], sampleRate: number, gain = 1): ArrayBuffer {
  const nch = channels.length
  const len = channels[0]?.length ?? 0
  const bytes = len * nch * 2
  const buf = new ArrayBuffer(44 + bytes)
  const v = new DataView(buf)
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i))
  }
  str(0, 'RIFF')
  v.setUint32(4, 36 + bytes, true)
  str(8, 'WAVE')
  str(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true)
  v.setUint16(22, nch, true)
  v.setUint32(24, sampleRate, true)
  v.setUint32(28, sampleRate * nch * 2, true)
  v.setUint16(32, nch * 2, true)
  v.setUint16(34, 16, true)
  str(36, 'data')
  v.setUint32(40, bytes, true)
  let o = 44
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < nch; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i] * gain))
      v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true)
      o += 2
    }
  }
  return buf
}

// ---------- synth ----------

type Osc = [OscillatorType, number, number, number?] // type, frequency multiple, gain, detune cents

interface Voice {
  oscs: Osc[]
  attack: number
  sustain: number // fraction of level held after the decay
  decay: number // time constant
  release: number // time constant
  filter?: [number, number?, number?] // lowpass start Hz, target Hz, time constant
  q?: number
}

const KEYS: Voice = {
  oscs: [['sine', 1, 1], ['sine', 2, 0.18], ['triangle', 1, 0.25, 4]],
  attack: 0.006, sustain: 0.3, decay: 0.6, release: 0.3
}
const PIANO: Voice = {
  oscs: [['triangle', 1, 1], ['sine', 2, 0.3], ['sine', 3, 0.08]],
  attack: 0.004, sustain: 0.15, decay: 0.8, release: 0.25, filter: [3500, 900, 0.6]
}
const PAD: Voice = {
  oscs: [['sawtooth', 1, 0.5, -8], ['sawtooth', 1, 0.5, 8], ['sine', 0.5, 0.4]],
  attack: 0.8, sustain: 1, decay: 1, release: 0.9, filter: [850], q: 0.5
}
const PLUCK: Voice = {
  oscs: [['sawtooth', 1, 0.6, -5], ['square', 1, 0.25, 5]],
  attack: 0.003, sustain: 0, decay: 0.14, release: 0.1, filter: [4200, 600, 0.08]
}
const BASS: Voice = {
  oscs: [['triangle', 1, 1], ['sine', 0.5, 0.6]],
  attack: 0.01, sustain: 0.7, decay: 0.3, release: 0.06, filter: [700]
}
const SYNTH_BASS: Voice = {
  oscs: [['sawtooth', 1, 0.7], ['square', 0.5, 0.3]],
  attack: 0.004, sustain: 0.2, decay: 0.12, release: 0.04, filter: [1800, 300, 0.07], q: 4
}
const BELL: Voice = {
  oscs: [['sine', 1, 1], ['sine', 2.76, 0.25], ['sine', 5.4, 0.08]],
  attack: 0.002, sustain: 0, decay: 0.5, release: 0.5
}

class Synth {
  ctx: OfflineAudioContext
  beat: number
  rand: () => number
  private out: GainNode
  private verb: ConvolverNode
  private noise: AudioBuffer

  constructor(ctx: OfflineAudioContext, bpm: number, seed: number) {
    this.ctx = ctx
    this.beat = 60 / bpm
    this.rand = seeded(seed)
    const comp = ctx.createDynamicsCompressor()
    comp.threshold.value = -14
    comp.ratio.value = 3
    comp.attack.value = 0.01
    comp.release.value = 0.2
    comp.connect(ctx.destination)
    this.out = ctx.createGain()
    this.out.gain.value = 0.5
    this.out.connect(comp)
    this.verb = ctx.createConvolver()
    this.verb.buffer = this.impulse(2.4)
    const wet = ctx.createGain()
    wet.gain.value = 0.35
    this.verb.connect(wet).connect(this.out)
    this.noise = ctx.createBuffer(1, SR, SR)
    const d = this.noise.getChannelData(0)
    for (let i = 0; i < d.length; i++) d[i] = this.rand() * 2 - 1
  }

  /** Time in seconds of `beat` (quarter notes, may be fractional) within `bar`. */
  at(bar: number, beat = 0): number {
    return (bar * 4 + beat) * this.beat
  }

  /** A mixer channel: level, stereo position and reverb send. */
  bus(level: number, pan = 0, send = 0.2): GainNode {
    const g = this.ctx.createGain()
    g.gain.value = level
    const p = this.ctx.createStereoPanner()
    p.pan.value = pan
    g.connect(p).connect(this.out)
    if (send > 0) {
      const s = this.ctx.createGain()
      s.gain.value = send
      g.connect(s).connect(this.verb)
    }
    return g
  }

  note(bus: AudioNode, midi: number, t: number, dur: number, v: Voice, level = 1): void {
    const ctx = this.ctx
    const hz = midiToHz(midi)
    const g = ctx.createGain()
    const p = g.gain
    const held = Math.max(dur, v.attack)
    p.setValueAtTime(0, t)
    p.linearRampToValueAtTime(level, t + v.attack)
    if (v.sustain < 1) p.setTargetAtTime(level * v.sustain, t + v.attack, v.decay)
    p.setTargetAtTime(0, t + held, v.release)
    const end = t + held + v.release * 7
    let input: AudioNode = g
    if (v.filter) {
      const f = ctx.createBiquadFilter()
      f.type = 'lowpass'
      f.Q.value = v.q ?? 0.7
      f.frequency.setValueAtTime(v.filter[0], t)
      if (v.filter[1]) f.frequency.setTargetAtTime(v.filter[1], t, v.filter[2] ?? 0.1)
      f.connect(g)
      input = f
    }
    g.connect(bus)
    for (const [type, mult, gain, cents] of v.oscs) {
      const osc = ctx.createOscillator()
      osc.type = type
      osc.frequency.value = hz * mult
      if (cents) osc.detune.value = cents
      if (gain === 1) osc.connect(input)
      else {
        const og = ctx.createGain()
        og.gain.value = gain
        osc.connect(og).connect(input)
      }
      osc.start(t)
      osc.stop(end)
    }
  }

  chord(bus: AudioNode, notes: number[], t: number, dur: number, v: Voice, level = 1, strum = 0): void {
    notes.forEach((m, i) => this.note(bus, m, t + i * strum, dur, v, level))
  }

  kick(bus: AudioNode, t: number, level = 1): void {
    const osc = this.ctx.createOscillator()
    const g = this.ctx.createGain()
    osc.frequency.setValueAtTime(150, t)
    osc.frequency.exponentialRampToValueAtTime(42, t + 0.13)
    g.gain.setValueAtTime(0.0001, t)
    g.gain.linearRampToValueAtTime(level, t + 0.004)
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.4)
    osc.connect(g).connect(bus)
    osc.start(t)
    osc.stop(t + 0.45)
  }

  private hit(bus: AudioNode, t: number, type: BiquadFilterType, freq: number, decay: number, level: number): void {
    const src = this.ctx.createBufferSource()
    src.buffer = this.noise
    const f = this.ctx.createBiquadFilter()
    f.type = type
    f.frequency.value = freq
    f.Q.value = 0.7
    const g = this.ctx.createGain()
    g.gain.setValueAtTime(0.0001, t)
    g.gain.linearRampToValueAtTime(level, t + 0.002)
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay)
    src.connect(f).connect(g).connect(bus)
    src.start(t, this.rand() * 0.5)
    src.stop(t + decay + 0.02)
  }

  snare(bus: AudioNode, t: number, level = 1): void {
    this.hit(bus, t, 'bandpass', 1800, 0.18, level)
    const osc = this.ctx.createOscillator()
    osc.type = 'triangle'
    osc.frequency.setValueAtTime(210, t)
    osc.frequency.exponentialRampToValueAtTime(160, t + 0.07)
    const g = this.ctx.createGain()
    g.gain.setValueAtTime(level * 0.5, t)
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09)
    osc.connect(g).connect(bus)
    osc.start(t)
    osc.stop(t + 0.1)
  }

  clap(bus: AudioNode, t: number, level = 1): void {
    for (let i = 0; i < 3; i++) this.hit(bus, t + i * 0.011, 'bandpass', 1300, 0.025, level * 0.7)
    this.hit(bus, t + 0.033, 'bandpass', 1200, 0.16, level)
  }

  hat(bus: AudioNode, t: number, level = 1, open = false): void {
    this.hit(bus, t, 'highpass', 7500, open ? 0.2 : 0.04, level)
  }

  private impulse(sec: number): AudioBuffer {
    const len = Math.round(sec * SR)
    const b = this.ctx.createBuffer(2, len, SR)
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c)
      for (let i = 0; i < len; i++) d[i] = (this.rand() * 2 - 1) * Math.pow(1 - i / len, 3)
    }
    return b
  }
}

// ---------- tracks ----------

interface TrackDef extends LibraryTrack {
  bars: number
  compose: (s: Synth) => void
}

const up = (notes: number[], n: number) => notes.map((m) => m + n)

const TRACKS: TrackDef[] = [
  {
    id: 'lofi',
    name: 'Late Night Notes',
    mood: 'Lo-fi, relaxed',
    bpm: 76,
    bars: 8,
    compose(s) {
      const chords = [[53, 57, 60, 64], [52, 55, 59, 62], [50, 53, 57, 60, 64], [48, 52, 55, 59]]
      const roots = [41, 40, 38, 36]
      const keys = s.bus(0.5, -0.1, 0.3)
      const lead = s.bus(0.45, 0.2, 0.4)
      const bass = s.bus(0.6, 0, 0)
      const drums = s.bus(0.7, 0, 0.08)
      const hats = s.bus(0.35, 0.25, 0.05)
      const swing = s.beat * 0.16
      for (let bar = 0; bar < 8; bar++) {
        const ch = chords[bar % 4]
        s.chord(keys, ch, s.at(bar, 0), s.beat * 1.6, KEYS, 0.28, 0.014)
        s.chord(keys, ch, s.at(bar, 2.5) + swing, s.beat * 1.2, KEYS, 0.2, 0.014)
        s.note(bass, roots[bar % 4], s.at(bar, 0), s.beat * 1.8, BASS, 0.8)
        s.note(bass, roots[bar % 4], s.at(bar, 2.5) + swing, s.beat * 1.2, BASS, 0.6)
        for (const b of bar % 2 ? [0, 1.75, 2.5] : [0, 2.5]) s.kick(drums, s.at(bar, b) + (b % 1 ? swing : 0), 0.9)
        s.snare(drums, s.at(bar, 1), 0.5)
        s.snare(drums, s.at(bar, 3), 0.5)
        for (let e = 0; e < 8; e++) s.hat(hats, s.at(bar, e / 2) + (e % 2 ? swing : 0), 0.5 + s.rand() * 0.4)
        if (bar >= 4) {
          for (const b of [0.5, 1, 1.5, 2.5, 3]) {
            if (s.rand() < 0.5) continue
            const m = ch[Math.floor(s.rand() * ch.length)] + 12
            s.note(lead, m, s.at(bar, b) + (b % 1 ? swing : 0), s.beat * 0.8, KEYS, 0.3)
          }
        }
      }
    }
  },
  {
    id: 'upbeat',
    name: 'Bright Side',
    mood: 'Upbeat, happy',
    bpm: 116,
    bars: 16,
    compose(s) {
      const chords = [[55, 59, 62], [54, 57, 62], [55, 59, 64], [55, 60, 64]]
      const roots = [43, 38, 40, 36]
      const pluck = s.bus(0.35, 0.15, 0.25)
      const pad = s.bus(0.12, -0.15, 0.4)
      const bass = s.bus(0.55, 0, 0)
      const drums = s.bus(0.75, 0, 0.06)
      const hats = s.bus(0.3, 0.25, 0.05)
      const arp = [0, 1, 2, 3, 2, 1, 2, 1]
      for (let bar = 0; bar < 16; bar++) {
        const ch = chords[bar % 4]
        const tones = [...up(ch, 12), ch[0] + 24]
        s.chord(pad, ch, s.at(bar, 0), s.beat * 4, PAD, 0.5)
        for (let e = 0; e < 8; e++) {
          s.note(pluck, tones[arp[e]], s.at(bar, e / 2), s.beat * 0.4, PLUCK, 0.6)
          s.note(bass, roots[bar % 4] + (e % 2 ? 12 : 0), s.at(bar, e / 2), s.beat * 0.4, BASS, 0.7)
          if (e % 2) s.hat(hats, s.at(bar, e / 2), 0.8)
        }
        for (let b = 0; b < 4; b++) s.kick(drums, s.at(bar, b), 0.95)
        if (bar >= 4 || bar % 2) {
          s.clap(drums, s.at(bar, 1), 0.55)
          s.clap(drums, s.at(bar, 3), 0.55)
        }
      }
    }
  },
  {
    id: 'inspire',
    name: 'Next Chapter',
    mood: 'Inspiring, corporate',
    bpm: 100,
    bars: 16,
    compose(s) {
      const chords = [[62, 66, 69], [61, 64, 69], [62, 66, 71], [62, 67, 71]]
      const roots = [38, 45, 47, 43]
      const piano = s.bus(0.4, -0.1, 0.35)
      const pad = s.bus(0.12, 0.1, 0.5)
      const bass = s.bus(0.5, 0, 0)
      const drums = s.bus(0.6, 0, 0.1)
      const hats = s.bus(0.25, 0.25, 0.05)
      for (let bar = 0; bar < 16; bar++) {
        const ch = chords[bar % 4]
        const pattern = [ch[0] - 12, ch[0], ch[1], ch[2], ch[0] + 12, ch[2], ch[1], ch[0]]
        pattern.forEach((m, e) => s.note(piano, m, s.at(bar, e / 2), s.beat * 0.9, PIANO, e === 0 ? 0.75 : 0.55))
        s.chord(pad, ch, s.at(bar, 0), s.beat * 4, PAD, 0.5)
        const full = bar >= 8
        if (full) for (let e = 0; e < 8; e++) s.note(bass, roots[bar % 4], s.at(bar, e / 2), s.beat * 0.4, BASS, 0.6)
        else s.note(bass, roots[bar % 4], s.at(bar, 0), s.beat * 3.8, BASS, 0.7)
        s.kick(drums, s.at(bar, 0), 0.8)
        s.kick(drums, s.at(bar, 2), 0.7)
        if (bar >= 4) {
          s.clap(drums, s.at(bar, 1), 0.4)
          s.clap(drums, s.at(bar, 3), 0.4)
        }
        if (full) for (let e = 0; e < 8; e++) s.hat(hats, s.at(bar, e / 2), e % 2 ? 0.8 : 0.45)
      }
    }
  },
  {
    id: 'ambient',
    name: 'Still Water',
    mood: 'Calm, ambient',
    bpm: 66,
    bars: 8,
    compose(s) {
      const chords = [[57, 60, 64, 67, 71], [53, 57, 60, 64], [48, 55, 60, 64, 67], [55, 59, 62, 67]]
      const roots = [45, 41, 36, 43]
      const pad = s.bus(0.22, 0, 0.6)
      const bells = s.bus(0.22, 0.3, 0.8)
      const sub = s.bus(0.45, 0, 0)
      for (let i = 0; i < 4; i++) {
        const bar = i * 2
        s.chord(pad, chords[i], s.at(bar, 0), s.beat * 8, PAD, 0.45)
        s.note(sub, roots[i] - 12, s.at(bar, 0), s.beat * 8, BASS, 0.7)
        for (let e = 0; e < 16; e++) {
          if (s.rand() > 0.22) continue
          const m = chords[i][Math.floor(s.rand() * chords[i].length)] + 12
          s.note(bells, m, s.at(bar, e / 2), s.beat * 0.5, BELL, 0.35 + s.rand() * 0.25)
        }
      }
    }
  },
  {
    id: 'tech',
    name: 'Signal Path',
    mood: 'Tech, driving',
    bpm: 122,
    bars: 16,
    compose(s) {
      const chords = [[57, 60, 64], [57, 60, 65], [55, 60, 64], [55, 59, 62]]
      const roots = [45, 41, 48, 43]
      const bass = s.bus(0.45, 0, 0)
      const stabs = s.bus(0.3, -0.2, 0.35)
      const pad = s.bus(0.1, 0.2, 0.5)
      const drums = s.bus(0.75, 0, 0.05)
      const hats = s.bus(0.28, 0.3, 0.03)
      for (let bar = 0; bar < 16; bar++) {
        const i = Math.floor(bar / 2) % 4
        for (let x = 0; x < 16; x++) {
          s.note(bass, roots[i] + (x % 4 === 2 ? 12 : 0), s.at(bar, x / 4), s.beat * 0.2, SYNTH_BASS, x % 4 === 0 ? 0.85 : 0.6)
          s.hat(hats, s.at(bar, x / 4), x % 4 === 2 ? 0.8 : 0.35)
        }
        for (const b of [0.75, 1.5, 3.5]) s.chord(stabs, up(chords[i], 12), s.at(bar, b), s.beat * 0.3, PLUCK, 0.4)
        for (let b = 0; b < 4; b++) s.kick(drums, s.at(bar, b), 1)
        s.clap(drums, s.at(bar, 1), 0.5)
        s.clap(drums, s.at(bar, 3), 0.5)
        if (bar >= 8 && bar % 2 === 0) s.chord(pad, chords[i], s.at(bar, 0), s.beat * 8, PAD, 0.5)
      }
    }
  }
]

export const LIBRARY: LibraryTrack[] = TRACKS.map(({ id, name, mood, bpm }) => ({ id, name, mood, bpm }))

const cache = new Map<string, Promise<Blob>>()

/** Render a library track to a seamless WAV loop. Cached per session. */
export function renderTrack(id: string): Promise<Blob> {
  const hit = cache.get(id)
  if (hit) return hit
  const job = render(id)
  cache.set(id, job)
  job.catch(() => cache.delete(id))
  return job
}

async function render(id: string): Promise<Blob> {
  const def = TRACKS.find((t) => t.id === id)
  if (!def) throw new Error(`Unknown track ${id}`)
  const loop = Math.round(((def.bars * 4 * 60) / def.bpm) * SR)
  const ctx = new OfflineAudioContext(2, loop + TAIL * SR, SR)
  let seed = 7
  for (const ch of id) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0
  def.compose(new Synth(ctx, def.bpm, seed))
  const out = await ctx.startRendering()
  const chans = [0, 1].map((c) => foldTail(out.getChannelData(c), loop))
  return new Blob([encodeWav(chans, SR, loudnessGain(chans))], { type: 'audio/wav' })
}
