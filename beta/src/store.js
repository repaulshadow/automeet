'use strict';
// Збереження стану, розкладу та оновлення розкладу з GitHub.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const cfg = require('./config');
const UPDATE_URL = cfg.RAW_BASE;
const UPDATE_CHECK_MS = 6 * 3600 * 1000;

class Store {
  constructor(dataDir, bundledDir) {
    this.dir = dataDir;
    this.bundled = bundledDir; // звідси беремо schedule.json, якщо ще не завантажували свіжий
    fs.mkdirSync(dataDir, { recursive: true });
    this.stateFile = path.join(dataDir, 'state.json');
    this.scheduleFile = path.join(dataDir, 'schedule.json');
    this.logFile = path.join(dataDir, 'auto_meet.log');
    // якщо state.json пошкоджено (вимкнули світло під час запису) — беремо останню резервну копію
    this.state = this._readJson(this.stateFile, null) || this._readJson(this.stateFile + '.bak', null) || {};
    this.migrate();
  }

  // ---------- облікові записи (до 5) ----------
  /** Старий формат (один профіль у корені state.json) → profiles[0]. */
  migrate() {
    const st = this.state;
    if (st.profiles) return;
    st.profiles = [];
    if (st.mode) {
      const p = { id: 'p1', enabled: true };
      for (const k of ['mode', 'group', 'surname', 'teacherName', 'aliases', 'map', 'last', 'unmatched', 'weekPattern']) {
        if (st[k] !== undefined) { p[k] = st[k]; delete st[k]; }
      }
      st.profiles.push(p);
      st.viewId = 'p1';
      this.save();
    }
  }
  get profiles() { return this.state.profiles || (this.state.profiles = []); }
  getProfile(id) { return this.profiles.find((p) => p.id === id) || null; }
  profileName(p) {
    if (p.label) return p.label;
    const base = p.mode === 'teacher' ? (p.teacherName || p.surname) : p.group;
    const same = this.profiles.filter((x) => (x.mode === 'teacher' ? (x.teacherName || x.surname) : x.group) === base);
    return same.length > 1 ? `${base} (${same.indexOf(p) + 1})` : base;
  }
  newProfileId() {
    for (let i = 1; i <= 9; i++) if (!this.getProfile('p' + i)) return 'p' + i;
    throw new Error('Забагато облікових записів');
  }
  /** Папка профілю браузера: p1 використовує старі папки (щоб не втратити вхід у Google). */
  browserProfileDir(id, kind) {
    return path.join(this.dir, 'profiles', id === 'p1' ? kind : `${id}-${kind}`);
  }
  removeProfile(id) {
    this.state.profiles = this.profiles.filter((p) => p.id !== id);
    if (this.state.viewId === id) this.state.viewId = (this.profiles[0] || {}).id;
    for (const kind of ['chrome', 'edge', 'chromium']) {
      try { fs.rmSync(this.browserProfileDir(id, kind), { recursive: true, force: true }); } catch { /* ok */ }
    }
    this.save();
  }

  _readJson(file, dflt) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return dflt; }
  }
  _writeJson(file, data) {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  }

  save() {
    try { if (fs.existsSync(this.stateFile)) fs.copyFileSync(this.stateFile, this.stateFile + '.bak'); } catch { /* ok */ }
    this._writeJson(this.stateFile, this.state);
  }
  reset() { this.state = {}; try { fs.unlinkSync(this.stateFile); } catch { /* ok */ } }

  loadSchedule() {
    const own = this._readJson(this.scheduleFile, null);
    if (own && own.groups) return own;
    const b = this._readJson(path.join(this.bundled, 'schedule.json'), null);
    return b;
  }

  log(line) {
    const text = `[${new Date().toLocaleString('uk-UA')}] ${line}\n`;
    try {
      if (fs.existsSync(this.logFile) && fs.statSync(this.logFile).size > 512 * 1024) {
        fs.renameSync(this.logFile, this.logFile + '.old');
      }
      fs.appendFileSync(this.logFile, text);
    } catch { /* журнал не критичний */ }
  }

  async _fetch(name) {
    const res = await fetch(UPDATE_URL + name, {
      headers: { 'Cache-Control': 'no-cache', 'User-Agent': 'AutoMeet-Beta-updater' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  /** Оновлює schedule.json за manifest.json. Повертає true, якщо розклад змінився. */
  async updateSchedule() {
    try {
      const manifest = JSON.parse((await this._fetch('manifest.json')).toString('utf8'));
      const want = (manifest.files || {})['schedule.json'];
      if (!want) return false;
      const cur = fs.existsSync(this.scheduleFile) ? fs.readFileSync(this.scheduleFile)
        : fs.existsSync(path.join(this.bundled, 'schedule.json')) ? fs.readFileSync(path.join(this.bundled, 'schedule.json')) : null;
      const have = cur ? crypto.createHash('sha256').update(cur).digest('hex') : null;
      if (have === want) return false;
      const data = await this._fetch('schedule.json');
      if (crypto.createHash('sha256').update(data).digest('hex') !== want) return false; // кеш ще не оновився
      const parsed = JSON.parse(data.toString('utf8'));
      if (!parsed.groups || !parsed.bells) return false;
      if (fs.existsSync(this.scheduleFile)) fs.copyFileSync(this.scheduleFile, this.scheduleFile + '.bak');
      fs.writeFileSync(this.scheduleFile + '.tmp', data);
      fs.renameSync(this.scheduleFile + '.tmp', this.scheduleFile);
      this.log('Розклад оновлено з GitHub');
      return true;
    } catch (e) {
      this.log('Перевірка оновлень розкладу не вдалася: ' + e.message);
      return false;
    }
  }
}

module.exports = { Store, UPDATE_CHECK_MS };
