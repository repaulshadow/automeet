'use strict';
// Рушій: браузер (Playwright), вхід на пари, прив'язка курсів Classroom, планувальник.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const L = require('./logic');

const ASK_BEFORE_MIN = 10;
const JOIN_BEFORE_MIN = 1;
const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';
const MOD_KEY = IS_MAC ? 'Meta' : 'Control';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const NO_TRANSLATE_JS = `
(() => {
  const apply = () => {
    const h = document.documentElement;
    if (h) { h.setAttribute('translate', 'no'); h.classList.add('notranslate'); }
    if (document.head && !document.querySelector('meta[name="google"]')) {
      const m = document.createElement('meta'); m.name = 'google'; m.content = 'notranslate';
      document.head.appendChild(m);
    }
  };
  apply();
  new MutationObserver(apply).observe(document, { childList: true, subtree: false });
})();`;

class Engine extends EventEmitter {
  /**
   * @param {Store} store
   * @param {{ask: Function, notify: Function, browsersDir: string, nodeBinary: string}} io
   * @param {object} profile запис із store.state.profiles (посилання: зміни зберігаються через store.save())
   */
  constructor(store, io, profile) {
    super();
    this.store = store;
    this.io = io;
    this.p = profile;
    this.sched = null;
    this.mySched = {};
    this.subs = []; // разові заміни
    this.started = new Set();
    this.timer = null;
    this.ctx = null;
    this.ctxUsers = 0;
    this.closeTimer = null;
    this.launching = null;
    this.coursesCache = { t: 0, courses: [] };
    this.busy = new Set(); // активні входи на пари
    this.status = 'Очікування';
  }

  get label() { return this.store.profileName(this.p); }
  get multi() { return this.store.profiles.length > 1; }
  log(msg) {
    const line = this.multi ? `[${this.label}] ${msg}` : msg;
    this.store.log(line);
    this.emit('log', `${new Date().toLocaleTimeString('uk-UA')}  ${line}`);
  }
  notify(text) { this.io.notify(this.multi ? `${this.label}: ${text}` : text); }
  ask(spec) { return this.io.ask(this.multi ? { ...spec, title: `${this.label} · ${spec.title}` } : spec); }
  setStatus(s) { this.status = s; this.emit('status-text', { id: this.p.id, text: s }); }

  // ---------- профіль ----------
  get isTeacher() { return this.p.mode === 'teacher'; }
  get explicitSaturdays() { return this.store.state.saturdays || {}; }

  loadProfile() {
    this.sched = this.store.loadSchedule();
    const st = this.p;
    if (!this.sched || !st.mode) return false;
    this.mySched = this.isTeacher
      ? L.teacherSchedule(this.sched, st.aliases && st.aliases.length ? st.aliases : st.surname)
      : (this.sched.groups[st.group] || {});
    return true;
  }
  identity() {
    return this.store.profileName(this.p);
  }
  currentStatus() {
    if (!this.sched) return { phase: 'none' };
    const s = L.computeStatus(this.sched, this.mySched, new Date(), this.explicitSaturdays, this.subs);
    s.identity = this.identity();
    s.profileId = this.p.id;
    s.canSubstitute = this.isTeacher;
    s.mode = this.p.mode;
    s.text = this.status;
    return s;
  }

  // ---------- браузер ----------
  browserCandidates() {
    const out = [];
    const prof = (n) => this.store.browserProfileDir(this.p.id, n);
    let chrome = [], edge = [];
    if (IS_WIN) {
      const roots = ['LOCALAPPDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)'].map((k) => process.env[k]).filter(Boolean);
      chrome = roots.map((r) => path.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe'));
      edge = roots.map((r) => path.join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    } else if (IS_MAC) {
      chrome = ['/Applications/Google Chrome.app', path.join(os.homedir(), 'Applications', 'Google Chrome.app')];
      edge = ['/Applications/Microsoft Edge.app'];
    } else {
      chrome = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'];
      edge = ['/usr/bin/microsoft-edge'];
    }
    if (chrome.some((p) => fs.existsSync(p))) out.push(['chrome', prof('chrome')]);
    if (edge.some((p) => fs.existsSync(p))) out.push(['msedge', prof('edge')]);
    out.push([null, prof('chromium')]);
    return out;
  }

  disableTranslate(profileDir) {
    try {
      const f = path.join(profileDir, 'Default', 'Preferences');
      fs.mkdirSync(path.dirname(f), { recursive: true });
      let prefs = {};
      try { prefs = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* новий профіль */ }
      prefs.translate = { ...(prefs.translate || {}), enabled: false };
      prefs.translate_blocked_languages = ['uk', 'ru', 'en'];
      prefs.intl = { ...(prefs.intl || {}), accept_languages: 'uk-UA,uk,ru,en-US,en' };
      delete prefs.translate_site_blacklist;
      delete prefs.translate_allowlists;
      fs.writeFileSync(f, JSON.stringify(prefs));
    } catch (e) { this.log('Не вдалося налаштувати переклад: ' + e.message); }
  }

  installChromium() {
    // Одноразово завантажує Chromium від Playwright (~150 МБ), якщо Chrome/Edge немає.
    this.notify('Завантажую браузер (одноразово, кілька хвилин)…');
    this.log('Завантажую Chromium…');
    const cli = path.join(path.dirname(require.resolve('playwright-core/package.json')), 'cli.js')
      .replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
    return new Promise((resolve, reject) => {
      const p = spawn(this.io.nodeBinary, [cli, 'install', 'chromium'], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PLAYWRIGHT_BROWSERS_PATH: this.io.browsersDir },
        windowsHide: true,
      });
      p.stdout.on('data', (d) => this.log(String(d).trim()));
      p.stderr.on('data', (d) => this.log(String(d).trim()));
      p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error('install chromium: код ' + c))));
      p.on('error', reject);
    });
  }

  async _launchOnce(channel, profileDir) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = this.io.browsersDir;
    const { chromium } = require('playwright-core');
    this.disableTranslate(profileDir);
    return chromium.launchPersistentContext(profileDir, {
      channel: channel || undefined, executablePath: process.env.AUTOMEET_BROWSER_PATH || undefined, headless: false, viewport: null, locale: 'uk-UA',
      args: ['--use-fake-ui-for-media-stream', '--disable-blink-features=AutomationControlled',
        '--lang=uk-UA', '--accept-lang=uk-UA,uk'],
      ignoreDefaultArgs: ['--enable-automation'],
    });
  }

  async _launch() {
    let lastErr = null;
    for (const [channel, profile] of this.browserCandidates()) {
      const name = { chrome: 'Google Chrome', msedge: 'Microsoft Edge' }[channel] || 'Chromium';
      try {
        let ctx;
        try {
          ctx = await this._launchOnce(channel, profile);
        } catch (e) {
          if (!channel && /Executable doesn't exist/i.test(String(e))) {
            await this.installChromium();
            ctx = await this._launchOnce(channel, profile);
          } else throw e;
        }
        this.log(`Браузер: ${name}`);
        for (const origin of ['https://meet.google.com', 'https://classroom.google.com']) {
          try { await ctx.grantPermissions(['camera', 'microphone'], { origin }); } catch { /* не критично */ }
        }
        await ctx.addInitScript(NO_TRANSLATE_JS);
        this.showHomePage(ctx).catch(() => { /* не критично */ });
        ctx.on('close', () => { if (this.ctx === ctx) this.ctx = null; });
        return ctx;
      } catch (e) {
        lastErr = e;
        this.log(`Не вдалося запустити ${name}: ${String(e.message || e).split('\n')[0]}`);
      }
    }
    this.notify('Не вдалося запустити браузер.');
    throw new Error('Не вдалося запустити жоден браузер: ' + (lastErr && lastErr.message));
  }

  /** Замість порожньої вкладки about:blank показуємо довідкову сторінку: таймер і пари дня. */
  async showHomePage(ctx) {
    const first = ctx.pages()[0];
    if (!first) return;
    const u = first.url();
    if (u && u !== 'about:blank' && !/^chrome:\/\/newtab|^edge:\/\/newtab/.test(u)) return;
    const pairs = L.dayPairs(this.sched, this.mySched, L.startOfDay(new Date()), this.explicitSaturdays, this.subs)
      .map((i) => ({ pair: i.pair, start: i.start.getTime(), end: i.end.getTime(), label: i.label }));
    // браузер не читає з app.asar, тож кладемо копію в папку даних
    const file = path.join(this.store.dir, 'browser-home.html');
    fs.writeFileSync(file, fs.readFileSync(path.join(__dirname, '..', 'renderer', 'browser-home.html')));
    const hash = encodeURIComponent(JSON.stringify({ name: this.identity(), pairs }));
    await first.goto('file://' + (file.startsWith('/') ? '' : '/') + file.replace(/\\/g, '/') + '#' + hash);
  }

  /** Бере браузер у користування (запускає при потребі). Обов'язково викликати release(). */
  async acquire() {
    clearTimeout(this.closeTimer);
    if (!this.ctx) {
      if (!this.launching) this.launching = this._launch().then((c) => { this.ctx = c; }).finally(() => { this.launching = null; });
      await this.launching;
    }
    this.ctxUsers++;
    return this.ctx;
  }
  release() {
    this.ctxUsers = Math.max(0, this.ctxUsers - 1);
    if (this.ctxUsers === 0) {
      clearTimeout(this.closeTimer);
      // не закриваємо одразу: наступна пара може бути зовсім скоро
      this.closeTimer = setTimeout(async () => {
        if (this.ctxUsers === 0 && this.ctx) { try { await this.ctx.close(); } catch { /* ok */ } this.ctx = null; }
      }, 3 * 60 * 1000);
    }
  }
  async shutdown() {
    clearInterval(this.timer);
    clearTimeout(this.closeTimer);
    if (this.ctx) { try { await this.ctx.close(); } catch { /* ok */ } this.ctx = null; }
  }

  // ---------- Classroom ----------
  /** Чекає, поки в БУДЬ-ЯКІЙ вкладці браузера з'явиться список курсів Classroom.
   *  Після входу в Google сайт відкриває логін в окремій новій вкладці, тож стежити лише
   *  за «своєю» вкладкою не можна. */
  async waitForCoursesPage(ctx, ownPage, timeoutMs) {
    const t0 = Date.now();
    let redirected = false;
    while (Date.now() - t0 < timeoutMs) {
      for (const pg of ctx.pages()) {
        let url = '';
        try { url = pg.url(); } catch { continue; }
        if (!/^https:\/\/classroom\.google\.com\//.test(url)) continue;
        try {
          const n = await pg.evaluate(() => document.querySelectorAll('a[href*="/c/"]').length);
          if (n > 0) return pg;
        } catch { /* сторінка ще вантажиться */ }
      }
      // Нова (не авторизована) вкладка часто потрапляє на рекламну сторінку Google for Education —
      // тоді відразу ведемо її на форму входу, щоб людина входила прямо тут.
      if (!redirected && Date.now() - t0 > 6000) {
        let u = '';
        try { u = ownPage.url(); } catch { /* закрита */ }
        if (u && !/classroom\.google\.com|accounts\.google\.com/.test(u)) {
          redirected = true;
          ownPage.goto('https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fclassroom.google.com%2F')
            .catch(() => {});
        }
      }
      await sleep(1000);
    }
    throw new Error('Не дочекався входу в Classroom (5 хвилин). Увійдіть у Google у вікні браузера і повторіть: Налаштування → Прив\'язати курси.');
  }

  async scrapeCourses(ctx, stripGroupPrefix) {
    const own = await ctx.newPage();
    let page = own;
    try {
      await own.goto('https://classroom.google.com/u/0/h').catch(() => {});
      this.log('Якщо попросить — увійдіть у Google-акаунт у вікні браузера (чекаю до 5 хвилин)…');
      page = await this.waitForCoursesPage(ctx, own, 5 * 60 * 1000);
      await page.waitForTimeout(2500);
      const raw = await page.evaluate(() => {
        const m = {};
        document.querySelectorAll('a[href*="/c/"]').forEach((a) => {
          const t = a.innerText.trim(); const h = a.href.split('?')[0];
          if (t && (!m[h] || t.length > m[h].length)) m[h] = t;
        });
        return m;
      });
      const courses = [];
      for (const [url, text] of Object.entries(raw)) {
        if (!/\/c\/[^/]+\/?$/.test(url)) continue;
        const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
        let title = lines.find((l) => l.length > 2) || lines[0];
        if (stripGroupPrefix) {
          title = title.replace(/^\s*[A-Za-zА-Яа-яІіЇїЄєҐґ]{1,4}\s*-?\s*\d+\s*/, '').trim() || title;
        }
        courses.push({ title, text: lines.join(' '), url });
      }
      this.log(`Курсів у Classroom: ${courses.length}`);
      if (courses.length && !courses.some((c) => /[А-Яа-яІіЇїЄє]/.test(c.title))) {
        throw new Error('Браузер переклав Classroom на англійську. Закрийте його, вимкніть переклад («Ніколи не перекладати») і спробуйте ще раз.');
      }
      return courses;
    } finally {
      for (const pg of new Set([page, own])) { try { await pg.close(); } catch { /* ok */ } }
    }
  }

  async getCourses(stripGroupPrefix, maxAgeMs = 30 * 60 * 1000) {
    if (this.coursesCache.courses.length && Date.now() - this.coursesCache.t < maxAgeMs &&
        this.coursesCache.strip === stripGroupPrefix) return this.coursesCache.courses;
    const ctx = await this.acquire();
    try {
      const courses = await this.scrapeCourses(ctx, stripGroupPrefix);
      this.coursesCache = { t: Date.now(), courses, strip: stripGroupPrefix };
      return courses;
    } finally { this.release(); }
  }

  /** Прив'язує пари розкладу до курсів Classroom. onlyMissing — лише нові пари. */
  async mapOptions(onlyMissing) {
    const st = this.p;
    st.map = st.map || {};
    st.unmatched = st.unmatched || [];
    let options = L.buildOptions(this.mySched, this.isTeacher);
    if (onlyMissing) options = options.filter((o) => !(o.option in st.map) && !st.unmatched.includes(o.option));
    if (!options.length) return;
    this.setStatus('Читаю курси Classroom…');
    const courses = await this.getCourses(!this.isTeacher, 0);
    const todo = [];
    for (const { option, group } of options) {
      const pool = group ? L.filterByGroup(courses, group) : courses;
      const ranked = L.rank(option, pool).filter(([s]) => s >= 0.35).slice(0, 5);
      if (!ranked.length) {
        this.log(`«${option}»: схожих курсів не знайдено`);
        if (!st.unmatched.includes(option)) st.unmatched.push(option);
        continue;
      }
      const top = ranked[0][0];
      if (top >= 0.85 && (ranked.length === 1 || ranked[1][0] <= top - 0.15)) {
        st.map[option] = ranked[0][1].url;
        this.log(`✓ ${option} → ${ranked[0][1].title}`);
        continue;
      }
      todo.push({ option, ranked });
    }
    let n = 0;
    for (const { option, ranked } of todo) {
      n++;
      const items = ranked.map(([s, c], i) => ({ value: String(i), label: `${c.title}  (${Math.round(s * 100)}%)` }));
      const ans = await this.ask({
        kind: 'choose', title: `Куди заходити на пару? (${n} з ${todo.length})`, text: option,
        items, allowSkip: true, skipLabel: 'Пропустити цю пару', timeoutMs: 0,
      });
      if (ans && ans.value != null) st.map[option] = ranked[+ans.value][1].url;
      else if (!st.unmatched.includes(option)) st.unmatched.push(option);
    }
    this.store.save();
    this.setStatus('Готово');
  }

  // ---------- вхід на пару ----------
  async clickFirst(page, selectors, timeout = 3000, poll = 150) {
    const deadline = Date.now() + timeout;
    for (;;) {
      for (const sel of selectors) {
        try {
          const el = page.locator(sel).first();
          if (await el.isVisible()) { await el.click(); return true; }
        } catch { /* наступний селектор */ }
      }
      if (Date.now() >= deadline) return false;
      await sleep(poll);
    }
  }

  async attend(name, courseUrl, endTime) {
    const ctx = await this.acquire();
    const page = await ctx.newPage();
    this.log(`Заходжу: ${name}`);
    this.busy.add(name);
    this.setStatus(`На парі: ${name}`);
    try {
      await page.goto(courseUrl);
      let meetHref = null;
      for (let i = 0; i < Math.max(1, Math.round((this.linkWaitMs ?? 20000) / 1000)) && !meetHref; i++) {
        meetHref = await page.evaluate(() => document.querySelector('a[href*="meet.google.com/"]')?.href || null);
        if (!meetHref) await page.waitForTimeout(1000);
      }
      if (!meetHref) throw new Error('Не знайшов посилання на Meet на сторінці курсу');
      await page.goto(meetHref);

      const MIC = ['Turn off microphone', 'Вимкнути мікрофон', 'Отключить микрофон', 'Выключить микрофон'];
      const CAM = ['Turn off camera', 'Вимкнути камеру', 'Отключить камеру', 'Выключить камеру'];
      const sel = (labels) => labels.map((l) => `[aria-label*="${l}" i]`).join(',');
      const isOn = async (labels) => { try { return await page.locator(sel(labels)).first().isVisible(); } catch { return false; } };
      const toggleOff = async (labels, shortcut, attempts = 3, pause = 500) => {
        for (let i = 0; i < attempts; i++) {
          if (!(await isOn(labels))) return true;
          await page.keyboard.press(shortcut);
          await page.waitForTimeout(pause);
          if (!(await isOn(labels))) return true;
          await this.clickFirst(page, labels.map((l) => `[aria-label*="${l}" i]`), 1000);
          await page.waitForTimeout(pause);
        }
        return !(await isOn(labels));
      };

      await page.waitForTimeout(800);
      try { await page.locator('body').click({ position: { x: 5, y: 5 }, timeout: 1500 }); } catch { /* не критично */ }
      const micOff = await toggleOff(MIC, `${MOD_KEY}+d`);
      const camOff = await toggleOff(CAM, `${MOD_KEY}+e`);
      if (!micOff) this.notify(`Не вдалося вимкнути мікрофон: ${name}`);
      if (!camOff) this.notify(`Не вдалося вимкнути камеру: ${name}`);

      const ok = await this.clickFirst(page, [
        'button:has-text("Join now")', 'button:has-text("Ask to join")',
        'button:has-text("Приєднатися")', 'button:has-text("Попросити приєднатися")',
        'button:has-text("Присоединиться")', 'button:has-text("Попросить войти")'], 15000);
      if (!ok) { this.log(`Не знайшов кнопку входу: ${name}`); return false; }

      const sched = this.sched || this.store.loadSchedule();
      const day = L.startOfDay(new Date(endTime - 60000));
      const starts = Object.keys(sched.bells).map((p) => L.pairTimes(sched, p, day)[0].getTime());
      await sleep(Math.max(0, L.leaveTime(sched, endTime, starts) - Date.now()));
      await this.clickFirst(page, ['[aria-label*="Leave call" i]', '[aria-label*="Вийти з дзвінка" i]',
        '[aria-label*="Покинуть" i]'], 3000);
      return true;
    } catch (e) {
      this.log('Помилка: ' + e.message);
      return false;
    } finally {
      try { await page.close(); } catch { /* ok */ }
      this.busy.delete(name);
      this.release();
      this.log(`Вийшов: ${name}`);
      this.setStatus(this.busy.size ? `На парі: ${[...this.busy][0]}` : 'Чекаю наступної пари');
    }
  }

  /** Заходить на пару з повторами: якщо вхід не вдався (немає посилання, збій мережі), пробує ще
   *  кілька разів, поки до кінця пари лишається більше 5 хвилин. Повідомляє лише про остаточну невдачу. */
  async attendReliably(name, courseUrl, endTime) {
    for (let attempt = 1; attempt <= 4; attempt++) {
      if (await this.attend(name, courseUrl, endTime)) return true;
      if (endTime - Date.now() < 5 * 60000) break;
      if (attempt < 4) { this.log(`Повторна спроба входу (${attempt}/3): ${name}`); await sleep(this.retryPauseMs ?? 30000); }
    }
    this.notify(`Не вдалося зайти: ${name}`);
    return false;
  }

  // ---------- планувальник ----------
  start() {
    this.stop();
    this.setStatus('Чекаю наступної пари');
    const run = () => this.tick().catch((e) => this.log('Планувальник: ' + e.message));
    run();
    this.timer = setInterval(run, 20000);
  }
  stop() { clearInterval(this.timer); this.timer = null; }

  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = new Date();
      this.emit('status', this.currentStatus());

      const day = L.effectiveDay(now, this.explicitSaturdays);
      const periods = (day && this.mySched[day]) || {};
      for (const [pair, options] of Object.entries(periods)) {
        const [start, end] = L.pairTimes(this.sched, pair, L.startOfDay(now));
        const key = `${L.isoDate(now)}-${pair}`;
        if (this.started.has(key)) continue;
        if (start.getTime() - ASK_BEFORE_MIN * 60000 <= now.getTime() && now < end) {
          this.started.add(key);
          this.handlePair(pair, options, start, end).catch((e) => this.log('Пара ' + pair + ': ' + e.message));
        }
      }
    } finally { this.ticking = false; }
  }

  async handlePair(pair, options, start, end) {
    const st = this.p;
    st.last = st.last || {};
    const eff = L.effectiveDay(start, this.explicitSaturdays);
    const groupDayKey = `${L.DAYS.indexOf(eff) >= 0 ? L.DAYS.indexOf(eff) : L.weekday(start)}-${pair}`;
    let chosen = null;
    const needsAsk = options.length > 1 || options.some((o) => o.startsWith('?'));
    if (needsAsk) {
      const real = options.map((o) => o.replace(/^\?+/, '').trim()).filter(Boolean);
      const parity = L.weekParity(start);
      st.weekPattern = st.weekPattern || {};
      const learned = st.weekPattern[groupDayKey] || {};
      if (real.includes(learned[parity])) {
        chosen = learned[parity];
      } else {
        const dontKnow = 'Не знаю (питати щотижня)';
        const none = '— пари нема —';
        const items = [...real, dontKnow, none].map((v) => ({ value: v, label: v }));
        const waitLeft = Math.max(0, start.getTime() - Date.now());
        const dflt = st.last[groupDayKey];
        const ans = await this.ask({
          kind: 'choose', title: `Пара №${pair} (${L.pairTimes(this.sched, pair, L.startOfDay(start))[0].toTimeString().slice(0, 5)})`,
          text: 'Яка пара цього тижня?', items, default: dflt, timeoutMs: waitLeft + 120000,
        });
        let pick = ans ? ans.value : dflt;
        if (!pick || pick === none) { this.log(`Пара ${pair}: пропуск`); return; }
        if (pick === dontKnow) {
          delete st.weekPattern[groupDayKey];
        } else if (real.includes(pick)) {
          learned[parity] = pick;
          if (real.length === 2) {
            const other = real.find((o) => o !== pick);
            const otherParity = parity === '0' ? '1' : '0';
            if (!learned[otherParity]) learned[otherParity] = other;
          }
          st.weekPattern[groupDayKey] = learned;
        }
        st.last[groupDayKey] = pick;
        this.store.save();
        chosen = pick;
      }
    } else {
      chosen = (options[0] || '').trim();
    }
    if (!chosen) return;
    const url = (st.map || {})[chosen];
    if (!url) { this.notify(`Немає курсу для «${chosen}». Відкрийте Налаштування → Прив'язати курси.`); return; }
    await sleep(Math.max(0, start.getTime() - JOIN_BEFORE_MIN * 60000 - Date.now()));
    await this.attendReliably(chosen, url, end.getTime());
  }

  // ---------- заміна пари ----------
  /** Пари, які ще не закінчились сьогодні: [{pair, start, end}]. */
  upcomingPairsToday() {
    const now = new Date();
    const day = L.startOfDay(now);
    const out = [];
    for (const pair of Object.keys(this.sched.bells).sort((a, b) => a - b)) {
      const [start, end] = L.pairTimes(this.sched, pair, day);
      if (end > now) out.push({ pair, start: start.getTime(), end: end.getTime() });
    }
    return out;
  }

  async substituteCourses(group) {
    const courses = await this.getCourses(false);
    return L.filterByGroup(courses, group)
      .map((c) => ({ title: c.title, url: c.url }))
      .sort((a, b) => a.title.localeCompare(b.title, 'uk'));
  }

  addSubstitution({ group, pair, start, end, title, url }) {
    const label = `${group}: ${title}`;
    this.subs.push({ pair, start: new Date(start).toISOString(), end: new Date(end).toISOString(), label });
    this.notify(`Заміна: зайду на «${label}» о ${new Date(start).toTimeString().slice(0, 5)}.`);
    this.log(`Заміна додана: ${label}`);
    (async () => {
      await sleep(Math.max(0, start - JOIN_BEFORE_MIN * 60000 - Date.now()));
      await this.attendReliably(label, url, end);
    })();
    this.emit('status', this.currentStatus());
  }
}

/** Текст помилки без службових кодів кольору Playwright та зайвих рядків. */
function cleanError(e) {
  return String((e && e.message) || e).replace(/\u001b\[[0-9;]*m/g, '').replace(/\[\d+m/g, '')
    .split('\n').map((x) => x.trim()).filter(Boolean)[0] || 'Невідома помилка';
}

module.exports = { Engine, cleanError };
