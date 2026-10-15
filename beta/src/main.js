'use strict';
const { app, BrowserWindow, Tray, Menu, Notification, dialog, ipcMain, nativeImage, powerSaveBlocker, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const L = require('./logic');
const { Store } = require('./store');
const { Engine, cleanError } = require('./engine');
const { checkAppUpdate, isTrustedUrl } = require('./updater');
const { UPDATE_CHECK_MS } = require('./store');
const cfg = require('./config');

app.setName('AutoMeet Beta');
if (process.env.AUTOMEET_DATA_DIR) app.setPath('userData', process.env.AUTOMEET_DATA_DIR);
const IS_STARTUP = process.argv.includes('--startup');
const VERSION = app.getVersion();

if (!app.requestSingleInstanceLock()) { app.quit(); }

let win = null;
let tray = null;
let quitting = false;
let store;
const engines = new Map(); // id облікового запису -> Engine
let viewId = null;               // який обліковий запис показано на панелі
const statuses = new Map();      // id -> останній статус
const MAX_ACCOUNTS = 5;
let blockerId = null;
const logTail = [];
let busyText = null;

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

// ---------- облікові записи ----------
function getEngine(id = viewId) { return engines.get(id) || null; }

function ensureEngine(p) {
  let e = engines.get(p.id);
  if (e) return e;
  const browsersDir = path.join(app.getPath('userData'), 'browsers');
  e = new Engine(store, { ask, notify, browsersDir, nodeBinary: process.execPath }, p);
  e.on('log', (line) => { logTail.push(line); if (logTail.length > 50) logTail.shift(); send('log', line); });
  e.on('status', (st) => { statuses.set(p.id, st); pushStatus(); });
  e.on('status-text', ({ id, text }) => { if (id === viewId) send('status-text', text); });
  engines.set(p.id, e);
  return e;
}

function describe(p) {
  const who = p.mode === 'teacher' ? 'викладач' : 'студент';
  const detail = p.mode === 'teacher' ? '' : ` · ${p.group}`;
  return `${who}${detail}`;
}
function accountsPayload() {
  return {
    max: MAX_ACCOUNTS, viewId,
    accounts: store.profiles.map((p) => ({
      id: p.id, name: store.profileName(p), sub: describe(p), mode: p.mode, enabled: !!p.enabled, viewing: p.id === viewId,
    })),
  };
}
function sendAccounts() { send('accounts', accountsPayload()); }

/** Короткий опис наступної пари для інших активних облікових записів. */
function othersLine() {
  const out = [];
  for (const p of store.profiles) {
    if (p.id === viewId || !p.enabled) continue;
    const st = statuses.get(p.id);
    let line = 'пар найближчим часом немає';
    if (st && st.target) {
      const when = st.dayOffset === 0 ? '' : st.dayOffset === 1 ? 'завтра, ' : st.dayDate + ', ';
      line = `${st.phase === 'during' ? 'йде' : 'далі'} №${st.pair} · ${when}${st.startHM}–${st.endHM} · ${st.label}`;
    }
    out.push({ name: store.profileName(p), line });
  }
  return out;
}
function pushStatus() {
  const e = getEngine();
  const st = e ? (statuses.get(viewId) || e.currentStatus()) : { phase: 'none' };
  send('status', { ...st, others: othersLine() });
}

function anyEnabled() { return store.profiles.some((p) => p.enabled); }

/** Запускає рушії ввімкнених облікових записів і зупиняє вимкнені. */
function begin() {
  if (!store.profiles.length) return;
  if (!store.getProfile(viewId)) viewId = store.state.viewId && store.getProfile(store.state.viewId) ? store.state.viewId : store.profiles[0].id;
  for (const p of store.profiles) {
    const e = ensureEngine(p);
    e.p = p;
    e.loadProfile();
    if (p.enabled) { if (!e.timer) e.start(); }
    else { e.stop(); e.shutdown().catch(() => {}); statuses.delete(p.id); }
  }
  if (anyEnabled()) { if (blockerId == null) blockerId = powerSaveBlocker.start('prevent-app-suspension'); }
  else if (blockerId != null) { powerSaveBlocker.stop(blockerId); blockerId = null; }
  sendAccounts();
  pushStatus();
}

async function removeAccount(id) {
  const e = engines.get(id);
  if (e) { e.stop(); await e.shutdown().catch(() => {}); engines.delete(id); }
  statuses.delete(id);
  store.removeProfile(id);
  if (viewId === id) viewId = (store.profiles[0] || {}).id || null;
  store.state.viewId = viewId;
  store.save();
  begin();
}

async function confirmAndRemove(id) {
  const p = store.getProfile(id);
  if (!p) return;
  const ok = await ask({
    kind: 'choose', title: 'Видалити обліковий запис?',
    text: `«${store.profileName(p)}»: налаштування й вхід у Google для нього буде видалено з цієї програми.`,
    items: [{ value: 'yes', label: 'Так, видалити' }, { value: 'no', label: 'Ні' }], default: 'no', timeoutMs: 0,
  });
  if (!ok || ok.value !== 'yes') return;
  await removeAccount(id);
  if (!store.profiles.length) await runSetup(null);
}

// ---------- сценарії ----------
function summaryText(p) {
  const e = getEngine(p.id);
  const lines = [`Обліковий запис: ${store.profileName(p)} (${p.mode === 'teacher' ? 'викладач' : 'група ' + p.group}).`];
  const s = e.currentStatus();
  if (s.target) {
    const when = s.dayOffset === 0 ? 'сьогодні' : s.dayOffset === 1 ? 'завтра' : s.dayDate;
    lines.push(`Найближча пара: №${s.pair} о ${s.startHM} (${when}) — ${s.label}.`);
    if (s.dayOffset === 0) lines.push(`Пар сьогодні лишилось: ${s.leftToday}.`);
  } else lines.push('Найближчим часом пар немає.');
  lines.push('Автозапуск: ' + (autostartEnabled() ? 'увімкнено' : 'вимкнено') + '.');
  const miss = (p.unmatched || []).length;
  if (miss) lines.push(`Пар без прив'язки до курсу Classroom: ${miss} (на них програма не заходитиме).`);
  if (p.mode === 'teacher') lines.push('Заміняєте чужу пару? Натисніть «Заміняю пару».');
  lines.push('Інші облікові записи можна додати й увімкнути в меню вгорі праворуч.');
  return lines.join('\n');
}

/** Налаштування облікового запису. id=null: новий; id існує: перенастроїти. */
async function runSetup(id) {
  const sched = store.loadSchedule();
  if (!sched) { await ask({ kind: 'info', title: 'Немає розкладу', text: 'Не знайдено schedule.json. Перевірте інтернет і перезапустіть програму.' }); return false; }
  if (!id && store.profiles.length >= MAX_ACCOUNTS) {
    await ask({ kind: 'info', title: 'Ліміт', text: `Можна додати до ${MAX_ACCOUNTS} облікових записів. Видаліть непотрібний.` });
    return false;
  }
  const first = store.profiles.length === 0;
  const role = await ask({
    kind: 'choose', title: first ? 'Вітаємо в Auto Meet' : 'Новий обліковий запис', text: 'Це студент чи викладач?',
    items: [{ value: 'student', label: 'Студент' }, { value: 'teacher', label: 'Викладач' }], default: 'student', timeoutMs: 0,
  });
  if (!role) return false;
  const data = { mode: role.value, map: {}, last: {}, unmatched: [], weekPattern: {} };
  if (role.value === 'teacher') {
    const dir = L.buildTeacherDirectory(sched);
    const MANUAL = 'manual';
    const items = dir.map((t) => ({ value: t.id, label: `${t.name}  ·  ${t.pairs} у розкладі` }));
    items.push({ value: MANUAL, label: 'Мого прізвища немає в списку (ввести вручну)', sticky: true });
    const pick = await ask({ kind: 'choose', title: 'Оберіть себе в списку викладачів', text: 'Можна друкувати для пошуку.', items, timeoutMs: 0 });
    if (!pick) return false;
    let surname, aliases;
    if (pick.value === MANUAL) {
      const sn = await ask({ kind: 'text', title: 'Прізвище', text: 'Введіть своє прізвище так, як воно написано в розкладі:' });
      surname = sn && sn.value && sn.value.trim();
      if (!surname) return false;
      const known = L.findTeacher(dir, surname); // раптом воно є в списку під іншим написанням
      aliases = known ? known.aliases : [surname];
      if (known) surname = known.surname;
    } else {
      const t = dir.find((x) => x.id === pick.value);
      surname = t.surname; aliases = t.aliases;
    }
    if (!Object.keys(L.teacherSchedule(sched, aliases)).length) {
      await ask({ kind: 'info', title: 'Нічого не знайдено', text: `За прізвищем «${surname}» у розкладі пар немає. Перевірте написання.` });
      return false;
    }
    data.surname = surname; data.teacherName = surname; data.aliases = aliases;
  } else {
    const g = await ask({ kind: 'group', title: 'Оберіть групу', groups: L.groupsByCourse(Object.keys(sched.groups)) });
    if (!g) return false;
    data.group = g.value;
  }

  let p = id ? store.getProfile(id) : null;
  if (p) {
    for (const k of ['group', 'surname', 'teacherName', 'aliases']) delete p[k];
    Object.assign(p, data);
  } else {
    p = { id: store.newProfileId(), enabled: true, ...data };
    store.profiles.push(p);
  }
  viewId = p.id;
  store.state.viewId = p.id;
  store.save();
  const e = ensureEngine(p);
  e.p = p;
  e.loadProfile();
  sendAccounts();
  try {
    setBusy(first ? 'Відкриваю Classroom. Якщо попросить, увійдіть у Google-акаунт у вікні браузера…'
      : `Відкриваю Classroom для «${store.profileName(p)}». Увійдіть у Google-акаунт ЦЬОГО користувача у вікні браузера…`);
    await e.mapOptions(false);
  } catch (err) {
    setBusy(null);
    store.log('Налаштування: ' + err.message);
    await ask({ kind: 'info', title: 'Не вдалося зв\'язати курси', text: cleanError(err) + '\n\nМожна повторити: Налаштування → Прив\'язати курси.' });
  }
  setBusy(null);
  if (!autostartEnabled() && first) {
    const a = await ask({
      kind: 'choose', title: 'Автозапуск',
      text: 'Питати при кожному вході в комп\'ютер, чи запускати Auto Meet? Нічого не запуститься без вашої згоди.',
      items: [{ value: 'yes', label: 'Так, питати' }, { value: 'no', label: 'Ні' }], default: 'yes', timeoutMs: 0,
    });
    if (a && a.value === 'yes') setAutostart(true);
  }
  begin();
  await ask({ kind: 'info', title: 'Готово!', text: summaryText(p) });
  return true;
}

async function runRename(id) {
  const p = store.getProfile(id);
  if (!p) return;
  const r = await ask({ kind: 'text', title: 'Назва облікового запису', text: 'Наприклад: «Син», «Я (викладач)». Порожнє поле поверне назву за замовчуванням.', default: p.label || '' });
  if (!r) return;
  p.label = (r.value || '').trim() || undefined;
  if (!p.label) delete p.label;
  store.save();
  sendAccounts();
  pushStatus();
}

async function runSubstitute() {
  const eng = getEngine();
  if (!eng || !eng.sched || !eng.isTeacher) return;
  const sched = eng.sched;
  const g = await ask({ kind: 'group', title: 'Заміна: оберіть групу', groups: L.groupsByCourse(Object.keys(sched.groups)) });
  if (!g) return;
  const pairs = eng.upcomingPairsToday();
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
    courses = await eng.substituteCourses(g.value);
  } catch (e) {
    setBusy(null);
    await ask({ kind: 'info', title: 'Помилка', text: 'Не вдалося прочитати курси Classroom: ' + cleanError(e) });
    return;
  }
  setBusy(null);
  const c = await ask({
    kind: 'choose', title: `${g.value}, ${p.value} пара (${hm(pair.start)}). Який курс?`,
    items: courses.map((x, i) => ({ value: String(i), label: x.title })), timeoutMs: 0,
  });
  if (!c) return;
  const course = courses[+c.value];
  eng.addSubstitution({ group: g.value, pair: pair.pair, start: pair.start, end: pair.end, title: course.title, url: course.url });
}

async function reloadAllAfterScheduleUpdate() {
  for (const p of store.profiles) {
    const e = getEngine(p.id);
    if (!e) continue;
    e.loadProfile();
    e.mapOptions(true).catch((err) => e.log('Прив\'язка нових пар: ' + cleanError(err)));
  }
  pushStatus();
}

async function runSettings() {
  for (;;) {
    const on = autostartEnabled();
    const cur = store.getProfile(viewId);
    const r = await ask({
      kind: 'settings', title: 'Налаштування',
      text: `Auto Meet ${VERSION}` + (cur ? ` · ${store.profileName(cur)}` : ''),
      groups: [
        { title: 'Обліковий запис', tiles: [
          { value: 'map', icon: 'link', label: 'Курси Classroom', sub: 'Прив\'язати ще раз' },
          { value: 'reconf', icon: 'user', label: 'Група / викладач', sub: 'Змінити' },
          { value: 'remove', icon: 'trash', label: 'Видалити', sub: 'Скинути запис', danger: true },
        ] },
        { title: 'Оновлення', tiles: [
          { value: 'update', icon: 'calendar', label: 'Розклад', sub: 'Перевірити' },
          { value: 'appupdate', icon: 'download', label: 'Програма', sub: `Версія ${VERSION}` },
        ] },
        { title: 'Система', tiles: [
          { value: 'autostart', icon: 'power', label: 'Автозапуск', toggle: on, sub: on ? 'Увімкнено' : 'Вимкнено' },
        ] },
      ],
      footer: [{ value: 'log', icon: 'file', label: 'Журнал (для розробників)' }],
      timeoutMs: 0,
    });
    if (!r) return;
    const eng = getEngine();
    if (r.value === 'autostart') { setAutostart(!on); }
    else if (r.value === 'map') {
      if (!eng) continue;
      try { setBusy('Читаю курси Classroom…'); cur.unmatched = []; await eng.mapOptions(false); }
      catch (e) { await ask({ kind: 'info', title: 'Помилка', text: cleanError(e) }); }
      setBusy(null);
    } else if (r.value === 'update') {
      setBusy('Перевіряю оновлення…');
      const changed = await store.updateSchedule();
      setBusy(null);
      if (changed) reloadAllAfterScheduleUpdate();
      await ask({ kind: 'info', title: 'Розклад', text: changed ? 'Розклад оновлено.' : 'У вас актуальна версія розкладу.' });
    } else if (r.value === 'appupdate') {
      setBusy('Перевіряю нову версію…');
      try { await checkApp(true); } finally { setBusy(null); }
    } else if (r.value === 'log') {
      shell.openPath(store.logFile);
    } else if (r.value === 'reconf') {
      if (cur) { await runSetup(cur.id); return; }
    } else if (r.value === 'remove') {
      if (cur) { await confirmAndRemove(cur.id); return; }
    }
  }
}

// ---------- оновлення самої програми ----------
let appCheckRunning = false;
async function checkApp(manual) {
  if (appCheckRunning) return;
  appCheckRunning = true;
  try {
    const u = await checkAppUpdate(VERSION);
    store.state.lastAppCheck = Date.now();
    store.save();
    if (!u) {
      if (manual) await ask({ kind: 'info', title: 'Оновлення програми', text: `Встановлена версія: ${VERSION}. Новішого опублікованого релізу немає.\n\nЯкщо ви тестуєте збірку з гілки beta, її номер може збігатися з попереднім — номер змінюється лише з новим релізом (тегом v…).` });
      return;
    }
    if (!manual && store.state.skipVersion === u.version) return;
    const text = `Доступна версія ${u.version} (у вас ${VERSION}).` + (u.notes ? `\n\n${u.notes}` : '') +
      '\n\nПісля завантаження вийдіть із програми (іконка в треї → Вийти) і запустіть інсталятор.';
    const r = await ask({
      kind: 'choose', title: 'Нова версія Auto Meet', text,
      items: [{ value: 'get', label: u.direct ? 'Завантажити' : 'Відкрити сторінку завантаження' },
        { value: 'later', label: 'Нагадати пізніше' }, { value: 'skip', label: 'Пропустити цю версію' }],
      default: 'get', timeoutMs: manual ? 0 : 3 * 60 * 1000,
    });
    if (!r) return;
    if (r.value === 'get') { if (isTrustedUrl(u.url)) shell.openExternal(u.url); else shell.openExternal(cfg.RELEASES_PAGE); }
    else if (r.value === 'skip') { store.state.skipVersion = u.version; store.save(); }
  } catch (e) {
    store.log('Перевірка оновлення програми: ' + e.message);
    if (manual) await ask({ kind: 'info', title: 'Оновлення програми', text: 'Не вдалося перевірити оновлення. Перевірте інтернет.\n\nСторінка завантаження: ' + cfg.RELEASES_PAGE });
  } finally { appCheckRunning = false; }
}
function scheduleAppChecks() {
  const due = () => store.profiles.length && Date.now() - (store.state.lastAppCheck || 0) > cfg.APP_CHECK_MS;
  setTimeout(() => { if (due()) checkApp(false); }, 20 * 1000);
  setInterval(() => { if (due()) checkApp(false); }, 30 * 60 * 1000);
}

// ---------- спільні перевірки (раз на 20 с) ----------
let lastScheduleCheck = Date.now();
const askedSat = new Set();
async function managerTick() {
  if (!store.profiles.length) return;
  const now = new Date();
  if (Date.now() - lastScheduleCheck > UPDATE_CHECK_MS) {
    lastScheduleCheck = Date.now();
    if (await store.updateSchedule()) { notify('Розклад оновлено.'); reloadAllAfterScheduleUpdate(); }
  }
  // субота без відомого дня: питаємо один раз для всіх облікових записів
  if (L.weekday(now) === 5 && anyEnabled() && L.saturdayValue(now, store.state.saturdays || {}) === null &&
      !askedSat.has(L.isoDate(now))) {
    askedSat.add(L.isoDate(now));
    const ans = await ask({
      kind: 'choose', title: 'Сьогодні субота', text: 'За розкладом якого дня навчаємось?',
      items: ['пн', 'вт', 'ср', 'чт', 'пт', 'Сьогодні пар нема'].map((v) => ({ value: v, label: v })),
      default: 'Сьогодні пар нема', timeoutMs: 10 * 60 * 1000,
    });
    if (ans) {
      store.state.saturdays = store.state.saturdays || {};
      store.state.saturdays[L.isoDate(now)] = L.DAYS.slice(0, 5).includes(ans.value) ? ans.value : 'нема';
      store.save();
      pushStatus();
    }
  }
}

// ---------- запуск ----------
async function startupGate() {
  if (!store.profiles.length) return true;
  const sched = store.loadSchedule();
  const sat = store.state.saturdays || {};
  const any = store.profiles.filter((p) => p.enabled).some((p) => {
    const my = p.mode === 'teacher' ? L.teacherSchedule(sched, p.aliases && p.aliases.length ? p.aliases : p.surname) : (sched.groups[p.group] || {});
    return L.pairsLeftToday(sched, my, new Date(), sat, []) !== false;
  });
  if (!any) return false;
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

ipcMain.handle('init', () => {
  const e = getEngine();
  return {
    version: VERSION, configured: store.profiles.length > 0,
    status: { ...(e ? (statuses.get(viewId) || e.currentStatus()) : { phase: 'none' }), others: othersLine() },
    accounts: accountsPayload(), log: logTail.slice(-8), busy: busyText,
  };
});
ipcMain.handle('command', async (_e, name, arg) => {
  if (name === 'substitute') await runSubstitute();
  else if (name === 'settings') await runSettings();
  else if (name === 'add-account') await runSetup(null);
  else if (name === 'select-account') {
    if (store.getProfile(arg)) { viewId = arg; store.state.viewId = arg; store.save(); sendAccounts(); pushStatus(); }
  } else if (name === 'toggle-account') {
    const p = store.getProfile(arg && arg.id);
    if (p) { p.enabled = !!arg.enabled; store.save(); begin(); }
  } else if (name === 'rename-account') await runRename(arg);
  else if (name === 'remove-account') await confirmAndRemove(arg);
});

app.on('second-instance', showWindow);
app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => { /* працюємо у фоні (трей) */ });
app.on('activate', showWindow);

app.whenReady().then(async () => {
  store = new Store(app.getPath('userData'), (app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', '..')));
  viewId = (store.getProfile(store.state.viewId) || store.profiles[0] || {}).id || null;

  if (IS_STARTUP || process.argv.includes('--startup')) {
    if (!(await startupGate())) { quitting = true; app.quit(); return; }
  }
  createWindow();
  createTray();
  win.webContents.once('did-finish-load', async () => {
    store.updateSchedule().then((changed) => { if (changed) reloadAllAfterScheduleUpdate(); });
    scheduleAppChecks();
    setInterval(() => managerTick().catch((e) => store.log('managerTick: ' + e.message)), 20 * 1000);
    if (store.profiles.length) begin();
    else { showWindow(); await runSetup(null); }
  });
});
