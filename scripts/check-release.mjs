// Checks the things Obsidian's community store requires, and that a human
// reviewer would otherwise catch for us.
//
// This exists because all three of these were missing at once and none of them
// fails a build: there was no LICENSE, no versions.json, and a 647-character
// description against a 250 limit. A description in particular is the kind of
// thing that grows back — it is prose, nobody counts it, and it is only read
// by a reviewer months later. So it is asserted in CI instead.
//
// Run with `npm run check:release`. Requires `npm run build` first, since it
// also checks the three files the store actually installs.

import fs from 'node:fs';
let fail = 0;
const ok = (n, c, extra='') => { console.log((c ? '  ok  ' : 'FAIL  ') + n + (c ? '' : '  ' + extra)); if (!c) fail++; };
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

console.log('== manifest.json ==');
const m = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
for (const k of ['id','name','version','minAppVersion','description','author','isDesktopOnly'])
  ok(`has ${k}`, m[k] !== undefined);
ok('version is semver', SEMVER.test(m.version), m.version);
ok('minAppVersion is semver', SEMVER.test(m.minAppVersion), m.minAppVersion);
// Letters and hyphens ONLY — no digits. The submission form rejected
// `gemma4-litert-wiki` for the 4; this check had allowed [0-9] and let it
// through to the dashboard.
ok('id is lowercase letters/hyphens only (no digits)', /^[a-z-]+$/.test(m.id), m.id);
ok('id has no "obsidian"', !/obsidian/i.test(m.id));
ok('id does not end with "plugin"', !/plugin$/.test(m.id), m.id);
ok('name has no "Obsidian"', !/obsidian/i.test(m.name), m.name);
ok('name has no "Plugin"', !/plugin/i.test(m.name));
ok(`description <= 250 (is ${m.description.length})`, m.description.length <= 250);
ok('description is one line', !/[\r\n]/.test(m.description));
ok('description does not open with "A plugin"/"This plugin"', !/^(a |this )?plugin/i.test(m.description.trim()));
// The directory rejects it outright: the word is implied by the context of a
// plugin directory, and the automated review fails the release over it.
ok('description does not say "Obsidian"', !/obsidian/i.test(m.description));
ok('name does not say "Obsidian"', !/obsidian/i.test(m.name));
ok('isDesktopOnly true (uses node fs + local server)', m.isDesktopOnly === true);

console.log('\n== versions.json ==');
ok('exists', fs.existsSync('versions.json'));
const v = JSON.parse(fs.readFileSync('versions.json', 'utf8'));
ok('manifest.version is listed', v[m.version] !== undefined, Object.keys(v).join(','));
ok('maps to manifest.minAppVersion', v[m.version] === m.minAppVersion);
ok('every key is semver', Object.keys(v).every(k => SEMVER.test(k)));
ok('every value is semver', Object.values(v).every(x => SEMVER.test(x)));

console.log('\n== LICENSE ==');
ok('exists', fs.existsSync('LICENSE'));
const lic = fs.readFileSync('LICENSE', 'utf8');
ok('non-empty', lic.trim().length > 400);
ok('names a licence', /MIT License/.test(lic));
ok('has a copyright holder', /Copyright \(c\) \d{4} \S+/.test(lic));
ok('package.json declares the same', JSON.parse(fs.readFileSync('package.json','utf8')).license === 'MIT');

console.log('\n== release payload (the three files the store installs) ==');
for (const f of ['main.js','manifest.json','styles.css']) {
  const there = fs.existsSync(f);
  ok(`${f} present${there ? ` (${(fs.statSync(f).size/1024).toFixed(0)} KB)` : ''}`, there);
}
ok('main.js is a real bundle', fs.statSync('main.js').size > 100_000);
// A wasm/ directory on disk is fine — in a dev checkout the plugin folder IS
// the repo, so the runtime's on-demand download lands here. What must never
// happen is git carrying it into a release.
{
  const { execSync } = await import('node:child_process');
  const tracked = execSync('git ls-files wasm', { encoding: 'utf8' }).trim();
  ok('git does not carry wasm/', tracked === '');
}


// Everything that carries a version has to agree, or the store installs one
// version's manifest beside another version's code. package-lock carries it
// twice (root and packages[""]) and `npm version` is the only thing that
// normally keeps them in step; we do not use it, so this is the guard.
console.log('\n== version agreement ==');
{
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
  ok('package.json matches manifest', pkg.version === m.version, `${pkg.version} vs ${m.version}`);
  ok('package-lock root matches', lock.version === m.version, `${lock.version}`);
  ok('package-lock packages[""] matches', lock.packages?.['']?.version === m.version);
  ok('CHANGELOG has an entry for this version', /^## \[?\d/m.test(fs.readFileSync('CHANGELOG.md','utf8'))
    && fs.readFileSync('CHANGELOG.md','utf8').includes(m.version));
  // Set by the release workflow from the pushed tag. A tag that disagrees with
  // the manifest is the one release mistake Obsidian cannot recover from: it
  // fetches assets by tag name and reads the version from the manifest.
  if (process.env.RELEASE_TAG)
    ok('git tag matches manifest version', process.env.RELEASE_TAG === m.version,
       `tag ${process.env.RELEASE_TAG} vs manifest ${m.version}`);
}

// The rules Obsidian's automated review scans source for. Each of these is
// cheap to check and expensive to be told about after submission.
console.log('\n== plugin guidelines ==');
{
  const srcFiles = fs.readdirSync('src').filter((f) => f.endsWith('.ts'));
  const src = srcFiles.map((f) => [f, fs.readFileSync(`src/${f}`, 'utf8')]);
  const hits = (re) => src.filter(([, t]) => re.test(t)).map(([f]) => f);

  const html = hits(/\b(innerHTML|outerHTML|insertAdjacentHTML)\b/);
  ok('no innerHTML/outerHTML/insertAdjacentHTML', html.length === 0, html.join(', '));

  // `app` as a bare global is deprecated; every use must go through this.app
  // or an App passed in. Matches `app.` not preceded by a word char or dot.
  const globalApp = hits(/(?<![\w.])app\.(vault|workspace|metadataCache)/);
  const declaresApp = (t) => /\bapp\s*:\s*App\b/.test(t) || /\bapp\s*=\s*/.test(t);
  const badApp = globalApp.filter((f) => !declaresApp(src.find(([n]) => n === f)[1]));
  ok('no global `app` object', badApp.length === 0, badApp.join(', '));

  const evals = hits(/\beval\s*\(|new Function\s*\(|child_process/);
  ok('no eval / new Function / child_process', evals.length === 0, evals.join(', '));

  // Network hosts must be disclosed in the README, and there must be no host
  // we forgot to write down. Reviewers check the README against the source, so
  // a host that reaches the code without reaching the README is a rejection.
  //
  // Comments are stripped first, and `xmlns` is skipped: an SVG namespace is a
  // URI, not an address anything is fetched from. Without that this fires on
  // http://www.w3.org/2000/svg and a URL inside an explanatory comment, and a
  // check that cries wolf gets an allowlist bolted on until it checks nothing.
  const readme = fs.readFileSync('README.md', 'utf8');
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const hosts = new Set(
    src.flatMap(([, t]) =>
      [...strip(t).matchAll(/(xmlns="?)?https?:\/\/([a-z0-9.-]+)/gi)]
        .filter((x) => !x[1])
        .map((x) => x[2].toLowerCase())
    )
  );
  const undisclosed = [...hosts].filter((h) => !readme.includes(h) && !h.endsWith('github.com'));
  ok(`every network host in src/ is named in the README (${hosts.size} found)`,
     undisclosed.length === 0, undisclosed.join(', '));

  // Policy: a plugin may not update itself. The CDN version is fixed at build
  // time from the installed dependency, which is what makes that true here.
  const wasmStore = fs.readFileSync('src/wasm-store.ts', 'utf8');
  ok('runtime CDN version is pinned at build time', /__LITERT_VERSION__/.test(wasmStore));
  ok('runtime download is filename-allowlisted', /ALLOWED\s*=\s*\/\^/.test(wasmStore));

  ok('registered resources are released on unload',
     /onunload\s*\(/.test(fs.readFileSync('src/main.ts', 'utf8')));

  // An Error in the store's review blocks installation, and this is the one
  // that stood: the check is static, so it fires on the string being present
  // in the bundle whether or not the branch can ever run. The vendor loader
  // is replaced at build time (build.js alias → src/wasm-loader.ts); this
  // asserts the replacement actually took.
  const bundle = fs.readFileSync('main.js', 'utf8');
  ok('bundle creates no <script> element', !/createElement\(\s*["']script["']\s*\)/.test(bundle));
  ok('bundle assigns no script.src', !/script\.src\s*=/.test(bundle));
  ok('the script-free WASM loader is the one that shipped',
     bundle.includes('The WASM script resolver was not installed'));
}

// The command table in the README is the first thing a reviewer compares
// against the palette. It drifted once already, when five commands became one.
//
// Both directions are checked, because they fail differently. A command
// missing from the README is a gap a reviewer asks about; a README row naming
// a command that no longer exists is an instruction that does not work, and
// that is the one that shipped.
console.log('\n== README matches the code ==');
{
  const mainTs = fs.readFileSync('src/main.ts', 'utf8');
  const cmds = [...mainTs.matchAll(/name: '([^']+)',/g)].map((x) => x[1]);
  const live = new Set(cmds);

  // Only the `| Command | ... |` tables are read. The README has other tables
  // with a bold first column, and counting those would make the second check
  // fire on every one of their rows.
  const commandTableRows = (markdown) => {
    const rows = [];
    let inTable = false;
    for (const line of markdown.split('\n')) {
      if (/^\|\s*(Command|コマンド)\s*\|/.test(line)) { inTable = true; continue; }
      if (!inTable) continue;
      if (!line.startsWith('|')) { inTable = false; continue; }
      if (/^\|[\s\-|]+\|$/.test(line)) continue;
      const m = line.match(/^\|\s*\*\*([^*]+)\*\*/);
      if (m) rows.push(m[1].trim());
    }
    return rows;
  };

  for (const file of ['README.md', 'README.ja.md']) {
    const rows = commandTableRows(fs.readFileSync(file, 'utf8'));
    // A parser that matched nothing would pass both checks silently.
    ok(`${file} has a command table`, rows.length >= 10, `${rows.length} rows`);
    const undocumented = cmds.filter((c) => !rows.includes(c));
    ok(`${file}: every command is documented (${cmds.length} commands)`,
       undocumented.length === 0, undocumented.join(' | '));
    const dead = rows.filter((r) => !live.has(r));
    ok(`${file}: every documented command exists`, dead.length === 0, dead.join(' | '));
  }
}

console.log(fail ? `\n${fail} FAILURE(S)` : '\nALL PASS');
process.exit(fail ? 1 : 0);
