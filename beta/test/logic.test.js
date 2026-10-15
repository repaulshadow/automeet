process.env.TZ = 'Europe/Kyiv';
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const L = require('../src/logic');
const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures.json'), 'utf8'));
const sched = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'schedule.json'), 'utf8'));
const close = (a, b) => Math.abs(a - b) < 1e-9;

test('SequenceMatcher ratio збігається з Python', () => {
  for (const [a, b, r] of fx.ratio) assert.ok(close(L.seqRatio(a, b), r), `${a}/${b}: ${L.seqRatio(a, b)} vs ${r}`);
});
test('оцінка предмета збігається з Python', () => {
  for (const [a, b, r] of fx.subject) assert.ok(close(L.subjectScore(a, b), r), `${a}/${b}: ${L.subjectScore(a, b)} vs ${r}`);
});
test('бонус за викладача', () => {
  for (const [t, x, r] of fx.bonus) assert.ok(close(L.teacherBonus(t, x), r));
});
test('суботи по колу', () => {
  for (const [d, want] of fx.eff) assert.strictEqual(L.effectiveDay(L.parseIso(d), fx.sats), want, d);
});
test('розклад викладача', () => {
  assert.deepStrictEqual(L.teacherSchedule(sched, 'Мазур'), fx.teacher);
  assert.deepStrictEqual(L.teacherSchedule(sched, 'Aліев'), fx.teacher2);
});
test('статус (таймер) збігається', () => {
  const my = sched.groups['КІ-31'];
  for (const [iso, want] of fx.status) {
    const [dpart, tpart] = iso.split('T');
    const [y, m, d] = dpart.split('-').map(Number);
    const [hh, mm] = tpart.split(':').map(Number);
    const got = L.computeStatus(sched, my, new Date(y, m - 1, d, hh, mm), fx.sats, []);
    assert.strictEqual(got.phase, want.phase, iso);
    assert.strictEqual(got.pair, want.pair, iso);
    assert.strictEqual(got.label, want.label, iso);
    assert.strictEqual(got.target, want.target, iso);
  }
});
test('підказки: наступна пара й скільки лишилось', () => {
  const my = sched.groups['КІ-31'];
  const got = L.computeStatus(sched, my, new Date(2026, 9, 13, 11, 0), {}, []);
  assert.strictEqual(got.pair, '2');
  assert.strictEqual(got.leftToday, 3);
  assert.ok(got.next.startsWith('№3 о 11:30'));
});
test('разова заміна потрапляє в таймер', () => {
  const my = sched.groups['КІ-31'];
  const sub = { start: new Date(2026, 9, 13, 12, 0).toISOString(), end: new Date(2026, 9, 13, 13, 20).toISOString(), pair: '3', label: 'КІ-21: X' };
  const items = L.dayPairs(sched, my, new Date(2026, 9, 13), {}, [sub]);
  assert.ok(items.some((x) => x.sub && x.label === 'Заміна · КІ-21: X'));
});
test('парність тижня', () => {
  for (const [d, want] of fx.parity) assert.strictEqual(L.weekParity(L.parseIso(d)), want, d);
});
test('курс групи', () => {
  for (const [g, c] of fx.courses) assert.strictEqual(L.groupCourse(g), c, g);
});
test('buildOptions', () => {
  const key = (x) => x.join('|');
  const got = L.buildOptions(L.teacherSchedule(sched, 'Мазур'), true).map((x) => [x.option, x.group]).map(key).sort();
  const want = fx.opts.map(key).sort();
  assert.ok(want.every((w) => got.includes(w)));
});

test('список викладачів: варіанти одного прізвища об\'єднані, різні люди — ні', () => {
  const dir = L.buildTeacherDirectory(sched);
  const by = (surname) => dir.find((x) => x.surname === surname);
  const names = dir.map((x) => x.surname);
  // однакові люди
  assert.deepStrictEqual(by("П'ятниченко").aliases, ['пятниченк', 'пятниченко', 'пятніченко']);
  assert.deepStrictEqual(by('Сухих').aliases, ['сухих', 'сухіх']);
  assert.deepStrictEqual(by('Головіна').aliases, ['голвіна', 'головіна']);
  assert.ok(by('Лиховидова').aliases.includes('лиховидоа'));
  // різні люди (чоловік/жінка) не зливаються
  for (const [a, b] of [['Калугін', 'Калугіна'], ['Лиховидов', 'Лиховидова'], ['Семенов', 'Семенова']]) {
    assert.ok(names.includes(a) && names.includes(b), `${a}/${b} мають бути окремо`);
  }
  // сміття відсутнє
  for (const bad of ['***', '2', 'с.а']) assert.ok(!dir.some((x) => x.aliases.some((al) => al.includes(bad))), bad);
  assert.ok(dir.length >= 60 && dir.length <= 70);
});

test('пари викладача знаходяться за всіма написаннями', () => {
  const dir = L.buildTeacherDirectory(sched);
  const t = dir.find((x) => x.surname === "П'ятниченко");
  const all = Object.values(L.teacherSchedule(sched, t.aliases)).flatMap((d) => Object.values(d)).flat().length;
  const one = Object.values(L.teacherSchedule(sched, "П'ятниченко")).flatMap((d) => Object.values(d)).flat().length;
  assert.ok(all > one, `${all} має бути більше за ${one}`);
});

test('ручні налаштування teachers у schedule.json: merge / split / hide', () => {
  const s2 = JSON.parse(JSON.stringify(sched));
  s2.teachers = { merge: [['Терещенко', 'Трешенко']], split: [['Пятниченк', 'Пятниченко']], hide: ['Козел'] };
  const dir = L.buildTeacherDirectory(s2);
  assert.ok(dir.some((x) => x.aliases.includes('терещенко') && x.aliases.includes('трешенко')));
  assert.ok(!dir.some((x) => x.surname === 'Козел'));
  assert.ok(dir.some((x) => x.aliases.length === 1 && x.aliases[0] === 'пятниченк'));
});

test('пошук викладача за введеним прізвищем', () => {
  const dir = L.buildTeacherDirectory(sched);
  assert.strictEqual(L.findTeacher(dir, 'Aлієв Р.').surname, 'Алієв');   // латинська «A»
  assert.strictEqual(L.findTeacher(dir, 'невідомий'), null);
});

test('Store: міграція, імена, ліміт', () => {
  const fs = require('fs'), os = require('os'), path = require('path');
  const { Store } = require('../src/store');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-st-'));
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ mode: 'teacher', surname: 'Мазур', teacherName: 'Мазур Г.В.', map: { a: 1 } }));
  const st = new Store(dir, path.join(__dirname, '..', '..'));
  assert.equal(st.profiles.length, 1);
  assert.equal(st.profiles[0].id, 'p1');
  assert.equal(st.profileName(st.profiles[0]), 'Мазур Г.В.');
  assert.ok(st.browserProfileDir('p1', 'chrome').endsWith(path.join('profiles', 'chrome')));
  assert.ok(st.browserProfileDir('p2', 'chrome').endsWith('p2-chrome'));
  st.profiles.push({ id: 'p2', mode: 'teacher', teacherName: 'Мазур Г.В.' });
  assert.notEqual(st.profileName(st.profiles[0]), st.profileName(st.profiles[1]));
  assert.equal(st.newProfileId(), 'p3');
  st.removeProfile('p2');
  assert.equal(st.profiles.length, 1);
});
