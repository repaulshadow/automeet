'use strict';
// Чиста логіка (без Electron/Playwright): розклад, суботи, пошук викладача,
// порівняння назв предметів з курсами Classroom. Портовано з auto_meet.py.

const DAYS = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'нд'];
const STOP = new Set(['за', 'пс', 'і', 'та', 'й', 'в', 'на', 'по']);
const DURATION_MIN = 80;

// ---------- дати ----------
function pad(n) { return String(n).padStart(2, '0'); }
function isoDate(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function parseIso(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
}
/** Понеділок = 0 … неділя = 6 (як у Python weekday()). */
function weekday(d) { return (d.getDay() + 6) % 7; }
function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function addDays(d, n) { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes(), d.getSeconds()); return x; }
function daysBetween(a, b) {
  return Math.round((Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) -
    Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / 86400000);
}
/** Номер ISO-тижня (як date.isocalendar()[1]). */
function isoWeek(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
}
function weekParity(d) { return String(isoWeek(d) % 2); }

// ---------- нечітке порівняння ----------
/** Аналог difflib.SequenceMatcher(None, a, b).ratio() для коротких рядків. */
function seqRatio(a, b) {
  const A = Array.from(a), B = Array.from(b);
  function longest(alo, ahi, blo, bhi) {
    let bi = alo, bj = blo, bk = 0;
    let prev = new Array(B.length + 1).fill(0);
    for (let i = alo; i < ahi; i++) {
      const cur = new Array(B.length + 1).fill(0);
      for (let j = blo; j < bhi; j++) {
        if (A[i] === B[j]) {
          const k = (prev[j] || 0) + 1;
          cur[j + 1] = k;
          if (k > bk) { bi = i - k + 1; bj = j - k + 1; bk = k; }
        }
      }
      prev = cur;
    }
    return [bi, bj, bk];
  }
  function matches(alo, ahi, blo, bhi) {
    if (alo >= ahi || blo >= bhi) return 0;
    const [i, j, k] = longest(alo, ahi, blo, bhi);
    if (!k) return 0;
    return k + matches(alo, i, blo, j) + matches(i + k, ahi, j + k, bhi);
  }
  const total = A.length + B.length;
  return total ? (2 * matches(0, A.length, 0, B.length)) / total : 1;
}

function norm(s) {
  return s.toLowerCase().replace(/['’ʼ`]/g, '')
    .replace(/[^\p{L}\p{N}_\s]/gu, ' ').split(/\s+/).filter(Boolean);
}

function tokSim(a, b) {
  if (a === b) return 1.0;
  if (a.length >= 3 && b.length >= 3 && (b.startsWith(a) || a.startsWith(b))) return 0.9;
  const r = seqRatio(a, b);
  return r >= 0.75 ? r : 0.0;
}

function subjectScore(subject, title) {
  const st = norm(subject).filter((t) => !STOP.has(t));
  const ct = norm(title);
  if (!st.length || !ct.length) return 0.0;
  const acr = ct.filter((c) => !STOP.has(c)).map((c) => Array.from(c)[0]).join('');
  const scores = st.map((t) => {
    let best = Math.max(...ct.map((c) => tokSim(t, c)));
    if (t.length >= 2 && acr.length >= 2 && (acr.startsWith(t) || t.startsWith(acr))) best = Math.max(best, 0.8);
    return best;
  });
  return scores.reduce((x, y) => x + y, 0) / scores.length;
}

function teacherBonus(teacher, text) {
  const hay = norm(text).join('');
  for (const part of teacher.split(/[/,]/)) {
    const stem = norm(part).join('').slice(0, 5);
    if (stem.length >= 4 && hay.includes(stem)) return 0.2;
  }
  return 0.0;
}

function parseOption(opt) {
  opt = opt.replace(/^\?+/, '').trim();
  const i = opt.indexOf('|');
  if (i < 0) return [opt.trim(), ''];
  return [opt.slice(0, i).trim(), opt.slice(i + 1).trim()];
}

function rank(option, courses) {
  const [subj, teacher] = parseOption(option);
  const res = courses.map((c) => [Math.min(1.0, subjectScore(subj, c.title) + teacherBonus(teacher, c.text)), c]);
  res.sort((x, y) => y[0] - x[0]);
  return res;
}

function normCode(s) { return s.replace(/[^0-9a-zA-Zа-яА-ЯіІїЇєЄ]/g, '').toLowerCase(); }
function filterByGroup(courses, group) {
  const code = normCode(group);
  const hits = courses.filter((c) => normCode(c.title).includes(code));
  return hits.length ? hits : courses;
}

// ---------- викладачі ----------
const HOMOGLYPHS = { a: 'а', e: 'е', i: 'і', o: 'о', p: 'р', c: 'с', x: 'х' };
function normName(s) {
  return Array.from(s.toLowerCase()).map((ch) => HOMOGLYPHS[ch] || ch).join('')
    .replace(/['’ʼ`]/g, '').replace(/-/g, ' ').trim();
}
function surnameMatches(target, part) {
  const t = normName(target).split(/\s+/).filter(Boolean);
  const p = normName(part).split(/\s+/).filter(Boolean);
  if (!t.length || !p.length) return false;
  return t[0] === p[0];
}

/** Персональний розклад викладача: day -> pair -> ["ГРУПА: Предмет | Викладач"]. */
function teacherSchedule(sched, surname) {
  const names = Array.isArray(surname) ? surname : [surname];
  const out = {};
  for (const [group, days] of Object.entries(sched.groups)) {
    for (const [day, periods] of Object.entries(days)) {
      for (const [period, opts] of Object.entries(periods)) {
        for (const opt of opts) {
          const maybe = opt.startsWith('?');
          const [subj, teacher] = parseOption(opt);
          if (!teacher) continue;
          if (!teacher.split(/[/,]/).some((p) => names.some((n) => surnameMatches(n, p)))) continue;
          const label = `${maybe ? '?' : ''}${group}: ${subj} | ${teacher}`;
          out[day] = out[day] || {};
          out[day][period] = out[day][period] || [];
          if (!out[day][period].includes(label)) out[day][period].push(label);
        }
      }
    }
  }
  return out;
}


// ---------- список викладачів (для вибору зі списку) ----------
/** «Скелет» прізвища: прибирає різницю и/і/ї, є/е, апострофи, латиницю-двійників. */
function skeleton(w) {
  return normName(w).replace(/[иыї]/g, 'і').replace(/[єёэ]/g, 'е').replace(/ъ/g, '');
}

/** Чи ймовірно, що a і b — той самий викладач (різні написання/описки одного прізвища). */
function sameTeacher(a, b) {
  if (a === b) return true;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  if (s.length < 5) return false;
  // обрізане прізвище: «пятніченк» ~ «пятніченко», але НЕ «калугін» ~ «калугіна» (жіноча форма)
  if (l.length - s.length === 1 && l.startsWith(s) && !'ая'.includes(l[l.length - 1])) return true;
  // одна пропущена/зайва/замінена літера всередині, при тому самому закінченні
  if (l[l.length - 1] !== s[s.length - 1]) return false;
  if (l.length === s.length) {
    let diff = 0;
    for (let i = 0; i < l.length; i++) if (l[i] !== s[i]) diff++;
    return diff === 1 && l.length >= 7;
  }
  if (l.length - s.length === 1 && l.length >= 7) {
    for (let i = 0; i < l.length; i++) if (l.slice(0, i) + l.slice(i + 1) === s) return true;
  }
  return false;
}

/**
 * Список викладачів зі schedule.json: [{id, name, aliases, pairs}] за абеткою.
 * aliases — усі написання прізвища (для пошуку пар), pairs — скільки записів у розкладі.
 * Необов'язкове налаштування в schedule.json:
 *   "teachers": { "merge": [["Лиховидоа","Лиховидова"]], "split": [["Калугін","Калугіна"]], "hide": ["ТБД"] }
 * merge — примусово об'єднати; split — примусово НЕ об'єднувати; hide — не показувати.
 */
function buildTeacherDirectory(sched) {
  const cfg = sched.teachers || {};
  const hide = new Set((cfg.hide || []).map(skeleton));
  const variants = new Map(); // skeleton -> {raw: Map(rawWord->count), norms:Set, rests: Map, pairs}
  for (const days of Object.values(sched.groups)) {
    for (const periods of Object.values(days)) {
      for (const opts of Object.values(periods)) {
        for (const opt of opts) {
          const [, teacher] = parseOption(opt);
          if (!teacher || teacher.includes('*')) continue;
          for (const part of teacher.split(/[/,]/)) {
            const toks = part.trim().split(/\s+/);
            const word = (toks[0] || '').replace(/[.,;:()]+$/g, '');
            if (!/^[\p{L}'’ʼ`-]{3,}$/u.test(word)) continue;
            const key = skeleton(word);
            if (hide.has(key)) continue;
            let v = variants.get(key);
            if (!v) { v = { raw: new Map(), norms: new Set(), rests: new Map(), pairs: 0 }; variants.set(key, v); }
            v.raw.set(word, (v.raw.get(word) || 0) + 1);
            v.norms.add(normName(word));
            v.pairs++;
            const rest = toks.slice(1).join('').replace(/\(.*?\)/g, '').replace(/[,;]+$/g, '');
            if (rest && /^[\p{L}.]+$/u.test(rest)) v.rests.set(rest, (v.rests.get(rest) || 0) + 1);
          }
        }
      }
    }
  }
  // об'єднання схожих
  const keys = [...variants.keys()];
  const parent = new Map(keys.map((k) => [k, k]));
  const find = (k) => { while (parent.get(k) !== k) { parent.set(k, parent.get(parent.get(k))); k = parent.get(k); } return k; };
  const union = (a, b) => { const x = find(a), y = find(b); if (x !== y) parent.set(x, y); };
  const splitPairs = new Set();
  for (const grp of cfg.split || []) for (const a of grp) for (const b of grp) splitPairs.add(skeleton(a) + '|' + skeleton(b));
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      if (splitPairs.has(keys[i] + '|' + keys[j])) continue;
      if (sameTeacher(keys[i], keys[j])) union(keys[i], keys[j]);
    }
  }
  for (const grp of cfg.merge || []) {
    const ks = grp.map(skeleton).filter((k) => variants.has(k));
    for (let i = 1; i < ks.length; i++) union(ks[0], ks[i]);
  }
  const clusters = new Map();
  for (const k of keys) {
    const r = find(k);
    if (!clusters.has(r)) clusters.set(r, []);
    clusters.get(r).push(variants.get(k));
  }
  const out = [];
  for (const members of clusters.values()) {
    const raw = new Map(), rests = new Map();
    const aliases = new Set();
    let pairs = 0;
    for (const m of members) {
      for (const [w, c] of m.raw) raw.set(w, (raw.get(w) || 0) + c);
      for (const [w, c] of m.rests) rests.set(w, (rests.get(w) || 0) + c);
      m.norms.forEach((n) => aliases.add(n));
      pairs += m.pairs;
    }
    const top = (map) => [...map.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)[0];
    // показуємо найповніше з частих написань (з апострофом тощо)
    const name = top(raw)[0];
    // ініціали: бажано повні («Г.В.»), а не уривок («Г»)
    const full = new Map([...rests].filter(([w]) => /^[\p{L}]\.?[\p{L}]\.?$/u.test(w)));
    let initials = full.size ? top(full)[0] : (rests.size ? top(rests)[0] : '');
    if (/^[\p{L}]\.[\p{L}]$/u.test(initials)) initials += '.';
    else if (/^[\p{L}][\p{L}]$/u.test(initials)) initials = `${initials[0]}.${initials[1]}.`;
    out.push({ name: initials ? `${name} ${initials}` : name, surname: name, aliases: [...aliases].sort(), pairs });
  }
  out.sort((a, b) => a.surname.localeCompare(b.surname, 'uk'));
  out.forEach((t, i) => { t.id = String(i); });
  return out;
}

/** Знаходить викладача зі списку за введеним вручну прізвищем (або null). */
function findTeacher(directory, typed) {
  const n = normName(typed || '').split(/\s+/)[0];
  if (!n) return null;
  return directory.find((t) => t.aliases.includes(n)) || null;
}

function groupCourse(name) {
  const m = /-\s*(\d)/.exec(name);
  return m ? +m[1] : 0;
}

/** [{course:1, groups:[...]}] — групи за курсами й абеткою. */
function groupsByCourse(groups) {
  const by = new Map();
  for (const g of groups) {
    const c = groupCourse(g);
    if (!by.has(c)) by.set(c, []);
    by.get(c).push(g);
  }
  return [...by.keys()].sort((a, b) => a - b).map((c) => ({ course: c, groups: by.get(c).sort((x, y) => x.localeCompare(y, 'uk')) }));
}

// ---------- суботи ----------
/** Що відомо про суботу d: «пн»…«пт», «нема» або null. explicit = {"YYYY-MM-DD": "пн"}. */
function saturdayValue(d, explicit) {
  explicit = explicit || {};
  const key = isoDate(d);
  if (explicit[key]) return explicit[key];
  let best = null;
  for (const [k, v] of Object.entries(explicit)) {
    const kd = parseIso(k);
    if (!kd || !DAYS.slice(0, 5).includes(v) || !(kd < startOfDay(d))) continue;
    if (!best || kd > best[0]) best = [kd, v];
  }
  if (!best) return null;
  const weeks = Math.floor(daysBetween(best[0], d) / 7);
  return DAYS[(DAYS.indexOf(best[1]) + weeks) % 5];
}

function effectiveDay(d, explicit) {
  const wd = weekday(d);
  if (wd < 5) return DAYS[wd];
  if (wd === 5) {
    const v = saturdayValue(d, explicit);
    return DAYS.slice(0, 5).includes(v) ? v : null;
  }
  return null;
}

// ---------- час пар ----------
function setHM(d, hm) {
  const [h, m] = hm.split(':').map(Number);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m, 0, 0);
}
function pairTimes(sched, pair, dayDate) {
  const start = setHM(dayDate, sched.bells[pair]);
  const fixed = (sched.ends || {})[pair];
  if (fixed) return [start, setHM(dayDate, fixed)];
  return [start, new Date(start.getTime() + DURATION_MIN * 60000)];
}
function labelOf(opts) {
  return opts.map((o) => o.replace(/^\?+/, '').trim()).filter(Boolean).join(' / ');
}

/** Пари дня разом із разовими замінами: [{pair,start,end,label,sub}]. */
function dayPairs(sched, mySched, dayDate, explicit, subs) {
  const items = [];
  const day = effectiveDay(dayDate, explicit);
  const periods = (day && mySched[day]) || {};
  for (const pair of Object.keys(periods).sort((a, b) => a - b)) {
    const label = labelOf(periods[pair]);
    if (!label) continue;
    const [start, end] = pairTimes(sched, pair, dayDate);
    items.push({ pair, start, end, label, sub: false });
  }
  for (const sb of subs || []) {
    if (isoDate(new Date(sb.start)) === isoDate(dayDate)) {
      items.push({ pair: sb.pair, start: new Date(sb.start), end: new Date(sb.end), label: 'Заміна · ' + sb.label, sub: true });
    }
  }
  items.sort((a, b) => a.start - b.start);
  return items;
}

const fmtHM = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

function computeStatus(sched, mySched, now, explicit, subs) {
  for (let offset = 0; offset < 8; offset++) {
    const dayDate = startOfDay(addDays(now, offset));
    const items = dayPairs(sched, mySched, dayDate, explicit, subs);
    for (let idx = 0; idx < items.length; idx++) {
      const it = items[idx];
      if (offset === 0 && now >= it.end) continue;
      const phase = offset === 0 && now >= it.start ? 'during' : 'before';
      const nxt = items[idx + 1];
      const left = offset === 0 ? items.filter((x) => x.end > now).length : items.length;
      return {
        phase, target: (phase === 'during' ? it.end : it.start).getTime(),
        pair: it.pair, label: it.label, startHM: fmtHM(it.start), endHM: fmtHM(it.end),
        dayOffset: offset, dayDate: `${pad(dayDate.getDate())}.${pad(dayDate.getMonth() + 1)}`,
        leftToday: offset === 0 ? left : 0,
        next: nxt ? `№${nxt.pair} о ${fmtHM(nxt.start)} — ${nxt.label}` : '',
      };
    }
  }
  return { phase: 'none', target: null, pair: null, label: '' };
}

/** Чи є ще пари сьогодні (для питання при автозапуску). */
function pairsLeftToday(sched, mySched, now, explicit, subs) {
  if (weekday(now) === 5 && saturdayValue(now, explicit) === null) return true;
  return dayPairs(sched, mySched, startOfDay(now), explicit, subs).some((x) => x.end > now);
}

/** Унікальні пари розкладу: [{option, group}]. */
function buildOptions(mySched, isTeacher) {
  const out = [];
  const seen = new Set();
  for (const periods of Object.values(mySched)) {
    for (const opts of Object.values(periods)) {
      for (const raw of opts) {
        const o = raw.replace(/^\?+/, '').trim();
        if (!o) continue;
        const group = isTeacher ? o.split(':')[0].trim() : null;
        const key = o + '\u0000' + group;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ option: o, group });
      }
    }
  }
  return out;
}

module.exports = {
  DAYS, DURATION_MIN, isoDate, parseIso, weekday, startOfDay, addDays, isoWeek, weekParity,
  seqRatio, norm, tokSim, subjectScore, teacherBonus, parseOption, rank, normCode, filterByGroup,
  normName, surnameMatches, teacherSchedule, skeleton, sameTeacher, buildTeacherDirectory, findTeacher, groupCourse, groupsByCourse,
  saturdayValue, effectiveDay, pairTimes, dayPairs, computeStatus, pairsLeftToday, buildOptions, labelOf,
};
