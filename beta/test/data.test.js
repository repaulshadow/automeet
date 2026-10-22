process.env.TZ = 'Europe/Kyiv';
'use strict';
// Перевірка самого розкладу (schedule.json) і того, що логіка не падає на жодній групі / жодному викладачеві.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const L = require('../src/logic');
const sched = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'schedule.json'), 'utf8'));
const DAYS5 = ['пн', 'вт', 'ср', 'чт', 'пт'];
const hm = (s) => /^\d{2}:\d{2}$/.test(s) && +s.slice(0, 2) < 24 && +s.slice(3) < 60;
const mins = (s) => +s.slice(0, 2) * 60 + +s.slice(3);

test('дзвінки: формат, порядок, ends коректні', () => {
  const keys = Object.keys(sched.bells);
  assert.ok(keys.length >= 4);
  let prev = -1;
  for (const k of keys.sort((a, b) => a - b)) {
    assert.ok(hm(sched.bells[k]), `дзвінок ${k}`);
    assert.ok(mins(sched.bells[k]) > prev, 'час має зростати');
    prev = mins(sched.bells[k]);
  }
  for (const [k, v] of Object.entries(sched.ends || {})) {
    assert.ok(sched.bells[k], `ends: немає дзвінка ${k}`);
    assert.ok(hm(v) && mins(v) > mins(sched.bells[k]), `ends ${k} має бути пізніше початку`);
    const next = sched.bells[String(+k + 1)];
    if (next) assert.ok(mins(v) < mins(next), `пара ${k} закінчується після початку наступної`);
  }
  if (sched.leave_after_min !== undefined) assert.ok(Number.isFinite(sched.leave_after_min) && sched.leave_after_min >= 0 && sched.leave_after_min <= 10);
});

test('кожна пара за замовчуванням закінчується до початку наступної (з перервою ≥ 5 хв)', () => {
  const day = L.startOfDay(new Date(2026, 9, 19));
  const ks = Object.keys(sched.bells).sort((a, b) => a - b);
  for (let i = 0; i < ks.length - 1; i++) {
    const end = L.pairTimes(sched, ks[i], day)[1];
    const next = L.pairTimes(sched, ks[i + 1], day)[0];
    assert.ok(next - end >= 5 * 60000, `перерва після пари ${ks[i]} < 5 хв`);
  }
});

test('групи: дні пн–пт, номери пар існують, рядки не порожні', () => {
  assert.ok(Object.keys(sched.groups).length >= 10);
  for (const [g, days] of Object.entries(sched.groups)) {
    assert.match(g, /\S/);
    for (const [day, periods] of Object.entries(days)) {
      assert.ok(DAYS5.includes(day), `${g}: дивний день «${day}»`);
      for (const [p, opts] of Object.entries(periods)) {
        assert.ok(sched.bells[p], `${g} ${day}: пари ${p} немає в дзвінках`);
        assert.ok(Array.isArray(opts) && opts.length >= 1, `${g} ${day} ${p}: немає варіантів`);
        for (const o of opts) assert.ok(typeof o === 'string' && o.trim().length > 0, `${g} ${day} ${p}: порожній рядок`);
      }
    }
  }
});

test('дані: рядки без «Предмет | Викладач» (попередження, не помилка)', () => {
  const bad = [];
  for (const [g, days] of Object.entries(sched.groups))
    for (const [day, periods] of Object.entries(days))
      for (const [p, opts] of Object.entries(periods))
        for (const o of opts) if (!o.includes(' | ') || /\?\?\?/.test(o)) bad.push(`${g} ${day} №${p}: «${o}»`);
  if (bad.length) console.log(`# УВАГА: ${bad.length} підозрілих записів у розкладі:\n#  ` + bad.join('\n#  '));
  assert.ok(bad.length < 60, 'підозріло багато некоректних записів');
});

test('довідник викладачів: унікальні id, усі групи існують, пари є', () => {
  const dir = L.buildTeacherDirectory(sched);
  assert.ok(dir.length >= 20);
  const ids = new Set();
  for (const t of dir) {
    assert.ok(!ids.has(t.id), 'дублікат id ' + t.id); ids.add(t.id);
    assert.ok(t.name && t.surname);
    assert.ok(t.pairs > 0, t.name + ': 0 пар');
    assert.ok(L.findTeacher(dir, t.name), 'findTeacher не знаходить ' + t.name);
  }
});

test('жодна комбінація група/викладач × момент тижня не кидає помилку (2 тижні, крок 7 хв, з суботами)', () => {
  const explicit = { '2026-10-17': 'ср' }; // субота «замінює» середу
  const dir = L.buildTeacherDirectory(sched);
  const mine = [];
  for (const g of Object.keys(sched.groups)) mine.push(sched.groups[g]);
  for (const t of dir.slice(0, 40)) mine.push(L.teacherSchedule(sched, t.aliases && t.aliases.length ? t.aliases : t.surname));
  let checked = 0;
  for (let t = new Date(2026, 9, 19, 0, 0).getTime(); t < new Date(2026, 9, 19 + 14, 0, 0).getTime(); t += 7 * 60000) {
    const now = new Date(t);
    for (const my of mine) {
      const s = L.computeStatus(sched, my, now, explicit, []);
      assert.ok(s && typeof s === 'object');
      checked++;
    }
  }
  assert.ok(checked > 10000);
});

test('кожна пара кожної групи отримує ненульову тривалість і коректні дати', () => {
  const day = L.startOfDay(new Date(2026, 9, 21));
  for (const p of Object.keys(sched.bells)) {
    const [s, e] = L.pairTimes(sched, p, day);
    assert.ok(e > s && !Number.isNaN(s.getTime()) && !Number.isNaN(e.getTime()));
  }
});
