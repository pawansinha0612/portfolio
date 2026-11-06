/* Workload model worker: streams log files line by line, so big files never sit in memory whole.
 * Everything stays on this computer: the worker reads Files the page hands it and posts back counts. */
importScripts('workload.js');
const W = self.Workload;

self.onmessage = async (e) => {
  const { sources, options } = e.data;
  try {
    const t0 = Date.now();
    const parse = W.createParser(options.formatInfo, options);
    const ruleSet = W.parseRules(options.rulesText || '');
    const agg = W.createAggregator({ rules: ruleSet.rules });
    const rec = { t: 0, method: '', path: '', status: 0, rt: NaN, ip: '', ua: '' };
    const totalBytes = sources.reduce((a, s) => a + (s.file ? s.file.size : s.text.length), 0);
    let doneBytes = 0, lastPost = 0, lines = 0;

    const feed = (line) => {
      if (line.charCodeAt(line.length - 1) === 13) line = line.slice(0, -1);
      if (!line) return;
      lines++;
      const ok = parse(line, rec);
      if (ok === 'skip') return;
      if (!ok) agg.noteUnparsed(line); else agg.add(rec);
    };
    const progress = (force) => {
      const now = Date.now();
      if (!force && now - lastPost < 200) return;
      lastPost = now;
      self.postMessage({ type: 'progress', bytes: doneBytes, totalBytes, lines, ms: now - t0 });
    };

    for (const src of sources) {
      if (src.text != null) {
        const parts = src.text.split('\n');
        for (let i = 0; i < parts.length; i++) feed(parts[i]);
        doneBytes += src.text.length;
        progress(true);
        continue;
      }
      const file = src.file;
      const magic = new Uint8Array(await file.slice(0, 2).arrayBuffer());
      const gz = magic[0] === 0x1f && magic[1] === 0x8b;
      let stream = file.stream();
      const base = doneBytes;
      let fileBytes = 0;
      stream = stream.pipeThrough(new TransformStream({
        transform(chunk, ctl) { fileBytes += chunk.byteLength; doneBytes = base + fileBytes; ctl.enqueue(chunk); }
      }));
      if (gz) {
        if (typeof DecompressionStream === 'undefined') throw new Error(file.name + ' is gzipped and this browser cannot unzip it. Unzip it first (gunzip ' + file.name + ') or use a current Chrome, Edge, Firefox or Safari.');
        stream = stream.pipeThrough(new DecompressionStream('gzip'));
      }
      const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
      let carry = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const buf = carry + value;
        const cut = buf.lastIndexOf('\n');
        if (cut < 0) { carry = buf; continue; }
        carry = buf.slice(cut + 1);
        const parts = buf.slice(0, cut).split('\n');
        for (let i = 0; i < parts.length; i++) feed(parts[i]);
        progress(false);
      }
      if (carry) feed(carry);
      doneBytes = base + file.size;
      progress(true);
    }
    const result = agg.finish({
      format: options.formatInfo.format, formatLabel: W.FORMAT_LABELS[options.formatInfo.format],
      ms: Date.now() - t0, bytes: totalBytes, ruleErrors: ruleSet.errors
    });
    self.postMessage({ type: 'done', result });
  } catch (err) {
    self.postMessage({ type: 'error', message: err && err.message ? err.message : String(err) });
  }
};
