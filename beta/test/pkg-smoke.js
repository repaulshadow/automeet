// Запуск ПАКЕТОВАНОЇ програми (після electron-builder --dir): вікно, вбудований розклад, пошук Chromium, довідкова сторінка.
// Запуск: AUTOMEET_BROWSER_PATH=<chromium> xvfb-run -a node test/pkg-smoke.js <шлях до виконуваного файлу>
const { _electron: electron } = require('playwright-core');
const fs = require('fs'); const path = require('path'); const os = require('os');
const exe = process.argv[2];
const results = [];
const check = (n, ok, x = '') => { results.push(ok); console.log(`${ok ? 'OK  ' : 'FAIL'} ${n} ${x}`); };
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-pkg-'));
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ profiles: [{ id: 'p1', enabled: true, mode: 'student', group: 'КІ-31', map: {}, last: {}, unmatched: [] }], viewId: 'p1' }));
  const app = await electron.launch({ executablePath: exe, args: ['--no-sandbox'], env: { ...process.env, AUTOMEET_DATA_DIR: dir } });
  const page = await app.firstWindow();
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  await page.waitForTimeout(3500);
  check('вікно відкрилось, заголовок', (await page.title()).includes('Auto Meet'), await page.title());
  check('показано обліковий запис КІ-31', /КІ-31/.test(await page.locator('#identity').innerText().catch(() => '')));
  check('версія з package.json у налаштуваннях', true, await app.evaluate(({ app }) => app.getVersion()));
  await page.locator('#settingsBtn').click(); await page.waitForTimeout(400);
  check('налаштування: 6 плиток', (await page.locator('.tile').count()) === 6);
  await page.getByRole('button', { name: /Курси Classroom/ }).click();
  await page.waitForTimeout(12000); // запускається браузер (Chromium), довідкова сторінка копіюється в папку даних
  check('браузер запущено, довідкова сторінка скопійована з asar', fs.existsSync(path.join(dir, 'browser-home.html')));
  check('журнал пишеться', fs.existsSync(path.join(dir, 'auto_meet.log')) && /Браузер|Chromium|Chrome/.test(fs.readFileSync(path.join(dir, 'auto_meet.log'), 'utf8')), '');
  check('помилок у вікні немає', errs.length === 0, errs.join('; '));
  try { await app.close(); } catch { /* ok */ }
  const bad = results.filter((r) => !r).length;
  console.log(bad ? `PKG FAIL (${bad})` : 'PKG OK'); process.exit(bad ? 1 : 0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
