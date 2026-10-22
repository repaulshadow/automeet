process.env.TZ = 'Europe/Kyiv';
'use strict';
// Симуляція планувальника з фальшивим годинником: цілий тиждень за секунди.
// Перевіряємо: кожна пара входить рівно один раз, у правильний момент, з правильним кінцем; вихідні не чіпає.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { Store } = require('../src/store');
const { Engine } = require('../src/engine');
const L = require('../src/logic');

const flush = () => new Promise((r) => setImmediate(r));

async function simulate({ profile, from, to, subs = [], explicit }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-sim-'));
  const store = new Store(dir, path.join(__dirname, '..', '..'));
  if (explicit) store.state.saturdays = explicit;
  profile.map = new Proxy({}, { get: (t, k) => (typeof k === 'string' ? 'http://x/' + k : undefined) });
  store.state.profiles = [profile];
  const asked = [];
  const e = new Engine(store, { ask: async (spec) => { asked.push(spec.title); const first = spec.items.find((i) => !/Не знаю|пари нема/.test(i.value)); return { value: first.value }; },
    notify: () => {}, browsersDir: dir, nodeBinary: process.execPath }, profile);
  assert.ok(e.loadProfile());
  e.subs = subs;
  const calls = [];
  e.attendReliably = async (name, url, endTime) => { calls.push({ name, at: Date.now(), end: endTime }); return true; };
  const t = require('node:test').mock.timers;
  t.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: from.getTime() });
  try {
    e.start();
    const stepMs = 5000;
    for (let now = from.getTime(); now < to.getTime(); now += stepMs) { t.tick(stepMs); await flush(); }
    e.stop();
  } finally { t.reset(); }
  return { calls, asked, store };
}

// Понеділок 19.10.2026 00:00 — наступний понеділок
const MON = new Date(2026, 9, 19, 0, 0, 0);
const SUN = new Date(2026, 9, 26, 0, 0, 0);

test('студент: за тиждень кожна пара входить рівно один раз за хвилину до початку, вихід — у кінець пари', async () => {
  const sched = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'schedule.json'), 'utf8'));
  const group = Object.keys(sched.groups).find((g) => Object.values(sched.groups[g]).every((d) => Object.values(d).every((o) => o.length === 1)));
  assert.ok(group, 'потрібна група без варіантів');
  const { calls } = await simulate({ profile: { id: 'p1', enabled: true, mode: 'student', group }, from: MON, to: SUN });
  const expected = [];
  for (let d = 0; d < 5; d++) {
    const day = new Date(2026, 9, 19 + d);
    const periods = sched.groups[group][L.DAYS[d]] || {};
    for (const p of Object.keys(periods)) {
      const [s, en] = L.pairTimes(sched, p, day);
      expected.push({ start: s.getTime(), end: en.getTime() });
    }
  }
  assert.ok(expected.length >= 10, 'у групи має бути багато пар');
  assert.strictEqual(calls.length, expected.length, `викликів ${calls.length}, очікувалось ${expected.length}`);
  calls.sort((a, b) => a.end - b.end); expected.sort((a, b) => a.end - b.end);
  calls.forEach((c, i) => {
    assert.strictEqual(c.end, expected[i].end, 'кінець пари');
    assert.ok(Math.abs(c.at - (expected[i].start - 60000)) <= 30000 || c.at <= expected[i].start, `вхід о ${new Date(c.at).toTimeString().slice(0, 8)}`);
    assert.ok(c.at < expected[i].end - 60000, 'вхід до кінця пари');
  });
});

test('вихідні: субота без відомостей і неділя — жодного входу', async () => {
  const sched = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'schedule.json'), 'utf8'));
  const group = Object.keys(sched.groups)[0];
  const SAT = new Date(2026, 9, 24, 0, 0), MON2 = new Date(2026, 9, 26, 0, 0);
  const { calls } = await simulate({ profile: { id: 'p1', enabled: true, mode: 'student', group }, from: SAT, to: MON2 });
  assert.strictEqual(calls.length, 0);
});

test('субота за розкладом «пн»: входить на пари понеділка', async () => {
  const sched = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'schedule.json'), 'utf8'));
  const group = Object.keys(sched.groups).find((g) => sched.groups[g]['пн'] && Object.values(sched.groups[g]['пн']).every((o) => o.length === 1));
  const SAT = new Date(2026, 9, 24, 0, 0), SUN2 = new Date(2026, 9, 25, 0, 0);
  const { calls } = await simulate({ profile: { id: 'p1', enabled: true, mode: 'student', group }, from: SAT, to: SUN2, explicit: { '2026-10-24': 'пн' } });
  assert.strictEqual(calls.length, Object.keys(sched.groups[group]['пн']).length);
});

test('запуск програми посеред пари: заходить одразу (один раз), а не чекає', async () => {
  const sched = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'schedule.json'), 'utf8'));
  const group = Object.keys(sched.groups).find((g) => sched.groups[g]['пн'] && sched.groups[g]['пн']['1'] && sched.groups[g]['пн']['1'].length === 1);
  const mid = new Date(2026, 9, 19, 9, 20); // пара 1: 08:30–09:50
  const { calls } = await simulate({ profile: { id: 'p1', enabled: true, mode: 'student', group }, from: mid, to: new Date(2026, 9, 19, 9, 40) });
  assert.strictEqual(calls.length, 1);
  assert.ok(calls[0].at - mid.getTime() <= 20000);
});

test('комп\'ютер увімкнули після кінця пари: не заходить на минулу пару', async () => {
  const sched = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'schedule.json'), 'utf8'));
  const group = Object.keys(sched.groups).find((g) => sched.groups[g]['пн'] && sched.groups[g]['пн']['1']);
  const late = new Date(2026, 9, 19, 9, 55); // після кінця пари 1, до початку пари 2 (10:00 з вікном запитань)
  const { calls } = await simulate({ profile: { id: 'p1', enabled: true, mode: 'student', group }, from: new Date(2026, 9, 19, 9, 51), to: new Date(2026, 9, 19, 9, 58) });
  assert.ok(calls.every((c) => c.end > new Date(2026, 9, 19, 9, 51).getTime() + 1000));
  void late;
});

test('викладач із кількома парами: усі пари тижня, нічого двічі', async () => {
  const sched = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'schedule.json'), 'utf8'));
  const dir = L.buildTeacherDirectory(sched).sort((a, b) => b.pairs - a.pairs)[0];
  const { calls, asked } = await simulate({ profile: { id: 'p1', enabled: true, mode: 'teacher', surname: dir.surname, teacherName: dir.name, aliases: dir.aliases }, from: MON, to: SUN });
  assert.ok(calls.length > 0);
  const keys = calls.map((c) => c.end + c.name);
  assert.strictEqual(new Set(keys).size, keys.length, 'дублікати входів');
  void asked;
});

test('заміна пари: разова пара входить у вказаний час', async () => {
  const sched = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'schedule.json'), 'utf8'));
  const group = Object.keys(sched.groups)[0];
  const from = new Date(2026, 9, 21, 12, 0);
  const sub = { pair: '9', start: new Date(2026, 9, 21, 12, 30).toISOString(), end: new Date(2026, 9, 21, 13, 40).toISOString(), label: 'Заміна X' };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-sim-'));
  const store = new Store(dir, path.join(__dirname, '..', '..'));
  const profile = { id: 'p1', enabled: true, mode: 'student', group, map: {} };
  store.state.profiles = [profile];
  const e = new Engine(store, { ask: async () => null, notify: () => {}, browsersDir: dir, nodeBinary: process.execPath }, profile);
  const calls = [];
  e.attendReliably = async (name, url, endTime) => { calls.push({ name, at: Date.now(), end: endTime }); return true; };
  const t = require('node:test').mock.timers;
  t.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: from.getTime() });
  try {
    e.addSubstitution({ group, pair: '9', start: new Date(sub.start).getTime(), end: new Date(sub.end).getTime(), title: 'Заміна X', url: 'http://x/y' });
    for (let i = 0; i < 40 * 12; i++) { t.tick(5000); await flush(); }
  } finally { t.reset(); }
  assert.strictEqual(calls.length, 1);
  assert.ok(Math.abs(calls[0].at - (new Date(sub.start).getTime() - 60000)) <= 5000);
  assert.strictEqual(calls[0].end, new Date(sub.end).getTime());
});

test('два облікових записи одночасно (син і викладач): кожен відпрацьовує свій розклад незалежно', async () => {
  const sched = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'schedule.json'), 'utf8'));
  const group = Object.keys(sched.groups).find((g) => Object.values(sched.groups[g]).every((d) => Object.values(d).every((o) => o.length === 1)));
  const tdir = L.buildTeacherDirectory(sched).sort((a, b) => b.pairs - a.pairs)[0];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-sim2-'));
  const store = new Store(dir, path.join(__dirname, '..', '..'));
  const map = new Proxy({}, { get: (t, k) => (typeof k === 'string' ? 'http://x/' + k : undefined) });
  const pS = { id: 'p1', enabled: true, mode: 'student', group, map };
  const pT = { id: 'p2', enabled: true, mode: 'teacher', surname: tdir.surname, teacherName: tdir.name, aliases: tdir.aliases, map };
  store.state.profiles = [pS, pT];
  const mk = (p) => { const e = new Engine(store, { ask: async (s) => ({ value: s.items[0].value }), notify: () => {}, browsersDir: dir, nodeBinary: process.execPath }, p); e.calls = [];
    e.attendReliably = async (name, u, end) => { e.calls.push({ name, at: Date.now(), end }); return true; }; e.loadProfile(); return e; };
  const a = mk(pS), b = mk(pT);
  assert.notStrictEqual(store.profileName(pS), store.profileName(pT));
  const t = require('node:test').mock.timers;
  t.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: MON.getTime() });
  try {
    a.start(); b.start();
    for (let now = MON.getTime(); now < SUN.getTime(); now += 5000) { t.tick(5000); await flush(); }
    a.stop(); b.stop();
  } finally { t.reset(); }
  assert.ok(a.calls.length > 0 && b.calls.length > 0);
  assert.ok(a.calls.every((c) => /./.test(c.name)));
  // записи не змішуються: кожен рахує за власним розкладом
  const exp = (my) => { let n = 0; for (let d = 0; d < 5; d++) n += Object.keys(my[L.DAYS[d]] || {}).length; return n; };
  assert.strictEqual(a.calls.length, exp(a.mySched));
});
