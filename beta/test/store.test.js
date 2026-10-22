process.env.TZ = 'Europe/Kyiv';
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { Store } = require('../src/store');
const root = path.join(__dirname, '..', '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'am-store-'));

test('порожня папка: чистий стан, розклад береться з вбудованого', () => {
  const st = new Store(tmp(), root);
  assert.deepStrictEqual(st.profiles, []);
  const sched = st.loadSchedule();
  assert.ok(sched && sched.groups && sched.bells);
});

test('пошкоджений state.json відновлюється з резервної копії', () => {
  const dir = tmp();
  const a = new Store(dir, root);
  a.state.profiles = [{ id: 'p1', mode: 'student', group: 'КІ-31', enabled: true, map: { x: 'y' } }];
  a.save(); a.state.profiles[0].group = 'КІ-32'; a.save(); // тепер є .bak з попереднім станом
  fs.writeFileSync(path.join(dir, 'state.json'), '{"profiles": [{"id":'); // обрізаний запис
  const b = new Store(dir, root);
  assert.strictEqual(b.profiles.length, 1);
  assert.strictEqual(b.profiles[0].group, 'КІ-31'); // з резервної копії
});

test('пошкоджені і state, і резервна копія: програма не падає, стартує з чистого стану', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'state.json'), 'сміття');
  fs.writeFileSync(path.join(dir, 'state.json.bak'), '{{{');
  const st = new Store(dir, root);
  assert.deepStrictEqual(st.profiles, []);
  st.save(); // і зберегти можна
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')));
});

test('пошкоджений schedule.json у папці даних → вбудований розклад', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'schedule.json'), '{ "groups": ');
  const st = new Store(dir, root);
  assert.ok(st.loadSchedule().groups);
});

test('журнал не росте безмежно (ротація >512 КБ)', () => {
  const dir = tmp(); const st = new Store(dir, root);
  const line = 'x'.repeat(1000);
  for (let i = 0; i < 1500; i++) st.log(line);
  const size = fs.statSync(st.logFile).size;
  assert.ok(size < 700 * 1024, 'файл журналу завеликий: ' + size);
  assert.ok(fs.existsSync(st.logFile + '.old'));
});

test('збереження атомарне: після save() немає .tmp, файл — коректний JSON', () => {
  const dir = tmp(); const st = new Store(dir, root);
  st.state.profiles = [{ id: 'p1', mode: 'student', group: 'КІ-31' }];
  for (let i = 0; i < 50; i++) st.save();
  assert.ok(!fs.existsSync(path.join(dir, 'state.json.tmp')));
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).profiles.length, 1);
});

test('видалення акаунта чистить його профіль браузера і перемикає перегляд', () => {
  const dir = tmp(); const st = new Store(dir, root);
  st.state.profiles = [{ id: 'p1', mode: 'student', group: 'A' }, { id: 'p2', mode: 'student', group: 'B' }];
  st.state.viewId = 'p2';
  const d = st.browserProfileDir('p2', 'chrome'); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'cookie'), '1');
  st.removeProfile('p2');
  assert.ok(!fs.existsSync(d));
  assert.strictEqual(st.state.viewId, 'p1');
  assert.strictEqual(st.profiles.length, 1);
});

test('newProfileId: унікальні id, до 9', () => {
  const st = new Store(tmp(), root);
  const ids = new Set();
  for (let i = 0; i < 5; i++) { const id = st.newProfileId(); assert.ok(!ids.has(id)); ids.add(id); st.profiles.push({ id, mode: 'student', group: 'G' + i }); }
});

test('оновлення розкладу відхиляє сміття і не псує поточний файл', async () => {
  const dir = tmp(); const st = new Store(dir, root);
  fs.writeFileSync(path.join(dir, 'schedule.json'), JSON.stringify(st.loadSchedule()));
  const before = fs.readFileSync(path.join(dir, 'schedule.json'), 'utf8');
  const crypto = require('crypto');
  const junk = Buffer.from('<html>404</html>');
  st._fetch = async (name) => (name === 'manifest.json' ? Buffer.from(JSON.stringify({ files: { 'schedule.json': crypto.createHash('sha256').update(junk).digest('hex') } })) : junk);
  assert.strictEqual(await st.updateSchedule(), false);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'schedule.json'), 'utf8'), before);
  // неспівпадіння суми (CDN-кеш) теж ігнорується
  st._fetch = async (name) => (name === 'manifest.json' ? Buffer.from(JSON.stringify({ files: { 'schedule.json': 'deadbeef' } })) : Buffer.from('{"groups":{},"bells":{}}'));
  assert.strictEqual(await st.updateSchedule(), false);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'schedule.json'), 'utf8'), before);
  // мережа впала
  st._fetch = async () => { throw new Error('offline'); };
  assert.strictEqual(await st.updateSchedule(), false);
});

test('оновлення розкладу приймає коректний файл із вірною сумою', async () => {
  const dir = tmp(); const st = new Store(dir, root);
  const crypto = require('crypto');
  const good = Buffer.from(JSON.stringify({ bells: { 1: '08:30' }, groups: { 'Z-1': {} } }));
  st._fetch = async (name) => (name === 'manifest.json' ? Buffer.from(JSON.stringify({ files: { 'schedule.json': crypto.createHash('sha256').update(good).digest('hex') } })) : good);
  assert.strictEqual(await st.updateSchedule(), true);
  assert.ok(st.loadSchedule().groups['Z-1']);
});
