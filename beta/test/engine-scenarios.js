// Сценарії рушія на макеті Meet: звичайний вхід, затримка виходу, посилання з'являється не одразу,
// немає кнопки входу (повтори + одне повідомлення), мікрофон/камера не вимикаються.
// Запуск: AUTOMEET_BROWSER_PATH=<chromium> xvfb-run -a node test/engine-scenarios.js
const http = require('http'); const fs = require('fs'); const os = require('os'); const path = require('path');
const { Store } = require('../src/store');
const { Engine } = require('../src/engine');

let cfg = {}; let events = []; let courseHits = 0;
const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  const port = server.address().port;
  if (req.url.startsWith('/course')) {
    courseHits++;
    const hasLink = courseHits > (cfg.linkAfter || 0);
    res.end(`<html><body>${hasLink ? `<a href="http://localhost:${port}/meet.google.com/abc">Meet</a>` : 'Посилання ще немає'}</body></html>`);
  } else if (req.url.startsWith('/meet.google.com')) {
    res.end(`<html><body>
      <button id="mic" aria-label="Turn off microphone (ctrl + d)">mic</button>
      <button id="cam" aria-label="Turn off camera (ctrl + e)">cam</button>
      ${cfg.noJoin ? '' : '<button id="join">Join now</button>'}
      <script>
        document.addEventListener('keydown', (e) => {
          if (${cfg.stuckMic ? 'false' : 'true'} && e.ctrlKey && e.key === 'd') { document.getElementById('mic')?.remove(); fetch('/ev?mic'); }
          if (e.ctrlKey && e.key === 'e') { document.getElementById('cam')?.remove(); fetch('/ev?cam'); }
        });
        document.getElementById('join')?.addEventListener('click', () => { fetch('/ev?joined');
          const b = document.createElement('button'); b.setAttribute('aria-label','Leave call'); b.textContent='leave';
          b.onclick = () => fetch('/ev?left'); document.body.append(b); document.getElementById('join').remove(); });
      </script></body></html>`);
  } else if (req.url.startsWith('/ev')) { events.push([req.url.slice(4), Date.now()]); res.end('ok'); }
  else res.end('');
});

const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} ${extra}`); };
const has = (n) => events.some((e) => e[0] === n);

(async () => {
  await new Promise((r) => server.listen(0, r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-scn-'));
  const store = new Store(dir, path.join(__dirname, '..', '..'));
  const notes = [];
  const profile = { id: 'p1', enabled: true, mode: 'student', group: 'КІ-31', map: {} };
  store.state.profiles = [profile];
  const engine = new Engine(store, { ask: async () => null, notify: (t) => notes.push(t), browsersDir: dir, nodeBinary: process.execPath }, profile);
  engine.browserCandidates = () => [[null, path.join(dir, 'prof')]];
  engine.retryPauseMs = 400;
  const url = `http://localhost:${server.address().port}/course`;
  const reset = (c) => { cfg = c; events = []; courseHits = 0; notes.length = 0; };

  // 1. Звичайний вхід + затримка виходу 3 с після кінця
  reset({});
  engine.sched = { ...store.loadSchedule(), leave_after_min: 0.05 };
  let end = Date.now() + 5000;
  let ok = await engine.attendReliably('Тест 1', url, end);
  const left = events.find((e) => e[0] === 'left');
  check('звичайний вхід: mic, cam, joined, left', ok && ['mic', 'cam', 'joined', 'left'].every(has));
  check('вихід ПІСЛЯ кінця пари (+3 с)', left && left[1] >= end + 2500 && left[1] <= end + 6000, left ? `(+${left[1] - end} мс)` : '');
  check('жодних повідомлень про помилки', notes.length === 0);

  // 2. Нульова затримка → вихід у кінець
  reset({});
  engine.sched = { ...store.loadSchedule(), leave_after_min: 0 };
  end = Date.now() + 4000;
  ok = await engine.attendReliably('Тест 2', url, end);
  const l2 = events.find((e) => e[0] === 'left');
  check('leave_after_min=0: вихід у кінець пари', ok && l2 && l2[1] >= end - 300 && l2[1] <= end + 3000, l2 ? `(+${l2[1] - end} мс)` : '');

  // 3. Посилання на Meet з'являється не одразу → повторні спроби
  reset({ linkAfter: 1 });
  engine.sched = { ...store.loadSchedule(), leave_after_min: 0 };
  engine.linkWaitMs = 1500;
  end = Date.now() + 6 * 60000 + 8000; // >5 хв до кінця, щоб дозволені повтори; перерахуємо вихід нижче
  const p3 = engine.attendReliably('Тест 3', url, Date.now() + 6 * 60000);
  const t0 = Date.now();
  while (!has('joined') && Date.now() - t0 < 60000) await new Promise((r) => setTimeout(r, 200));
  check('посилання з’явилось з 2-ї спроби → зайшов', has('joined'), `(відвідувань курсу: ${courseHits})`);
  check('жодного повідомлення про невдачу', notes.length === 0);
  engine.sched = { ...engine.sched }; // вихід чекає кінця (6 хв) — завершуємо тест примусово
  await engine.shutdown(); void p3;

  // 4. Немає кнопки входу → повтори, одне повідомлення
  engine.ctx = null;
  reset({ noJoin: true });
  engine.sched = { ...store.loadSchedule(), leave_after_min: 0 };
  ok = await engine.attendReliably('Тест 4', url, Date.now() + 10 * 60000);
  check('немає кнопки входу: false + рівно одне повідомлення', ok === false && notes.length === 1 && /Не вдалося зайти/.test(notes[0]), JSON.stringify(notes));
  check('було кілька спроб (кілька відвідувань курсу)', courseHits >= 3, `(${courseHits})`);

  // 5. Остання спроба не робиться, якщо до кінця менше 5 хв
  reset({ noJoin: true });
  ok = await engine.attendReliably('Тест 5', url, Date.now() + 2 * 60000);
  check('до кінця <5 хв: одна спроба, без зайвих повторів', ok === false && courseHits === 1, `(${courseHits})`);

  // 6. Мікрофон не вимикається → повідомлення, але на пару заходить
  reset({ stuckMic: true });
  engine.sched = { ...store.loadSchedule(), leave_after_min: 0 };
  ok = await engine.attendReliably('Тест 6', url, Date.now() + 3000);
  check('мікрофон «завис»: сповіщення, але вхід відбувся', ok && has('joined') && notes.some((n) => /мікрофон/.test(n)), JSON.stringify(notes));

  await engine.shutdown(); server.close();
  const bad = results.filter((r) => !r).length;
  console.log(bad ? `SCENARIOS FAIL (${bad})` : 'SCENARIOS OK');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
