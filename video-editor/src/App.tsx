import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  AudioLines,
  Captions,
  Download,
  Film,
  Maximize2,
  Music2,
  Pause,
  Play,
  Plus,
  Redo2,
  Scissors,
  SkipBack,
  Sparkles,
  Trash2,
  Type,
  Undo2,
  Upload,
  Wand2,
  ZoomIn,
  ZoomOut,
  Crop,
  X
} from 'lucide-react'
import {
  type Aspect,
  type Clip,
  type Cue,
  type Grade,
  type Range,
  clipLength,
  clipStarts,
  computeEnvelope,
  findSilences,
  formatTime,
  outputSize,
  parseSubtitles,
  rangesInUse,
  removeRanges,
  sourceToTimeline,
  splitAt,
  suggestThreshold,
  totalDuration,
  uid,
  MIN_CLIP
} from './engine'
import {
  type Asset,
  type CaptionStyle,
  type Music,
  type Overlay,
  type OverlayStyle,
  type Project,
  type Settings,
  Player,
  exportMime
} from './player'
import { LIBRARY, type LibraryTrack, renderTrack } from './music'
import './App.css'

// --- Project history (undo/redo) -------------------------------------------

interface History {
  past: Project[]
  present: Project
  future: Project[]
  key: string
  at: number
}

type Update = Project | ((p: Project) => Project)

function useHistory(initial: Project) {
  const [h, setH] = useState<History>({ past: [], present: initial, future: [], key: '', at: 0 })
  // `key` merges a burst of changes (a slider drag, typing) into one undo step.
  const commit = useCallback((u: Update, key = '') => {
    setH((s) => {
      const next = typeof u === 'function' ? u(s.present) : u
      if (next === s.present) return s
      const now = Date.now()
      if (key && key === s.key && now - s.at < 1500) return { ...s, present: next, at: now }
      return { past: [...s.past.slice(-99), s.present], present: next, future: [], key, at: now }
    })
  }, [])
  const undo = useCallback(
    () =>
      setH((s) =>
        s.past.length
          ? { past: s.past.slice(0, -1), present: s.past[s.past.length - 1], future: [s.present, ...s.future], key: '', at: 0 }
          : s
      ),
    []
  )
  const redo = useCallback(
    () =>
      setH((s) =>
        s.future.length
          ? { past: [...s.past, s.present], present: s.future[0], future: s.future.slice(1), key: '', at: 0 }
          : s
      ),
    []
  )
  return { project: h.present, commit, undo, redo, canUndo: h.past.length > 0, canRedo: h.future.length > 0 }
}

const INITIAL: Project = {
  clips: [],
  overlays: [],
  captions: {},
  captionStyle: { enabled: true, size: 0.06, y: 0.8, style: 'box', color: '#ffffff', upper: false },
  settings: {
    aspect: '16:9',
    res: 1080,
    fit: 'cover',
    panX: 0,
    panY: 0,
    grade: { preset: 'none', brightness: 0, contrast: 0, saturation: 0 },
    voiceVolume: 1,
    musicVolume: 0.35,
    duck: true
  }
}

const CLIP_COLORS = ['#3b6fe0', '#7c5ce0', '#1f9bb5', '#2f9e6b', '#c4567f', '#c98a2c']

type Tab = 'media' | 'silence' | 'captions' | 'text' | 'look' | 'audio' | 'format'
type Selection = { kind: 'clip' | 'overlay'; id: string } | null

interface ExportUi {
  phase: 'setup' | 'running' | 'done' | 'error'
  progress: number
  name: string
  url?: string
  ext?: string
  error?: string
}

function isVideoFile(f: File) {
  return f.type.startsWith('video/') || /\.(mp4|mov|m4v|webm|mkv)$/i.test(f.name)
}

function readVideoMeta(file: File): Promise<Asset> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const v = document.createElement('video')
    v.preload = 'metadata'
    v.onloadedmetadata = () => {
      if (!Number.isFinite(v.duration) || v.duration <= 0) {
        reject(new Error(`Could not read the length of "${file.name}".`))
        return
      }
      resolve({ id: uid('asset'), name: file.name, file, url, duration: v.duration, width: v.videoWidth, height: v.videoHeight })
    }
    v.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error(`This browser can't play "${file.name}". Try an MP4 (H.264) file.`))
    }
    v.src = url
  })
}

async function decodeEnvelope(file: File): Promise<Float32Array | null> {
  const buf = await file.arrayBuffer()
  const ctx = new OfflineAudioContext(1, 1, 22050)
  try {
    const audio = await ctx.decodeAudioData(buf)
    const channels = Array.from({ length: audio.numberOfChannels }, (_, i) => audio.getChannelData(i))
    return computeEnvelope(channels, audio.sampleRate)
  } catch {
    return null // no audio track, or a codec the browser can't decode
  }
}

// --- App ---------------------------------------------------------------------

export default function App() {
  const { project, commit, undo, redo, canUndo, canRedo } = useHistory(INITIAL)
  const { clips, overlays, settings } = project
  const [assets, setAssets] = useState<Asset[]>([])
  const [music, setMusic] = useState<Music | null>(null)
  const [tab, setTab] = useState<Tab>('media')
  const [sel, setSel] = useState<Selection>(null)
  const [zoom, setZoom] = useState(40) // pixels per second
  const [toast, setToast] = useState<{ text: string; bad?: boolean } | null>(null)
  const [exportUi, setExportUi] = useState<ExportUi | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [showAbout, setShowAbout] = useState(false)

  const [player] = useState(() => new Player())
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const toastTimer = useRef(0)

  const time = useSyncExternalStore(player.subscribe, player.getTime)
  const playing = player.playing
  const total = totalDuration(clips)
  const assetById = useMemo(() => new Map(assets.map((a) => [a.id, a])), [assets])

  const say = useCallback((text: string, bad = false) => {
    setToast({ text, bad })
    clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 4000)
  }, [])

  useEffect(() => {
    player.attach(canvasRef.current!, hostRef.current!)
    return () => player.detach()
  }, [player])
  useEffect(() => player.setProject(project), [player, project])
  useEffect(() => player.setAssets(assets), [player, assets])
  useEffect(() => player.setMusic(music), [player, music])

  // Warn before leaving with work on the timeline: nothing is saved anywhere.
  useEffect(() => {
    if (!clips.length) return
    const h = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', h)
    return () => window.removeEventListener('beforeunload', h)
  }, [clips.length])

  const setSettings = useCallback(
    (patch: Partial<Settings>, key?: string) => commit((p) => ({ ...p, settings: { ...p.settings, ...patch } }), key),
    [commit]
  )

  // --- Importing ---

  const importFiles = useCallback(
    async (files: FileList | File[]) => {
      const list = Array.from(files)
      const videos = list.filter(isVideoFile)
      const audio = list.find((f) => f.type.startsWith('audio/'))
      if (audio) {
        setMusic({ name: audio.name, url: URL.createObjectURL(audio) })
        say(`Music added: ${audio.name}`)
      }
      if (!videos.length) {
        if (!audio) say('Those files are not videos. Use MP4, MOV or WebM.', true)
        return
      }
      const added: Asset[] = []
      for (const f of videos) {
        try {
          added.push(await readVideoMeta(f))
        } catch (e) {
          say((e as Error).message, true)
        }
      }
      if (!added.length) return
      setAssets((a) => [...a, ...added])
      // First import: put the clips straight on the timeline and match the format.
      commit((p) => {
        if (p.clips.length) return p
        const first = added[0]
        const aspect: Aspect = first.height > first.width ? '9:16' : first.height === first.width ? '1:1' : '16:9'
        return {
          ...p,
          clips: added.map((a) => ({ id: uid('clip'), assetId: a.id, in: 0, out: a.duration })),
          settings: { ...p.settings, aspect }
        }
      })
      say(added.length === 1 ? `Imported ${added[0].name}` : `Imported ${added.length} videos`)
    },
    [commit, say]
  )

  const addToTimeline = (a: Asset) => {
    commit((p) => ({ ...p, clips: [...p.clips, { id: uid('clip'), assetId: a.id, in: 0, out: a.duration }] }))
    say(`Added ${a.name} to the end of the timeline`)
  }

  const removeAsset = (a: Asset) => {
    if (clips.some((c) => c.assetId === a.id)) {
      say('That video is on the timeline. Delete its clips first.', true)
      return
    }
    setAssets((list) => list.filter((x) => x.id !== a.id))
    URL.revokeObjectURL(a.url)
  }

  // --- Clip editing ---

  const selectedClip = sel?.kind === 'clip' ? clips.find((c) => c.id === sel.id) : undefined
  const selectedOverlay = sel?.kind === 'overlay' ? overlays.find((o) => o.id === sel.id) : undefined

  const split = useCallback(() => {
    const next = splitAt(project.clips, player.time)
    if (next === project.clips) say('Move the playhead inside a clip, away from its edges, to split it.', true)
    else commit({ ...project, clips: next })
  }, [project, player, commit, say])

  const deleteSelected = useCallback(() => {
    if (!sel) return
    if (sel.kind === 'clip') commit((p) => ({ ...p, clips: p.clips.filter((c) => c.id !== sel.id) }))
    else commit((p) => ({ ...p, overlays: p.overlays.filter((o) => o.id !== sel.id) }))
    setSel(null)
  }, [sel, commit])

  const moveClip = (dir: -1 | 1) => {
    if (!selectedClip) return
    commit((p) => {
      const i = p.clips.findIndex((c) => c.id === selectedClip.id)
      const j = i + dir
      if (i < 0 || j < 0 || j >= p.clips.length) return p
      const next = [...p.clips]
      ;[next[i], next[j]] = [next[j], next[i]]
      return { ...p, clips: next }
    })
  }

  const updateClip = (id: string, patch: Partial<Clip>, key: string) =>
    commit((p) => ({ ...p, clips: p.clips.map((c) => (c.id === id ? { ...c, ...patch } : c)) }), key)

  const updateOverlay = (id: string, patch: Partial<Overlay>, key: string) =>
    commit((p) => ({ ...p, overlays: p.overlays.map((o) => (o.id === id ? { ...o, ...patch } : o)) }), key)

  const addOverlay = (style: OverlayStyle) => {
    const o: Overlay = {
      id: uid('text'),
      text: style === 'banner' ? 'Your name · what you do' : 'Your title here',
      start: Math.min(player.time, Math.max(0, total - 1)),
      dur: 4,
      x: 0.5,
      y: style === 'banner' ? 0.82 : 0.2,
      size: style === 'banner' ? 0.05 : 0.08,
      color: style === 'banner' ? '#2557d6' : '#ffffff',
      style
    }
    commit((p) => ({ ...p, overlays: [...p.overlays, o] }))
    setSel({ kind: 'overlay', id: o.id })
  }

  // --- Keyboard shortcuts ---

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t.closest('input, textarea, select, [contenteditable]') || player.exporting) return
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        redo()
      } else if (e.key === ' ') {
        e.preventDefault()
        player.toggle()
      } else if (e.key.toLowerCase() === 's' && !mod) {
        split()
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        deleteSelected()
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault()
        const step = e.shiftKey ? 1 : 1 / 30
        player.seek(player.time + (e.key === 'ArrowLeft' ? -step : step))
      } else if (e.key === 'Home') player.seek(0)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [player, undo, redo, split, deleteSelected])

  // --- Export ---

  const startExport = async () => {
    if (!exportUi) return
    const mime = exportMime()
    const ext = mime.includes('mp4') ? 'mp4' : 'webm'
    setExportUi({ ...exportUi, phase: 'running', progress: 0 })
    try {
      const blob = await player.export(
        (p) => setExportUi((u) => (u && u.phase === 'running' ? { ...u, progress: p } : u)),
        settings.res === 1080 ? 8_000_000 : 5_000_000
      )
      setExportUi((u) => (u ? { ...u, phase: 'done', progress: 1, url: URL.createObjectURL(blob), ext } : u))
    } catch (e) {
      const msg = (e as Error).message
      if (msg === 'cancelled') setExportUi((u) => (u ? { ...u, phase: 'setup', progress: 0 } : u))
      else setExportUi((u) => (u ? { ...u, phase: 'error', error: msg } : u))
    }
  }

  const closeExport = () => {
    if (exportUi?.url) URL.revokeObjectURL(exportUi.url)
    setExportUi(null)
  }

  const out = outputSize(settings.aspect, settings.res)

  return (
    <div
      className={`app ${dragOver ? 'drag-over' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragOver(false)
      }}
      onDrop={(e) => {
        e.preventDefault()
        setDragOver(false)
        if (e.dataTransfer.files.length) importFiles(e.dataTransfer.files)
      }}
    >
      <header className="topbar">
        <a className="back" href="/#projects" title="Back to pawansinha.com.au">
          <ArrowLeft size={16} /> <span>pawansinha.com.au</span>
        </a>
        <div className="brand">
          <Film size={18} /> Video Editor
          <button className="link" onClick={() => setShowAbout(true)}>
            How it works
          </button>
        </div>
        <div className="top-actions">
          <button className="icon" onClick={undo} disabled={!canUndo} title="Undo (Ctrl/Cmd+Z)" aria-label="Undo">
            <Undo2 size={16} />
          </button>
          <button className="icon" onClick={redo} disabled={!canRedo} title="Redo (Shift+Ctrl/Cmd+Z)" aria-label="Redo">
            <Redo2 size={16} />
          </button>
          <button
            className="primary"
            disabled={!clips.length}
            onClick={() => {
              player.pause()
              setExportUi({ phase: 'setup', progress: 0, name: 'my-video' })
            }}
          >
            <Download size={16} /> Export
          </button>
        </div>
      </header>

      <div className="main">
        <nav className="tabs" aria-label="Tools">
          {(
            [
              ['media', Upload, 'Media'],
              ['silence', Wand2, 'Cut pauses'],
              ['captions', Captions, 'Captions'],
              ['text', Type, 'Text'],
              ['look', Sparkles, 'Look'],
              ['audio', Music2, 'Audio'],
              ['format', Crop, 'Format']
            ] as const
          ).map(([id, Icon, label]) => (
            <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>
              <Icon size={18} />
              <span>{label}</span>
            </button>
          ))}
        </nav>

        <aside className="panel">
          {tab === 'media' && (
            <MediaPanel
              assets={assets}
              clips={clips}
              onImport={() => fileRef.current?.click()}
              onAdd={addToTimeline}
              onRemove={removeAsset}
            />
          )}
          {tab === 'silence' && (
            <SilencePanel project={project} assetById={assetById} commit={commit} say={say} />
          )}
          {tab === 'captions' && (
            <CaptionsPanel project={project} assetById={assetById} commit={commit} say={say} seek={(t) => player.seek(t)} />
          )}
          {tab === 'text' && (
            <TextPanel
              overlays={overlays}
              selected={selectedOverlay}
              onAdd={addOverlay}
              onSelect={(o) => {
                setSel({ kind: 'overlay', id: o.id })
                player.seek(o.start)
              }}
              onChange={updateOverlay}
              onDelete={(o) => {
                commit((p) => ({ ...p, overlays: p.overlays.filter((x) => x.id !== o.id) }))
                setSel(null)
              }}
              playhead={() => player.time}
            />
          )}
          {tab === 'look' && (
            <LookPanel grade={settings.grade} onChange={(g, key) => setSettings({ grade: { ...settings.grade, ...g } }, key)} />
          )}
          {tab === 'audio' && (
            <AudioPanel
              settings={settings}
              music={music}
              onSettings={setSettings}
              onMusicFile={(f) => setMusic({ name: f.name, url: URL.createObjectURL(f) })}
              onLibraryTrack={(name, blob) => {
                if (music) URL.revokeObjectURL(music.url)
                setMusic({ name, url: URL.createObjectURL(blob) })
                say(`Music added: ${name}`)
              }}
              onRemoveMusic={() => {
                if (music) URL.revokeObjectURL(music.url)
                setMusic(null)
              }}
            />
          )}
          {tab === 'format' && <FormatPanel settings={settings} onSettings={setSettings} />}
        </aside>

        <section className="stage">
          <Preview
            player={player}
            canvasRef={canvasRef}
            empty={!clips.length}
            onImport={() => fileRef.current?.click()}
            overlays={overlays}
            selectedId={selectedOverlay?.id}
            onSelectOverlay={(id) => {
              setSel({ kind: 'overlay', id })
              setTab('text')
            }}
            onMoveOverlay={(id, x, y) => updateOverlay(id, { x, y }, `move-${id}`)}
          />
          <div className="transport">
            <button className="icon" onClick={() => player.seek(0)} title="Go to start (Home)" aria-label="Go to start">
              <SkipBack size={16} />
            </button>
            <button
              className="icon play"
              onClick={() => player.toggle()}
              disabled={!clips.length}
              title="Play / pause (Space)"
              aria-label={playing ? 'Pause' : 'Play'}
            >
              {playing ? <Pause size={18} /> : <Play size={18} />}
            </button>
            <span className="timecode">
              {formatTime(time)} <span className="dim">/ {formatTime(total)}</span>
            </span>
            <span className="dim small out-size">
              {out.w}×{out.h}
            </span>
          </div>
        </section>
      </div>

      <Timeline
        project={project}
        assetById={assetById}
        time={time}
        zoom={zoom}
        setZoom={setZoom}
        sel={sel}
        setSel={setSel}
        seek={(t) => player.seek(t)}
        updateClip={updateClip}
        updateOverlay={updateOverlay}
        onSplit={split}
        onDelete={deleteSelected}
        onMove={moveClip}
        canMove={!!selectedClip}
      />

      <input
        ref={fileRef}
        type="file"
        accept="video/*,.mov,.mkv,audio/*"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files) importFiles(e.target.files)
          e.target.value = ''
        }}
      />
      {/* Hidden media elements the player decodes from. */}
      <div ref={hostRef} className="media-host" aria-hidden="true" />

      {dragOver && (
        <div className="drop-hint">
          <Upload size={32} />
          Drop videos (or a music file) to import
        </div>
      )}
      {toast && <div className={`toast ${toast.bad ? 'bad' : ''}`}>{toast.text}</div>}

      {exportUi && (
        <ExportDialog
          ui={exportUi}
          setUi={setExportUi}
          total={total}
          out={out}
          onStart={startExport}
          onCancel={() => player.cancelExport()}
          onClose={closeExport}
        />
      )}
      {showAbout && <About onClose={() => setShowAbout(false)} />}
    </div>
  )
}

// --- Panels ------------------------------------------------------------------

function MediaPanel(props: {
  assets: Asset[]
  clips: Clip[]
  onImport: () => void
  onAdd: (a: Asset) => void
  onRemove: (a: Asset) => void
}) {
  const { assets, clips, onImport, onAdd, onRemove } = props
  return (
    <div className="panel-body">
      <h2>Media</h2>
      <p className="hint">Your files stay on this device. Nothing is uploaded.</p>
      <button className="primary wide" onClick={onImport}>
        <Upload size={16} /> Import videos
      </button>
      {!assets.length && <p className="hint">Or drag files anywhere onto the editor. MP4, MOV and WebM work best.</p>}
      <ul className="asset-list">
        {assets.map((a) => {
          const uses = clips.filter((c) => c.assetId === a.id).length
          return (
            <li key={a.id}>
              <video src={`${a.url}#t=0.5`} muted preload="metadata" />
              <div className="asset-meta">
                <b title={a.name}>{a.name}</b>
                <span className="dim small">
                  {formatTime(a.duration, false)} · {a.width}×{a.height}
                  {uses ? ` · on timeline ×${uses}` : ''}
                </span>
                <div className="row nowrap">
                  <button className="small-btn" onClick={() => onAdd(a)}>
                    <Plus size={13} /> Add to timeline
                  </button>
                  <button className="small-btn ghost" onClick={() => onRemove(a)} aria-label={`Remove ${a.name}`}>
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function SilencePanel(props: {
  project: Project
  assetById: Map<string, Asset>
  commit: (u: Update, key?: string) => void
  say: (t: string, bad?: boolean) => void
}) {
  const { project, assetById, commit, say } = props
  const [threshold, setThreshold] = useState(-40)
  const [minSilence, setMinSilence] = useState(0.6)
  const [pad, setPad] = useState(0.12)
  const [busy, setBusy] = useState('')
  // Loudness envelopes per asset; null = file has no readable audio.
  const [envs, setEnvs] = useState<Map<string, Float32Array | null>>(new Map())

  const usedIds = [...new Set(project.clips.map((c) => c.assetId))]
  const analysed = usedIds.length > 0 && usedIds.every((id) => envs.has(id))

  const found = useMemo(() => {
    const out: Record<string, Range[]> = {}
    for (const id of usedIds) {
      const env = envs.get(id)
      if (env) out[id] = rangesInUse(findSilences(env, threshold, minSilence, pad), project.clips, id)
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [envs, threshold, minSilence, pad, project.clips])

  const count = Object.values(found).reduce((n, r) => n + r.length, 0)
  const seconds = Object.values(found).reduce((n, r) => n + r.reduce((s, x) => s + x.end - x.start, 0), 0)

  const analyse = async () => {
    const next = new Map(envs)
    let suggested: number | null = null
    for (const id of usedIds) {
      if (next.has(id)) continue
      const a = assetById.get(id)
      if (!a) continue
      setBusy(`Listening to ${a.name}…`)
      try {
        const env = await decodeEnvelope(a.file)
        next.set(id, env)
        if (env && suggested === null) suggested = suggestThreshold(env)
        if (!env) say(`${a.name} has no audio the browser can read, so it was skipped.`, true)
      } catch {
        next.set(id, null)
        say(`Could not read the audio of ${a.name}. Very large files can run out of memory.`, true)
      }
    }
    setEnvs(next)
    if (suggested !== null) setThreshold(suggested)
    setBusy('')
  }

  const apply = () => {
    commit((p) => ({
      ...p,
      clips: Object.entries(found).reduce((cl, [id, ranges]) => removeRanges(cl, id, ranges), p.clips)
    }))
    say(`Removed ${count} pause${count === 1 ? '' : 's'} (${seconds.toFixed(1)} s). Undo if it's too tight.`)
  }

  return (
    <div className="panel-body">
      <h2>Cut pauses</h2>
      <p className="hint">
        Finds the quiet gaps in your talking and cuts them out, the classic "jump cut" style. It measures the loudness of
        the sound in your browser; no AI service, nothing uploaded.
      </p>
      {!project.clips.length && <p className="hint warn">Import a video first.</p>}
      {project.clips.length > 0 && !analysed && (
        <button className="primary wide" onClick={analyse} disabled={!!busy}>
          <AudioLines size={16} /> {busy || 'Find the pauses'}
        </button>
      )}
      {analysed && (
        <>
          <Slider
            label="Quiet below"
            value={threshold}
            min={-65}
            max={-15}
            step={1}
            fmt={(v) => `${v} dB`}
            onChange={setThreshold}
            help="Raise it if breaths and room noise aren't being caught. Lower it if quiet words get cut."
          />
          <Slider
            label="Shortest pause to cut"
            value={minSilence}
            min={0.2}
            max={2}
            step={0.05}
            fmt={(v) => `${v.toFixed(2)} s`}
            onChange={setMinSilence}
          />
          <Slider
            label="Breathing room"
            value={pad}
            min={0}
            max={0.4}
            step={0.01}
            fmt={(v) => `${v.toFixed(2)} s`}
            onChange={setPad}
            help="Silence kept either side of each cut so words don't start abruptly."
          />
          <div className="result-box">
            {count ? (
              <>
                <b>{count}</b> pause{count === 1 ? '' : 's'} found, <b>{seconds.toFixed(1)} s</b> in total. They are
                shaded red on the timeline.
              </>
            ) : (
              'No pauses match these settings.'
            )}
          </div>
          <button className="primary wide" onClick={apply} disabled={!count}>
            <Scissors size={16} /> Cut {count || ''} pause{count === 1 ? '' : 's'}
          </button>
          <button className="small-btn ghost" onClick={analyse} disabled={!!busy}>
            {busy || 'Re-check newly added videos'}
          </button>
          <SilenceSync found={found} />
        </>
      )}
    </div>
  )
}

// Shares the silence preview with the timeline without threading props through App.
const silenceStore = {
  value: {} as Record<string, Range[]>,
  listeners: new Set<() => void>(),
  set(v: Record<string, Range[]>) {
    this.value = v
    this.listeners.forEach((f) => f())
  },
  subscribe(f: () => void) {
    silenceStore.listeners.add(f)
    return () => silenceStore.listeners.delete(f)
  },
  get() {
    return silenceStore.value
  }
}
function SilenceSync({ found }: { found: Record<string, Range[]> }) {
  useEffect(() => {
    silenceStore.set(found)
    return () => silenceStore.set({})
  }, [found])
  return null
}

function CaptionsPanel(props: {
  project: Project
  assetById: Map<string, Asset>
  commit: (u: Update, key?: string) => void
  say: (t: string, bad?: boolean) => void
  seek: (t: number) => void
}) {
  const { project, assetById, commit, say, seek } = props
  const s = project.captionStyle
  const fileRef = useRef<HTMLInputElement>(null)
  const target = useRef('')
  const usedIds = [...new Set(project.clips.map((c) => c.assetId))]
  const [openId, setOpenId] = useState('')
  const setStyle = (patch: Partial<CaptionStyle>, key?: string) =>
    commit((p) => ({ ...p, captionStyle: { ...p.captionStyle, ...patch } }), key)

  const load = async (file: File) => {
    const cues = parseSubtitles(await file.text())
    if (!cues.length) {
      say(`No captions found in ${file.name}. Use an .srt or .vtt file.`, true)
      return
    }
    const id = target.current
    commit((p) => ({ ...p, captions: { ...p.captions, [id]: cues } }))
    setOpenId(id)
    say(`Loaded ${cues.length} captions`)
  }

  const editCue = (id: string, i: number, text: string) =>
    commit((p) => {
      const list = [...(p.captions[id] ?? [])]
      list[i] = { ...list[i], text }
      return { ...p, captions: { ...p.captions, [id]: list } }
    }, `cue-${id}-${i}`)

  return (
    <div className="panel-body">
      <h2>Captions</h2>
      <p className="hint">
        Load a subtitle file (.srt or .vtt) for each video. Captions stay in sync after you cut pauses or trim, and are
        burned into the export. Free ways to get one: YouTube Studio's auto-captions (download as .srt), CapCut's
        auto-captions export, or any Whisper transcription tool.
      </p>
      {!usedIds.length && <p className="hint warn">Import a video first.</p>}
      {usedIds.map((id) => {
        const a = assetById.get(id)
        const cues = project.captions[id]
        return (
          <div key={id} className="caption-asset">
            <div className="row between">
              <b className="ellipsis" title={a?.name}>
                {a?.name}
              </b>
              <span className="dim small">{cues ? `${cues.length} captions` : 'none'}</span>
            </div>
            <div className="row">
              <button
                className="small-btn"
                onClick={() => {
                  target.current = id
                  fileRef.current?.click()
                }}
              >
                <Upload size={13} /> {cues ? 'Replace' : 'Load'} .srt / .vtt
              </button>
              {cues && (
                <>
                  <button className="small-btn ghost" onClick={() => setOpenId(openId === id ? '' : id)}>
                    {openId === id ? 'Hide' : 'Edit text'}
                  </button>
                  <button
                    className="small-btn ghost"
                    aria-label="Remove captions"
                    onClick={() =>
                      commit((p) => {
                        const next = { ...p.captions }
                        delete next[id]
                        return { ...p, captions: next }
                      })
                    }
                  >
                    <Trash2 size={13} />
                  </button>
                </>
              )}
            </div>
            {openId === id && cues && (
              <ol className="cue-list">
                {cues.map((c: Cue, i) => {
                  const at = sourceToTimeline(project.clips, id, c.start)
                  return (
                    <li key={i} className={at === null ? 'cut' : ''}>
                      <button className="cue-time" disabled={at === null} onClick={() => at !== null && seek(at)}>
                        {at === null ? 'cut' : formatTime(at)}
                      </button>
                      <input value={c.text} onChange={(e) => editCue(id, i, e.target.value)} />
                    </li>
                  )
                })}
              </ol>
            )}
          </div>
        )
      })}
      <input
        ref={fileRef}
        type="file"
        accept=".srt,.vtt,text/vtt"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) load(f)
          e.target.value = ''
        }}
      />
      <h3>Style</h3>
      <label className="check">
        <input type="checkbox" checked={s.enabled} onChange={(e) => setStyle({ enabled: e.target.checked })} /> Show
        captions
      </label>
      <label className="check">
        <input type="checkbox" checked={s.upper} onChange={(e) => setStyle({ upper: e.target.checked })} /> ALL CAPS
      </label>
      <Segmented
        value={s.style}
        options={[
          ['box', 'Dark box'],
          ['outline', 'Outline']
        ]}
        onChange={(v) => setStyle({ style: v })}
      />
      <Slider label="Size" value={s.size} min={0.03} max={0.11} step={0.005} fmt={(v) => `${Math.round(v * 1000) / 10}%`} onChange={(v) => setStyle({ size: v }, 'cap-size')} />
      <Slider label="Height on screen" value={s.y} min={0.1} max={0.95} step={0.01} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v) => setStyle({ y: v }, 'cap-y')} />
      <label className="field">
        Colour <input type="color" value={s.color} onChange={(e) => setStyle({ color: e.target.value }, 'cap-color')} />
      </label>
    </div>
  )
}

function TextPanel(props: {
  overlays: Overlay[]
  selected?: Overlay
  onAdd: (s: OverlayStyle) => void
  onSelect: (o: Overlay) => void
  onChange: (id: string, patch: Partial<Overlay>, key: string) => void
  onDelete: (o: Overlay) => void
  playhead: () => number
}) {
  const { overlays, selected: o, onAdd, onSelect, onChange, onDelete, playhead } = props
  return (
    <div className="panel-body">
      <h2>Text</h2>
      <p className="hint">Adds text at the playhead. Drag it in the preview to place it; drag its bar on the timeline to retime it.</p>
      <div className="preset-grid">
        <button onClick={() => onAdd('shadow')}>
          <span className="pv pv-shadow">Title</span>
          Title
        </button>
        <button onClick={() => onAdd('box')}>
          <span className="pv pv-box">Boxed</span>
          Boxed
        </button>
        <button onClick={() => onAdd('banner')}>
          <span className="pv pv-banner">Name</span>
          Name banner
        </button>
      </div>
      {o && (
        <div className="editor-card">
          <textarea value={o.text} rows={2} onChange={(e) => onChange(o.id, { text: e.target.value }, `text-${o.id}`)} />
          <Segmented
            value={o.style}
            options={[
              ['shadow', 'Title'],
              ['box', 'Boxed'],
              ['banner', 'Banner']
            ]}
            onChange={(v) => onChange(o.id, { style: v }, '')}
          />
          <Slider label="Size" value={o.size} min={0.03} max={0.2} step={0.005} fmt={(v) => `${Math.round(v * 1000) / 10}%`} onChange={(v) => onChange(o.id, { size: v }, `size-${o.id}`)} />
          <div className="row">
            <label className="field">
              Starts at
              <input type="number" min={0} step={0.1} value={Number(o.start.toFixed(2))} onChange={(e) => onChange(o.id, { start: Math.max(0, Number(e.target.value)) }, `start-${o.id}`)} />
            </label>
            <label className="field">
              Lasts (s)
              <input type="number" min={0.3} step={0.1} value={Number(o.dur.toFixed(2))} onChange={(e) => onChange(o.id, { dur: Math.max(0.3, Number(e.target.value)) }, `dur-${o.id}`)} />
            </label>
          </div>
          <div className="row between">
            <label className="field">
              {o.style === 'banner' ? 'Banner colour' : 'Colour'}
              <input type="color" value={o.color} onChange={(e) => onChange(o.id, { color: e.target.value }, `color-${o.id}`)} />
            </label>
            <button className="small-btn" onClick={() => onChange(o.id, { start: playhead() }, '')}>
              Start at playhead
            </button>
          </div>
          <button className="small-btn ghost danger" onClick={() => onDelete(o)}>
            <Trash2 size={13} /> Delete text
          </button>
        </div>
      )}
      {overlays.length > 0 && (
        <ul className="overlay-list">
          {overlays.map((x) => (
            <li key={x.id}>
              <button className={x.id === o?.id ? 'active' : ''} onClick={() => onSelect(x)}>
                <span className="ellipsis">{x.text || '(empty)'}</span>
                <span className="dim small">{formatTime(x.start)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function LookPanel({ grade, onChange }: { grade: Grade; onChange: (g: Partial<Grade>, key?: string) => void }) {
  const presets: [Grade['preset'], string][] = [
    ['none', 'Original'],
    ['punchy', 'Punchy'],
    ['warm', 'Warm'],
    ['cool', 'Cool'],
    ['film', 'Film'],
    ['bw', 'Black & white']
  ]
  return (
    <div className="panel-body">
      <h2>Look</h2>
      <p className="hint">Applies to the whole video.</p>
      <div className="chip-grid">
        {presets.map(([id, label]) => (
          <button key={id} className={grade.preset === id ? 'active' : ''} onClick={() => onChange({ preset: id })}>
            {label}
          </button>
        ))}
      </div>
      <Slider label="Brightness" value={grade.brightness} min={-50} max={50} step={1} fmt={(v) => `${v > 0 ? '+' : ''}${v}`} onChange={(v) => onChange({ brightness: v }, 'g-b')} />
      <Slider label="Contrast" value={grade.contrast} min={-50} max={50} step={1} fmt={(v) => `${v > 0 ? '+' : ''}${v}`} onChange={(v) => onChange({ contrast: v }, 'g-c')} />
      <Slider label="Saturation" value={grade.saturation} min={-100} max={100} step={1} fmt={(v) => `${v > 0 ? '+' : ''}${v}`} onChange={(v) => onChange({ saturation: v }, 'g-s')} />
      <button className="small-btn ghost" onClick={() => onChange({ preset: 'none', brightness: 0, contrast: 0, saturation: 0 })}>
        Reset
      </button>
    </div>
  )
}

function AudioPanel(props: {
  settings: Settings
  music: Music | null
  onSettings: (p: Partial<Settings>, key?: string) => void
  onMusicFile: (f: File) => void
  onLibraryTrack: (name: string, blob: Blob) => void
  onRemoveMusic: () => void
}) {
  const { settings, music, onSettings, onMusicFile, onLibraryTrack, onRemoveMusic } = props
  const ref = useRef<HTMLInputElement>(null)
  return (
    <div className="panel-body">
      <h2>Audio</h2>
      <Slider label="Voice volume" value={settings.voiceVolume} min={0} max={2} step={0.05} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v) => onSettings({ voiceVolume: v }, 'voice')} />
      <h3>Background music</h3>
      <p className="hint">Music loops under the whole video and fades out at the end.</p>
      {music ? (
        <div className="row between music-row">
          <span className="ellipsis" title={music.name}>
            <Music2 size={14} /> {music.name}
          </span>
          <button className="small-btn ghost" onClick={onRemoveMusic} aria-label="Remove music">
            <X size={13} />
          </button>
        </div>
      ) : (
        <button className="small-btn" onClick={() => ref.current?.click()}>
          <Upload size={13} /> Upload your own music
        </button>
      )}
      <input
        ref={ref}
        type="file"
        accept="audio/*"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) onMusicFile(f)
          e.target.value = ''
        }}
      />
      <Slider label="Music volume" value={settings.musicVolume} min={0} max={1} step={0.01} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v) => onSettings({ musicVolume: v }, 'music')} />
      <label className="check">
        <input type="checkbox" checked={settings.duck} onChange={(e) => onSettings({ duck: e.target.checked })} /> Lower the
        music while you talk
      </label>
      <MusicLibrary current={music?.name ?? null} onUse={onLibraryTrack} />
    </div>
  )
}

function MusicLibrary({ current, onUse }: { current: string | null; onUse: (name: string, blob: Blob) => void }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [playing, setPlaying] = useState<string | null>(null)
  const [error, setError] = useState('')
  const audio = useRef<HTMLAudioElement | null>(null)
  const url = useRef<string | null>(null)
  useEffect(
    () => () => {
      audio.current?.pause()
      if (url.current) URL.revokeObjectURL(url.current)
    },
    []
  )
  const stop = () => {
    audio.current?.pause()
    setPlaying(null)
  }
  const preview = async (t: LibraryTrack) => {
    if (playing === t.id) return stop()
    stop()
    setBusy(t.id)
    setError('')
    try {
      const blob = await renderTrack(t.id)
      if (!audio.current) {
        audio.current = new Audio()
        audio.current.onended = () => setPlaying(null)
      }
      if (url.current) URL.revokeObjectURL(url.current)
      url.current = URL.createObjectURL(blob)
      audio.current.src = url.current
      await audio.current.play()
      setPlaying(t.id)
    } catch {
      setError('This browser could not play the preview.')
    } finally {
      setBusy(null)
    }
  }
  const use = async (t: LibraryTrack) => {
    setBusy(t.id)
    setError('')
    try {
      const blob = await renderTrack(t.id)
      stop()
      onUse(t.name, blob)
    } catch {
      setError('This browser could not create the track.')
    } finally {
      setBusy(null)
    }
  }
  return (
    <>
      <h3>Free music library</h3>
      <p className="hint">
        These tracks are composed and synthesised by this editor's own code, with no samples or recordings, so they are
        free to use anywhere, including monetised YouTube videos and client work.
      </p>
      <ul className="library">
        {LIBRARY.map((t) => {
          const inUse = current === t.name
          return (
            <li key={t.id} className={inUse ? 'on' : ''}>
              <button
                className="small-btn ghost lib-play"
                onClick={() => preview(t)}
                disabled={busy === t.id}
                aria-label={playing === t.id ? `Stop preview of ${t.name}` : `Preview ${t.name}`}
              >
                {busy === t.id ? <span className="lib-spin" /> : playing === t.id ? <Pause size={13} /> : <Play size={13} />}
              </button>
              <span className="lib-meta">
                <b>{t.name}</b>
                <span>
                  {t.mood} · {t.bpm} BPM
                </span>
              </span>
              <button className="small-btn" onClick={() => use(t)} disabled={inUse || busy === t.id}>
                {inUse ? 'In use' : 'Use'}
              </button>
            </li>
          )
        })}
      </ul>
      {error && <p className="hint bad">{error}</p>}
    </>
  )
}

function FormatPanel({ settings, onSettings }: { settings: Settings; onSettings: (p: Partial<Settings>, key?: string) => void }) {
  return (
    <div className="panel-body">
      <h2>Format</h2>
      <Segmented
        value={settings.aspect}
        options={[
          ['16:9', '16:9 YouTube'],
          ['9:16', '9:16 Shorts'],
          ['1:1', '1:1 Square']
        ]}
        onChange={(v) => onSettings({ aspect: v })}
      />
      <Segmented
        value={settings.fit}
        options={[
          ['cover', 'Fill (crop)'],
          ['contain', 'Fit (bars)']
        ]}
        onChange={(v) => onSettings({ fit: v })}
      />
      {settings.fit === 'cover' && (
        <>
          <Slider label="Crop position ↔" value={settings.panX} min={-1} max={1} step={0.01} fmt={(v) => (v === 0 ? 'centre' : `${Math.round(v * 100)}`)} onChange={(v) => onSettings({ panX: v }, 'panx')} />
          <Slider label="Crop position ↕" value={settings.panY} min={-1} max={1} step={0.01} fmt={(v) => (v === 0 ? 'centre' : `${Math.round(v * 100)}`)} onChange={(v) => onSettings({ panY: v }, 'pany')} />
        </>
      )}
      <h3>Quality</h3>
      <Segmented
        value={String(settings.res) as '720' | '1080'}
        options={[
          ['720', '720p (faster)'],
          ['1080', '1080p']
        ]}
        onChange={(v) => onSettings({ res: v === '720' ? 720 : 1080 })}
      />
    </div>
  )
}

// --- Preview -----------------------------------------------------------------

function Preview(props: {
  player: Player
  canvasRef: React.RefObject<HTMLCanvasElement | null>
  empty: boolean
  onImport: () => void
  overlays: Overlay[]
  selectedId?: string
  onSelectOverlay: (id: string) => void
  onMoveOverlay: (id: string, x: number, y: number) => void
}) {
  const { player, canvasRef, empty, onImport, overlays, selectedId, onSelectOverlay, onMoveOverlay } = props
  const drag = useRef<{ id: string; dx: number; dy: number } | null>(null)
  const [hover, setHover] = useState(false)

  const toCanvas = (e: React.PointerEvent) => {
    const c = canvasRef.current!
    const r = c.getBoundingClientRect()
    return { x: ((e.clientX - r.left) / r.width) * c.width, y: ((e.clientY - r.top) / r.height) * c.height, c }
  }

  return (
    <div className="preview">
      <div className="canvas-wrap">
        <canvas ref={canvasRef} width={1920} height={1080} />
        <div
          className={`canvas-hit ${hover ? 'grab' : ''}`}
          onPointerDown={(e) => {
            const { x, y } = toCanvas(e)
            const box = [...player.overlayBoxes].reverse().find((b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h)
            if (!box) {
              player.toggle()
              return
            }
            const o = overlays.find((v) => v.id === box.id)
            const c = canvasRef.current!
            if (!o) return
            onSelectOverlay(o.id)
            drag.current = { id: o.id, dx: x - o.x * c.width, dy: y - o.y * c.height }
            e.currentTarget.setPointerCapture(e.pointerId)
          }}
          onPointerMove={(e) => {
            const { x, y, c } = toCanvas(e)
            if (drag.current) {
              const nx = Math.max(0.02, Math.min(0.98, (x - drag.current.dx) / c.width))
              const ny = Math.max(0.02, Math.min(0.98, (y - drag.current.dy) / c.height))
              onMoveOverlay(drag.current.id, nx, ny)
            } else {
              setHover(player.overlayBoxes.some((b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h))
            }
          }}
          onPointerUp={() => (drag.current = null)}
        />
        {selectedId && player.overlayBoxes.some((b) => b.id === selectedId) && <SelectedBox player={player} id={selectedId} canvasRef={canvasRef} />}
      </div>
      {empty && (
        <div className="empty">
          <Film size={36} />
          <p>
            <b>Start with a video.</b>
            <br />
            Drop files here, or
          </p>
          <button className="primary" onClick={onImport}>
            <Upload size={16} /> Import videos
          </button>
          <p className="dim small">Runs entirely in your browser. Your videos are never uploaded.</p>
        </div>
      )}
    </div>
  )
}

function SelectedBox({ player, id, canvasRef }: { player: Player; id: string; canvasRef: React.RefObject<HTMLCanvasElement | null> }) {
  useSyncExternalStore(player.subscribe, player.getTime) // re-render with the frame
  const b = player.overlayBoxes.find((x) => x.id === id)
  const c = canvasRef.current
  if (!b || !c) return null
  return (
    <div
      className="sel-box"
      style={{
        left: `${(b.x / c.width) * 100}%`,
        top: `${(b.y / c.height) * 100}%`,
        width: `${(b.w / c.width) * 100}%`,
        height: `${(b.h / c.height) * 100}%`
      }}
    />
  )
}

// --- Timeline ----------------------------------------------------------------

function Timeline(props: {
  project: Project
  assetById: Map<string, Asset>
  time: number
  zoom: number
  setZoom: (z: number) => void
  sel: Selection
  setSel: (s: Selection) => void
  seek: (t: number) => void
  updateClip: (id: string, patch: Partial<Clip>, key: string) => void
  updateOverlay: (id: string, patch: Partial<Overlay>, key: string) => void
  onSplit: () => void
  onDelete: () => void
  onMove: (d: -1 | 1) => void
  canMove: boolean
}) {
  const { project, assetById, time, zoom, setZoom, sel, setSel, seek, updateClip, updateOverlay } = props
  const { clips, overlays } = project
  const total = totalDuration(clips)
  const starts = clipStarts(clips)
  const scrollRef = useRef<HTMLDivElement>(null)
  const silences = useSyncExternalStore(silenceStore.subscribe, silenceStore.get)
  const colorOf = useMemo(() => {
    const ids = [...assetById.keys()]
    return (id: string) => CLIP_COLORS[Math.max(0, ids.indexOf(id)) % CLIP_COLORS.length]
  }, [assetById])

  const width = Math.max(total + 5, 30) * zoom
  const timeAt = (clientX: number) => {
    const el = scrollRef.current!
    const r = el.getBoundingClientRect()
    return Math.max(0, (clientX - r.left + el.scrollLeft - 12) / zoom)
  }

  // Keep the playhead in view while playing.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const x = time * zoom + 12
    if (x < el.scrollLeft || x > el.scrollLeft + el.clientWidth - 40) el.scrollLeft = Math.max(0, x - 60)
  }, [time, zoom])

  const fit = () => {
    const el = scrollRef.current
    if (el && total > 0) setZoom(Math.max(2, Math.min(200, (el.clientWidth - 60) / total)))
  }

  // Generic pointer-drag helper for scrubbing, trimming and moving.
  const dragWith = (e: React.PointerEvent, onMove: (dt: number, ev: PointerEvent) => void) => {
    e.stopPropagation()
    e.preventDefault()
    const x0 = e.clientX
    const move = (ev: PointerEvent) => onMove((ev.clientX - x0) / zoom, ev)
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const scrub = (e: React.PointerEvent) => {
    seek(timeAt(e.clientX))
    dragWith(e, (_dt, ev) => seek(timeAt(ev.clientX)))
  }

  const ticks = useMemo(() => {
    const step = zoom >= 80 ? 1 : zoom >= 30 ? 2 : zoom >= 12 ? 5 : zoom >= 5 ? 15 : 30
    const out: number[] = []
    for (let t = 0; t <= width / zoom; t += step) out.push(t)
    return out
  }, [zoom, width])

  return (
    <footer className="timeline">
      <div className="tl-toolbar">
        <button className="small-btn" onClick={props.onSplit} disabled={!clips.length} title="Split at playhead (S)">
          <Scissors size={14} /> Split
        </button>
        <button className="small-btn" onClick={props.onDelete} disabled={!sel} title="Delete selected (Delete)">
          <Trash2 size={14} /> Delete
        </button>
        <button className="small-btn" onClick={() => props.onMove(-1)} disabled={!props.canMove} title="Move clip earlier">
          <ArrowLeft size={14} />
        </button>
        <button className="small-btn" onClick={() => props.onMove(1)} disabled={!props.canMove} title="Move clip later">
          <ArrowRight size={14} />
        </button>
        <span className="spacer" />
        <span className="dim small hide-sm">Space play · S split · ←/→ frame · drag clip edges to trim</span>
        <button className="icon" onClick={() => setZoom(Math.max(2, zoom / 1.5))} aria-label="Zoom out">
          <ZoomOut size={15} />
        </button>
        <button className="icon" onClick={() => setZoom(Math.min(200, zoom * 1.5))} aria-label="Zoom in">
          <ZoomIn size={15} />
        </button>
        <button className="icon" onClick={fit} aria-label="Fit timeline" title="Fit to width">
          <Maximize2 size={15} />
        </button>
      </div>
      <div className="tl-scroll" ref={scrollRef}>
        <div className="tl-inner" style={{ width: width + 24 }}>
          <div className="ruler" onPointerDown={scrub}>
            {ticks.map((t) => (
              <span key={t} style={{ left: t * zoom + 12 }}>
                {formatTime(t, false)}
              </span>
            ))}
          </div>

          <div className="track video-track" onPointerDown={scrub}>
            {!clips.length && <span className="track-empty dim small">Imported videos appear here</span>}
            {clips.map((c, i) => {
              const a = assetById.get(c.assetId)
              const left = starts[i] * zoom + 12
              const w = Math.max(4, clipLength(c) * zoom)
              const marks = silences[c.assetId] ?? []
              return (
                <div
                  key={c.id}
                  className={`clip ${sel?.id === c.id ? 'selected' : ''}`}
                  style={{ left, width: w, background: colorOf(c.assetId) }}
                  onPointerDown={(e) => {
                    e.stopPropagation()
                    setSel({ kind: 'clip', id: c.id })
                    seek(timeAt(e.clientX))
                  }}
                >
                  {marks
                    .filter((m) => m.end > c.in && m.start < c.out)
                    .map((m, k) => (
                      <i
                        key={k}
                        className="silence"
                        style={{ left: (Math.max(m.start, c.in) - c.in) * zoom, width: (Math.min(m.end, c.out) - Math.max(m.start, c.in)) * zoom }}
                      />
                    ))}
                  <span className="clip-label">{a?.name ?? 'missing file'}</span>
                  <span
                    className="handle left"
                    onPointerDown={(e) => {
                      setSel({ kind: 'clip', id: c.id })
                      const base = c.in
                      dragWith(e, (dt) => updateClip(c.id, { in: Math.max(0, Math.min(c.out - MIN_CLIP, base + dt)) }, `trim-${c.id}`))
                    }}
                  />
                  <span
                    className="handle right"
                    onPointerDown={(e) => {
                      setSel({ kind: 'clip', id: c.id })
                      const base = c.out
                      const max = a?.duration ?? c.out
                      dragWith(e, (dt) => updateClip(c.id, { out: Math.min(max, Math.max(c.in + MIN_CLIP, base + dt)) }, `trim-${c.id}`))
                    }}
                  />
                </div>
              )
            })}
          </div>

          <div className="track text-track" onPointerDown={scrub}>
            {overlays.map((o) => (
              <div
                key={o.id}
                className={`ov ${sel?.id === o.id ? 'selected' : ''}`}
                style={{ left: o.start * zoom + 12, width: Math.max(6, o.dur * zoom) }}
                onPointerDown={(e) => {
                  setSel({ kind: 'overlay', id: o.id })
                  const base = o.start
                  dragWith(e, (dt) => updateOverlay(o.id, { start: Math.max(0, base + dt) }, `tmove-${o.id}`))
                }}
              >
                <Type size={11} /> <span className="ellipsis">{o.text}</span>
                <span
                  className="handle right"
                  onPointerDown={(e) => {
                    setSel({ kind: 'overlay', id: o.id })
                    const base = o.dur
                    dragWith(e, (dt) => updateOverlay(o.id, { dur: Math.max(0.3, base + dt) }, `tdur-${o.id}`))
                  }}
                />
              </div>
            ))}
          </div>

          <div className="playhead" style={{ left: time * zoom + 12 }} />
        </div>
      </div>
    </footer>
  )
}

// --- Dialogs & small controls -----------------------------------------------

function ExportDialog(props: {
  ui: ExportUi
  setUi: (u: ExportUi) => void
  total: number
  out: { w: number; h: number }
  onStart: () => void
  onCancel: () => void
  onClose: () => void
}) {
  const { ui, setUi, total, out, onStart, onCancel, onClose } = props
  const mime = exportMime()
  const ext = mime.includes('mp4') ? 'MP4' : 'WebM'
  const isSafari = /^((?!chrome|chromium|android|edg|firefox).)*safari/i.test(navigator.userAgent)
  return (
    <div className="modal-back">
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="export-title">
        <h2 id="export-title">Export video</h2>
        {ui.phase === 'setup' && (
          <>
            <label className="field">
              File name
              <input value={ui.name} onChange={(e) => setUi({ ...ui, name: e.target.value })} />
            </label>
            <ul className="facts">
              <li>
                {out.w}×{out.h}, 30 fps, {ext}
                {ext === 'WebM' && ' (YouTube, LinkedIn and X accept WebM)'}
              </li>
              <li>Takes about {formatTime(total, false)}: the video plays through once while it records.</li>
              <li>Keep this tab open and in front until it finishes, or frames get skipped.</li>
              {isSafari && <li>Safari can leave short silent gaps at cuts. Chrome or Edge give the cleanest export.</li>}
            </ul>
            {!mime && <p className="warn">This browser can't record video. Try Chrome, Edge, Firefox or Safari.</p>}
            <div className="row end">
              <button className="small-btn ghost" onClick={onClose}>
                Close
              </button>
              <button className="primary" onClick={onStart} disabled={!mime}>
                <Download size={16} /> Start export
              </button>
            </div>
          </>
        )}
        {ui.phase === 'running' && (
          <>
            <div className="progress">
              <i style={{ width: `${Math.round(ui.progress * 100)}%` }} />
            </div>
            <p className="dim">
              Recording… {Math.round(ui.progress * 100)}% ({formatTime(ui.progress * total, false)} of {formatTime(total, false)})
            </p>
            <div className="row end">
              <button className="small-btn ghost" onClick={onCancel}>
                Cancel
              </button>
            </div>
          </>
        )}
        {ui.phase === 'done' && ui.url && (
          <>
            <video className="result" src={ui.url} controls playsInline />
            <div className="row end">
              <button className="small-btn ghost" onClick={onClose}>
                Back to editing
              </button>
              <a className="primary" href={ui.url} download={`${ui.name.trim() || 'video'}.${ui.ext}`}>
                <Download size={16} /> Download .{ui.ext}
              </a>
            </div>
          </>
        )}
        {ui.phase === 'error' && (
          <>
            <p className="warn">{ui.error}</p>
            <div className="row end">
              <button className="small-btn ghost" onClick={onClose}>
                Close
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function About({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="about-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="about-title">How it works</h2>
        <p>
          A side project: a video editor that runs entirely in the browser, built for cutting talking-head videos and
          Shorts quickly. Your files never leave your device. There is no server and no account.
        </p>
        <ul className="facts">
          <li>
            <b>Cut pauses</b> decodes the audio with the Web Audio API, measures loudness every 20 ms and removes the quiet
            stretches you choose.
          </li>
          <li>
            <b>Playback</b> keeps two video decoders per file, so the next clip is already loaded at each cut and plays
            without a pause.
          </li>
          <li>
            <b>Export</b> draws each frame (crop, colour, text, captions) on a canvas and records it with the audio mix
            using the browser's MediaRecorder.
          </li>
          <li>Nothing is saved: closing the tab loses the edit, so export before you leave.</li>
        </ul>
        <p>
          <a href="/videos/demos/video-editor.mp4" target="_blank" rel="noopener">
            Watch the 1-minute demo
          </a>
        </p>
        <p className="dim small">Built with React and TypeScript by Pawan Sinha.</p>
        <div className="row end">
          <button className="primary" onClick={onClose}>
            Got it
          </button>
        </div>
      </div>
    </div>
  )
}

function Slider(props: {
  label: string
  value: number
  min: number
  max: number
  step: number
  fmt: (v: number) => string
  onChange: (v: number) => void
  help?: string
}) {
  return (
    <label className="slider">
      <span className="row between">
        <span>{props.label}</span>
        <span className="dim small">{props.fmt(props.value)}</span>
      </span>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
      />
      {props.help && <span className="dim small">{props.help}</span>}
    </label>
  )
}

function Segmented<T extends string>(props: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="segmented" role="radiogroup">
      {props.options.map(([v, label]) => (
        <button key={v} role="radio" aria-checked={props.value === v} className={props.value === v ? 'active' : ''} onClick={() => props.onChange(v)}>
          {label}
        </button>
      ))}
    </div>
  )
}
