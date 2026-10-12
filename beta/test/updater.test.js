'use strict';
const test = require('node:test');
const assert = require('node:assert');
const U = require('../src/updater');

test('порівняння версій', () => {
  const c = U.compareVersions;
  assert.strictEqual(c('0.1.0', '0.1.0'), 0);
  assert.strictEqual(c('0.2.0', '0.1.9'), 1);
  assert.strictEqual(c('1.0.0', '1.0.0-beta.5'), 1);       // реліз новіший за бету
  assert.strictEqual(c('0.1.0-beta.2', '0.1.0-beta.10'), -1);
  assert.strictEqual(c('v0.1.0-beta.2', '0.1.0-beta.1'), 1);
  assert.strictEqual(c('0.1.0-beta.1', '0.1.0-beta'), 1);
});

const rels = [
  { tag_name: 'v0.2.0-beta.1', prerelease: true, draft: false, html_url: 'p1', body: 'нове', assets: [
    { name: 'AutoMeet-Windows.exe', browser_download_url: 'https://x/win.exe' },
    { name: 'AutoMeet-macOS-arm64.dmg', browser_download_url: 'https://x/arm.dmg' },
    { name: 'AutoMeet-macOS-intel.dmg', browser_download_url: 'https://x/intel.dmg' }] },
  { tag_name: 'v0.1.0', prerelease: false, draft: false, html_url: 'p0', assets: [] },
  { tag_name: 'v0.9.0', prerelease: false, draft: true, html_url: 'pd', assets: [] },
];
const fakeFetch = (data) => async () => ({ ok: true, json: async () => data });

test('бета-користувач бачить пре-реліз і отримує файл під свою систему', async () => {
  const w = await U.checkAppUpdate('0.1.0-beta.1', { platform: 'win32', arch: 'x64', fetchImpl: fakeFetch(rels) });
  assert.strictEqual(w.version, '0.2.0-beta.1');
  assert.strictEqual(w.url, 'https://x/win.exe');
  const m = await U.checkAppUpdate('0.1.0-beta.1', { platform: 'darwin', arch: 'x64', fetchImpl: fakeFetch(rels) });
  assert.strictEqual(m.url, 'https://x/intel.dmg');
  const a = await U.checkAppUpdate('0.1.0-beta.1', { platform: 'darwin', arch: 'arm64', fetchImpl: fakeFetch(rels) });
  assert.strictEqual(a.url, 'https://x/arm.dmg');
});
test('стабільний користувач не бачить пре-релізів і чернеток', async () => {
  assert.strictEqual(await U.checkAppUpdate('0.1.0', { platform: 'win32', arch: 'x64', fetchImpl: fakeFetch(rels) }), null);
});
test('актуальна версія → null; без файлу → сторінка релізу', async () => {
  assert.strictEqual(await U.checkAppUpdate('0.2.0-beta.1', { platform: 'win32', arch: 'x64', fetchImpl: fakeFetch(rels) }), null);
  const r = await U.checkAppUpdate('0.0.1', { platform: 'win32', arch: 'x64', fetchImpl: fakeFetch([rels[1]]) });
  assert.strictEqual(r.url, 'p0');
  assert.strictEqual(r.direct, false);
});
