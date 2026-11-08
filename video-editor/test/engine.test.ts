// Run: npm test   (Node 22+, uses --experimental-strip-types)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  computeEnvelope, cueAt, findSilences, fitRect, locate, parseSubtitles, rangesInUse, removeRanges,
  sourceToTimeline, splitAt, suggestThreshold, totalDuration, wrapText, type Clip
} from '../src/engine.ts'

const c = (id: string, assetId: string, i: number, o: number): Clip => ({ id, assetId, in: i, out: o })
const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`)

test('locate maps timeline time to clip and source time', () => {
  const clips = [c('a', 'A', 2, 5), c('b', 'B', 10, 14)]
  assert.equal(totalDuration(clips), 7)
  assert.equal(locate(clips, 0)!.clip.id, 'a')
  near(locate(clips, 1)!.srcTime, 3)
  assert.equal(locate(clips, 3)!.clip.id, 'b') // boundary belongs to the next clip
  near(locate(clips, 3.5)!.srcTime, 10.5)
  near(locate(clips, 7)!.srcTime, 14) // end of timeline still resolves to the last clip
  assert.equal(locate(clips, 7.5), null)
  assert.equal(locate([], 0), null)
})

test('splitAt splits inside a clip and ignores edges', () => {
  const clips = [c('a', 'A', 0, 10)]
  const s = splitAt(clips, 4)
  assert.equal(s.length, 2)
  near(s[0].out, 4)
  near(s[1].in, 4)
  assert.equal(splitAt(clips, 0.05), clips)
  assert.equal(splitAt(clips, 9.95), clips)
})

test('removeRanges cuts middles, edges, and leaves other assets alone', () => {
  const clips = [c('a', 'A', 0, 10), c('b', 'B', 0, 5), c('a2', 'A', 20, 30)]
  const out = removeRanges(clips, 'A', [{ start: 2, end: 3 }, { start: 9, end: 21 }, { start: 29.95, end: 31 }])
  assert.deepEqual(out.map((x) => [x.assetId, x.in, x.out]), [
    ['A', 0, 2], ['A', 3, 9], ['B', 0, 5], ['A', 21, 29.95]
  ])
  assert.equal(out[2], clips[1]) // untouched clip keeps identity
  assert.equal(removeRanges(clips, 'A', []), clips)
  // A tiny leftover sliver is dropped.
  assert.deepEqual(removeRanges([c('x', 'A', 0, 1)], 'A', [{ start: 0.05, end: 1 }]), [])
})

test('envelope + findSilences find quiet runs with padding', () => {
  const sr = 1000
  const sig = new Float32Array(sr * 6)
  // loud 0-2s, silent 2-4s, loud 4-6s
  for (let i = 0; i < sig.length; i++) sig[i] = i < 2000 || i >= 4000 ? Math.sin(i) * 0.5 : 0.0001
  const env = computeEnvelope([sig], sr, 0.02)
  assert.equal(env.length, 300)
  const r = findSilences(env, -40, 0.5, 0.1, 0.02)
  assert.equal(r.length, 1)
  near(r[0].start, 2.1, 1e-3)
  near(r[0].end, 3.9, 1e-3)
  assert.deepEqual(findSilences(env, -40, 2.5, 0.1, 0.02), []) // too short
  const t = suggestThreshold(env)
  assert.ok(t >= -60 && t <= -20)
})

test('silence at the very start/end is cut without outer padding', () => {
  const env = new Float32Array([-90, -90, -90, -90, -90, -10, -10, -90, -90, -90, -90, -90])
  const r = findSilences(env, -40, 0.3, 0.02, 0.1) // 0.1 s per window
  assert.equal(r.length, 2)
  near(r[0].start, 0)
  near(r[0].end, 0.48)
  near(r[1].start, 0.72)
  near(r[1].end, 1.2)
})

test('rangesInUse clips silence ranges to the parts on the timeline', () => {
  const clips = [c('a', 'A', 5, 8)]
  assert.deepEqual(rangesInUse([{ start: 1, end: 6 }, { start: 7.5, end: 12 }, { start: 20, end: 21 }], clips, 'A'), [
    { start: 5, end: 6 }, { start: 7.5, end: 8 }
  ])
})

test('parseSubtitles reads SRT and VTT, strips tags', () => {
  const srt = '1\r\n00:00:01,000 --> 00:00:02,500\r\n<i>Hello</i> there\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\nSecond\r\nline\r\n'
  const s = parseSubtitles(srt)
  assert.deepEqual(s, [{ start: 1, end: 2.5, text: 'Hello there' }, { start: 3, end: 4, text: 'Second\nline' }])
  const vtt = 'WEBVTT\n\n00:01.200 --> 00:02.000 align:start\nHi\n\nnote\n01:00:00.000 --> 01:00:01.5\n{\\an8}Late'
  const v = parseSubtitles(vtt)
  assert.equal(v.length, 2)
  near(v[0].start, 1.2)
  near(v[1].start, 3600)
  near(v[1].end, 3601.5)
  assert.equal(v[1].text, 'Late')
  assert.equal(cueAt(s, 1.5)!.text, 'Hello there')
  assert.equal(cueAt(s, 2.7), null)
})

test('sourceToTimeline follows cuts', () => {
  const clips = [c('a', 'A', 0, 2), c('b', 'A', 5, 9)]
  near(sourceToTimeline(clips, 'A', 6)!, 3)
  assert.equal(sourceToTimeline(clips, 'A', 3), null)
})

test('fitRect cover crops, contain letterboxes', () => {
  const cover = fitRect(1920, 1080, 1080, 1920, 'cover')
  near(cover.h, 1920)
  near(cover.x, (1080 - cover.w) / 2)
  const left = fitRect(1920, 1080, 1080, 1920, 'cover', -1)
  near(left.x, 0) // -1 keeps the left edge
  const right = fitRect(1920, 1080, 1080, 1920, 'cover', 1)
  near(right.x + right.w, 1080) // 1 keeps the right edge
  const contain = fitRect(1920, 1080, 1080, 1920, 'contain')
  near(contain.w, 1080)
  near(contain.y, (1920 - 607.5) / 2)
})

test('wrapText wraps by width', () => {
  const lines = wrapText('one two three four', 9, (s) => s.length)
  assert.deepEqual(lines, ['one two', 'three', 'four'])
})

import { encodeWav, foldTail, loudnessGain, midiToHz, seeded } from '../src/music.ts'

test('music helpers: tuning, seeded randomness, seamless loop fold, WAV header', () => {
  near(midiToHz(69), 440)
  near(midiToHz(57), 220)
  const a = seeded(42), b = seeded(42)
  for (let i = 0; i < 5; i++) assert.equal(a(), b())
  const folded = foldTail(new Float32Array([1, 2, 3, 4, 5, 6, 7]), 4)
  assert.deepEqual([...folded], [1 + 5, 2 + 6, 3 + 7, 4])
  const g = loudnessGain([new Float32Array([0.5, -0.5, 0.5, -0.5])])
  near(g, 0.16 / 0.5)
  const wav = new DataView(encodeWav([new Float32Array([0, 1]), new Float32Array([-1, 0.5])], 44100))
  assert.equal(wav.byteLength, 44 + 8)
  assert.equal(String.fromCharCode(wav.getUint8(0), wav.getUint8(1), wav.getUint8(2), wav.getUint8(3)), 'RIFF')
  assert.equal(wav.getUint16(22, true), 2)
  assert.equal(wav.getInt16(46, true), -32768)
  assert.equal(wav.getInt16(48, true), 32767)
})

import { advise, frameStats, quietRun, voiceStats, type AdviceInput } from '../src/advisor.ts'
import { outputSize } from '../src/engine.ts'

const base: AdviceInput = {
  duration: 300, aspect: '16:9', res: 1080, sourceW: 1920, sourceH: 1080,
  frames: [{ luma: 120, spread: 180, sat: 0.3 }],
  grade: { preset: 'none', brightness: 0, contrast: 0, saturation: 0 },
  voice: { speechDb: -20, peakDb: -6 }, voiceVolume: 1,
  pauses: { count: 0, seconds: 0 }, leadSilence: 0, tailSilence: 0,
  hasCaptions: true, hasOverlays: true, hasMusic: true, musicVolume: 0.3, duck: true,
}
const ids = (x: Partial<AdviceInput>) => advise({ ...base, ...x }).map((a) => a.id)

test('advisor: a well-made video gets only "good" notes', () => {
  const out = advise(base)
  assert.ok(out.every((a) => a.level === 'good'), JSON.stringify(out.map((a) => a.id)))
})

test('advisor: dark, flat, quiet, slow start, pauses and missing extras are flagged with fixes', () => {
  const out = advise({ ...base, frames: [{ luma: 60, spread: 80, sat: 0.05 }], voice: { speechDb: -34, peakDb: -12 },
    leadSilence: 2.5, pauses: { count: 4, seconds: 3.2 }, hasCaptions: false, hasOverlays: false, hasMusic: false, duration: 45 })
  const got = out.map((a) => a.id)
  for (const id of ['dark', 'flat', 'dull', 'quiet', 'lead', 'pauses', 'captions', 'title', 'music', 'shorts']) assert.ok(got.includes(id), id)
  assert.equal(out[0].level, 'fix')
  const dark = out.find((a) => a.id === 'dark')!
  assert.equal(dark.action!.do.kind, 'grade')
  const quiet = out.find((a) => a.id === 'quiet')!
  // -34 dB speech needs about +14 dB, but the -12 dB peak only allows +11 dB before -1 dBFS
  assert.ok(quiet.action!.do.kind === 'voice' && quiet.action!.do.volume <= 3.55 && quiet.action!.do.volume > 1)
})

test('advisor: no repeat advice once a fix is applied', () => {
  assert.ok(!ids({ frames: [{ luma: 60, spread: 180, sat: 0.3 }], grade: { preset: 'none', brightness: 40, contrast: 0, saturation: 0 } }).includes('dark'))
  assert.ok(ids({ voiceVolume: 2, voice: { speechDb: -14, peakDb: -2 } }).includes('loud'))
  assert.ok(ids({ aspect: '9:16', duration: 200 }).includes('too-long'))
  assert.ok(ids({ sourceW: 1280, sourceH: 720 }).includes('res'))
  assert.ok(ids({ musicVolume: 0.8 }).includes('music-loud'))
  assert.ok(ids({ voiceVolume: 2, voice: { speechDb: -40, peakDb: -20 } }).includes('quiet-max'))
})

test('advisor helpers: frame stats, voice stats, quiet runs, 4:5 size', () => {
  const px = new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255])
  const fs = frameStats(px)
  near(fs.luma, 127.5, 0.6)
  assert.equal(fs.sat, 0)
  const env = new Float32Array([-60, -60, -60, -20, -18, -22, -60])
  assert.equal(voiceStats(env, -40), null) // too little speech to judge
  near(quietRun(env, -40, 0, 0.14, 0.02), 0.06)
  near(quietRun(env, -40, 0, 0.14, 0.02, true), 0.02)
  assert.deepEqual(outputSize('4:5', 1080), { w: 1080, h: 1350 })
})
