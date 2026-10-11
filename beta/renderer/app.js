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
function closeDialog() { $('modal').hidden = true; $('dialog').replaceChildren(); dlg.id = null; }
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
    const q = search.value.trim().toLowerCase();
    shown = q ? items.filter((i) => i.label.toLowerCase().includes(q)) : items;
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
  ({ choose: showChoose, group: showGroup, text: showText, info: showInfo }[spec.kind] || showInfo)(spec);
});
window.api.onAskCancel(({ id }) => { if (dlg.id === id) closeDialog(); });
window.api.onBusy((text) => { $('busy').hidden = !text; $('busyText').textContent = text || ''; });
window.api.onStatus((s) => { state = s; render(); });
window.api.onStatusText((t) => { $('statusText').textContent = 'Статус: ' + t; });
window.api.onLog(addLog);
$('subBtn').onclick = () => window.api.command('substitute');
$('settingsBtn').onclick = () => window.api.command('settings');

window.api.init().then((i) => {
  state = i.status || state;
  (i.log || []).forEach(addLog);
  if (i.busy) { $('busy').hidden = false; $('busyText').textContent = i.busy; }
  render();
});
setInterval(render, 1000);
