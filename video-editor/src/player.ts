// The playback + render + export engine. Imperative on purpose: it runs every
// animation frame, and React only hears about the playhead through subscribe().
import {
  type Aspect,
  type Clip,
  type Cue,
  type Grade,
  clipLength,
  clipSpeed,
  cueAt,
  filterString,
  fitRect,
  locate,
  outputSize,
  totalDuration,
  wrapText
} from './engine'

export interface Asset {
  id: string
  name: string
  file: File
  url: string
  duration: number
  width: number
  height: number
}

export interface Music {
  name: string
  url: string
}

export type OverlayStyle = 'shadow' | 'box' | 'banner'

export interface Overlay {
  id: string
  text: string
  start: number
  dur: number
  x: number // centre, 0..1 of frame width
  y: number // centre, 0..1 of frame height
  size: number // font size as a fraction of the frame's shorter side
  color: string
  style: OverlayStyle
  anim?: OverlayAnim
}

export type OverlayAnim = 'none' | 'pop' | 'fade' | 'slide'

export interface CaptionStyle {
  enabled: boolean
  size: number
  y: number
  style: 'box' | 'outline'
  color: string
  upper: boolean
}

export interface Settings {
  aspect: Aspect
  res: 720 | 1080
  fit: 'cover' | 'contain'
  panX: number
  panY: number
  grade: Grade
  voiceVolume: number // 0..2
  musicVolume: number // 0..1
  duck: boolean
  fadeIn?: number // seconds of fade from black at the start (0 = off)
  fadeOut?: number // seconds of fade to black at the end (0 = off)
}

export interface Project {
  clips: Clip[]
  overlays: Overlay[]
  captions: Record<string, Cue[]> // per asset, in source-file time
  captionStyle: CaptionStyle
  settings: Settings
}

export interface Box {
  id: string
  x: number
  y: number
  w: number
  h: number
}

const FONT = "Inter, 'Helvetica Neue', Arial, sans-serif"

const MIME_CANDIDATES = [
  'video/mp4;codecs=avc1.640028,mp4a.40.2',
  'video/mp4;codecs=avc1,mp4a.40.2',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm'
]

export function exportMime(): string {
  if (typeof MediaRecorder === 'undefined') return ''
  return MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m)) ?? ''
}

interface AudioGraph {
  ctx: AudioContext
  voice: GainNode
  music: GainNode
  analyser: AnalyserNode
  buf: Float32Array<ArrayBuffer>
  dest: MediaStreamAudioDestinationNode
}

interface ExportJob {
  recorder: MediaRecorder
  stream: MediaStream
  cancelled: boolean
  onProgress: (p: number) => void
}

export class Player {
  time = 0
  playing = false
  overlayBoxes: Box[] = []

  private project: Project | null = null
  private assets = new Map<string, Asset>()
  private pool = new Map<string, [HTMLVideoElement, HTMLVideoElement]>()
  private current: HTMLVideoElement | null = null
  private lastSeek = new WeakMap<HTMLVideoElement, number>()
  private canvas: HTMLCanvasElement | null = null
  private host: HTMLElement | null = null
  private musicEl: HTMLAudioElement | null = null
  private audio: AudioGraph | null = null
  private routed = new WeakSet<HTMLMediaElement>()
  private listeners = new Set<() => void>()
  private job: ExportJob | null = null
  private raf = 0
  private lastVoice = 0
  private gateEl: HTMLVideoElement | null = null
  private gateTime = -1
  private gateMoved = 0

  attach(canvas: HTMLCanvasElement, host: HTMLElement) {
    this.canvas = canvas
    this.host = host
    for (const pair of this.pool.values()) pair.forEach((v) => host.appendChild(v))
    cancelAnimationFrame(this.raf)
    this.raf = requestAnimationFrame(this.tick)
  }

  detach() {
    cancelAnimationFrame(this.raf)
    this.pause()
    this.canvas = null
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  getTime = () => this.time

  private emit() {
    this.listeners.forEach((fn) => fn())
  }

  setProject(p: Project) {
    this.project = p
    const total = totalDuration(p.clips)
    if (this.time > total) this.seek(total)
  }

  setAssets(list: Asset[]) {
    this.assets = new Map(list.map((a) => [a.id, a]))
    for (const [id, pair] of this.pool) {
      if (!this.assets.has(id)) {
        pair.forEach((v) => {
          v.pause()
          v.remove()
        })
        this.pool.delete(id)
      }
    }
  }

  setMusic(m: Music | null) {
    if (!m) {
      this.musicEl?.pause()
      if (this.musicEl) this.musicEl.removeAttribute('src')
      return
    }
    if (!this.musicEl) {
      this.musicEl = new Audio()
      this.musicEl.loop = true
      this.musicEl.preload = 'auto'
      this.route(this.musicEl, 'music')
    }
    this.musicEl.src = m.url
    if (this.playing) this.syncMusic()
  }

  get duration() {
    return this.project ? totalDuration(this.project.clips) : 0
  }

  get exporting() {
    return this.job !== null
  }

  // --- Transport ------------------------------------------------------------

  play() {
    if (!this.project?.clips.length || this.playing) return
    this.ensureAudio()
    if (this.time >= this.duration - 0.05) this.time = 0
    this.playing = true
    this.syncMusic()
    this.emit()
  }

  pause() {
    if (!this.playing) return
    this.playing = false
    this.current?.pause()
    this.musicEl?.pause()
    this.emit()
  }

  toggle() {
    if (this.playing) this.pause()
    else this.play()
  }

  seek(t: number) {
    this.time = Math.max(0, Math.min(t, this.duration))
    if (this.playing) {
      // Re-anchor on the next tick.
      this.current?.pause()
      this.current = null
      this.syncMusic()
    }
    this.emit()
  }

  // --- Media elements -------------------------------------------------------

  private pair(assetId: string): [HTMLVideoElement, HTMLVideoElement] | null {
    const existing = this.pool.get(assetId)
    if (existing) return existing
    const asset = this.assets.get(assetId)
    if (!asset) return null
    const make = () => {
      const v = document.createElement('video')
      v.src = asset.url
      v.preload = 'auto'
      v.playsInline = true
      v.dataset.asset = assetId
      this.host?.appendChild(v)
      if (this.audio) this.route(v, 'voice')
      return v
    }
    const p: [HTMLVideoElement, HTMLVideoElement] = [make(), make()]
    this.pool.set(assetId, p)
    return p
  }

  /** The element to show a clip of this asset on, preferring the one on screen. */
  private elementFor(assetId: string): HTMLVideoElement | null {
    const p = this.pair(assetId)
    if (!p) return null
    if (this.current && this.current.dataset.asset === assetId) return this.current
    return p[0]
  }

  /** The element to pre-load the next clip on, so the cut is instant. */
  private standbyFor(assetId: string): HTMLVideoElement | null {
    const p = this.pair(assetId)
    if (!p) return null
    return p[0] === this.current ? p[1] : p[0]
  }

  private seekEl(v: HTMLVideoElement, t: number) {
    const last = this.lastSeek.get(v)
    if (v.seeking && last !== undefined && Math.abs(last - t) < 0.02) return
    if (Math.abs(v.currentTime - t) < 0.02) return
    this.lastSeek.set(v, t)
    v.currentTime = t
  }

  // --- Audio ----------------------------------------------------------------

  private ensureAudio() {
    if (this.audio) {
      if (this.audio.ctx.state === 'suspended') this.audio.ctx.resume().catch(() => {})
      return
    }
    const ctx = new AudioContext()
    const voice = ctx.createGain()
    const music = ctx.createGain()
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 1024
    const dest = ctx.createMediaStreamDestination()
    voice.connect(ctx.destination)
    voice.connect(dest)
    voice.connect(analyser)
    music.connect(ctx.destination)
    music.connect(dest)
    this.audio = { ctx, voice, music, analyser, dest, buf: new Float32Array(analyser.fftSize) }
    for (const pair of this.pool.values()) pair.forEach((v) => this.route(v, 'voice'))
    if (this.musicEl) this.route(this.musicEl, 'music')
  }

  private route(el: HTMLMediaElement, bus: 'voice' | 'music') {
    if (!this.audio || this.routed.has(el)) return
    const src = this.audio.ctx.createMediaElementSource(el)
    src.connect(bus === 'voice' ? this.audio.voice : this.audio.music)
    this.routed.add(el)
  }

  private syncMusic() {
    const m = this.musicEl
    if (!m || !m.src) return
    if (!this.playing) {
      m.pause()
      return
    }
    if (m.duration > 0) m.currentTime = this.time % m.duration
    m.play().catch(() => {})
  }

  /** 0 = fully visible, 1 = fully black, from the fade in/out settings at the current time. */
  private fadeAmount(): number {
    const s = this.project?.settings
    if (!s) return 0
    const fi = s.fadeIn ?? 0
    const fo = s.fadeOut ?? 0
    let k = 0
    if (fi > 0 && this.time < fi) k = Math.max(k, 1 - this.time / fi)
    const left = this.duration - this.time
    if (fo > 0 && left < fo) k = Math.max(k, 1 - Math.max(0, left) / fo)
    return Math.min(1, Math.max(0, k))
  }

  private mixAudio() {
    const a = this.audio
    const s = this.project?.settings
    if (!a || !s) return
    const now = a.ctx.currentTime
    const loc = this.project ? locate(this.project.clips, this.time) : null
    const clipVol = loc ? (loc.clip.volume ?? 1) : 1
    const fade = 1 - this.fadeAmount()
    a.voice.gain.setTargetAtTime(s.voiceVolume * clipVol * fade, now, 0.03)
    let target = s.musicVolume * fade
    if (s.duck && this.playing) {
      a.analyser.getFloatTimeDomainData(a.buf)
      let sum = 0
      for (const x of a.buf) sum += x * x
      const db = 20 * Math.log10(Math.sqrt(sum / a.buf.length) || 1e-6)
      if (db > -45) this.lastVoice = performance.now()
      if (performance.now() - this.lastVoice < 450) target *= 0.25
    }
    const remaining = this.duration - this.time
    if (remaining < 2) target *= Math.max(0, remaining / 2) // fade out at the end
    a.music.gain.setTargetAtTime(target, now, 0.12)
  }

  // --- Frame loop -----------------------------------------------------------

  private tick = () => {
    this.raf = requestAnimationFrame(this.tick)
    const p = this.project
    if (!p || !this.canvas) return
    const before = this.time
    if (this.playing) {
      this.advance(p.clips)
      this.gateRecorder()
    } else this.holdFrame(p.clips)
    this.mixAudio()
    this.draw(p)
    if (this.job) this.job.onProgress(this.duration ? this.time / this.duration : 0)
    if (this.time !== before) this.emit()
  }

  private holdFrame(clips: Clip[]) {
    const loc = locate(clips, this.time)
    if (!loc) return
    const v = this.elementFor(loc.clip.assetId)
    if (!v) return
    if (this.current !== v) {
      this.current?.pause()
      this.current = v
    }
    this.seekEl(v, Math.min(loc.srcTime, loc.clip.out - 0.001))
  }

  private advance(clips: Clip[]) {
    const total = totalDuration(clips)
    const loc = locate(clips, this.time)
    if (!loc || this.time >= total) return this.finish()
    const { clip, index, start } = loc

    const v = this.elementFor(clip.assetId)
    if (!v) return this.finish()
    if (this.current !== v) {
      this.current?.pause()
      this.current = v
      this.seekEl(v, loc.srcTime)
    }
    const rate = clipSpeed(clip)
    if (v.playbackRate !== rate) {
      v.playbackRate = rate
      v.preservesPitch = true // speed changes keep the voice at its normal pitch
    }
    if (v.paused && !v.ended) v.play().catch(() => {})
    if (v.seeking || v.readyState < 2) return // waiting for data: hold the playhead

    const src = v.currentTime
    if (src < clip.in - 0.3 || src > clip.out + 0.3) {
      this.seekEl(v, loc.srcTime)
      return
    }
    this.time = start + Math.max(0, src - clip.in) / rate

    // Get the next clip ready on the standby element.
    const next = clips[index + 1]
    const contiguous = next && next.assetId === clip.assetId && Math.abs(next.in - clip.out) < 0.03
    if (next && !contiguous) {
      const sb = this.standbyFor(next.assetId)
      if (sb && sb !== v && sb.paused) this.seekEl(sb, next.in)
    }

    if (src >= clip.out - 0.012 || v.ended) {
      this.time = start + clipLength(clip)
      if (!next) return this.finish()
      if (contiguous) return
      const nv = this.standbyFor(next.assetId)
      if (!nv) return this.finish()
      v.pause()
      this.current = nv
      this.seekEl(nv, next.in)
      nv.playbackRate = clipSpeed(next)
      nv.preservesPitch = true
      nv.play().catch(() => {})
    }
  }

  /**
   * While exporting, pause the recorder whenever playback is waiting on the
   * next clip (seeking, buffering, starting), so the file never contains a
   * frozen frame or a gap. Safari needs this most: it can take ~0.5 s per cut.
   */
  private gateRecorder() {
    const job = this.job
    if (!job || job.recorder.state === 'inactive') return
    const v = this.current
    // Safari can report "playing" while its clock is stuck, so also require currentTime to have moved recently.
    // Measured in wall time, not frames: Firefox only updates currentTime once per video frame (~40 ms at 24 fps),
    // and a frame count would wrongly pause the recorder there and squash the export.
    const t = v ? v.currentTime : -1
    const now = performance.now()
    if (v !== this.gateEl || t !== this.gateTime) this.gateMoved = now
    this.gateEl = v
    this.gateTime = t
    const flowing = !!v && !v.paused && !v.seeking && v.readyState >= 3 && now - this.gateMoved < 150
    if (!flowing && job.recorder.state === 'recording') {
      job.recorder.pause()
      this.musicEl?.pause()
    } else if (flowing && job.recorder.state === 'paused') {
      job.recorder.resume()
      if (this.musicEl?.src) this.musicEl.play().catch(() => {})
    }
  }

  private finish() {
    this.time = this.duration
    this.pause()
    if (this.job) {
      const job = this.job
      // Let the last frame and audio reach the recorder.
      setTimeout(() => job.recorder.state !== 'inactive' && job.recorder.stop(), 250)
    }
  }

  // --- Drawing --------------------------------------------------------------

  private draw(p: Project) {
    const canvas = this.canvas!
    const { w, h } = outputSize(p.settings.aspect, p.settings.res)
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w
      canvas.height = h
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, w, h)

    const loc = locate(p.clips, this.time)
    const v = this.current
    if (loc && v && v.dataset.asset === loc.clip.assetId && v.readyState >= 2 && v.videoWidth) {
      const r = fitRect(v.videoWidth, v.videoHeight, w, h, p.settings.fit, p.settings.panX, p.settings.panY)
      const z = Math.min(2, Math.max(1, loc.clip.zoom ?? 1))
      if (z !== 1) {
        // Punch in around the frame centre.
        r.x = w / 2 + (r.x - w / 2) * z
        r.y = h / 2 + (r.y - h / 2) * z
        r.w *= z
        r.h *= z
      }
      ctx.filter = filterString(p.settings.grade)
      ctx.drawImage(v, r.x, r.y, r.w, r.h)
      ctx.filter = 'none'
    }

    const unit = Math.min(w, h)
    this.overlayBoxes = []
    for (const o of p.overlays) {
      if (this.time < o.start || this.time >= o.start + o.dur || !o.text.trim()) continue
      const anim = o.anim ?? 'none'
      const inP = Math.min(1, (this.time - o.start) / 0.35)
      const outP = Math.min(1, (o.start + o.dur - this.time) / 0.3)
      const ease = 1 - Math.pow(1 - inP, 3)
      ctx.save()
      if (anim !== 'none' && this.playing) {
        const cx = o.x * w
        const cy = o.y * h
        if (anim === 'pop') {
          const sc = inP < 1 ? 0.6 + 0.4 * ease + Math.sin(inP * Math.PI) * 0.08 : 1
          ctx.translate(cx, cy)
          ctx.scale(sc, sc)
          ctx.translate(-cx, -cy)
          ctx.globalAlpha = Math.min(1, inP * 2)
        } else if (anim === 'fade') {
          ctx.globalAlpha = Math.max(0, Math.min(inP, outP))
        } else if (anim === 'slide') {
          ctx.translate(0, (1 - ease) * unit * 0.08)
          ctx.globalAlpha = ease
        }
      }
      this.overlayBoxes.push(this.drawOverlay(ctx, o, w, h, unit))
      ctx.restore()
    }

    if (loc && p.captionStyle.enabled) {
      const cue = cueAt(p.captions[loc.clip.assetId], loc.srcTime)
      if (cue) this.drawCaption(ctx, cue.text, p.captionStyle, w, h, unit)
    }

    const fade = this.fadeAmount()
    if (fade > 0) {
      ctx.fillStyle = `rgba(0,0,0,${fade.toFixed(3)})`
      ctx.fillRect(0, 0, w, h)
    }
  }

  private drawOverlay(ctx: CanvasRenderingContext2D, o: Overlay, w: number, h: number, unit: number): Box {
    const px = Math.round(o.size * unit)
    ctx.font = `800 ${px}px ${FONT}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    const lines = wrapText(o.text, w * 0.86, (s) => ctx.measureText(s).width)
    const lh = px * 1.18
    const blockW = Math.max(...lines.map((l) => ctx.measureText(l).width))
    const blockH = lh * lines.length
    const cx = o.x * w
    const cy = o.y * h
    const padX = px * 0.45
    const padY = px * 0.25
    const box = { id: o.id, x: cx - blockW / 2 - padX, y: cy - blockH / 2 - padY, w: blockW + padX * 2, h: blockH + padY * 2 }

    if (o.style === 'box' || o.style === 'banner') {
      ctx.fillStyle = o.style === 'box' ? 'rgba(0,0,0,0.72)' : o.color
      ctx.beginPath()
      ctx.roundRect(box.x, box.y, box.w, box.h, px * 0.22)
      ctx.fill()
    }
    ctx.fillStyle = o.style === 'banner' ? '#ffffff' : o.color
    if (o.style === 'shadow') {
      ctx.shadowColor = 'rgba(0,0,0,0.75)'
      ctx.shadowBlur = px * 0.25
      ctx.shadowOffsetY = px * 0.06
    }
    lines.forEach((l, i) => ctx.fillText(l, cx, cy - blockH / 2 + lh * (i + 0.5)))
    ctx.shadowColor = 'transparent'
    ctx.shadowBlur = 0
    ctx.shadowOffsetY = 0
    return box
  }

  private drawCaption(ctx: CanvasRenderingContext2D, text: string, s: CaptionStyle, w: number, h: number, unit: number) {
    const px = Math.round(s.size * unit)
    ctx.font = `800 ${px}px ${FONT}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    const lines = wrapText(s.upper ? text.toUpperCase() : text, w * 0.84, (t) => ctx.measureText(t).width)
    const lh = px * 1.25
    const top = s.y * h - (lh * lines.length) / 2
    lines.forEach((line, i) => {
      const y = top + lh * (i + 0.5)
      if (s.style === 'box') {
        const lw = ctx.measureText(line).width
        ctx.fillStyle = 'rgba(0,0,0,0.72)'
        ctx.beginPath()
        ctx.roundRect(w / 2 - lw / 2 - px * 0.35, y - lh / 2, lw + px * 0.7, lh, px * 0.18)
        ctx.fill()
      } else {
        ctx.lineJoin = 'round'
        ctx.lineWidth = px * 0.18
        ctx.strokeStyle = '#000'
        ctx.strokeText(line, w / 2, y)
      }
      ctx.fillStyle = s.color
      ctx.fillText(line, w / 2, y)
    })
  }

  // --- Export ---------------------------------------------------------------

  /** Plays the whole timeline once in real time and records the canvas plus the audio mix. */
  async export(onProgress: (p: number) => void, bitrate: number): Promise<Blob> {
    if (!this.canvas || !this.project?.clips.length) throw new Error('Add a clip to the timeline first.')
    const mime = exportMime()
    if (!mime || typeof this.canvas.captureStream !== 'function') {
      throw new Error('This browser cannot record video. Use Chrome, Edge, Firefox or Safari 14.1+.')
    }
    this.ensureAudio()
    await this.audio!.ctx.resume()
    this.pause()
    this.seek(0)
    await this.waitForFrame()

    const stream = new MediaStream([
      ...this.canvas.captureStream(30).getVideoTracks(),
      ...this.audio!.dest.stream.getAudioTracks()
    ])
    const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bitrate, audioBitsPerSecond: 160_000 })
    const chunks: Blob[] = []
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data)

    return new Promise<Blob>((resolve, reject) => {
      const job: ExportJob = { recorder, stream, cancelled: false, onProgress }
      this.job = job
      recorder.onstop = () => {
        stream.getVideoTracks().forEach((t) => t.stop())
        this.job = null
        if (job.cancelled) reject(new Error('cancelled'))
        else resolve(new Blob(chunks, { type: mime.split(';')[0] }))
      }
      recorder.onerror = () => {
        this.job = null
        this.pause()
        reject(new Error('The browser stopped the recording.'))
      }
      recorder.start(1000)
      this.play()
    })
  }

  cancelExport() {
    if (!this.job) return
    this.job.cancelled = true
    this.pause()
    if (this.job.recorder.state !== 'inactive') this.job.recorder.stop()
  }

  private waitForFrame(): Promise<void> {
    return new Promise((resolve) => {
      const started = performance.now()
      const check = () => {
        const v = this.current
        const ready = v && !v.seeking && v.readyState >= 2
        if (ready || performance.now() - started > 5000) resolve()
        else setTimeout(check, 50)
      }
      setTimeout(check, 50)
    })
  }
}
