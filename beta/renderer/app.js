'use strict';
const $ = (id) => document.getElementById(id);
let state = { phase: 'none' };

function fmt(ms) {
  if (ms < 0) ms = 0;
  const t = Math.floor(ms / 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(Math.floor(t / 3600))}:${p(Math.floor((t % 3600) / 60))}:${p(t % 60)}`;
}

function render() {
  document.body.className = state.phase === 'during' ? 'during' : '';
  $('identity').textContent = state.identity || 'Auto Meet';
  $('dot').className = 'dot ' + (state.phase === 'during' ? 'during' : state.phase === 'none' ? 'none' : '');
  const canSub = !!state.canSubstitute;
  $('subBtn').hidden = !canSub;
  $('subHint').hidden = !canSub;
  const oth = $('others');
  oth.hidden = !(state.others && state.others.length);
  oth.replaceChildren(...((state.others || []).map((o) => {
    const d = document.createElement('div');
    const b = document.createElement('b'); b.textContent = o.name;
    d.append('Також працює: ', b, ' — ', o.line);
    return d;
  })));
  if (state.phase === 'none' || !state.target) {
    $('phaseText').textContent = state.mode ? 'Пар найближчим часом немає' : 'Потрібне налаштування';
    $('timer').textContent = '--:--:--';
    ['label', 'sub', 'next', 'left'].forEach((id) => { $(id).textContent = ''; });
    return;
  }
  const diff = state.target - Date.now();
  $('timer').textContent = fmt(diff);
  $('label').textContent = state.label || '';
  const when = !state.dayOffset ? '' : (state.dayOffset === 1 ? 'завтра, ' : state.dayDate + ', ');
  $('sub').textContent = `Пара №${state.pair} · ${when}${state.startHM}–${state.endHM}`;
  $('next').textContent = state.next ? 'Далі: ' + state.next : '';
  $('left').textContent = state.leftToday ? `Пар сьогодні лишилось: ${state.leftToday}` : '';
  $('phaseText').textContent = state.phase === 'during' ? 'Йде пара · до завершення'
    : (diff <= 0 ? 'Заходимо…' : 'До початку пари');
}

function addLog(line) {
  const box = $('log');
  const d = document.createElement('div');
  d.textContent = line;
  box.appendChild(d);
  while (box.children.length > 40) box.removeChild(box.firstChild);
  box.scrollTop = box.scrollHeight;
}

// ---------- діалоги ----------
const dlg = { id: null };
function closeDialog() { $('modal').hidden = true; $('dialog').classList.remove('wide'); $('dialog').replaceChildren(); dlg.id = null; }
function reply(value) { if (dlg.id != null) window.api.askReply(dlg.id, value); closeDialog(); }
function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  Object.assign(e, props);
  kids.forEach((k) => e.append(k));
  return e;
}
function header(spec) {
  const out = [el('h2', { textContent: spec.title || '' })];
  if (spec.text) out.push(el('p', { textContent: spec.text }));
  return out;
}

// для пошуку: без апострофів, и=і=ї, є=е (щоб «пятн» знаходило «П'ятниченко»)
const fold = (s) => s.toLowerCase().replace(/['’ʼ`]/g, '').replace(/[иыї]/g, 'і').replace(/[єёэ]/g, 'е');

function showChoose(spec) {
  const d = $('dialog');
  let items = spec.items;
  let sel = Math.max(0, items.findIndex((i) => i.value === spec.default));
  let shown = items;
  const list = el('div', { className: 'list', role: 'listbox' });
  const search = items.length > 10 ? el('input', { type: 'search', placeholder: 'Пошук…', autofocus: true }) : null;
  const ok = el('button', { className: 'primary', textContent: 'OK' });
  ok.style.marginTop = '0';
  const draw = () => {
    list.replaceChildren();
    if (!shown.length) list.append(el('div', { className: 'empty', textContent: 'Нічого не знайдено' }));
    shown.forEach((it, i) => {
      const b = el('button', { textContent: it.label, className: i === sel ? 'sel' : '' });
      b.onclick = () => { sel = i; draw(); };
      b.ondblclick = () => reply(it.value);
      list.append(b);
    });
    const cur = list.querySelector('.sel'); if (cur) cur.scrollIntoView({ block: 'nearest' });
  };
  if (search) search.oninput = () => {
    const q = fold(search.value.trim());
    shown = q ? items.filter((i) => i.sticky || fold(i.label).includes(q)) : items;
    sel = 0; draw();
  };
  ok.onclick = () => { if (shown[sel]) reply(shown[sel].value); };
  const cancel = el('button', { textContent: 'Скасувати' });
  cancel.onclick = () => reply(null);
  const acts = el('div', { className: 'actions' });
  if (spec.allowSkip) { const s = el('button', { textContent: spec.skipLabel || 'Пропустити' }); s.onclick = () => reply(null); acts.append(s); }
  else acts.append(cancel);
  acts.append(ok);
  d.append(...header(spec), ...(search ? [search] : []), list, acts);
  d.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); ok.onclick(); }
    else if (e.key === 'Escape') reply(null);
    else if (e.key === 'ArrowDown' && sel < shown.length - 1) { sel++; draw(); e.preventDefault(); }
    else if (e.key === 'ArrowUp' && sel > 0) { sel--; draw(); e.preventDefault(); }
  };
  draw();
  (search || ok).focus();
}

const ICONS = {
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  trash: '<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/><path d="M10 11v6M14 11v6"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/><path d="M9 15l2 2 4-4"/>',
  download: '<path d="M12 3v12"/><path d="M7 11l5 5 5-5"/><path d="M4 20h16"/>',
  power: '<path d="M12 3v9"/><path d="M6.3 6.8a8 8 0 1 0 11.4 0"/>',
  file: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5M10 13h6M10 17h6"/>',
};
function icon(name) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('class', 'ico');
  s.innerHTML = ICONS[name] || '';
  return s;
}

function showSettings(spec) {
  const d = $('dialog');
  d.classList.add('wide');
  const body = el('div', { className: 'sgroups' });
  for (const g of spec.groups) {
    const row = el('div', { className: 'tiles' });
    for (const t of g.tiles) {
      const b = el('button', { className: 'tile' + (t.danger ? ' danger' : '') + (t.toggle !== undefined ? (t.toggle ? ' on' : ' off') : '') });
      const ic = el('span', { className: 'tico' }); ic.append(icon(t.icon));
      if (t.toggle !== undefined) ic.append(el('span', { className: 'badge', textContent: t.toggle ? '✓' : '' }));
      b.append(ic, el('span', { className: 'tl', textContent: t.label }), el('span', { className: 'ts', textContent: t.sub || '' }));
      b.onclick = () => reply(t.value);
      row.append(b);
    }
    body.append(el('div', { className: 'gtitle', textContent: g.title }), row);
  }
  const close = el('button', { textContent: 'Закрити' });
  close.onclick = () => reply(null);
  const foot = el('div', { className: 'sfoot' });
  for (const f of spec.footer || []) {
    const b = el('button', { className: 'ghost tiny', title: f.label });
    b.setAttribute('aria-label', f.label);
    b.append(icon(f.icon)); b.onclick = () => reply(f.value); foot.append(b);
  }
  foot.append(close);
  d.append(...header(spec), body, foot);
  d.onkeydown = (e) => { if (e.key === 'Escape') reply(null); };
  close.focus();
}

function showGroup(spec) {
  const d = $('dialog');
  const courses = spec.groups; // [{course, groups}]
  let cur = 0;
  const tabs = el('div', { className: 'tabs' });
  const chips = el('div', { className: 'chips' });
  const search = el('input', { type: 'search', placeholder: 'Пошук групи…' });
  const draw = () => {
    const q = search.value.trim().toLowerCase();
    tabs.replaceChildren(...courses.map((c, i) => {
      const b = el('button', { textContent: `${c.course ? c.course + ' курс' : 'Інші'} (${c.groups.length})`, className: i === cur && !q ? 'sel' : '' });
      b.onclick = () => { cur = i; search.value = ''; draw(); };
      return b;
    }));
    const pool = q ? courses.flatMap((c) => c.groups).filter((g) => g.toLowerCase().includes(q)) : courses[cur].groups;
    chips.replaceChildren(...pool.map((g) => { const b = el('button', { textContent: g }); b.onclick = () => reply(g); return b; }));
    if (!pool.length) chips.append(el('div', { className: 'empty', textContent: 'Нічого не знайдено' }));
  };
  search.oninput = draw;
  const cancel = el('button', { textContent: 'Скасувати' });
  cancel.onclick = () => reply(null);
  d.append(...header(spec), tabs, search, chips, el('div', { className: 'actions' }, cancel));
  d.onkeydown = (e) => { if (e.key === 'Escape') reply(null); };
  draw(); search.focus();
}

function showText(spec) {
  const d = $('dialog');
  const input = el('input', { type: 'text', value: spec.default || '' });
  const ok = el('button', { className: 'primary', textContent: 'OK' });
  ok.style.marginTop = '0';
  ok.onclick = () => reply(input.value.trim() || null);
  const cancel = el('button', { textContent: 'Скасувати' });
  cancel.onclick = () => reply(null);
  d.append(...header(spec), input, el('div', { className: 'actions' }, cancel, ok));
  d.onkeydown = (e) => { if (e.key === 'Enter') ok.onclick(); else if (e.key === 'Escape') reply(null); };
  input.focus();
}

function showInfo(spec) {
  const d = $('dialog');
  const ok = el('button', { className: 'primary', textContent: 'OK' });
  ok.style.marginTop = '0';
  ok.onclick = () => reply('ok');
  d.append(...header(spec), el('div', { className: 'actions' }, ok));
  d.onkeydown = (e) => { if (e.key === 'Enter' || e.key === 'Escape') reply('ok'); };
  ok.focus();
}

window.api.onAsk((spec) => {
  closeDialog();
  dlg.id = spec.id;
  $('busy').hidden = true;
  $('modal').hidden = false;
  ({ settings: showSettings, choose: showChoose, group: showGroup, text: showText, info: showInfo }[spec.kind] || showInfo)(spec);
});
window.api.onAskCancel(({ id }) => { if (dlg.id === id) closeDialog(); });
window.api.onBusy((text) => { $('busy').hidden = !text; $('busyText').textContent = text || ''; });
window.api.onStatus((s) => { state = s; render(); });
window.api.onStatusText((t) => { $('statusText').textContent = 'Статус: ' + t; });
window.api.onLog(addLog);
// ---------- облікові записи ----------
let accts = { accounts: [], max: 5 };
function renderAccounts() {
  const cur = accts.accounts.find((a) => a.viewing) || accts.accounts[0];
  $('acctName').textContent = cur ? cur.name : 'Обліковий запис';
  $('acctAvatar').textContent = cur ? cur.name.trim().charAt(0).toUpperCase() : '?';
  const menu = $('acctMenu');
  menu.replaceChildren();
  menu.append(el('div', { className: 'head', textContent: 'Облікові записи: клацніть, щоб переглянути; галочка «Працює» — запускати на парі' }));
  accts.accounts.forEach((a) => {
    const who = el('button', { className: 'who', title: 'Показати цей обліковий запис' }, el('b', { textContent: a.name }), el('small', { textContent: a.sub }));
    who.onclick = () => { window.api.command('select-account', a.id); };
    const cb = el('input', { type: 'checkbox', checked: a.enabled });
    cb.onchange = () => window.api.command('toggle-account', { id: a.id, enabled: cb.checked });
    const lab = el('label', { title: 'Запускати цей обліковий запис за розкладом' }, cb, 'Працює');
    const ren = el('button', { className: 'mini', textContent: '✎', title: 'Перейменувати', ariaLabel: 'Перейменувати' });
    ren.onclick = () => { closeMenu(); window.api.command('rename-account', a.id); };
    const del = el('button', { className: 'mini', textContent: '✕', title: 'Видалити', ariaLabel: 'Видалити' });
    del.onclick = () => { closeMenu(); window.api.command('remove-account', a.id); };
    menu.append(el('div', { className: 'row' + (a.viewing ? ' view' : '') }, who, lab, ren, del));
  });
  const add = el('button', { className: 'add', textContent: `+ Додати обліковий запис (${accts.accounts.length}/${accts.max})` });
  add.disabled = accts.accounts.length >= accts.max;
  add.onclick = () => { closeMenu(); window.api.command('add-account'); };
  menu.append(add);
}
function closeMenu() { $('acctMenu').hidden = true; $('acctBtn').setAttribute('aria-expanded', 'false'); }
$('acctBtn').onclick = (e) => {
  e.stopPropagation();
  const open = $('acctMenu').hidden;
  $('acctMenu').hidden = !open;
  $('acctBtn').setAttribute('aria-expanded', String(open));
};
document.addEventListener('click', (e) => { if (!$('acctMenu').contains(e.target)) closeMenu(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
window.api.onAccounts((a) => { accts = a; renderAccounts(); });

$('subBtn').onclick = () => window.api.command('substitute');
$('settingsBtn').onclick = () => window.api.command('settings');

window.api.init().then((i) => {
  state = i.status || state;
  accts = i.accounts || accts;
  renderAccounts();
  (i.log || []).forEach(addLog);
  if (i.busy) { $('busy').hidden = false; $('busyText').textContent = i.busy; }
  render();
});
setInterval(render, 1000);
