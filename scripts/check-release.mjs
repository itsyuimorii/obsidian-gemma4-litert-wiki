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
ok('id is lowercase/hyphen only', /^[a-z0-9-]+$/.test(m.id), m.id);
ok('id has no "obsidian"', !/obsidian/i.test(m.id));
ok('name has no "Obsidian"', !/obsidian/i.test(m.name), m.name);
ok('name has no "Plugin"', !/plugin/i.test(m.name));
ok(`description <= 250 (is ${m.description.length})`, m.description.length <= 250);
ok('description is one line', !/[\r\n]/.test(m.description));
ok('description does not open with "A plugin"/"This plugin"', !/^(a |this )?plugin/i.test(m.description.trim()));
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
ok('no wasm/ produced by the build', !fs.existsSync('wasm'));

console.log(fail ? `\n${fail} FAILURE(S)` : '\nALL PASS');
process.exit(fail ? 1 : 0);
