// Перший чистий запуск: вкладка Classroom потрапляє на рекламну сторінку, а вхід відкривається
// в НОВІЙ вкладці. Перевіряємо, що курси знаходяться в будь-якій вкладці.
// Запуск: AUTOMEET_BROWSER_PATH=<chromium> xvfb-run -a node test/scrape-smoke.js
const fs = require('fs'); const os = require('os'); const path = require('path');
const { Store } = require('../src/store');
const { Engine } = require('../src/engine');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-scr-'));
  const store = new Store(dir, path.join(__dirname, '..', '..'));
  const engine = new Engine(store, { ask: async () => null, notify: () => {}, browsersDir: dir, nodeBinary: process.execPath }, { id: 'p1', enabled: true, mode: 'student', group: 'КІ-31', map: {} });
  engine.browserCandidates = () => [[null, path.join(dir, 'prof')]];
  const ctx = await engine.acquire();
  let accountsHit = 0;
  await ctx.route('**/*', (route) => {
    const u = route.request().url();
    const html = (b) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: `<html><body>${b}</body></html>` });
    if (u.startsWith('https://classroom.google.com/u/0/h')) return u.endsWith('/h') ? route.fulfill({ status: 302, headers: { location: 'https://edu.google.com/market' } })
      : html('<a href="https://classroom.google.com/c/AAA111">КІ-31 Алгоритмизація\nМазур Г.В.</a><a href="https://classroom.google.com/c/BBB222">КІ-31 Комп.логіка\nМазур</a>');
    if (u.startsWith('https://edu.google.com')) return html('<h1>Where teaching and learning come together</h1>');
    if (u.startsWith('https://accounts.google.com')) { accountsHit++; return html('<h1>Увійдіть</h1>'); }
    return route.continue();
  });
  // «користувач» через 9 секунд завершує вхід у новій вкладці
  setTimeout(async () => { const p = await ctx.newPage(); await p.goto('https://classroom.google.com/u/0/h2'); }, 9000);
  engine.release();
  const courses = await engine.scrapeCourses(ctx, false);
  console.log('courses:', courses.map((c) => c.title));
  console.log('accounts redirect:', accountsHit > 0, ' pages left:', ctx.pages().length);
  const ok = courses.length === 2 && accountsHit > 0;
  await engine.shutdown();
  console.log(ok ? 'SCRAPE OK' : 'SCRAPE FAIL');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
