// Довідкова сторінка замість about:blank. Запуск: AUTOMEET_BROWSER_PATH=<chromium> xvfb-run -a node test/home-smoke.js
const fs = require('fs'); const os = require('os'); const path = require('path');
const { Store } = require('../src/store');
const { Engine } = require('../src/engine');
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-home-'));
  const store = new Store(dir, path.join(__dirname, '..', '..'));
  const engine = new Engine(store, { ask: async () => null, notify: () => {}, browsersDir: dir, nodeBinary: process.execPath },
    { id: 'p1', enabled: true, mode: 'student', group: 'КІ-31', map: {} });
  engine.sched = store.loadSchedule();
  engine.mySched = { 1: { 1: 'Тест А', 2: 'Тест Б' } };
  engine.browserCandidates = () => [[null, path.join(dir, 'prof')]];
  const ctx = await engine.acquire();
  await new Promise((r) => setTimeout(r, 2500));
  const pg = ctx.pages()[0];
  const url = pg.url();
  console.log('url:', url.slice(0, 60));
  console.log('title:', await pg.title(), '| who:', await pg.locator('#who').innerText());
  await pg.screenshot({ path: (process.env.SHOTS || '/tmp/am-test') + '/8-browser-home.png' });
  await engine.shutdown();
  const ok = url.startsWith('file://') && (await Promise.resolve(true));
  console.log(ok ? 'HOME OK' : 'HOME FAIL'); process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
