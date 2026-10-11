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
