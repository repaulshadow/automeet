'use strict';
const { app, BrowserWindow, Tray, Menu, Notification, dialog, ipcMain, nativeImage, powerSaveBlocker, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const L = require('./logic');
const { Store } = require('./store');
const { Engine } = require('./engine');

app.setName('AutoMeet Beta');
if (process.env.AUTOMEET_DATA_DIR) app.setPath('userData', process.env.AUTOMEET_DATA_DIR);
const IS_STARTUP = process.argv.includes('--startup');
const VERSION = app.getVersion();

if (!app.requestSingleInstanceLock()) { app.quit(); }

let win = null;
let tray = null;
let quitting = false;
let store, engine;
let blockerId = null;
const logTail = [];
let busyText = null;
let currentStatus = { phase: 'none' };

// ---------- діалоги через вікно застосунку ----------
const pending = new Map();
let askSeq = 0;
let askChain = Promise.resolve();

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}
function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/** Показує запитання у вікні. Повертає {value} або null (скасовано / час вийшов). */
function ask(spec) {
  const run = () => new Promise((resolve) => {
    const id = ++askSeq;
    let timer = null;
    const done = (v) => { clearTimeout(timer); pending.delete(id); resolve(v); };
    pending.set(id, done);
    showWindow();
    send('ask', { id, ...spec });
    if (spec.timeoutMs > 0) {
      timer = setTimeout(() => { send('ask-cancel', { id }); done(null); }, spec.timeoutMs);
    }
  });
  const p = askChain.then(run, run);
  askChain = p.catch(() => {});
  return p;
}
ipcMain.on('ask-reply', (_e, { id, value }) => {
  const done = pending.get(id);
  if (done) done(value === undefined || value === null ? null : { value });
});

function notify(text) {
  try {
    if (Notification.isSupported()) new Notification({ title: 'Auto Meet', body: text, silent: false }).show();
  } catch { /* не критично */ }
  store && store.log('[сповіщення] ' + text);
}
function setBusy(text) { busyText = text; send('busy', text); }

// ---------- автозапуск ----------
function autostartEnabled() {
  try {
    const s = process.platform === 'win32'
      ? app.getLoginItemSettings({ args: ['--startup'] }) : app.getLoginItemSettings();
    return !!s.openAtLogin;
  } catch { return false; }
}
function setAutostart(on) {
  try {
    app.setLoginItemSettings({ openAtLogin: on, args: ['--startup'] });
    return true;
  } catch (e) { store.log('Автозапуск: ' + e.message); return false; }
}

// ---------- сценарії ----------
function summaryText() {
  const st = store.state;
  const lines = [`Профіль: ${st.mode === 'teacher' ? 'викладач ' + st.surname : 'група ' + st.group}.`];
  const s = engine.currentStatus();
  if (s.target) {
    const when = s.dayOffset === 0 ? 'сьогодні' : s.dayOffset === 1 ? 'завтра' : s.dayDate;
    lines.push(`Найближча пара: №${s.pair} о ${s.startHM} (${when}) — ${s.label}.`);
    if (s.dayOffset === 0) lines.push(`Пар сьогодні лишилось: ${s.leftToday}.`);
  } else lines.push('Найближчим часом пар немає.');
  lines.push('Автозапуск: ' + (autostartEnabled() ? 'увімкнено' : 'вимкнено') + '.');
  const miss = (st.unmatched || []).length;
  if (miss) lines.push(`Пар без прив'язки до курсу Classroom: ${miss} (на них програма не заходитиме).`);
  if (st.mode === 'teacher') lines.push('Заміняєте чужу пару? Натисніть «Заміняю пару».');
  return lines.join('\n');
}

async function runSetup() {
  const sched = store.loadSchedule();
  if (!sched) { await ask({ kind: 'info', title: 'Немає розкладу', text: 'Не знайдено schedule.json. Перевірте інтернет і перезапустіть програму.' }); return false; }
  const role = await ask({
    kind: 'choose', title: 'Вітаємо в Auto Meet', text: 'Ви студент чи викладач?',
    items: [{ value: 'student', label: 'Студент' }, { value: 'teacher', label: 'Викладач' }], default: 'student', timeoutMs: 0,
  });
  if (!role) return false;
  const st = { mode: role.value, map: {}, last: {}, unmatched: [], saturdays: (store.state.saturdays || {}) };
  if (role.value === 'teacher') {
    const sn = await ask({ kind: 'text', title: 'Прізвище', text: 'Введіть своє прізвище так, як воно написано в розкладі:' });
    const surname = sn && sn.value && sn.value.trim();
    if (!surname) return false;
    if (!Object.keys(L.teacherSchedule(sched, surname)).length) {
      await ask({ kind: 'info', title: 'Нічого не знайдено', text: `За прізвищем «${surname}» у розкладі пар немає. Перевірте написання.` });
      return false;
    }
    st.surname = surname; st.teacherName = surname;
  } else {
    const g = await ask({ kind: 'group', title: 'Оберіть свою групу', groups: L.groupsByCourse(Object.keys(sched.groups)) });
    if (!g) return false;
    st.group = g.value;
  }
  store.state = st;
  store.save();
  engine.loadProfile();
  try {
    setBusy('Відкриваю Classroom. Якщо попросить, увійдіть у Google-акаунт у вікні браузера…');
    await engine.mapOptions(false);
  } catch (e) {
    setBusy(null);
    store.log('Налаштування: ' + e.message);
    await ask({ kind: 'info', title: 'Не вдалося зв\'язати курси', text: String(e.message) + '\n\nМожна повторити: Налаштування → Прив\'язати курси.' });
  }
  setBusy(null);
  if (!autostartEnabled()) {
    const a = await ask({
      kind: 'choose', title: 'Автозапуск',
      text: 'Питати при кожному вході в комп\'ютер, чи запускати Auto Meet? Нічого не запуститься без вашої згоди.',
      items: [{ value: 'yes', label: 'Так, питати' }, { value: 'no', label: 'Ні' }], default: 'yes', timeoutMs: 0,
    });
    if (a && a.value === 'yes') setAutostart(true);
  }
  begin();
  await ask({ kind: 'info', title: 'Готово!', text: summaryText() });
  return true;
}

async function runSubstitute() {
  if (!engine.sched) return;
  const sched = engine.sched;
  const g = await ask({ kind: 'group', title: 'Заміна: оберіть групу', groups: L.groupsByCourse(Object.keys(sched.groups)) });
  if (!g) return;
  const pairs = engine.upcomingPairsToday();
  if (!pairs.length) { await ask({ kind: 'info', title: 'Заміна', text: 'Сьогодні пари вже закінчились.' }); return; }
  const hm = (ms) => new Date(ms).toTimeString().slice(0, 5);
  const p = await ask({
    kind: 'choose', title: `${g.value}: яку пару ви заміняєте?`,
    items: pairs.map((x) => ({ value: x.pair, label: `${x.pair} пара — ${hm(x.start)}–${hm(x.end)}` })),
    default: pairs[0].pair, timeoutMs: 0,
  });
  if (!p) return;
  const pair = pairs.find((x) => x.pair === p.value);
  let courses;
  try {
    setBusy('Читаю курси Classroom…');
    courses = await engine.substituteCourses(g.value);
  } catch (e) {
    setBusy(null);
    await ask({ kind: 'info', title: 'Помилка', text: 'Не вдалося прочитати курси Classroom: ' + e.message });
    return;
  }
  setBusy(null);
  const c = await ask({
    kind: 'choose', title: `${g.value}, ${p.value} пара (${hm(pair.start)}). Який курс?`,
    items: courses.map((x, i) => ({ value: String(i), label: x.title })), timeoutMs: 0,
  });
  if (!c) return;
  const course = courses[+c.value];
  engine.addSubstitution({ group: g.value, pair: pair.pair, start: pair.start, end: pair.end, title: course.title, url: course.url });
}

async function runSettings() {
  for (;;) {
    const on = autostartEnabled();
    const r = await ask({
      kind: 'choose', title: 'Налаштування', text: `Auto Meet Beta ${VERSION}`,
      items: [
        { value: 'autostart', label: on ? 'Вимкнути автозапуск' : 'Увімкнути автозапуск' },
        { value: 'map', label: 'Прив\'язати курси Classroom ще раз' },
        { value: 'update', label: 'Перевірити оновлення розкладу' },
        { value: 'log', label: 'Відкрити журнал' },
        { value: 'reset', label: 'Змінити профіль (скинути налаштування)' },
      ], timeoutMs: 0,
    });
    if (!r) return;
    if (r.value === 'autostart') { setAutostart(!on); }
    else if (r.value === 'map') {
      try { setBusy('Читаю курси Classroom…'); store.state.unmatched = []; await engine.mapOptions(false); }
      catch (e) { await ask({ kind: 'info', title: 'Помилка', text: e.message }); }
      setBusy(null);
    } else if (r.value === 'update') {
      setBusy('Перевіряю оновлення…');
      const changed = await store.updateSchedule();
      setBusy(null);
      if (changed) { engine.loadProfile(); engine.mapOptions(true).catch(() => {}); }
      await ask({ kind: 'info', title: 'Розклад', text: changed ? 'Розклад оновлено.' : 'У вас актуальна версія розкладу.' });
    } else if (r.value === 'log') {
      shell.openPath(store.logFile);
    } else if (r.value === 'reset') {
      const ok = await ask({ kind: 'choose', title: 'Скинути налаштування?', text: 'Профіль і прив\'язки курсів буде видалено.',
        items: [{ value: 'yes', label: 'Так, скинути' }, { value: 'no', label: 'Ні' }], default: 'no', timeoutMs: 0 });
      if (ok && ok.value === 'yes') {
        engine.stop(); store.reset();
        await runSetup();
        return;
      }
    }
  }
}

function begin() {
  engine.loadProfile();
  if (blockerId == null) blockerId = powerSaveBlocker.start('prevent-app-suspension');
  engine.start();
}

// ---------- запуск ----------
async function startupGate() {
  if (!store.state.mode) return true;
  engine.loadProfile();
  if (L.pairsLeftToday(engine.sched, engine.mySched, new Date(), store.state.saturdays || {}, []) === false) return false;
  const r = await dialog.showMessageBox({
    type: 'question', title: 'Auto Meet', message: 'Запустити Auto Meet на сьогоднішні пари?',
    buttons: ['Так, запустити', 'Ні, не зараз', 'Більше не питати'], defaultId: 0, cancelId: 1,
  });
  if (r.response === 2) { setAutostart(false); notify('Автозапуск вимкнено. Запускайте програму вручну.'); return false; }
  return r.response === 0;
}

function createWindow() {
  win = new BrowserWindow({
    width: 560, height: 720, minWidth: 460, minHeight: 560, show: !IS_STARTUP,
    title: 'Auto Meet Beta', backgroundColor: '#0b0e16', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.on('close', (e) => { if (!quitting) { e.preventDefault(); win.hide(); } });
}

function createTray() {
  try {
    const img = nativeImage.createFromPath(path.join(__dirname, '..', 'build', 'tray.png'));
    tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
    tray.setToolTip('Auto Meet Beta');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Показати', click: showWindow },
      { label: 'Вийти', click: () => { quitting = true; app.quit(); } },
    ]));
    tray.on('click', showWindow);
  } catch (e) { store.log('Трей: ' + e.message); }
}

ipcMain.handle('init', () => ({
  version: VERSION, configured: !!store.state.mode, status: engine.currentStatus(),
  log: logTail.slice(-8), busy: busyText,
}));
ipcMain.handle('command', async (_e, name) => {
  if (name === 'substitute') await runSubstitute();
  else if (name === 'settings') await runSettings();
  else if (name === 'setup') await runSetup();
});

app.on('second-instance', showWindow);
app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => { /* працюємо у фоні (трей) */ });
app.on('activate', showWindow);

app.whenReady().then(async () => {
  store = new Store(app.getPath('userData'), (app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', '..')));
  const browsersDir = path.join(app.getPath('userData'), 'browsers');
  engine = new Engine(store, { ask, notify, browsersDir, nodeBinary: process.execPath });
  engine.on('log', (line) => { logTail.push(line); if (logTail.length > 50) logTail.shift(); send('log', line); });
  engine.on('status', (s) => { currentStatus = s; send('status', s); });
  engine.on('status-text', (t) => send('status-text', t));

  if (IS_STARTUP || process.argv.includes('--startup')) {
    if (!(await startupGate())) { quitting = true; app.quit(); return; }
  }
  createWindow();
  createTray();
  win.webContents.once('did-finish-load', async () => {
    store.updateSchedule().then((changed) => {
      if (changed && store.state.mode) { engine.loadProfile(); engine.mapOptions(true).catch(() => {}); }
    });
    if (store.state.mode) begin();
    else { showWindow(); await runSetup(); }
  });
});
