/* Dependency Risk Monitor: pure functions, no DOM, no network of its own. Runs in the browser (window.DepRisk) and in
   Node (module.exports) for toolkit-tests/dependency-risk.test.js.

   parseFiles([{ name, text }])   package.json, package-lock.json (v1–v3), yarn.lock (v1 and Berry), requirements.txt,
                                  poetry.lock, pom.xml, build.gradle(.kts), go.mod, Gemfile.lock, composer.lock, *.csproj
                                  → { deps: [{ ecosystem, name, version, direct, dev, exact, license, file }], files, warnings }
   osvBatch(deps)                 the request body for https://api.osv.dev/v1/querybatch (names and versions only)
   scan(deps, fetch, opts)        calls OSV.dev and the npm / PyPI registries through an injected fetch function
   analyse(deps, scanData)        vulnerabilities with severity and fixed versions, outdated (major/minor/patch),
                                  deprecated, licences with copyleft flags, risk scores, an upgrade plan and commands
   cvss3Score(vector)             CVSS v3.x base score
   workflow(ecosystems), dependabot(ecosystems)   free CI configuration */
(function (root) {
  'use strict';

  // ------------------------------------------------------------------ helpers
  const ECO = { npm: 'npm', pypi: 'PyPI', maven: 'Maven', go: 'Go', gem: 'RubyGems', composer: 'Packagist', nuget: 'NuGet' };
  const decode = s => String(s || '').replace(/&(lt|gt|amp|quot|apos);/g, (m, e) => ({ lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }[e]));
  const tagText = (block, tag) => { const m = new RegExp('<' + tag + '>\\s*([^<]*?)\\s*</' + tag + '>').exec(block); return m ? decode(m[1]) : ''; };
  const pyName = n => String(n).toLowerCase().replace(/[-_.]+/g, '-');
  function dep(o) {
    return Object.assign({ ecosystem: '', name: '', version: '', spec: '', direct: null, dev: false, exact: true, license: '', file: '' }, o);
  }
  // lowest version a range allows: ^1.2.3 → 1.2.3, >=2.0 → 2.0, ~=1.4 → 1.4
  function floorOf(spec) {
    const s = String(spec || '').trim();
    if (!s || s === '*' || s === 'latest' || /^(file:|link:|git|http|workspace:|npm:)/.test(s)) return '';
    const m = /(\d+(?:\.\d+){0,3}(?:[-.]?[A-Za-z][\w.]*)?)/.exec(s.replace(/\s+-\s+.*$/, ''));
    return m ? m[1].replace(/\.x$/i, '.0') : '';
  }

  // ------------------------------------------------------------------ npm
  function parsePackageJson(text, file) {
    const j = JSON.parse(text);
    const out = [];
    const add = (obj, dev) => Object.keys(obj || {}).forEach(n => {
      const spec = String(obj[n]);
      const v = floorOf(spec);
      out.push(dep({ ecosystem: ECO.npm, name: n, version: v, spec, direct: true, dev, exact: /^\d/.test(spec) && v === spec, file }));
    });
    add(j.dependencies, false); add(j.optionalDependencies, false); add(j.devDependencies, true);
    return out;
  }
  function parsePackageLock(text, file) {
    const j = JSON.parse(text);
    const out = [];
    if (j.packages) {
      const rootPkg = j.packages[''] || {};
      const directs = new Set(Object.keys(Object.assign({}, rootPkg.dependencies, rootPkg.devDependencies, rootPkg.optionalDependencies, rootPkg.peerDependencies)));
      for (const k in j.packages) {
        if (!k) continue;
        const p = j.packages[k];
        if (!p || p.link || !p.version) continue;
        const i = k.lastIndexOf('node_modules/');
        if (i < 0) continue; // workspace folders
        const name = p.name || k.slice(i + 13);
        out.push(dep({ ecosystem: ECO.npm, name, version: p.version, direct: k === 'node_modules/' + name && directs.has(name), dev: !!(p.dev || p.devOptional), license: typeof p.license === 'string' ? p.license : '', file }));
      }
    } else if (j.dependencies) {
      const walk = (deps, depth) => Object.keys(deps).forEach(n => {
        const d = deps[n];
        if (d && d.version && !/^(file|link|git)/.test(d.version)) out.push(dep({ ecosystem: ECO.npm, name: n, version: d.version, direct: depth === 0 ? null : false, dev: !!d.dev, file }));
        if (d && d.dependencies) walk(d.dependencies, depth + 1);
      });
      walk(j.dependencies, 0);
    } else throw new Error(file + ': no "packages" or "dependencies" in this lockfile.');
    return out;
  }
  function parseYarnLock(text, file) {
    const out = [];
    let cur = null;
    String(text).split(/\r?\n/).forEach(line => {
      if (!line.trim() || /^\s*#/.test(line)) return;
      if (!/^\s/.test(line) && /:\s*$/.test(line)) {
        const first = line.replace(/:\s*$/, '').split(/,\s*/)[0].replace(/^"|"$/g, '').trim();
        if (first === '__metadata' || /@(workspace|link|portal|file|patch):/.test(first)) { cur = null; return; }
        const at = first.indexOf('@', 1);
        cur = { name: at > 0 ? first.slice(0, at) : first, version: '' };
        out.push(cur);
        return;
      }
      const m = /^\s+version:?\s+"?([^"\s]+)"?/.exec(line);
      if (m && cur && !cur.version) cur.version = m[1];
    });
    const seen = new Set();
    return out.filter(x => x.version && !seen.has(x.name + '@' + x.version) && seen.add(x.name + '@' + x.version))
      .map(x => dep({ ecosystem: ECO.npm, name: x.name, version: x.version, direct: null, file }));
  }

  // ------------------------------------------------------------------ Python
  function parseRequirements(text, file) {
    const out = [];
    String(text).split(/\r?\n/).forEach(raw => {
      const l = raw.replace(/\s+#.*$/, '').replace(/\\$/, '').trim();
      if (!l || l.startsWith('#') || l.startsWith('-') || /^(git\+|https?:|\.|\/)/.test(l)) return;
      const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?\s*(.*?)\s*(?:;.*)?$/.exec(l);
      if (!m) return;
      const spec = m[2].split(/\s*--hash/)[0].trim();
      const eq = /^===?\s*([^,\s*]+)$/.exec(spec);
      out.push(dep({ ecosystem: ECO.pypi, name: pyName(m[1]), version: eq ? eq[1] : floorOf(spec), spec, direct: true, exact: !!eq, file }));
    });
    return out;
  }
  function parsePoetryLock(text, file) {
    const out = [];
    let cur = null;
    String(text).split(/\r?\n/).forEach(line => {
      if (/^\[\[package\]\]\s*$/.test(line)) { cur = {}; out.push(cur); return; }
      if (/^\[/.test(line)) { if (!/^\[\[package\]\]/.test(line)) cur = cur && cur.name && cur.version ? null : cur; return; }
      if (!cur) return;
      const m = /^(name|version|category|optional)\s*=\s*"?([^"\n]*)"?/.exec(line);
      if (m && cur[m[1]] === undefined) cur[m[1]] = m[2];
      const g = /^groups\s*=\s*\[(.*)\]/.exec(line);
      if (g) cur.groups = g[1];
    });
    return out.filter(p => p.name && p.version).map(p => dep({ ecosystem: ECO.pypi, name: pyName(p.name), version: p.version, direct: null,
      dev: p.category === 'dev' || (p.groups ? !/"main"/.test(p.groups) : false), file }));
  }

  // ------------------------------------------------------------------ JVM
  function parsePom(text, file) {
    const s = String(text).replace(/<!--[\s\S]*?-->/g, '');
    const props = {};
    const pb = /<properties>([\s\S]*?)<\/properties>/.exec(s);
    if (pb) { const re = /<([\w.-]+)>\s*([^<]*?)\s*<\/\1>/g; let m; while ((m = re.exec(pb[1]))) props[m[1]] = m[2]; }
    const proj = s.replace(/<parent>[\s\S]*?<\/parent>/, '').replace(/<dependencies>[\s\S]*<\/dependencies>/, '').replace(/<build>[\s\S]*<\/build>/, '');
    props['project.version'] = tagText(proj, 'version');
    const parent = /<parent>([\s\S]*?)<\/parent>/.exec(s);
    if (!props['project.version'] && parent) props['project.version'] = tagText(parent[1], 'version');
    props['project.parent.version'] = parent ? tagText(parent[1], 'version') : '';
    const sub = v => v.replace(/\$\{([^}]+)\}/g, (m, k) => (props[k] != null ? props[k] : m));
    const out = [];
    const managed = new Set();
    const dm = /<dependencyManagement>([\s\S]*?)<\/dependencyManagement>/.exec(s);
    const re = /<dependency>([\s\S]*?)<\/dependency>/g;
    let m;
    while ((m = re.exec(s))) {
      const b = m[1];
      const g = sub(tagText(b, 'groupId')), a = sub(tagText(b, 'artifactId'));
      if (!g || !a) continue;
      let v = sub(tagText(b, 'version'));
      const scope = tagText(b, 'scope');
      const inDM = dm && m.index > dm.index && m.index < dm.index + dm[0].length;
      if (inDM) managed.add(g + ':' + a);
      const resolved = v && !/\$\{/.test(v);
      const exact = resolved && !/[[\](),]/.test(v);
      if (!exact) v = resolved ? floorOf(v) : '';
      out.push(dep({ ecosystem: ECO.maven, name: g + ':' + a, version: v, spec: tagText(b, 'version'), direct: true, dev: scope === 'test', exact, file, managed: inDM }));
    }
    // a dependency listed both in dependencyManagement and dependencies: keep one, with the managed version
    const by = new Map();
    out.forEach(d => { const o = by.get(d.name); if (!o || (!o.version && d.version)) by.set(d.name, d); else if (o && d.dev === false) o.dev = false; });
    return [...by.values()];
  }
  function parseGradle(text, file) {
    const s = String(text).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
    const vars = {};
    const vr = /(?:def|val|var|ext\.)?\s*([A-Za-z_][\w]*)\s*=\s*["']([^"'$]+)["']/g;
    let m;
    while ((m = vr.exec(s))) vars[m[1]] = m[2];
    const sub = v => v.replace(/\$\{?(?:project\.|rootProject\.|ext\.)?([A-Za-z_][\w.]*)\}?/g, (x, k) => (vars[k.split('.').pop()] != null ? vars[k.split('.').pop()] : x));
    const CONF = '(implementation|api|compile|compileOnly|runtimeOnly|testImplementation|testCompileOnly|testRuntimeOnly|androidTestImplementation|kapt|ksp|annotationProcessor|classpath)';
    const out = [];
    const re1 = new RegExp(CONF + '\\s*\\(?\\s*(?:platform\\()?["\']([^"\':\\s]+):([^"\':\\s]+):([^"\'\\s@]+)(?:@\\w+)?["\']', 'g');
    while ((m = re1.exec(s))) {
      const v = sub(m[4]);
      out.push(dep({ ecosystem: ECO.maven, name: m[2] + ':' + m[3], version: /\$|[+\[(]/.test(v) ? floorOf(v.replace(/\$\{?[\w.]+\}?/, '')) : v, spec: m[4], direct: true, dev: /^test|^androidTest/.test(m[1]), exact: !/\$|[+\[(]/.test(v), file }));
    }
    const re2 = new RegExp(CONF + '\\s*\\(?\\s*group\\s*[:=]\\s*["\']([^"\']+)["\']\\s*,\\s*name\\s*[:=]\\s*["\']([^"\']+)["\']\\s*,\\s*version\\s*[:=]\\s*["\']([^"\']+)["\']', 'g');
    while ((m = re2.exec(s))) { const v = sub(m[4]); out.push(dep({ ecosystem: ECO.maven, name: m[2] + ':' + m[3], version: v, spec: m[4], direct: true, dev: /^test/.test(m[1]), exact: !/\$|[+\[(]/.test(v), file })); }
    return out;
  }

  // ------------------------------------------------------------------ Go, Ruby, PHP, .NET
  function parseGoMod(text, file) {
    const out = [];
    let inBlock = false;
    String(text).split(/\r?\n/).forEach(raw => {
      const line = raw.trim();
      if (/^require\s*\($/.test(line)) { inBlock = true; return; }
      if (inBlock && line === ')') { inBlock = false; return; }
      let body = null;
      if (inBlock) body = line; else { const m = /^require\s+(.+)$/.exec(line); if (m) body = m[1]; }
      if (!body || body.startsWith('//')) return;
      const m = /^(\S+)\s+(v\S+)(\s*\/\/\s*indirect)?/.exec(body);
      if (m) out.push(dep({ ecosystem: ECO.go, name: m[1], version: m[2].replace(/^v/, '').replace(/\+incompatible$/, ''), spec: m[2], direct: !m[3], file }));
    });
    return out;
  }
  function parseGemfileLock(text, file) {
    const out = [], directs = new Set();
    let section = '', inSpecs = false;
    String(text).split(/\r?\n/).forEach(line => {
      if (/^[A-Z]/.test(line)) { section = line.trim(); inSpecs = false; return; }
      if (/^\s{2}specs:/.test(line)) { inSpecs = true; return; }
      if (section === 'DEPENDENCIES') { const m = /^\s{2}([^\s!(]+)/.exec(line); if (m) directs.add(m[1]); return; }
      if (inSpecs && (section === 'GEM' || section === 'GIT' || section === 'PATH')) {
        const m = /^\s{4}([^\s(]+)\s+\(([^)]+)\)\s*$/.exec(line);
        if (m && section === 'GEM') out.push({ name: m[1], version: m[2].replace(/-(x86|x64|arm|aarch|java|universal|mingw|mswin|darwin|linux).*$/, '') });
      }
    });
    const seen = new Set();
    return out.filter(g => !seen.has(g.name) && seen.add(g.name)).map(g => dep({ ecosystem: ECO.gem, name: g.name, version: g.version, direct: directs.size ? directs.has(g.name) : null, file }));
  }
  function parseComposerLock(text, file) {
    const j = JSON.parse(text);
    const out = [];
    const add = (list, dev) => (list || []).forEach(p => {
      if (!p || !p.name || !p.version || /^dev-/.test(p.version)) return;
      out.push(dep({ ecosystem: ECO.composer, name: p.name, version: String(p.version).replace(/^v/, ''), direct: null, dev, license: Array.isArray(p.license) ? p.license.join(' OR ') : (p.license || ''), file }));
    });
    add(j.packages, false); add(j['packages-dev'], true);
    if (!out.length && !j.packages) throw new Error(file + ': no "packages" in this composer.lock.');
    return out;
  }
  function parseCsproj(text, file) {
    const out = [];
    const re = /<PackageReference\b([^>]*?)(\/>|>([\s\S]*?)<\/PackageReference>)/gi;
    let m;
    while ((m = re.exec(String(text)))) {
      const at = {};
      m[1].replace(/([\w]+)\s*=\s*"([^"]*)"/g, (x, k, v) => { at[k.toLowerCase()] = v; });
      const name = at.include || at.update;
      let v = at.version || (m[3] ? tagText(m[3], 'Version') : '');
      if (!name) continue;
      const exact = /^\d[\w.-]*$/.test(v);
      out.push(dep({ ecosystem: ECO.nuget, name, version: exact ? v : floorOf(v), spec: v, direct: true, exact, dev: /PrivateAssets\s*=\s*"all"/i.test(m[1]) || /<PrivateAssets>\s*all/i.test(m[3] || ''), file }));
    }
    return out;
  }

  // ------------------------------------------------------------------ detection and merging
  function detect(name, text) {
    const n = String(name || '').toLowerCase().split(/[\\/]/).pop();
    const t = String(text || '').replace(/^﻿/, '').trimStart();
    if (n === 'package.json') return 'package.json';
    if (n === 'package-lock.json' || n === 'npm-shrinkwrap.json') return 'package-lock';
    if (n === 'yarn.lock') return 'yarn.lock';
    if (n === 'poetry.lock') return 'poetry.lock';
    if (n === 'pom.xml') return 'pom';
    if (/\.gradle(\.kts)?$/.test(n)) return 'gradle';
    if (n === 'go.mod') return 'go.mod';
    if (n === 'gemfile.lock') return 'gemfile.lock';
    if (n === 'composer.lock') return 'composer.lock';
    if (/\.(csproj|fsproj|vbproj)$|^directory\.packages\.props$/.test(n)) return 'csproj';
    if (/requirements.*\.txt$|\.in$/.test(n)) return 'requirements';
    // content sniffing for pasted text
    if (t[0] === '{') {
      if (/"lockfileVersion"/.test(t)) return 'package-lock';
      if (/"content-hash"|"packages-dev"/.test(t)) return 'composer.lock';
      if (/"(dev)?[dD]ependencies"\s*:/.test(t)) return 'package.json';
    }
    if (/^module\s+\S+/m.test(t) && /^go\s+\d/m.test(t)) return 'go.mod';
    if (/<project\b[\s\S]*<artifactId>/.test(t)) return 'pom';
    if (/<PackageReference\b/i.test(t)) return 'csproj';
    if (/^\[\[package\]\]/m.test(t)) return 'poetry.lock';
    if (/^GEM\s*$/m.test(t) && /^\s{2}specs:/m.test(t)) return 'gemfile.lock';
    if (/# yarn lockfile v1|^__metadata:/m.test(t) || /^"?@?[\w./-]+@[^\n]*:\n\s+version:? /m.test(t)) return 'yarn.lock';
    if (/(implementation|testImplementation|api)\s*\(?\s*["'][^"':]+:[^"':]+:/.test(t) || /^\s*dependencies\s*\{/m.test(t)) return 'gradle';
    if (/^[A-Za-z0-9][\w.-]*(\[[^\]]*\])?\s*(==|>=|~=|<=|!=|>|<)/m.test(t)) return 'requirements';
    return '';
  }
  const PARSERS = { 'package.json': parsePackageJson, 'package-lock': parsePackageLock, 'yarn.lock': parseYarnLock, requirements: parseRequirements, 'poetry.lock': parsePoetryLock,
    pom: parsePom, gradle: parseGradle, 'go.mod': parseGoMod, 'gemfile.lock': parseGemfileLock, 'composer.lock': parseComposerLock, csproj: parseCsproj };
  const KIND_LABEL = { 'package.json': 'package.json', 'package-lock': 'package-lock.json', 'yarn.lock': 'yarn.lock', requirements: 'requirements.txt', 'poetry.lock': 'poetry.lock',
    pom: 'pom.xml', gradle: 'build.gradle', 'go.mod': 'go.mod', 'gemfile.lock': 'Gemfile.lock', 'composer.lock': 'composer.lock', csproj: '.csproj' };

  function parseFiles(files) {
    const warnings = [], parsed = [];
    (files || []).forEach((f, i) => {
      const text = String(f.text || '');
      if (!text.trim()) return;
      const kind = f.kind || detect(f.name, text);
      const label = f.name || 'Pasted file ' + (i + 1);
      if (!kind) { warnings.push(label + ': not recognised. Supported: package.json, package-lock.json, yarn.lock, requirements.txt, poetry.lock, pom.xml, build.gradle, go.mod, Gemfile.lock, composer.lock, .csproj.'); return; }
      try { parsed.push({ name: label, kind, deps: PARSERS[kind](text, label) }); }
      catch (e) { warnings.push(label + ': ' + (e instanceof SyntaxError ? 'not valid JSON (' + e.message + ')' : e.message)); }
    });
    // a lockfile gives exact versions; package.json says which are direct and which are dev-only
    const pj = parsed.filter(p => p.kind === 'package.json');
    const locks = parsed.filter(p => p.kind === 'package-lock' || p.kind === 'yarn.lock');
    if (pj.length && locks.length) {
      const direct = new Map();
      pj.forEach(p => p.deps.forEach(d => direct.set(d.name, d)));
      locks.forEach(l => l.deps.forEach(d => {
        const pd = direct.get(d.name);
        if (d.direct === null) d.direct = false;
        if (pd && (d.direct || l.kind === 'yarn.lock')) { d.direct = true; d.spec = pd.spec; if (pd.dev) d.dev = true; }
      }));
      // in a yarn.lock the same package can appear at several versions: only one of them is the direct one
      pj.forEach(p => { p.superseded = true; });
    }
    const deps = [];
    const seen = new Set();
    parsed.forEach(p => {
      if (p.superseded) return;
      p.deps.forEach(d => {
        if (!d.name) return;
        const key = d.ecosystem + '|' + d.name + '|' + d.version;
        if (seen.has(key)) { const o = deps.find(x => x.ecosystem + '|' + x.name + '|' + x.version === key); if (o && d.direct) o.direct = true; if (o && !d.dev) o.dev = false; return; }
        seen.add(key);
        deps.push(d);
      });
    });
    if (!deps.length && !warnings.length) warnings.push('No dependencies found.');
    return { deps, files: parsed.map(p => ({ name: p.name, kind: p.kind, label: KIND_LABEL[p.kind], count: p.deps.length, ecosystem: p.deps[0] ? p.deps[0].ecosystem : '' })), warnings };
  }

  // ------------------------------------------------------------------ versions
  function parts(v) { return String(v || '').replace(/^v/i, '').split(/[.+-]/).map(x => (/^\d+$/.test(x) ? +x : x)); }
  const PRE = /^(a|alpha|b|beta|rc|cr|m|milestone|pre|preview|dev|snapshot|ea)\d*$/i;
  function cmp(a, b) {
    const x = parts(a), y = parts(b);
    const n = Math.max(x.length, y.length);
    for (let i = 0; i < n; i++) {
      let p = x[i], q = y[i];
      if (p === undefined) return typeof q === 'string' && PRE.test(q) ? 1 : (q === 0 ? 0 : -1);
      if (q === undefined) return typeof p === 'string' && PRE.test(p) ? -1 : (p === 0 ? 0 : 1);
      if (p === q) continue;
      if (typeof p === 'number' && typeof q === 'number') return p < q ? -1 : 1;
      if (typeof p === 'number') return 1;
      if (typeof q === 'number') return -1;
      // split "0rc1" style pieces
      return String(p).localeCompare(String(q), undefined, { numeric: true }) < 0 ? -1 : 1;
    }
    return 0;
  }
  function bump(from, to) {
    if (!from || !to) return 'unknown';
    if (cmp(from, to) >= 0) return 'none';
    const a = parts(from), b = parts(to);
    const n = i => (typeof a[i] === 'number' ? a[i] : 0), m = i => (typeof b[i] === 'number' ? b[i] : 0);
    if (n(0) !== m(0)) return 'major';
    if (n(0) === 0 && n(1) !== m(1)) return 'major'; // 0.x: a minor bump can break
    if (n(1) !== m(1)) return 'minor';
    return 'patch';
  }
  function isPre(v) { return /[-.]?(alpha|beta|rc|canary|next|nightly|dev|pre|snapshot)/i.test(String(v)); }

  // ------------------------------------------------------------------ OSV
  function osvBatch(deps) {
    const queries = [], index = [];
    const seen = new Map();
    deps.forEach((d, i) => {
      if (!d.version || !d.ecosystem) return;
      const k = d.ecosystem + '|' + d.name + '|' + d.version;
      if (seen.has(k)) { index[seen.get(k)].push(i); return; }
      seen.set(k, queries.length);
      queries.push({ package: { name: d.name, ecosystem: d.ecosystem }, version: d.version });
      index.push([i]);
    });
    const chunks = [];
    for (let i = 0; i < queries.length; i += 1000) chunks.push({ queries: queries.slice(i, i + 1000) });
    return { queries, index, chunks };
  }

  const W = { AV: { N: 0.85, A: 0.62, L: 0.55, P: 0.2 }, AC: { L: 0.77, H: 0.44 }, UI: { N: 0.85, R: 0.62 }, CIA: { H: 0.56, L: 0.22, N: 0 } };
  function roundUp(x) { const i = Math.round(x * 100000); return i % 10000 === 0 ? i / 100000 : (Math.floor(i / 10000) + 1) / 10; }
  function cvss3Score(vector) {
    const m = {};
    String(vector || '').split('/').forEach(p => { const [k, v] = p.split(':'); if (k && v) m[k] = v; });
    if (!/^3/.test(m.CVSS || '') || !m.AV || !m.AC || !m.PR || !m.UI || !m.S || !m.C || !m.I || !m.A) return null;
    const changed = m.S === 'C';
    const pr = { N: 0.85, L: changed ? 0.68 : 0.62, H: changed ? 0.5 : 0.27 }[m.PR];
    const iss = 1 - (1 - W.CIA[m.C]) * (1 - W.CIA[m.I]) * (1 - W.CIA[m.A]);
    const impact = changed ? 7.52 * (iss - 0.029) - 3.25 * Math.pow(iss - 0.02, 15) : 6.42 * iss;
    const expl = 8.22 * W.AV[m.AV] * W.AC[m.AC] * pr * W.UI[m.UI];
    if ([pr, W.AV[m.AV], W.AC[m.AC], W.UI[m.UI]].some(x => x === undefined)) return null;
    if (impact <= 0) return 0;
    return roundUp(Math.min(changed ? 1.08 * (impact + expl) : impact + expl, 10));
  }
  const rating = s => (s == null ? 'unknown' : s === 0 ? 'none' : s < 4 ? 'low' : s < 7 ? 'medium' : s < 9 ? 'high' : 'critical');
  const SEV_RANK = { critical: 4, high: 3, medium: 2, low: 1, unknown: 1.5, none: 0 };

  function parseVuln(v, d) {
    const sev = (v.severity || []).concat(...(v.affected || []).map(a => a.severity || []));
    let score = null, vector = '';
    sev.forEach(s => { if (/CVSS_V3/.test(s.type)) { const sc = cvss3Score(s.score); if (sc != null && (score == null || sc > score)) { score = sc; vector = s.score; } } });
    if (!vector) { const v4 = sev.find(s => /CVSS_V4/.test(s.type)); if (v4) vector = v4.score; }
    let label = rating(score);
    const dbs = (v.database_specific && v.database_specific.severity) || '';
    if (score == null && dbs) label = { CRITICAL: 'critical', HIGH: 'high', MODERATE: 'medium', MEDIUM: 'medium', LOW: 'low' }[String(dbs).toUpperCase()] || 'unknown';
    // the lowest fixed version above the version in use, for this package
    const fixes = [];
    let affectedHere = false;
    (v.affected || []).forEach(a => {
      if (!a.package || (d && (a.package.ecosystem !== d.ecosystem || norm(d.ecosystem, a.package.name) !== norm(d.ecosystem, d.name)))) return;
      affectedHere = true;
      (a.ranges || []).forEach(r => {
        if (r.type === 'GIT') return;
        let intro = '0';
        (r.events || []).forEach(e => {
          if (e.introduced !== undefined) intro = e.introduced;
          if (e.fixed !== undefined && (!d || !d.version || ((intro === '0' || cmp(d.version, intro) >= 0) && cmp(e.fixed, d.version) > 0))) fixes.push(e.fixed);
        });
      });
    });
    fixes.sort(cmp);
    const cve = (v.aliases || []).find(a => /^CVE-/.test(a));
    const ghsa = [v.id].concat(v.aliases || []).find(a => /^GHSA-/.test(a));
    return { id: v.id, aliases: v.aliases || [], cve: cve || '', ghsa: ghsa || '', summary: v.summary || (v.details ? String(v.details).split('\n')[0].slice(0, 200) : ''), severity: label, score, vector,
      fixed: fixes[0] || '', published: v.published || '', withdrawn: !!v.withdrawn, url: 'https://osv.dev/vulnerability/' + encodeURIComponent(v.id), affectedHere };
  }
  const norm = (eco, n) => (eco === ECO.pypi ? pyName(n) : eco === ECO.nuget || eco === ECO.composer ? String(n).toLowerCase() : String(n));

  // ------------------------------------------------------------------ registries (npm and PyPI allow browser requests)
  const npmPath = n => String(n).replace(/\//g, '%2f').replace(/^%40|^@/, '@');
  function npmUrls(d) { return { latest: 'https://registry.npmjs.org/' + npmPath(d.name) + '/latest', version: 'https://registry.npmjs.org/' + npmPath(d.name) + '/' + encodeURIComponent(d.version) }; }
  function pypiUrl(d) { return 'https://pypi.org/pypi/' + encodeURIComponent(d.name) + '/json'; }
  function licenseFromNpm(doc) {
    if (!doc) return '';
    if (typeof doc.license === 'string') return doc.license;
    if (doc.license && doc.license.type) return doc.license.type;
    if (Array.isArray(doc.licenses)) return doc.licenses.map(l => l.type || l).join(' OR ');
    return '';
  }
  function fromPypi(json, version) {
    const info = (json && json.info) || {};
    let lic = info.license_expression || '';
    if (!lic) {
      const cl = (info.classifiers || []).filter(c => /^License ::/.test(c)).map(c => c.split('::').pop().trim());
      lic = cl.length ? cl.map(classifierToSpdx).join(' OR ') : (info.license && info.license.length < 80 ? info.license : (info.license ? info.license.split('\n')[0].slice(0, 60) : ''));
    }
    const rel = json && json.releases && json.releases[version];
    const yanked = Array.isArray(rel) && rel.length > 0 && rel.every(f => f.yanked);
    const reason = yanked ? (rel.find(f => f.yanked_reason) || {}).yanked_reason || 'yanked' : '';
    return { latest: info.version || '', license: lic, deprecated: yanked ? 'This version was yanked from PyPI' + (reason && reason !== 'yanked' ? ': ' + reason : '') : '' };
  }
  function classifierToSpdx(c) {
    const map = [[/^MIT/, 'MIT'], [/Apache Software License|Apache.*2/, 'Apache-2.0'], [/^BSD/, 'BSD'], [/^ISC/, 'ISC'], [/Affero/, 'AGPL-3.0'], [/Lesser General Public License v3|LGPLv3/, 'LGPL-3.0'],
      [/Lesser General Public License v2|LGPLv2/, 'LGPL-2.1'], [/Lesser General/, 'LGPL'], [/General Public License v3|GPLv3/, 'GPL-3.0'], [/General Public License v2|GPLv2/, 'GPL-2.0'], [/General Public License/, 'GPL'],
      [/Mozilla Public License 2/, 'MPL-2.0'], [/Mozilla/, 'MPL'], [/Python Software Foundation/, 'PSF-2.0'], [/Public Domain/, 'Public domain'], [/Eclipse/, 'EPL'], [/Zope/, 'ZPL']];
    for (const [re, id] of map) if (re.test(c)) return id;
    return c;
  }

  // run tasks with a concurrency limit
  async function pool(items, n, fn) {
    let i = 0;
    const workers = Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } });
    await Promise.all(workers);
  }

  /* fetchFn(url, init) must behave like window.fetch. opts: { latest: 'direct' | 'all' | 'none', concurrency, onProgress(text) } */
  async function scan(deps, fetchFn, opts) {
    const o = Object.assign({ latest: 'direct', concurrency: 8, onProgress: () => {} }, opts || {});
    const out = { osv: {}, vulns: {}, registry: {}, errors: [], requests: 0 };
    const getJSON = async (url, init) => {
      out.requests++;
      const r = await fetchFn(url, init);
      if (!r.ok) { const e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
      return r.json();
    };
    const b = osvBatch(deps);
    for (let c = 0; c < b.chunks.length; c++) {
      o.onProgress('Checking ' + b.queries.length + ' packages against OSV.dev…');
      let res;
      try { res = await getJSON('https://api.osv.dev/v1/querybatch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b.chunks[c]) }); }
      catch (e) { out.errors.push('OSV.dev could not be reached (' + e.message + '). Vulnerabilities were not checked.'); out.osvFailed = true; break; }
      (res.results || []).forEach((r, k) => {
        const q = b.chunks[c].queries[k];
        out.osv[q.package.ecosystem + '|' + q.package.name + '|' + q.version] = (r.vulns || []).map(v => v.id);
        if (r.next_page_token) out.errors.push(q.package.name + ' has more known vulnerabilities than one OSV page; only the first page is shown.');
      });
    }
    const ids = [...new Set([].concat(...Object.values(out.osv)))];
    let done = 0;
    await pool(ids, o.concurrency, async id => {
      try { out.vulns[id] = await getJSON('https://api.osv.dev/v1/vulns/' + encodeURIComponent(id)); }
      catch (e) { out.vulns[id] = { id, summary: '(details could not be loaded)', affected: [] }; }
      o.onProgress('Loading vulnerability details ' + (++done) + ' of ' + ids.length + '…');
    });
    if (o.latest !== 'none') {
      const want = deps.filter(d => (d.ecosystem === ECO.npm || d.ecosystem === ECO.pypi) && (o.latest === 'all' || d.direct !== false));
      const uniq = [...new Map(want.map(d => [d.ecosystem + '|' + d.name + '|' + d.version, d])).values()];
      let n = 0;
      await pool(uniq, o.concurrency, async d => {
        const key = d.ecosystem + '|' + d.name + '|' + d.version;
        try {
          if (d.ecosystem === ECO.npm) {
            const u = npmUrls(d);
            const latest = await getJSON(u.latest);
            let cur = null;
            if (d.version) { try { cur = await getJSON(u.version); } catch (e) { cur = null; } }
            out.registry[key] = { latest: latest.version || '', license: licenseFromNpm(cur || latest), deprecated: cur && cur.deprecated ? String(cur.deprecated) : '', latestDeprecated: latest.deprecated ? String(latest.deprecated) : '' };
          } else {
            out.registry[key] = fromPypi(await getJSON(pypiUrl(d)), d.version);
          }
        } catch (e) { out.registry[key] = { error: e.status === 404 ? 'not found in the public registry (private package?)' : 'lookup failed' }; }
        o.onProgress('Checking latest versions ' + (++n) + ' of ' + uniq.length + '…');
      });
    }
    return out;
  }

  // ------------------------------------------------------------------ licences
  const STRONG = /\b(A?GPL|SSPL|OSL|RPL|CC-BY-SA|CC-BY-NC|EUPL|Sleepycat|CPAL)\b/i;
  const WEAK = /\b(LGPL|MPL|EPL|CDDL|CPL|EPL|MS-RL|APSL|Artistic)\b/i;
  const PERMISSIVE = /\b(MIT|ISC|BSD|Apache|0BSD|Unlicense|CC0|Zlib|Python|PSF|BlueOak|WTFPL|BSL-1\.0|Boost|X11|Public domain|PostgreSQL|MIT-0|ZPL|Ruby|OpenSSL|NCSA|UPL)\b/i;
  function licenseClass(lic) {
    const s = String(lic || '').trim();
    if (!s || /^(UNKNOWN|NOASSERTION|NONE)$/i.test(s)) return 'unknown';
    if (/^(UNLICENSED|SEE LICEN[CS]E IN|proprietary|commercial)/i.test(s)) return 'proprietary';
    const one = t => (STRONG.test(t) && !/LGPL/i.test(t) ? 'strong' : WEAK.test(t) || /LGPL/i.test(t) ? 'weak' : PERMISSIVE.test(t) ? 'permissive' : 'other');
    const rank = { permissive: 0, other: 1, weak: 2, strong: 3 };
    const ors = s.replace(/[()]/g, ' ').split(/\s+OR\s+|\s*\/\s*/i);
    // OR: you may choose the friendliest; AND / WITH: all apply
    let best = null;
    ors.forEach(part => {
      const worst = part.split(/\s+AND\s+/i).map(one).sort((a, b) => rank[b] - rank[a])[0];
      if (best == null || rank[worst] < rank[best]) best = worst;
    });
    return best || 'other';
  }

  // ------------------------------------------------------------------ analysis
  // OSV often has two records for one problem (a GitHub advisory and a PyPI or Go one, linked by aliases): keep one
  function dedupe(list) {
    const out = [];
    list.forEach(v => {
      const keys = [v.id].concat(v.aliases);
      const ex = out.find(u => u.keys.some(k => keys.includes(k)));
      if (!ex) { out.push(Object.assign({}, v, { keys })); return; }
      keys.forEach(k => { if (!ex.keys.includes(k)) ex.keys.push(k); });
      if ((v.score != null && (ex.score == null || v.score > ex.score)) || (ex.score == null && v.score == null && SEV_RANK[v.severity] > SEV_RANK[ex.severity])) {
        ex.score = v.score; ex.vector = v.vector; ex.severity = v.severity;
      }
      if (!ex.cve && v.cve) ex.cve = v.cve;
      if (!ex.ghsa && v.ghsa) { ex.ghsa = v.ghsa; }
      if (v.fixed && (!ex.fixed || cmp(v.fixed, ex.fixed) < 0)) ex.fixed = v.fixed;
      if (!ex.summary && v.summary) ex.summary = v.summary;
    });
    out.forEach(v => { delete v.keys; });
    return out;
  }
  const SEV_W = { critical: 40, high: 25, medium: 12, unknown: 10, low: 4, none: 0 };
  function analyse(deps, scanData) {
    const sd = scanData || null;
    const rows = deps.map(d => {
      const key = d.ecosystem + '|' + d.name + '|' + d.version;
      const ids = sd && sd.osv[key] ? sd.osv[key] : [];
      const vulns = dedupe(ids.map(id => parseVuln(sd.vulns[id] || { id, affected: [] }, d)).filter(v => !v.withdrawn))
        .sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity] || (b.score || 0) - (a.score || 0));
      const reg = (sd && sd.registry[key]) || {};
      const latest = reg.latest || '';
      const license = d.license || reg.license || '';
      const lclass = licenseClass(license);
      const update = latest && d.version && !isPre(latest) ? bump(d.version, latest) : 'unknown';
      const maxSev = vulns.length ? vulns[0].severity : '';
      // target: the lowest version that fixes every known vulnerability; otherwise the latest
      let target = '';
      if (vulns.length) {
        const fx = vulns.map(v => v.fixed).filter(Boolean).sort(cmp);
        if (fx.length) target = fx[fx.length - 1];
        if (latest && target && cmp(latest, target) > 0 && bump(d.version, target) === bump(d.version, latest) && update !== 'major') target = latest;
      }
      const unfixed = vulns.filter(v => !v.fixed).length;
      let risk = 0;
      if (vulns.length) risk += SEV_W[vulns[0].severity] + vulns.slice(1).reduce((s, v) => s + SEV_W[v.severity] * 0.25, 0);
      if (reg.deprecated) risk += 15;
      if (update === 'major') { const behind = (parts(latest)[0] | 0) - (parts(d.version)[0] | 0); risk += 8 + Math.min(12, Math.max(0, behind - 1) * 4); }
      else if (update === 'minor') risk += 3; else if (update === 'patch') risk += 1;
      if (lclass === 'strong') risk += 10; else if (lclass === 'weak') risk += 3; else if (lclass === 'proprietary') risk += 5;
      if (!d.exact && d.direct) risk += 3;
      if (d.direct === false) risk *= 0.8;
      if (d.dev) risk *= 0.6;
      return Object.assign({}, d, { key, vulns, maxSeverity: maxSev, latest, update, deprecated: reg.deprecated || '', registryError: reg.error || '', license, licenseClass: lclass,
        target, targetBump: target ? bump(d.version, target) : '', unfixed, risk: Math.min(100, Math.round(risk)) });
    });
    rows.sort((a, b) => b.risk - a.risk || a.name.localeCompare(b.name));
    const c = sev => rows.reduce((s, r) => s + r.vulns.filter(v => v.severity === sev).length, 0);
    const counts = { packages: rows.length, direct: rows.filter(r => r.direct === true).length, transitive: rows.filter(r => r.direct === false).length,
      vulnerable: rows.filter(r => r.vulns.length).length, critical: c('critical'), high: c('high'), medium: c('medium'), low: c('low'), unknown: c('unknown'),
      deprecated: rows.filter(r => r.deprecated).length, major: rows.filter(r => r.update === 'major').length, minor: rows.filter(r => r.update === 'minor').length,
      patch: rows.filter(r => r.update === 'patch').length, strong: rows.filter(r => r.licenseClass === 'strong').length, weak: rows.filter(r => r.licenseClass === 'weak').length,
      unpinned: rows.filter(r => !r.exact).length, checked: !!(sd && !sd.osvFailed) };
    const score = Math.min(100, Math.round(counts.critical * 25 + counts.high * 12 + counts.medium * 4 + counts.low + counts.unknown * 3 + counts.deprecated * 3 + counts.major * 1 + counts.strong * 4));
    const grade = score >= 80 ? 'critical' : score >= 50 ? 'high' : score >= 20 ? 'medium' : 'low';
    return { rows, counts, score, grade, ecosystems: [...new Set(rows.map(r => r.ecosystem))], plan: upgradePlan(rows) };
  }

  // ------------------------------------------------------------------ upgrade plan and commands
  const EFFORT = { patch: 0, minor: 1, none: 0, unknown: 2, major: 3, '': 2 };
  function command(r, to, ctx) {
    const v = to || r.latest;
    const transitive = r.direct === false;
    switch (r.ecosystem) {
      case ECO.npm:
        if (transitive) return 'npm update ' + r.name + '   # or pin it: "overrides": { "' + r.name + '": "' + v + '" } in package.json';
        return 'npm install ' + r.name + '@' + v + (r.dev ? ' --save-dev' : '');
      case ECO.pypi: return ctx && ctx.poetry ? 'poetry add "' + r.name + '@^' + v + '"' : 'pip install "' + r.name + '==' + v + '"';
      case ECO.maven: return '<version>' + v + '</version>   <!-- ' + r.name + ' in pom.xml, or implementation "' + r.name + ':' + v + '" in build.gradle -->';
      case ECO.go: return 'go get ' + r.name + '@v' + String(v).replace(/^v/, '') + ' && go mod tidy';
      case ECO.gem: return transitive ? 'bundle update --conservative ' + r.name : 'bundle update ' + r.name + '   # Gemfile: gem "' + r.name + '", "~> ' + v + '"';
      case ECO.composer: return transitive ? 'composer update ' + r.name + ' --with-dependencies' : 'composer require ' + r.name + ':^' + v;
      case ECO.nuget: return 'dotnet add package ' + r.name + ' --version ' + v;
      default: return '';
    }
  }
  function upgradePlan(rows) {
    const ctx = { poetry: rows.some(r => /poetry\.lock$/i.test(r.file)) };
    const steps = [];
    rows.forEach(r => {
      let why = '', to = '', kind = '';
      if (r.vulns.length) {
        kind = 'security';
        to = r.target;
        const top = r.vulns[0];
        why = r.vulns.length + ' known vulnerabilit' + (r.vulns.length > 1 ? 'ies' : 'y') + ', worst ' + top.severity + (top.score != null ? ' (CVSS ' + top.score + ')' : '') + (r.unfixed ? '; ' + r.unfixed + ' with no fix yet' : '');
        if (!to) { steps.push({ name: r.name, ecosystem: r.ecosystem, from: r.version, to: '', effort: 'unknown', kind, why: why + '. No fixed version is published: consider replacing the package or mitigating.', cmd: '', risk: r.risk, direct: r.direct, severity: top.severity }); return; }
      } else if (r.deprecated) { kind = 'deprecated'; to = r.latest; why = 'Deprecated: ' + r.deprecated.slice(0, 160); }
      else if (r.update === 'major' || r.update === 'minor' || r.update === 'patch') { kind = 'outdated'; to = r.latest; why = r.update + ' update available'; }
      else return;
      if (!to || cmp(to, r.version) <= 0) { if (kind !== 'deprecated') return; }
      const effort = to ? bump(r.version, to) : 'unknown';
      steps.push({ name: r.name, ecosystem: r.ecosystem, from: r.version, to, effort, kind, why, cmd: to ? command(r, to, ctx) : '', risk: r.risk, direct: r.direct, severity: r.maxSeverity,
        breaking: effort === 'major' });
    });
    const K = { security: 0, deprecated: 1, outdated: 2 };
    steps.sort((a, b) => K[a.kind] - K[b.kind] || (a.kind === 'security' ? SEV_RANK[b.severity] - SEV_RANK[a.severity] : 0) || EFFORT[a.effort] - EFFORT[b.effort] || b.risk - a.risk || a.name.localeCompare(b.name));
    return steps;
  }

  // ------------------------------------------------------------------ CI configuration
  const DEPENDABOT = { npm: 'npm', PyPI: 'pip', Maven: 'maven', Go: 'gomod', RubyGems: 'bundler', Packagist: 'composer', NuGet: 'nuget' };
  function dependabot(ecosystems, opts) {
    const o = Object.assign({ gradle: false, directory: '/' }, opts || {});
    const list = [...new Set((ecosystems || []).map(e => (e === ECO.maven && o.gradle ? 'gradle' : DEPENDABOT[e])).filter(Boolean))];
    if (o.gradle && (ecosystems || []).includes(ECO.maven) && o.maven) list.push('maven');
    list.push('github-actions');
    return `# .github/dependabot.yml: free weekly update pull requests from GitHub.
# Security updates also need: Settings → Code security → Dependabot security updates (on).
version: 2
updates:
${list.map(e => `  - package-ecosystem: "${e}"
    directory: "${o.directory}"
    schedule:
      interval: "weekly"
      day: "monday"
    open-pull-requests-limit: 10${e === 'github-actions' ? '' : `
    groups:
      minor-and-patch:
        update-types: ["minor", "patch"]`}`).join('\n')}
`;
  }
  function workflow(ecosystems, opts) {
    const o = Object.assign({ level: 'high', requirements: 'requirements.txt' }, opts || {});
    const eco = new Set(ecosystems || []);
    let jobs = `  osv-scanner:
    # Google's free scanner reads every lockfile in the repository and checks it against OSV.dev.
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version: stable
      - name: Install osv-scanner
        run: go install github.com/google/osv-scanner/cmd/osv-scanner@latest
      - name: Scan lockfiles (fails when a known vulnerability is found)
        run: osv-scanner --recursive .
`;
    if (eco.has(ECO.npm)) jobs += `
  npm-audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - name: npm audit (production dependencies)
        run: npm audit --omit=dev --audit-level=${o.level === 'critical' ? 'critical' : o.level === 'moderate' ? 'moderate' : 'high'}
`;
    if (eco.has(ECO.pypi)) jobs += `
  pip-audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.12"
      - name: pip-audit
        run: |
          python -m pip install pip-audit
          pip-audit -r ${o.requirements} --desc
`;
    return `# .github/workflows/dependency-check.yml
name: Dependency check

on:
  pull_request:
  push:
    branches: [main]
  schedule:
    - cron: "0 21 * * 0"   # every Monday 8am in Melbourne (Sunday 21:00 UTC)
  workflow_dispatch:

permissions:
  contents: read

jobs:
${jobs}`;
  }

  function toCSV(a) {
    const q = v => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) || /^[=+\-@]/.test(s) ? '"' + s.replace(/^([=+\-@])/, "'$1").replace(/"/g, '""') + '"' : s; };
    return 'ecosystem,package,version,direct,dev,vulnerabilities,worst_severity,fixed_in,latest,update,deprecated,license,license_type,risk\n'
      + a.rows.map(r => [r.ecosystem, r.name, r.version, r.direct == null ? '' : r.direct, r.dev, r.vulns.map(v => v.id).join(' '), r.maxSeverity, r.target, r.latest, r.update, r.deprecated ? 'yes' : '', r.license, r.licenseClass, r.risk].map(q).join(',')).join('\n') + '\n';
  }

  const api = { parseFiles, detect, parsePackageJson, parsePackageLock, parseYarnLock, parseRequirements, parsePoetryLock, parsePom, parseGradle, parseGoMod, parseGemfileLock,
    parseComposerLock, parseCsproj, osvBatch, scan, parseVuln, cvss3Score, rating, analyse, upgradePlan, command, licenseClass, cmp, bump, floorOf, fromPypi, npmUrls, pypiUrl,
    dependabot, workflow, toCSV, ECO };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DepRisk = api;
})(typeof self !== 'undefined' ? self : this);
