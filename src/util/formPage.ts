// util/formPage.ts — the request form page markup + client script.
// One page serves the in-app modal (iframe) and the no-login email
// links. All wording that ends up in an email is composed SERVER-side
// (util/requestForm.ts); this page only collects picks and shows the
// preview the server returns.

export function formPageHtml(token: string, packJson: string, userName: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Email Q-Scheduler — New request</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, sans-serif; background:#f4f7f8; margin:0; color:#17242e; }
  .band { background:#21414c; color:#fff; padding:14px 18px; }
  .band h1 { font-size:17px; margin:0; font-weight:650; }
  .band p { margin:3px 0 0; font-size:12.5px; opacity:.85; }
  .wrap { max-width:640px; margin:0 auto; padding:16px 14px 40px; }
  .card { background:#fff; border-radius:14px; padding:16px; margin-bottom:14px; box-shadow:0 1px 8px rgba(20,50,60,.06); }
  .banner { background:#fdf3e3; border:1px solid #ecd9ae; color:#6b5312; border-radius:12px; padding:12px 14px; font-size:13.5px; line-height:1.5; margin-bottom:14px; }
  label.lbl { display:block; font-size:12px; font-weight:650; color:#5b6b76; text-transform:uppercase; letter-spacing:.4px; margin:0 0 6px; }
  select, input[type=text], input[type=time], textarea { width:100%; padding:10px 11px; border:1.5px solid #d7e0e4; border-radius:10px; font-size:15px; background:#fff; color:#17242e; }
  textarea { min-height:74px; resize:vertical; }
  .hint { font-size:12.5px; color:#5b6b76; margin-top:6px; line-height:1.45; }
  h3.grp { font-size:13px; color:#5b6b76; text-transform:uppercase; letter-spacing:.5px; margin:16px 2px 8px; }
  .actions { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
  @media (max-width:430px){ .actions { grid-template-columns:1fr; } }
  button.act { text-align:left; padding:12px 13px; border:1.5px solid #d7e0e4; background:#fff; border-radius:12px; font-size:15px; cursor:pointer; color:#17242e; }
  button.act.on { border-color:#0e7c86; background:#eef7f7; box-shadow:inset 0 0 0 1px #0e7c86; }
  .panel { display:none; }
  .panel.on { display:block; }
  .cal { user-select:none; }
  .cal-head { display:flex; align-items:center; justify-content:space-between; margin-bottom:6px; }
  .cal-head b { font-size:15px; }
  .cal-nav { border:1.5px solid #d7e0e4; background:#fff; border-radius:9px; width:34px; height:34px; font-size:17px; cursor:pointer; color:#17242e; }
  .cal-grid { display:grid; grid-template-columns:repeat(7,1fr); gap:4px; }
  .cal-dow { text-align:center; font-size:11px; color:#8aa0a8; font-weight:650; padding:2px 0; }
  .cal-day { position:relative; text-align:center; padding:9px 0 7px; border-radius:9px; font-size:14px; border:1.5px solid transparent; background:#f2f5f6; color:#9db2ba; }
  .cal-day.has { background:#eef7f7; color:#17242e; cursor:pointer; border-color:#cfe4e6; font-weight:600; }
  .cal-day.sel { background:#0e7c86; color:#fff; border-color:#0e7c86; }
  .cal-day.today { box-shadow:inset 0 0 0 1.5px #0e7c86; }
  .cal-day .bdg { position:absolute; top:2px; right:4px; font-size:9.5px; background:#ff8a5c; color:#fff; border-radius:7px; padding:0 4px; font-weight:700; }
  .cal-day.sel .bdg { background:#fff; color:#0e7c86; }
  .items { margin-top:8px; }
  .item { display:block; width:100%; text-align:left; padding:10px 12px; border:1.5px solid #d7e0e4; border-radius:10px; background:#fff; margin-bottom:6px; font-size:14.5px; cursor:pointer; color:#17242e; }
  .item.on { border-color:#0e7c86; background:#eef7f7; box-shadow:inset 0 0 0 1px #0e7c86; }
  .item small { display:block; color:#5b6b76; font-size:12.5px; margin-top:2px; }
  .picked { font-size:14px; background:#eef7f7; border:1px solid #cfe4e6; border-radius:10px; padding:9px 12px; margin-top:8px; line-height:1.45; }
  .row2 { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
  .scope { display:flex; gap:8px; margin-top:10px; }
  .scope label { flex:1; border:1.5px solid #d7e0e4; border-radius:10px; padding:9px 10px; font-size:14px; cursor:pointer; text-align:center; }
  .scope input { margin-right:6px; }
  .scope label:has(input:checked) { border-color:#0e7c86; background:#eef7f7; }
  .preview { background:#fbfdfe; border:1.5px dashed #b9ccd1; border-radius:12px; padding:13px 14px; }
  .preview .subj { font-weight:700; font-size:15px; margin-bottom:6px; }
  .preview .body { white-space:pre-wrap; font-size:14.5px; line-height:1.55; color:#33424c; }
  .preview .wait { color:#8aa0a8; font-size:14px; }
  .perr { color:#b3261e; font-size:14px; line-height:1.45; }
  #send { width:100%; padding:15px; border:none; border-radius:12px; background:#0e7c86; color:#fff; font-size:16.5px; font-weight:700; cursor:pointer; }
  #send:disabled { background:#b9ccd1; cursor:default; }
  #send:not(:disabled):hover { background:#0a6270; }
  .done { text-align:center; padding:26px 10px; }
  .done .tick { font-size:44px; }
  details.orig { margin-top:10px; } details.orig summary { cursor:pointer; color:#0e7c86; font-size:13.5px; }
  details.orig pre { white-space:pre-wrap; font-size:13px; background:#f7f9fa; padding:10px; border-radius:8px; color:#33424c; }
</style></head>
<body>
<div class="band"><h1>✉️ Email Q-Scheduler — New request</h1><p>${escapeHtml(userName)} · the form is recommended: it is read exactly, first time.</p></div>
<div class="wrap" id="wrap">
  <div class="banner" id="banner" style="display:none"></div>

  <div class="card">
    <label class="lbl" for="fromSel">From</label>
    <div id="fromRow"></div>
    <div class="hint" id="fromHint"></div>
  </div>

  <div class="card">
    <label class="lbl">What do you need?</label>
    <div id="groups"></div>
  </div>

  <div class="card panel" id="panel"></div>

  <div class="card">
    <label class="lbl">The email that will be sent</label>
    <div class="preview" id="preview"><span class="wait">Pick what you need above — the exact email appears here before you send.</span></div>
  </div>

  <button id="send" disabled>Send request</button>
  <p class="hint" style="text-align:center;margin-top:12px">Prefer your own words? You can always email Q-Scheduler or reply to its emails in plain words instead — the form is recommended because it is read exactly.</p>
</div>

<script>
const PACK = ${packJson};
const TOKEN = ${JSON.stringify(token)};

const $ = (s, el) => (el || document).querySelector(s);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const fmtD = (ds) => { const d = new Date(ds + 'T00:00:00Z'); return DAYS[d.getUTCDay()] + ', ' + MONTHS[d.getUTCMonth()] + ' ' + d.getUTCDate() + ', ' + d.getUTCFullYear(); };
const todayStr = new Date().toISOString().slice(0, 10);

let action = null;
let S = {};
let fromEmail = PACK.fromLocked || PACK.me.email;

// ---------- From picker ----------
(function buildFrom() {
  const row = $('#fromRow'), hint = $('#fromHint');
  if (PACK.fromLocked) {
    row.innerHTML = '<div class="picked" style="margin-top:0">From: <strong>' + esc(PACK.fromLocked) + '</strong></div>';
    hint.textContent = 'This form was sent to that address, so it sends from there.';
    fromEmail = PACK.fromLocked;
    return;
  }
  const opts = [PACK.me.email].concat(PACK.me.altEmail ? [PACK.me.altEmail] : []);
  row.innerHTML = '<select id="fromSel">' + opts.map((e) => '<option value="' + esc(e) + '">' + esc(e) + '</option>').join('') + '</select>';
  $('#fromSel').addEventListener('change', (ev) => { fromEmail = ev.target.value; schedulePreview(); });
  hint.innerHTML = PACK.me.altEmail
    ? 'Q-Scheduler accepts requests from both of your addresses.'
    : 'Send requests from a different address too? Add it in the app: My Settings → “Emails I send from”.';
})();

// ---------- Banner (clarification links) ----------
if (PACK.banner) {
  const b = $('#banner');
  b.style.display = 'block';
  b.innerHTML = esc(PACK.banner) + (PACK.prefill && PACK.prefill.originalBody
    ? '<details class="orig"><summary>Your original email</summary><pre>' + esc(PACK.prefill.originalBody) + '</pre></details>' : '');
}

// ---------- Action list ----------
const ACTIONS = [
  { id: 'swap', grp: '📅 Schedule', label: '🔀 Swap a shift', show: () => PACK.myShifts.length > 0 && PACK.teamShifts.length > 0 },
  { id: 'request_off', grp: '📅 Schedule', label: '🌴 Request off', show: () => true },
  { id: 'pickup', grp: '📅 Schedule', label: '✋ Pick up a shift', show: () => PACK.openShifts.length > 0 },
  { id: 'cover', grp: '📅 Schedule', label: '🙋 Ask for cover', show: () => PACK.myShifts.length > 0 },
  { id: 'move_shift', grp: '📅 Schedule', label: '↔️ Move my shift', show: () => PACK.myShifts.length > 0 },
  { id: 'cancel_shift', grp: '📅 Schedule', label: '✖️ Cancel my shift', show: () => PACK.myShifts.length > 0 },
  { id: 'assign', grp: '📅 Schedule', label: '➕ Assign a shift', show: () => PACK.canAssign },
  { id: 'session_add', grp: '🎓 Calendar', label: '➕ Add a session', show: () => PACK.dashboards.length > 0 },
  { id: 'session_move', grp: '🎓 Calendar', label: '↔️ Move a session', show: () => PACK.sessions.length > 0 },
  { id: 'session_cancel', grp: '🎓 Calendar', label: '✖️ Cancel a session', show: () => PACK.sessions.length > 0 },
  { id: 'session_presenter', grp: '🎓 Calendar', label: '🎤 Change presenter', show: () => PACK.sessions.length > 0 },
  { id: 'session_room_supervisor', grp: '🎓 Calendar', label: '🚪 Change room / supervisor', show: () => PACK.sessions.length > 0 },
  { id: 'session_pickup', grp: '🎓 Calendar', label: '🙋 Pick up a session', show: () => PACK.sessions.some((s) => s.needsPresenter) },
  { id: 'question', grp: '❓ Ask', label: '❓ Ask a question', show: () => true },
];
(function renderGroups() {
  const host = $('#groups');
  let html = '', lastGrp = null;
  for (const a of ACTIONS) {
    if (!a.show()) continue;
    if (a.grp !== lastGrp) { html += '<h3 class="grp">' + esc(a.grp) + '</h3><div class="actions" data-grp="' + esc(a.grp) + '">'; lastGrp = a.grp; }
    html += '<button type="button" class="act" data-act="' + a.id + '">' + a.label + '</button>';
  }
  host.innerHTML = html;
  host.querySelectorAll('button.act').forEach((btn) => btn.addEventListener('click', () => selectAction(btn.getAttribute('data-act'))));
})();

function selectAction(id) {
  action = id; S = {};
  document.querySelectorAll('button.act').forEach((b) => b.classList.toggle('on', b.getAttribute('data-act') === id));
  renderPanel();
  schedulePreview();
}

// ---------- Calendar widget ----------
// cfg: { items: [{date, key, label, sub}], anyDay, multi, onPick(selectedItems) }
function calendar(mount, cfg) {
  const byDate = new Map();
  for (const it of cfg.items || []) {
    if (!byDate.has(it.date)) byDate.set(it.date, []);
    byDate.get(it.date).push(it);
  }
  const selected = new Map();
  const firstDate = (cfg.items && cfg.items.length ? cfg.items[0].date : todayStr);
  let cursor = firstDate.slice(0, 7); // YYYY-MM
  let openDay = null;
  function inWindow(ds) { return ds >= PACK.window.from && ds <= PACK.window.to; }
  function render() {
    const [cy, cm] = cursor.split('-').map(Number);
    const first = new Date(Date.UTC(cy, cm - 1, 1));
    const startDow = first.getUTCDay();
    const daysInMonth = new Date(Date.UTC(cy, cm, 0)).getUTCDate();
    let cells = '';
    for (let i = 0; i < startDow; i++) cells += '<div></div>';
    for (let d = 1; d <= daysInMonth; d++) {
      const ds = cursor + '-' + String(d).padStart(2, '0');
      const items = byDate.get(ds) || [];
      const enabled = inWindow(ds) && (cfg.anyDay || items.length > 0);
      const isSel = cfg.anyDay ? selected.has(ds) : items.some((it) => selected.has(it.key));
      const bdg = items.length > 1 ? '<span class="bdg">' + items.length + '</span>' : '';
      cells += '<div class="cal-day' + (enabled ? ' has' : '') + (isSel ? ' sel' : '') + (ds === todayStr ? ' today' : '') + '" data-d="' + ds + '">' + d + bdg + '</div>';
    }
    mount.innerHTML = '<div class="cal"><div class="cal-head"><button type="button" class="cal-nav" data-nav="-1">‹</button><b>' +
      MONTHS[cm - 1] + ' ' + cy + '</b><button type="button" class="cal-nav" data-nav="1">›</button></div>' +
      '<div class="cal-grid">' + ['Su','Mo','Tu','We','Th','Fr','Sa'].map((x) => '<div class="cal-dow">' + x + '</div>').join('') + cells + '</div>' +
      '<div class="items"></div></div>';
    mount.querySelectorAll('.cal-nav').forEach((b) => b.addEventListener('click', () => {
      const [y, m] = cursor.split('-').map(Number);
      const nd = new Date(Date.UTC(y, m - 1 + Number(b.getAttribute('data-nav')), 1));
      cursor = nd.toISOString().slice(0, 7); openDay = null; render();
    }));
    mount.querySelectorAll('.cal-day.has').forEach((cell) => cell.addEventListener('click', () => {
      const ds = cell.getAttribute('data-d');
      const items = cfg.anyDay ? [{ date: ds, key: ds, label: fmtD(ds) }] : (byDate.get(ds) || []);
      if (items.length === 1) { toggle(items[0]); return; }
      openDay = openDay === ds ? null : ds; renderItems(ds, items);
    }));
    if (openDay) {
      const items = byDate.get(openDay) || [];
      if (items.length > 1) renderItems(openDay, items);
    }
  }
  function renderItems(ds, items) {
    const host = mount.querySelector('.items');
    if (!host) return;
    host.innerHTML = items.map((it) => '<button type="button" class="item' + (selected.has(it.key) ? ' on' : '') + '" data-k="' + esc(it.key) + '">' + esc(it.label) + (it.sub ? '<small>' + esc(it.sub) + '</small>' : '') + '</button>').join('');
    host.querySelectorAll('.item').forEach((b) => b.addEventListener('click', () => {
      const it = items.find((x) => x.key === b.getAttribute('data-k'));
      if (it) toggle(it);
    }));
  }
  function toggle(it) {
    if (cfg.multi) { selected.has(it.key) ? selected.delete(it.key) : selected.set(it.key, it); }
    else { const had = selected.has(it.key); selected.clear(); if (!had) selected.set(it.key, it); }
    render();
    cfg.onPick([...selected.values()]);
  }
  render();
  return { getSelected: () => [...selected.values()] };
}

// ---------- Shared pick-item builders ----------
const myItems = () => PACK.myShifts.map((s) => ({ date: s.date, key: s.date + '|' + s.shiftTypeId, label: s.shiftTypeName, sub: fmtD(s.date), shiftTypeId: s.shiftTypeId }));
const theirItems = (uid) => PACK.teamShifts.filter((s) => s.userId === uid).map((s) => ({ date: s.date, key: s.date + '|' + s.shiftTypeId, label: s.shiftTypeName, sub: fmtD(s.date), shiftTypeId: s.shiftTypeId }));
const openItems = () => PACK.openShifts.map((s) => ({ date: s.date, key: s.date + '|' + s.shiftTypeId, label: s.shiftTypeName + ' — ' + s.open + ' open', sub: fmtD(s.date), shiftTypeId: s.shiftTypeId }));
const sessItems = (list) => list.map((s) => ({ date: s.date, key: s.id + '|' + s.date, label: s.title, sub: fmtD(s.date) + (s.startTime ? ' · ' + s.startTime + (s.endTime ? '–' + s.endTime : '') : '') + (s.presenterName ? ' · ' + s.presenterName : ' · needs a presenter') + (s.location ? ' · ' + s.location : ''), sess: s }));
const teamOpts = (extra) => (extra || '') + PACK.team.map((t) => '<option value="' + t.id + '">' + esc(t.name) + '</option>').join('');
const noteHtml = '<div style="margin-top:12px"><label class="lbl" for="f-note">Note (optional)</label><textarea id="f-note" placeholder="Anything the approvers should know"></textarea></div>';
const scopeHtml = '<div class="scope" id="f-scope" style="display:none"><label><input type="radio" name="scope" value="date" checked>Just this date</label><label><input type="radio" name="scope" value="series">Whole series</label></div>';
function scopeVal() { const r = document.querySelector('input[name="scope"]:checked'); return r ? r.value : 'date'; }
function showScope(recurring) { const el = $('#f-scope'); if (el) el.style.display = recurring ? 'flex' : 'none'; }
function pickedLine(el, text) { el.innerHTML = text ? '<div class="picked">' + esc(text) + '</div>' : ''; }

// ---------- Panels ----------
function renderPanel() {
  const p = $('#panel');
  p.classList.add('on');
  const L = (t) => '<label class="lbl">' + t + '</label>';
  if (action === 'swap') {
    p.innerHTML = L('Your shifts — tap every day you want to swap') + '<div id="c-my"></div><div id="pk-my"></div>' +
      '<div style="margin-top:12px">' + L('Swap with') + '<select id="f-person">' + teamOpts('<option value="">Choose a person…</option>') + '</select></div>' +
      '<div style="margin-top:12px">' + L('Their shifts — tap the same number of days (they pair up in date order)') + '<div id="c-their"></div><div id="pk-their"></div></div>' + noteHtml;
    const swapLine = () => {
      const a = (S.myPicks || []).length, b = (S.theirPicks || []).length;
      pickedLine($('#pk-my'), a ? (S.myPicks.map((x) => x.label + ' ' + fmtD(x.date)).join('; ')) : '');
      pickedLine($('#pk-their'), b ? (S.theirPicks.map((x) => x.label + ' ' + fmtD(x.date)).join('; ')) : '');
    };
    calendar($('#c-my'), { items: myItems(), multi: true, onPick: (sel) => { S.myPicks = sel.slice().sort((x, y) => x.date < y.date ? -1 : 1); swapLine(); schedulePreview(); } });
    $('#f-person').addEventListener('change', (ev) => {
      S.theirUserId = ev.target.value; S.theirPicks = [];
      calendar($('#c-their'), { items: theirItems(S.theirUserId), multi: true, onPick: (sel) => { S.theirPicks = sel.slice().sort((x, y) => x.date < y.date ? -1 : 1); swapLine(); schedulePreview(); } });
      swapLine();
      schedulePreview();
    });
  } else if (action === 'request_off') {
    p.innerHTML = L('Tap every day you want off') + '<div id="c-days"></div><div id="pk-days"></div>' + noteHtml;
    calendar($('#c-days'), { items: [], anyDay: true, multi: true, onPick: (sel) => { S.dates = sel.map((x) => x.date).sort(); pickedLine($('#pk-days'), S.dates.length ? S.dates.map(fmtD).join('; ') : ''); schedulePreview(); } });
  } else if (action === 'pickup') {
    p.innerHTML = L('Open shifts — tap a marked day') + '<div id="c-open"></div><div id="pk-open"></div>' + noteHtml;
    calendar($('#c-open'), { items: openItems(), onPick: (sel) => { S.open = sel[0] || null; pickedLine($('#pk-open'), S.open ? S.open.label + ' — ' + fmtD(S.open.date) : ''); schedulePreview(); } });
  } else if (action === 'cover') {
    // Cover offers BOTH ways (Deepika 2026-11-01): one named person,
    // or everyone with your job role (first to pick it up gets it).
    S.coverMode = 'everyone'; S.coverUserId = '';
    p.innerHTML = L('The shift you need covered') + '<div id="c-my"></div><div id="pk-my"></div>' +
      '<div style="margin-top:12px">' + L('Who should we ask?') +
      '<label style="display:flex;gap:8px;align-items:center;margin-top:6px;font-size:14.5px"><input type="radio" name="f-covermode" value="everyone" checked style="width:auto"> Everyone with my job role — first to pick it up gets it <button type="button" id="f-cover-info" aria-label="See who this goes to" style="margin-left:auto;flex:none;width:22px;height:22px;border-radius:50%;border:1.5px solid var(--teal);background:#fff;color:var(--teal);font-weight:700;font-size:13px;line-height:1;cursor:pointer;padding:0">i</button></label>' +
      '<label style="display:flex;gap:8px;align-items:center;margin-top:6px;font-size:14.5px"><input type="radio" name="f-covermode" value="person" style="width:auto"> One person</label>' +
      '<div id="cover-person-wrap" style="display:none;margin-top:8px"><select id="f-coverperson">' + teamOpts('<option value="">Choose a person…</option>') + '</select></div>' +
      '<div id="cover-recips" style="display:none;margin-top:8px;background:#f0faf9;border:1px solid var(--border);border-radius:10px;padding:10px 12px;font-size:13.5px;line-height:1.5"></div></div>' + noteHtml;
    calendar($('#c-my'), { items: myItems(), onPick: (sel) => { S.my = sel[0] || null; S.coverRecipients = null; pickedLine($('#pk-my'), S.my ? 'Your ' + S.my.label + ' — ' + fmtD(S.my.date) : ''); renderCoverRecips(); schedulePreview(); } });
    p.querySelectorAll('input[name="f-covermode"]').forEach((r) => r.addEventListener('change', (ev) => {
      S.coverMode = ev.target.value;
      $('#cover-person-wrap').style.display = S.coverMode === 'person' ? '' : 'none';
      if (S.coverMode === 'person') { const rb = $('#cover-recips'); if (rb) rb.style.display = 'none'; }
      schedulePreview();
    }));
    $('#f-coverperson').addEventListener('change', (ev) => { S.coverUserId = ev.target.value; schedulePreview(); });
    const infoBtn = $('#f-cover-info'), recipsBox = $('#cover-recips');
    if (infoBtn && recipsBox) infoBtn.addEventListener('click', (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      const open = recipsBox.style.display !== 'none';
      recipsBox.style.display = open ? 'none' : 'block';
      if (!open) renderCoverRecips();
    });
  } else if (action === 'move_shift') {
    p.innerHTML = L('Your shift') + '<div id="c-my"></div><div id="pk-my"></div>' +
      '<div style="margin-top:12px">' + L('Move it to') + '<div id="c-new"></div><div id="pk-new"></div></div>' + noteHtml;
    calendar($('#c-my'), { items: myItems(), onPick: (sel) => { S.my = sel[0] || null; pickedLine($('#pk-my'), S.my ? 'Your ' + S.my.label + ' — ' + fmtD(S.my.date) : ''); schedulePreview(); } });
    calendar($('#c-new'), { items: [], anyDay: true, onPick: (sel) => { S.newDate = sel.length ? sel[0].date : null; pickedLine($('#pk-new'), S.newDate ? fmtD(S.newDate) : ''); schedulePreview(); } });
  } else if (action === 'cancel_shift') {
    p.innerHTML = L('The shift to cancel') + '<div id="c-my"></div><div id="pk-my"></div>' + noteHtml;
    calendar($('#c-my'), { items: myItems(), onPick: (sel) => { S.my = sel[0] || null; pickedLine($('#pk-my'), S.my ? 'Your ' + S.my.label + ' — ' + fmtD(S.my.date) : ''); schedulePreview(); } });
  } else if (action === 'assign') {
    p.innerHTML = L('Team member') + '<select id="f-person">' + teamOpts('<option value="">Choose a person…</option>') + '</select>' +
      '<div style="margin-top:12px">' + L('Shift type') + '<select id="f-type">' + PACK.shiftTypes.map((t) => '<option value="' + t.id + '">' + esc(t.name) + '</option>').join('') + '</select></div>' +
      '<div style="margin-top:12px">' + L('Tap the dates') + '<div id="c-days"></div><div id="pk-days"></div></div>' + noteHtml;
    S.shiftTypeId = PACK.shiftTypes.length ? PACK.shiftTypes[0].id : null;
    $('#f-person').addEventListener('change', (ev) => { S.userId = ev.target.value; schedulePreview(); });
    $('#f-type').addEventListener('change', (ev) => { S.shiftTypeId = ev.target.value; schedulePreview(); });
    calendar($('#c-days'), { items: [], anyDay: true, multi: true, onPick: (sel) => { S.dates = sel.map((x) => x.date).sort(); pickedLine($('#pk-days'), S.dates.length ? S.dates.map(fmtD).join('; ') : ''); schedulePreview(); } });
  } else if (action === 'session_add') {
    p.innerHTML = L('Calendar') + '<select id="f-dash">' + PACK.dashboards.map((d) => '<option value="' + d.id + '">' + esc(d.name) + '</option>').join('') + '</select>' +
      '<div style="margin-top:12px">' + L('Session title') + '<input type="text" id="f-title" placeholder="e.g. Morning rounds"></div>' +
      '<div style="margin-top:12px">' + L('Date') + '<div id="c-day"></div><div id="pk-day"></div></div>' +
      '<div class="row2" style="margin-top:12px"><div>' + L('Starts') + '<input type="time" id="f-start"></div><div>' + L('Ends') + '<input type="time" id="f-end"></div></div>' +
      '<div style="margin-top:12px">' + L('Presenter (optional)') + '<select id="f-pres">' + teamOpts('<option value="">No presenter yet</option>') + '</select></div>' +
      '<div style="margin-top:12px">' + L('Room (optional)') + '<input type="text" id="f-room" list="rooms" placeholder="Room or location"><datalist id="rooms">' + PACK.rooms.map((r) => '<option value="' + esc(r) + '">').join('') + '</datalist></div>' +
      '<label style="display:flex;gap:8px;align-items:center;margin-top:12px;font-size:14.5px"><input type="checkbox" id="f-weekly" style="width:auto"> Repeats weekly</label>' + noteHtml;
    S.dashboardId = PACK.dashboards.length ? PACK.dashboards[0].id : null;
    $('#f-dash').addEventListener('change', (ev) => { S.dashboardId = ev.target.value; schedulePreview(); });
    ['f-title', 'f-start', 'f-end', 'f-room'].forEach((id) => $('#' + id).addEventListener('input', schedulePreview));
    $('#f-pres').addEventListener('change', schedulePreview);
    $('#f-weekly').addEventListener('change', schedulePreview);
    calendar($('#c-day'), { items: [], anyDay: true, onPick: (sel) => { S.date = sel.length ? sel[0].date : null; pickedLine($('#pk-day'), S.date ? fmtD(S.date) : ''); schedulePreview(); } });
  } else if (action && action.indexOf('session_') === 0) {
    const list = action === 'session_pickup' ? PACK.sessions.filter((s) => s.needsPresenter) : PACK.sessions;
    let extra = '';
    if (action === 'session_move') extra = '<div style="margin-top:12px">' + L('Move it to') + '<div id="c-new"></div><div id="pk-new"></div></div><div style="margin-top:12px">' + L('New start time (optional)') + '<input type="time" id="f-nst"></div>';
    if (action === 'session_presenter') extra = '<div style="margin-top:12px">' + L('New presenter') + '<select id="f-pres">' + teamOpts('<option value="">Choose a person…</option>') + '</select></div>';
    if (action === 'session_room_supervisor') extra = '<div style="margin-top:12px">' + L('Room') + '<input type="text" id="f-room" list="rooms" placeholder="Leave as is, or type the new room"><datalist id="rooms">' + PACK.rooms.map((r) => '<option value="' + esc(r) + '">').join('') + '</datalist></div><div style="margin-top:12px">' + L('Supervisor (optional)') + '<select id="f-sup">' + teamOpts('<option value="">No change</option>') + '</select></div>';
    p.innerHTML = L('Pick the session — tap a marked day, then the session') + '<div id="c-sess"></div><div id="pk-sess"></div>' + extra + scopeHtml + noteHtml;
    calendar($('#c-sess'), { items: sessItems(list), onPick: (sel) => {
      S.sess = sel.length ? sel[0].sess : null;
      pickedLine($('#pk-sess'), S.sess ? S.sess.title + ' — ' + fmtD(S.sess.date) + (S.sess.startTime ? ' · ' + S.sess.startTime : '') + (S.sess.presenterName ? ' · ' + S.sess.presenterName : ' · needs a presenter') + (S.sess.recurring ? ' · repeats' : '') : '');
      showScope(!!(S.sess && S.sess.recurring));
      const room = $('#f-room'); if (room && S.sess) room.value = S.sess.location || '';
      schedulePreview();
    } });
    if (action === 'session_move') {
      calendar($('#c-new'), { items: [], anyDay: true, onPick: (sel) => { S.newDate = sel.length ? sel[0].date : null; pickedLine($('#pk-new'), S.newDate ? fmtD(S.newDate) : ''); schedulePreview(); } });
      $('#f-nst').addEventListener('input', schedulePreview);
    }
    if (action === 'session_presenter') $('#f-pres').addEventListener('change', (ev) => { S.presenterId = ev.target.value; schedulePreview(); });
    if (action === 'session_room_supervisor') {
      $('#f-room').addEventListener('input', schedulePreview);
      $('#f-sup').addEventListener('change', (ev) => { S.supervisorId = ev.target.value; schedulePreview(); });
    }
    p.querySelectorAll('input[name="scope"]').forEach((r) => r.addEventListener('change', schedulePreview));
  } else if (action === 'question') {
    p.innerHTML = L('Your question') + '<textarea id="f-q" placeholder="e.g. Who is on Day Hospitalist this Friday?" style="min-height:96px"></textarea>' +
      '<div class="hint">Questions are answered by email, like asking Q-Scheduler in your own words.</div>';
    $('#f-q').addEventListener('input', schedulePreview);
  }
  const note = $('#f-note');
  if (note) note.addEventListener('input', schedulePreview);
}

// ---------- Collect fields ----------
function fields() {
  const note = ($('#f-note') && $('#f-note').value.trim()) || '';
  const withNote = (o) => { if (note) o.note = note; return o; };
  switch (action) {
    case 'swap': return withNote({ theirUserId: S.theirUserId, myPicks: (S.myPicks || []).map((x) => ({ date: x.date, shiftTypeId: x.shiftTypeId })), theirPicks: (S.theirPicks || []).map((x) => ({ date: x.date, shiftTypeId: x.shiftTypeId })) });
    case 'request_off': return withNote({ dates: S.dates || [] });
    case 'pickup': return withNote({ date: S.open && S.open.date, shiftTypeId: S.open && S.open.shiftTypeId });
    case 'cover': return withNote({ myDate: S.my && S.my.date, myShiftTypeId: S.my && S.my.shiftTypeId, coverMode: S.coverMode || 'everyone', coverUserId: S.coverMode === 'person' ? (S.coverUserId || undefined) : undefined });
    case 'move_shift': return withNote({ myDate: S.my && S.my.date, myShiftTypeId: S.my && S.my.shiftTypeId, newDate: S.newDate });
    case 'cancel_shift': return withNote({ myDate: S.my && S.my.date, myShiftTypeId: S.my && S.my.shiftTypeId });
    case 'assign': return withNote({ userId: S.userId, shiftTypeId: S.shiftTypeId, dates: S.dates || [] });
    case 'session_add': return withNote({ dashboardId: S.dashboardId, title: $('#f-title').value.trim(), date: S.date, startTime: $('#f-start').value, endTime: $('#f-end').value, presenterId: $('#f-pres').value || undefined, room: $('#f-room').value.trim() || undefined, weekly: $('#f-weekly').checked });
    case 'session_move': return withNote({ sessionId: S.sess && S.sess.id, date: S.sess && S.sess.date, newDate: S.newDate, newStartTime: $('#f-nst').value || undefined, scope: scopeVal() });
    case 'session_cancel': return withNote({ sessionId: S.sess && S.sess.id, date: S.sess && S.sess.date, scope: scopeVal() });
    case 'session_presenter': return withNote({ sessionId: S.sess && S.sess.id, date: S.sess && S.sess.date, presenterId: S.presenterId, scope: scopeVal() });
    case 'session_room_supervisor': return withNote({ sessionId: S.sess && S.sess.id, date: S.sess && S.sess.date, room: $('#f-room').value, supervisorId: S.supervisorId || undefined, scope: scopeVal() });
    case 'session_pickup': return withNote({ sessionId: S.sess && S.sess.id, date: S.sess && S.sess.date });
    case 'question': return { text: $('#f-q').value.trim() };
    default: return {};
  }
}

// ---------- Preview + send ----------
let pvTimer = null, pvSeq = 0;
function schedulePreview() {
  if (!action) return;
  clearTimeout(pvTimer);
  pvTimer = setTimeout(runPreview, 450);
}
// The cover ⓘ list (Deepika 2026-11-01): who the broadcast will
// actually go to for the picked shift. Names come from the preview
// response (server-computed with the same helper that bells them).
function renderCoverRecips() {
  const box = $('#cover-recips');
  if (!box || box.style.display === 'none') return;
  if (!S.my) { box.innerHTML = 'Pick your shift above first — then this shows exactly who will be asked for that shift.'; return; }
  const names = S.coverRecipients;
  if (!names) {
    const key = S.my.date + '|' + S.my.shiftTypeId;
    if (S.recipFor === key) { box.innerHTML = 'Could not work out the list — the preview above shows the message that will be sent.'; return; }
    box.innerHTML = 'One moment — working out who would be asked…'; schedulePreview(); return;
  }
  if (!names.length) { box.innerHTML = '<strong>Nobody else can be asked for this shift.</strong> Everyone with your job role is already working a shift that clashes with it.'; return; }
  box.innerHTML = '<strong>This will go to:</strong><br>' + names.map(esc).join('<br>') + '<br><span style="color:var(--dim)">People already working a clashing shift are not asked.</span>';
}
async function runPreview() {
  const seq = ++pvSeq;
  const box = $('#preview'), send = $('#send');
  try {
    const res = await fetch('/api/schedule/request-form/' + TOKEN + '/preview', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, fields: fields(), fromEmail }),
    });
    const data = await res.json();
    if (seq !== pvSeq) return;
    if (data.ok) {
      box.innerHTML = '<div class="subj">' + esc(data.subject) + '</div><div class="body">' + esc(data.body) + '</div>';
      send.disabled = false;
      S.coverRecipients = Array.isArray(data.recipients) ? data.recipients : null;
      S.recipFor = S.my ? (S.my.date + '|' + S.my.shiftTypeId) : null;
      renderCoverRecips();
    } else {
      box.innerHTML = '<span class="perr">' + esc(data.error || 'Pick what you need above.') + '</span>';
      send.disabled = true;
      S.coverRecipients = null;
      S.recipFor = S.my ? (S.my.date + '|' + S.my.shiftTypeId) : null;
      renderCoverRecips();
    }
  } catch {
    if (seq !== pvSeq) return;
    box.innerHTML = '<span class="perr">Could not reach the app — check your connection and try again.</span>';
    send.disabled = true;
  }
}
$('#send').addEventListener('click', async () => {
  const send = $('#send');
  send.disabled = true; send.textContent = 'Sending…';
  try {
    const res = await fetch('/api/schedule/request-form/' + TOKEN + '/submit', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, fields: fields(), fromEmail }),
    });
    const data = await res.json();
    if (data.ok) {
      $('#wrap').innerHTML = '<div class="card done"><div class="tick">✅</div><p style="font-size:16px;line-height:1.55">' + esc(data.message) + '</p><button type="button" class="act" style="text-align:center;width:100%" onclick="location.reload()">Make another request</button></div>';
      window.scrollTo(0, 0);
    } else {
      $('#preview').innerHTML = '<span class="perr">' + esc(data.error || 'Something went wrong.') + '</span>';
      send.disabled = false; send.textContent = 'Send request';
    }
  } catch {
    $('#preview').innerHTML = '<span class="perr">Could not reach the app — check your connection and try again.</span>';
    send.disabled = false; send.textContent = 'Send request';
  }
});
</script>
</body></html>`;
}

function escapeHtml(s: string): string {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}
