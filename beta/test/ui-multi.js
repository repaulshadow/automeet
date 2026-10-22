// UI: багато облікових записів (ліміт 5, перемикання, галочка «Працює», перейменування, видалення).
// Запуск: AUTOMEET_BROWSER_PATH=<chromium> xvfb-run -a node test/ui-multi.js
const { _electron: electron } = require('playwright-core');
const fs = require('fs'); const path = require('path'); const os = require('os');
const results = [];
const check = (n, ok, x = '') => { results.push(ok); console.log(`${ok ? 'OK  ' : 'FAIL'} ${n} ${x}`); };

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-multi-'));
  const prof = (id, extra) => ({ id, enabled: false, map: {}, last: {}, unmatched: [], ...extra });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ viewId: 'p1', profiles: [
    prof('p1', { mode: 'student', group: 'КІ-31' }), prof('p2', { mode: 'student', group: 'АС-31' }),
    prof('p3', { mode: 'teacher', surname: 'Мазур', teacherName: 'Мазур Г.В.' }), prof('p4', { mode: 'student', group: 'ТЕ-11' }),
    prof('p5', { mode: 'student', group: 'КІ-31' }) ] }));
  const app = await electron.launch({ args: [path.join(__dirname, '..'), '--no-sandbox'], env: { ...process.env, AUTOMEET_DATA_DIR: dir } });
  const page = await app.firstWindow();
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  await page.waitForTimeout(2500);
  const state = () => JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));

  await page.locator('#acctBtn').click(); await page.waitForTimeout(300);
  check('5 рядків у меню акаунтів', (await page.locator('#acctMenu .row').count()) === 5);
  check('кнопка «Додати» вимкнена (5/5)', await page.locator('#acctMenu .add').isDisabled(), await page.locator('#acctMenu .add').innerText());
  const names = await page.locator('#acctMenu .row .who b').allInnerTexts();
  check('однакові групи розрізняються номером', names.filter((n) => n.startsWith('КІ-31')).length === 2 && new Set(names).size === 5, JSON.stringify(names));

  // перемикання перегляду на 3-й запис (викладач)
  await page.locator('#acctMenu .row .who').nth(2).click(); await page.waitForTimeout(600);
  check('шапка показує вибраний акаунт', /Мазур/.test(await page.locator('#acctName').innerText()), await page.locator('#acctName').innerText());
  check('viewId збережено', state().viewId === 'p3');

  // галочка «Працює» для двох акаунтів
  if (!(await page.locator('#acctMenu').isVisible())) await page.locator('#acctBtn').click();
  await page.locator('#acctMenu .row input[type=checkbox]').nth(0).check();
  await page.locator('#acctMenu .row input[type=checkbox]').nth(2).check();
  await page.waitForTimeout(800);
  const en = state().profiles.map((p) => p.enabled);
  check('два акаунти увімкнено одночасно', JSON.stringify(en) === JSON.stringify([true, false, true, false, false]), JSON.stringify(en));
  await page.locator('#acctMenu .row input[type=checkbox]').nth(0).uncheck(); await page.waitForTimeout(500);
  check('вимкнення знімає галочку у стані', state().profiles[0].enabled === false);

  // перейменування
  await page.locator('#acctMenu .row .mini').nth(0).click(); await page.waitForTimeout(500);
  check('діалог перейменування', (await page.locator('#dialog h2').innerText()).includes('Назва'));
  await page.locator('#dialog input[type=text]').fill('Син'); await page.getByRole('button', { name: 'OK' }).click(); await page.waitForTimeout(600);
  check('нова назва збережена', state().profiles[0].label === 'Син');

  // видалення з підтвердженням
  await page.locator('#acctBtn').click(); await page.waitForTimeout(300);
  await page.locator('#acctMenu .row .mini').nth(3).click(); await page.waitForTimeout(500); // ✕ першого рядка
  check('запит підтвердження видалення', (await page.locator('#dialog h2').innerText()).includes('Видалити'));
  await page.getByRole('button', { name: 'Ні', exact: true }).click(); await page.getByRole('button', { name: 'OK', exact: true }).click(); await page.waitForTimeout(400);
  check('«Ні» нічого не видаляє', state().profiles.length === 5);
  await page.locator('#acctBtn').click(); await page.waitForTimeout(300);
  await page.locator('#acctMenu .row .mini').nth(3).click(); await page.waitForTimeout(400);
  await page.getByRole('button', { name: 'Так, видалити' }).click(); await page.getByRole('button', { name: 'OK', exact: true }).click(); await page.waitForTimeout(800);
  check('«Так» видаляє рівно один запис', state().profiles.length === 4);
  await page.locator('#acctBtn').click(); await page.waitForTimeout(300);
  check('«Додати» знову доступна (4/5)', await page.locator('#acctMenu .add').isEnabled());
  await page.screenshot({ path: (process.env.SHOTS || '/tmp/am-test') + '/11-multi.png' });

  check('помилок у вікні немає', errs.length === 0, errs.join('; '));
  await app.close();
  const bad = results.filter((r) => !r).length;
  console.log(bad ? `UI-MULTI FAIL (${bad})` : 'UI-MULTI OK');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
