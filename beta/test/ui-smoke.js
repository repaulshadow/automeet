// Запуск: xvfb-run -a node test/ui-smoke.js  (перевіряє, що вікно відкривається, панель і діалоги працюють)
const { _electron: electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const os = require('os');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-'));
  const seeded = process.argv.includes('--seeded');
  const teacher = process.argv.includes('--teacher');
  if (seeded) fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ mode: 'teacher', surname: 'Мазур', teacherName: 'Мазур', map: {}, last: {}, unmatched: [] }));
  const app = await electron.launch({
    args: [path.join(__dirname, '..'), '--no-sandbox'],
    env: { ...process.env, AUTOMEET_DATA_DIR: dir },
  });
  const page = await app.firstWindow();
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE', m.text()); });
  await page.waitForTimeout(2500);
  const shots = process.env.SHOTS || '/tmp/am-test';
  if (teacher) {
    await page.getByRole('button', { name: 'Викладач', exact: true }).click();
    await page.getByRole('button', { name: 'OK' }).click();
    await page.waitForTimeout(500);
    console.log('teacher dialog:', await page.locator('#dialog h2').innerText());
    console.log('items:', (await page.locator('.list button').allInnerTexts()).length);
    await page.locator('#dialog input[type=search]').fill('пятн');
    console.log('filtered:', await page.locator('.list button').allInnerTexts());
    await page.screenshot({ path: (process.env.SHOTS || '/tmp/am-test') + '/6-teachers.png' });
  } else if (!seeded) {
    console.log('role dialog:', (await page.locator('#dialog h2').innerText()));
    await page.screenshot({ path: shots + '/1-role.png' });
    await page.getByRole('button', { name: 'Студент', exact: true }).click();
    await page.getByRole('button', { name: 'OK' }).click();
    await page.waitForTimeout(500);
    console.log('group dialog:', await page.locator('#dialog h2').innerText());
    await page.getByRole('button', { name: /3 курс/ }).click();
    await page.screenshot({ path: shots + '/2-groups.png' });
    console.log('chips:', await page.locator('.chips button').allInnerTexts());
    await page.locator('#dialog input[type=search]').fill('кі');
    console.log('filtered:', await page.locator('.chips button').allInnerTexts());
  } else {
    await page.waitForTimeout(1500);
    console.log('identity:', await page.locator('#identity').innerText());
    console.log('timer:', await page.locator('#timer').innerText());
    console.log('label:', await page.locator('#label').innerText());
    console.log('sub btn visible:', await page.locator('#subBtn').isVisible());
    await page.screenshot({ path: shots + '/3-dashboard.png' });
    await page.locator('#subBtn').click();
    await page.waitForTimeout(500);
    console.log('substitute dialog:', await page.locator('#dialog h2').innerText());
    await page.screenshot({ path: shots + '/4-substitute.png' });
    await page.keyboard.press('Escape');
    await page.locator('#settingsBtn').click();
    await page.waitForTimeout(400);
    console.log('settings items:', await page.locator('.list button').allInnerTexts());
    await page.screenshot({ path: shots + '/5-settings.png' });
  }
  await app.close();
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
