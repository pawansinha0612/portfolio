// Checks docs/videos/videos.json and social.json, and the helpers in videos-lib.js. Run: node videos/test-videos.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const V = require('../docs/videos/videos-lib.js');
const docs = path.join(__dirname, '..', 'docs');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok', name); };

t('youtube ids', () => {
  assert.strictEqual(V.youtubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.strictEqual(V.youtubeId('https://youtu.be/dQw4w9WgXcQ?t=10'), 'dQw4w9WgXcQ');
  assert.strictEqual(V.youtubeId('https://youtube.com/shorts/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.strictEqual(V.youtubeId('https://m.youtube.com/watch?v=dQw4w9WgXcQ&list=x'), 'dQw4w9WgXcQ');
  assert.strictEqual(V.youtubeId('https://www.youtube.com/@channel'), '');
  assert.strictEqual(V.youtubeId('not a url'), '');
});

t('entry checks', () => {
  const good = { platform: 'youtube', url: 'https://youtu.be/dQw4w9WgXcQ', title: 'x', date: '2026-11-20', topic: 'perf', related: '/tools/jmeter-to-k6/', featured: true };
  assert.deepStrictEqual(V.problems(good), []);
  assert.deepStrictEqual(V.problems({ platform: 'tiktok', url: 'https://www.tiktok.com/@me/video/1', title: 'x', date: '2026-11-20' }), []);
  assert.deepStrictEqual(V.problems({ platform: 'instagram', url: 'https://www.instagram.com/reel/abc/', title: 'x', date: '2026-11-20' }), []);
  assert.ok(V.problems({ ...good, platform: 'vimeo' }).length);
  assert.ok(V.problems({ ...good, url: 'https://example.com/x' }).length);
  assert.ok(V.problems({ ...good, date: '20/11/2026' }).length);
  assert.ok(V.problems({ ...good, topic: 'cooking' }).length);
  assert.ok(V.problems({ ...good, featured: 'true' }).length);
  assert.ok(V.problems({ ...good, related: 'tools/x' }).length);
});

t('clean skips bad entries and sorts newest first', () => {
  const warn = console.warn; console.warn = () => {};
  const out = V.clean({ videos: [
    { platform: 'youtube', url: 'https://youtu.be/aaaaaaaaaaa', title: 'old', date: '2026-01-01' },
    { platform: 'youtube', url: 'bad', title: 'bad', date: '2026-01-02' },
    { platform: 'short', url: 'https://youtube.com/shorts/bbbbbbbbbbb', title: 'new', date: '2026-02-01' },
  ] });
  console.warn = warn;
  assert.deepStrictEqual(out.map((v) => v.title), ['new', 'old']);
  assert.deepStrictEqual(V.clean(null), []);
});

t('paths', () => {
  assert.ok(V.samePath('/tools/jmeter-to-k6', '/tools/jmeter-to-k6/'));
  assert.ok(V.samePath('/learn/index.html', '/learn/'));
  assert.ok(!V.samePath('/tools/', '/tools/jmeter-to-k6/'));
});

t('videos.json is valid and every entry passes', () => {
  const data = JSON.parse(fs.readFileSync(path.join(docs, 'videos', 'videos.json'), 'utf8'));
  assert.ok(Array.isArray(data.videos), 'videos.json needs { "videos": [ ... ] }');
  data.videos.forEach((v, i) => assert.deepStrictEqual(V.problems(v), [], 'entry ' + (i + 1) + ' (' + (v && v.title) + ')'));
  data.videos.forEach((v) => {
    if (!v.related) return;
    const f = path.join(docs, v.related.replace(/^\//, ''), v.related.endsWith('.html') ? '' : 'index.html');
    assert.ok(fs.existsSync(f), 'related page ' + v.related + ' does not exist in docs/');
  });
});

t('social.json is valid', () => {
  const s = JSON.parse(fs.readFileSync(path.join(docs, 'videos', 'social.json'), 'utf8'));
  ['youtube', 'tiktok', 'instagram', 'linkedin'].forEach((k) => assert.strictEqual(typeof s[k], 'string', k + ' must be a string ("" when not set)'));
  const set = Object.keys(s).filter((k) => s[k]);
  assert.strictEqual(V.socialLinks(s).length, set.length, 'a channel URL is set but not recognised: check it starts with https://www.youtube.com/, https://www.tiktok.com/ ...');
});

console.log(n + ' tests passed');
