/* Web Worker for /tools/visual-regression/: pixel-diffs screenshots off the main thread. Nothing leaves the browser. */
/* global importScripts, VisualRegression */
importScripts('/tools/visual-regression/vr.js');
self.onmessage = function (e) {
  const m = e.data;
  try {
    const a = { width: m.a.width, height: m.a.height, data: new Uint8ClampedArray(m.a.buffer) };
    const b = { width: m.b.width, height: m.b.height, data: new Uint8ClampedArray(m.b.buffer) };
    const r = VisualRegression.diffImages(a, b, m.opts);
    const out = r.output;
    r.output = null;
    self.postMessage({ id: m.id, ok: true, result: r, buffer: out.buffer }, [out.buffer]);
  } catch (err) {
    self.postMessage({ id: m.id, ok: false, error: err && err.message ? err.message : String(err) });
  }
};
