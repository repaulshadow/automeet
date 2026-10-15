// Перевірка рушія на макетних сторінках (без Google): запуск браузера, пошук посилання на Meet,
// вимкнення мікрофона/камери гарячими клавішами, натискання «Join now» і вихід по часу.
// Запуск: PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers xvfb-run -a node test/engine-smoke.js
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../src/store');
const { Engine } = require('../src/engine');

const events = [];
const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  if (req.url.startsWith('/course')) {
    res.end(`<html><body><a href="http://localhost:${server.address().port}/meet.google.com/abc">Meet</a></body></html>`);
  } else if (req.url.startsWith('/meet.google.com')) {
    res.end(`<html><body>
      <button id="mic" aria-label="Turn off microphone (ctrl + d)">mic</button>
      <button id="cam" aria-label="Turn off camera (ctrl + e)">cam</button>
      <button id="join">Join now</button>
      <script>
        document.addEventListener('keydown', (e) => {
          if (e.ctrlKey && e.key === 'd') { document.getElementById('mic').remove(); fetch('/ev?mic'); }
          if (e.ctrlKey && e.key === 'e') { document.getElementById('cam').remove(); fetch('/ev?cam'); }
        });
        document.getElementById('join').onclick = () => { fetch('/ev?joined');
          const b = document.createElement('button'); b.setAttribute('aria-label','Leave call'); b.textContent='leave';
          b.onclick = () => fetch('/ev?left'); document.body.append(b); document.getElementById('join').remove(); };
      </script></body></html>`);
  } else if (req.url.startsWith('/ev')) { events.push(req.url.slice(4)); res.end('ok'); }
  else res.end('');
});

(async () => {
  await new Promise((r) => server.listen(0, r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-eng-'));
  const store = new Store(dir, path.join(__dirname, '..', '..'));
  const engine = new Engine(store, {
    ask: async () => null, notify: (t) => console.log('NOTIFY', t),
    browsersDir: process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(dir, 'browsers'), nodeBinary: process.execPath,
  }, { id: 'p1', enabled: true, mode: 'student', group: 'КІ-31', map: {} });
  engine.browserCandidates = () => [[null, path.join(dir, 'prof')]];
  const end = Date.now() + 9000;
  await engine.attend('Тест', `http://localhost:${server.address().port}/course`, end);
  console.log('events:', events.join(','));
  const ok = ['mic', 'cam', 'joined', 'left'].every((e) => events.includes(e));
  await engine.shutdown();
  server.close();
  console.log(ok ? 'ENGINE OK' : 'ENGINE FAIL');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
