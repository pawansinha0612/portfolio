/* UI for /tools/dependency-risk/. Logic lives in deps.js (window.DepRisk).
   Files are parsed in the browser. Only when the user clicks "Check online" are package names and versions sent to
   api.osv.dev, registry.npmjs.org and pypi.org. */
(function () {
  'use strict';
  const D = window.DepRisk;
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = x => Number(x).toLocaleString('en-AU');
  let files = [], parsed = null, analysis = null, scanned = false, busy = false;

  // ------------------------------------------------------------------ samples
  const SAMPLES = {
    node: () => [
      { name: 'package.json', text: JSON.stringify({ name: 'shop-web', version: '2.4.0', dependencies: { express: '^4.17.1', lodash: '^4.17.20', axios: '^0.21.1', moment: '^2.29.1', 'node-fetch': '^2.6.0', jsonwebtoken: '^8.5.1' },
        devDependencies: { jest: '^26.6.3', request: '^2.88.2' } }, null, 2) },
      { name: 'package-lock.json', text: JSON.stringify({ name: 'shop-web', lockfileVersion: 3, packages: {
        '': { name: 'shop-web', dependencies: { express: '^4.17.1', lodash: '^4.17.20', axios: '^0.21.1', moment: '^2.29.1', 'node-fetch': '^2.6.0', jsonwebtoken: '^8.5.1' }, devDependencies: { jest: '^26.6.3', request: '^2.88.2' } },
        'node_modules/express': { version: '4.17.1', license: 'MIT' }, 'node_modules/qs': { version: '6.7.0', license: 'BSD-3-Clause' }, 'node_modules/body-parser': { version: '1.19.0', license: 'MIT' },
        'node_modules/lodash': { version: '4.17.20', license: 'MIT' }, 'node_modules/axios': { version: '0.21.1', license: 'MIT' }, 'node_modules/follow-redirects': { version: '1.14.0', license: 'MIT' },
        'node_modules/moment': { version: '2.29.1', license: 'MIT' }, 'node_modules/node-fetch': { version: '2.6.0', license: 'MIT' }, 'node_modules/jsonwebtoken': { version: '8.5.1', license: 'MIT' },
        'node_modules/jest': { version: '26.6.3', dev: true, license: 'MIT' }, 'node_modules/minimist': { version: '1.2.5', dev: true, license: 'MIT' },
        'node_modules/request': { version: '2.88.2', dev: true, license: 'Apache-2.0' }, 'node_modules/semver': { version: '5.7.1', license: 'ISC' } } }, null, 2) },
    ],
    python: () => [{ name: 'requirements.txt', text: '# API service\nDjango==3.2.0\nrequests==2.25.1\nurllib3==1.26.4\nPyYAML==5.3.1\nJinja2==2.11.2\ncryptography==3.3.1\ncelery>=5.0\nparamiko==2.7.2\n' }],
    java: () => [{ name: 'pom.xml', text: `<project>
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.acme</groupId><artifactId>payments-api</artifactId><version>3.8.0</version>
  <properties><log4j.version>2.14.1</log4j.version><jackson.version>2.9.8</jackson.version></properties>
  <dependencies>
    <dependency><groupId>org.apache.logging.log4j</groupId><artifactId>log4j-core</artifactId><version>\${log4j.version}</version></dependency>
    <dependency><groupId>com.fasterxml.jackson.core</groupId><artifactId>jackson-databind</artifactId><version>\${jackson.version}</version></dependency>
    <dependency><groupId>org.springframework</groupId><artifactId>spring-web</artifactId><version>5.3.9</version></dependency>
    <dependency><groupId>org.yaml</groupId><artifactId>snakeyaml</artifactId><version>1.26</version></dependency>
    <dependency><groupId>commons-io</groupId><artifactId>commons-io</artifactId><version>2.6</version></dependency>
    <dependency><groupId>junit</groupId><artifactId>junit</artifactId><version>4.12</version><scope>test</scope></dependency>
  </dependencies>
</project>
` }],
  };

  // ------------------------------------------------------------------ inputs
  function readFile(f) { return f.text ? f.text() : new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsText(f); }); }
  async function addFileList(list) {
    for (const f of Array.from(list)) {
      if (f.size > 30e6) { showErr(f.name + ' is larger than 30 MB.'); continue; }
      files.push({ name: f.name, text: await readFile(f) });
    }
    refresh();
  }
  $('file').addEventListener('change', async e => { await addFileList(e.target.files); e.target.value = ''; });
  const zone = $('drop');
  ['dragenter', 'dragover'].forEach(ev => zone.addEventListener(ev, e => { e.preventDefault(); zone.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => zone.addEventListener(ev, e => { e.preventDefault(); zone.classList.remove('over'); }));
  zone.addEventListener('drop', e => { if (e.dataTransfer && e.dataTransfer.files.length) addFileList(e.dataTransfer.files); });
  $('paste-add').addEventListener('click', () => {
    const t = $('paste').value;
    if (!t.trim()) return;
    const kind = $('paste-kind').value;
    files.push({ name: kind ? kindName(kind) : 'Pasted file ' + (files.length + 1), text: t, kind: kind || undefined });
    $('paste').value = '';
    refresh();
  });
  const kindName = k => ({ 'package.json': 'package.json', 'package-lock': 'package-lock.json', 'yarn.lock': 'yarn.lock', requirements: 'requirements.txt', 'poetry.lock': 'poetry.lock', pom: 'pom.xml', gradle: 'build.gradle', 'go.mod': 'go.mod', 'gemfile.lock': 'Gemfile.lock', 'composer.lock': 'composer.lock', csproj: 'project.csproj' }[k] || k);
  $('files').addEventListener('click', e => { const b = e.target.closest('[data-rm]'); if (b) { files.splice(+b.dataset.rm, 1); refresh(); } });
  $('clear').addEventListener('click', () => { files = []; refresh(); document.querySelectorAll('[data-sample]').forEach(b => b.removeAttribute('aria-pressed')); });
  document.querySelectorAll('[data-sample]').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('[data-sample]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    files = SAMPLES[b.dataset.sample]();
    refresh();
  }));
  function showErr(m) { $('err').textContent = m; $('err').hidden = !m; }

  function refresh() {
    showErr('');
    scanned = false;
    parsed = files.length ? D.parseFiles(files) : null;
    const info = parsed ? parsed.files : [];
    $('files').innerHTML = files.map((f, i) => {
      const p = info.find(x => x.name === (f.name || '')) || null;
      return '<li><span title="' + esc(f.name) + '">' + esc(f.name) + (p ? ' · ' + esc(p.label) + ', ' + num(p.count) + ' packages' : '') + '</span><button type="button" data-rm="' + i + '" aria-label="Remove ' + esc(f.name) + '">×</button></li>';
    }).join('');
    $('net').hidden = !(parsed && parsed.deps.length);
    if (!parsed) { $('result').hidden = true; return; }
    if (parsed.warnings.length && !parsed.deps.length) { showErr(parsed.warnings.join(' ')); $('result').hidden = true; return; }
    const deps = parsed.deps;
    const ecos = [...new Set(deps.map(d => d.ecosystem))];
    const sendable = D.osvBatch(deps).queries.length;
    $('net-what').innerHTML = '<b>' + num(sendable) + '</b> package name' + (sendable === 1 ? '' : 's') + ' with version and ecosystem (' + esc(ecos.join(', ')) + ') go to <code>api.osv.dev</code>'
      + (ecos.includes('npm') || ecos.includes('PyPI') ? ', and the names of ' + (ecos.includes('npm') ? 'npm' : '') + (ecos.includes('npm') && ecos.includes('PyPI') ? ' and ' : '') + (ecos.includes('PyPI') ? 'PyPI' : '') + ' packages go to their public registry for the latest version, licence and deprecation notices' : '') + '.';
    $('net-json').textContent = JSON.stringify({ queries: D.osvBatch(deps).queries.slice(0, 5) }, null, 2) + (sendable > 5 ? '\n… and ' + (sendable - 5) + ' more like these' : '');
    analysis = D.analyse(deps, null);
    render();
  }

  // ------------------------------------------------------------------ network
  $('check').addEventListener('click', async () => {
    if (!parsed || busy) return;
    busy = true; $('check').disabled = true; $('progress').hidden = false;
    try {
      const sd = await D.scan(parsed.deps, (u, i) => fetch(u, i), { latest: $('all-latest').checked ? 'all' : 'direct', onProgress: t => { $('progress').textContent = t; } });
      analysis = D.analyse(parsed.deps, sd);
      analysis.errors = sd.errors;
      analysis.requests = sd.requests;
      scanned = !sd.osvFailed;
      render();
    } catch (e) { showErr('The check failed: ' + e.message); }
    finally { busy = false; $('check').disabled = false; $('progress').hidden = true; }
  });

  // ------------------------------------------------------------------ render
  const SEV_LABEL = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low', unknown: 'Unrated' };
  const LIC_LABEL = { strong: 'Strong copyleft', weak: 'Weak copyleft', permissive: 'Permissive', proprietary: 'Proprietary', other: 'Other', unknown: 'Unknown' };
  function render() {
    const a = analysis, c = a.counts;
    const res = $('result');
    res.hidden = false;
    let h = '';
    if (!scanned) {
      h += '<div class="verdict"><h2>' + num(c.packages) + ' packages read: ' + num(c.direct) + ' direct' + (c.transitive ? ', ' + num(c.transitive) + ' transitive' : '') + '</h2>'
        + '<p>Nothing has been sent anywhere yet. Press <b>Check online</b> above to look up known vulnerabilities, latest versions and licences.</p>'
        + (a.errors && a.errors.length ? '<ul class="warnings">' + a.errors.map(e => '<li>' + esc(e) + '</li>').join('') + '</ul>' : '') + '</div>';
    } else {
      const cls = a.grade === 'low' ? 'pass' : a.grade === 'medium' ? 'warn' : 'fail';
      const head = c.vulnerable ? num(c.vulnerable) + ' of ' + num(c.packages) + ' packages have known vulnerabilities' : 'No known vulnerabilities in ' + num(c.packages) + ' packages';
      h += '<div class="verdict ' + cls + '"><h2>' + head + '</h2><p>Risk score <b>' + a.score + '/100</b> (' + a.grade + '). '
        + (c.critical + c.high ? num(c.critical) + ' critical and ' + num(c.high) + ' high severity issues. ' : '') + (c.deprecated ? num(c.deprecated) + ' deprecated. ' : '') + (c.major ? num(c.major) + ' a major version behind. ' : '')
        + (c.strong ? num(c.strong) + ' under a strong copyleft licence.' : '') + '</p><p class="fmt">' + num(a.requests) + ' requests to OSV.dev and public registries. Your files were not sent.</p>'
        + '<div class="exports"><button class="btn btn-ghost btn-small" type="button" id="x-csv">Download CSV</button><button class="btn btn-ghost btn-small" type="button" id="x-md">Download report (Markdown)</button></div></div>';
      if (a.errors && a.errors.length) h += '<ul class="warnings">' + a.errors.map(e => '<li>' + esc(e) + '</li>').join('') + '</ul>';
      h += '<div class="ja-stats">' + stat('Critical', c.critical, 'bad') + stat('High', c.high, 'bad') + stat('Medium', c.medium, 'warn') + stat('Low / unrated', c.low + c.unknown, '')
        + stat('Deprecated', c.deprecated, c.deprecated ? 'warn' : '') + stat('Major updates', c.major, '') + stat('Minor / patch', c.minor + c.patch, '') + stat('Copyleft', c.strong + c.weak, c.strong ? 'warn' : '') + '</div>';
      h += planBlock(a);
      h += vulnBlock(a);
    }
    h += '<div class="block"><div class="block-head"><h3>All packages</h3><div class="filters" role="group" aria-label="Filter">'
      + [['all', 'All'], ['vuln', 'Vulnerable'], ['out', 'Outdated'], ['dep', 'Deprecated'], ['lic', 'Copyleft'], ['direct', 'Direct only']].map((f, i) => '<button class="chip-btn" type="button" data-flt="' + f[0] + '" aria-pressed="' + (i === 0) + '">' + f[1] + '</button>').join('')
      + '</div></div><div class="tbl-wrap"><table class="data" id="t-all"></table></div><p class="hint" id="t-more"></p></div>';
    h += licBlock(a);
    h += ciBlock(a);
    res.innerHTML = h;
    bindAll(a);
  }
  const stat = (label, n, cls) => '<div class="ja-stat ' + (n ? cls : '') + '"><b>' + num(n) + '</b><span>' + esc(label) + '</span></div>';

  function planBlock(a) {
    if (!a.plan.length) return '<div class="block"><h3>Upgrade plan</h3><p class="hint">Nothing to upgrade from what could be checked.</p></div>';
    const effort = { patch: 'Patch: safe', minor: 'Minor: low risk', major: 'Major: may break', unknown: 'Unknown', none: '–' };
    let h = '<div class="block"><div class="block-head"><h3>Upgrade plan</h3><div class="exports"><button class="btn btn-small" type="button" id="x-cmds">Copy commands</button><span class="copied" id="copied" aria-live="polite"></span></div></div>'
      + '<p class="hint">Security fixes first, worst first; within each group the easy patch and minor upgrades come before majors. A major upgrade can change behaviour: read the changelog and run the tests. After upgrading, update the version in your manifest (requirements.txt, pom.xml, Gemfile) so the fix sticks.</p>'
      + '<div class="tbl-wrap"><table class="data"><thead><tr><th class="l">Package</th><th>From</th><th>To</th><th class="l">Effort</th><th class="l">Why</th><th class="l">Command</th></tr></thead><tbody>';
    a.plan.slice(0, 200).forEach((p, i) => {
      h += '<tr><td><b>' + (i + 1) + '. ' + esc(p.name) + '</b> <small>' + esc(p.ecosystem) + (p.direct === false ? ', transitive' : '') + '</small></td><td>' + esc(p.from) + '</td><td>' + esc(p.to || '–') + '</td><td class="l"><span class="eff ' + p.effort + '">' + (effort[p.effort] || p.effort) + '</span></td><td class="msg">'
        + (p.kind === 'security' ? '<span class="sev ' + p.severity + '">' + (SEV_LABEL[p.severity] || '') + '</span> ' : '') + esc(p.why) + '</td><td class="code">' + (p.cmd ? '<code>' + esc(p.cmd) + '</code>' : '–') + '</td></tr>';
    });
    return h + '</tbody></table></div>' + (a.plan.length > 200 ? '<p class="hint">Showing 200 of ' + a.plan.length + '. The CSV has everything.</p>' : '') + '</div>';
  }
  function vulnBlock(a) {
    const vr = a.rows.filter(r => r.vulns.length);
    if (!vr.length) return '';
    let h = '<div class="block"><div class="block-head"><h3>Known vulnerabilities</h3></div><p class="hint">From OSV.dev, which combines the GitHub Advisory Database, PyPI, Go, RustSec and other sources. Severity is the CVSS v3 base score where one is published, otherwise the advisory’s own rating.</p>';
    vr.slice(0, 80).forEach(r => {
      h += '<div class="card-x ' + (r.maxSeverity === 'critical' || r.maxSeverity === 'high' ? 'bad' : 'warn') + '"><h4>' + esc(r.name) + ' ' + esc(r.version) + ' <small>' + esc(r.ecosystem) + (r.direct === false ? ' · transitive' : r.direct ? ' · direct' : '') + (r.dev ? ' · dev only' : '') + '</small></h4>'
        + (r.target ? '<p>Fixed in <b>' + esc(r.target) + '</b>' + (r.latest ? ' · latest ' + esc(r.latest) : '') + '</p>' : '<p><b>No fixed version published</b> for at least one issue.</p>') + '<ul class="vl">'
        + r.vulns.map(v => '<li><span class="sev ' + v.severity + '">' + SEV_LABEL[v.severity] + (v.score != null ? ' ' + v.score : '') + '</span> <a href="' + esc(v.url) + '" target="_blank" rel="noopener">' + esc(v.cve || v.id) + '</a> ' + esc(v.summary) + (v.fixed ? ' <small>fixed in ' + esc(v.fixed) + '</small>' : ' <small>no fix yet</small>') + '</li>').join('')
        + '</ul></div>';
    });
    return h + '</div>';
  }
  function licBlock(a) {
    const by = {};
    a.rows.forEach(r => { (by[r.licenseClass] = by[r.licenseClass] || []).push(r); });
    const flagged = (by.strong || []).concat(by.weak || [], by.proprietary || []);
    let h = '<div class="block"><div class="block-head"><h3>Licences</h3></div><p class="hint">Strong copyleft (GPL, AGPL) can require you to publish your own source code when you distribute or, for AGPL, host the software. Weak copyleft (LGPL, MPL) mostly covers changes to the library itself. This is a flag for review, not legal advice.'
      + (scanned ? '' : ' Licences come from the lockfile now; checking online fills in more.') + '</p><div class="lic">'
      + ['strong', 'weak', 'proprietary', 'permissive', 'other', 'unknown'].map(k => '<span class="lic-c ' + k + '"><b>' + num((by[k] || []).length) + '</b> ' + LIC_LABEL[k] + '</span>').join('') + '</div>';
    if (flagged.length) h += '<ul class="notes" style="margin-top:10px">' + flagged.slice(0, 50).map(r => '<li><b>' + esc(r.name) + '</b> ' + esc(r.version) + ': ' + esc(r.license) + ' (' + LIC_LABEL[r.licenseClass].toLowerCase() + ')' + (r.dev ? ', dev only' : '') + '</li>').join('') + '</ul>';
    return h + '</div>';
  }
  function ciBlock(a) {
    return '<div class="block"><div class="block-head"><h3>Keep checking for free in CI</h3></div><p class="hint">A GitHub Actions workflow that scans every lockfile with Google’s osv-scanner'
      + (a.ecosystems.includes('npm') ? ', runs npm audit' : '') + (a.ecosystems.includes('PyPI') ? ', runs pip-audit' : '') + ' on every pull request and every Monday, and a Dependabot config that opens weekly update pull requests, grouped so minor and patch updates arrive together.</p>'
      + '<div class="modes" role="tablist" aria-label="CI file" id="ci-tabs"><button class="chip-btn" type="button" role="tab" data-ci="wf" aria-selected="true">dependency-check.yml</button><button class="chip-btn" type="button" role="tab" data-ci="db" aria-selected="false">dependabot.yml</button></div>'
      + '<div class="exports" style="margin:0 0 8px"><button class="btn btn-ghost btn-small" type="button" id="ci-copy">Copy</button><span class="copied" id="ci-copied" aria-live="polite"></span></div><pre class="gen"><code id="ci-code"></code></pre></div>';
  }

  function bindAll(a) {
    // packages table with filters and sorting
    let flt = 'all', sortK = 'risk', sortD = -1;
    const cols = [['name', 'Package', true], ['version', 'Version'], ['type', 'Type', true], ['vulns', 'Vulnerabilities', true], ['latest', 'Latest'], ['update', 'Update', true], ['license', 'Licence', true], ['risk', 'Risk']];
    const draw = () => {
      let rows = a.rows.filter(r => flt === 'all' || (flt === 'vuln' && r.vulns.length) || (flt === 'out' && /major|minor|patch/.test(r.update)) || (flt === 'dep' && r.deprecated)
        || (flt === 'lic' && /strong|weak/.test(r.licenseClass)) || (flt === 'direct' && r.direct === true));
      const val = (r, k) => (k === 'vulns' ? r.vulns.length * 10 + (r.vulns[0] ? { critical: 4, high: 3, medium: 2, unknown: 1.5, low: 1 }[r.vulns[0].severity] : 0) : k === 'type' ? (r.direct ? 'direct' : r.direct === false ? 'transitive' : '') : r[k]);
      rows = rows.slice().sort((x, y) => { const p = val(x, sortK), q = val(y, sortK); if (p == null || p === '') return 1; if (q == null || q === '') return -1; return (typeof p === 'string' ? p.localeCompare(q) : p - q) * sortD; });
      $('t-all').innerHTML = '<thead><tr>' + cols.map(c => '<th' + (c[2] ? ' class="l"' : '') + ' aria-sort="' + (c[0] === sortK ? (sortD > 0 ? 'ascending' : 'descending') : 'none') + '"><button type="button" data-k="' + c[0] + '">' + c[1] + '</button></th>').join('') + '</tr></thead><tbody>'
        + rows.slice(0, 600).map(r => '<tr><td><b>' + esc(r.name) + '</b> <small>' + esc(r.ecosystem) + '</small></td><td>' + esc(r.version || '?') + (r.exact ? '' : ' <small title="Range or unpinned: the lowest allowed version was checked">range</small>') + '</td><td class="l">'
          + (r.direct ? 'direct' : r.direct === false ? 'transitive' : '–') + (r.dev ? ' <small>dev</small>' : '') + '</td><td class="l">' + (r.vulns.length ? '<span class="sev ' + r.maxSeverity + '">' + r.vulns.length + ' · ' + SEV_LABEL[r.maxSeverity] + '</span>' : scanned ? 'none known' : '–')
          + '</td><td>' + esc(r.latest || (r.registryError ? '' : scanned && !/npm|PyPI/.test(r.ecosystem) ? 'unknown' : '–')) + (r.registryError ? '<small> ' + esc(r.registryError) + '</small>' : '') + '</td><td class="l">' + (r.update === 'unknown' ? '–' : r.update === 'none' ? 'up to date' : '<span class="eff ' + r.update + '">' + r.update + '</span>')
          + (r.deprecated ? ' <span class="sev high" title="' + esc(r.deprecated) + '">deprecated</span>' : '') + '</td><td class="l">' + (r.license ? esc(r.license) + (/strong|weak/.test(r.licenseClass) ? ' <span class="lic-f ' + r.licenseClass + '">' + (r.licenseClass === 'strong' ? 'copyleft' : 'weak copyleft') + '</span>' : '') : '–')
          + '</td><td>' + r.risk + '</td></tr>').join('') + '</tbody>';
      $('t-more').textContent = rows.length > 600 ? 'Showing 600 of ' + num(rows.length) + ' packages. The CSV has everything.' : rows.length ? '' : 'No packages match this filter.';
    };
    $('t-all').onclick = e => { const b = e.target.closest('button[data-k]'); if (!b) return; if (sortK === b.dataset.k) sortD = -sortD; else { sortK = b.dataset.k; sortD = /name|license|type/.test(sortK) ? 1 : -1; } draw(); };
    document.querySelectorAll('[data-flt]').forEach(b => b.addEventListener('click', () => { flt = b.dataset.flt; document.querySelectorAll('[data-flt]').forEach(x => x.setAttribute('aria-pressed', String(x === b))); draw(); }));
    draw();
    // CI
    const gradle = parsed.files.some(f => f.kind === 'gradle'), maven = parsed.files.some(f => f.kind === 'pom');
    const req = (parsed.files.find(f => f.kind === 'requirements') || {}).name;
    const texts = { wf: D.workflow(a.ecosystems, { requirements: req && /\.txt$/.test(req) ? req : 'requirements.txt' }), db: D.dependabot(a.ecosystems, { gradle, maven }) };
    let which = 'wf';
    const show = () => { $('ci-code').textContent = texts[which]; $('ci-tabs').querySelectorAll('[data-ci]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.ci === which))); };
    $('ci-tabs').addEventListener('click', e => { const b = e.target.closest('[data-ci]'); if (b) { which = b.dataset.ci; show(); } });
    $('ci-copy').addEventListener('click', () => copy(texts[which], 'ci-copied'));
    show();
    if ($('x-cmds')) $('x-cmds').addEventListener('click', () => copy(a.plan.filter(p => p.cmd).map(p => p.cmd).join('\n'), 'copied'));
    if ($('x-csv')) $('x-csv').addEventListener('click', () => download('dependency-risk.csv', D.toCSV(a), 'text/csv'));
    if ($('x-md')) $('x-md').addEventListener('click', () => download('dependency-risk.md', toMarkdown(a), 'text/markdown'));
  }

  async function copy(text, id) {
    try { await navigator.clipboard.writeText(text); $(id).textContent = 'Copied'; }
    catch (e) { $(id).textContent = 'Copy failed'; }
    setTimeout(() => { if ($(id)) $(id).textContent = ''; }, 2500);
  }
  function download(name, text, type) {
    const el = document.createElement('a');
    el.href = URL.createObjectURL(new Blob([text], { type: (type || 'text/plain') + ';charset=utf-8' }));
    el.download = name; document.body.appendChild(el); el.click(); el.remove();
    setTimeout(() => URL.revokeObjectURL(el.href), 2000);
  }
  function toMarkdown(a) {
    const c = a.counts;
    let md = '# Dependency risk report\n\n' + new Date().toLocaleDateString('en-AU') + ' · ' + c.packages + ' packages · risk score ' + a.score + '/100 (' + a.grade + ')\n\n'
      + '| Critical | High | Medium | Low/unrated | Deprecated | Major behind | Copyleft |\n|---|---|---|---|---|---|---|\n| ' + [c.critical, c.high, c.medium, c.low + c.unknown, c.deprecated, c.major, c.strong + c.weak].join(' | ') + ' |\n\n## Upgrade plan\n\n'
      + '| # | Package | From | To | Effort | Why |\n|---|---|---|---|---|---|\n' + a.plan.map((p, i) => '| ' + (i + 1) + ' | ' + p.name + ' | ' + p.from + ' | ' + (p.to || '–') + ' | ' + p.effort + ' | ' + p.why.replace(/\|/g, '/') + ' |').join('\n')
      + '\n\n## Commands\n\n```\n' + a.plan.filter(p => p.cmd).map(p => p.cmd).join('\n') + '\n```\n\n## Vulnerabilities\n\n'
      + a.rows.filter(r => r.vulns.length).map(r => '- **' + r.name + ' ' + r.version + '**: ' + r.vulns.map(v => (v.cve || v.id) + ' (' + v.severity + (v.fixed ? ', fixed in ' + v.fixed : ', no fix') + ')').join('; ')).join('\n')
      + '\n\n_Made with the free Dependency Risk Monitor: https://pawansinha.com.au/tools/dependency-risk/_\n';
    return md;
  }
})();
