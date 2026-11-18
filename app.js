/* ============================================================
   Veto Lab — Call of Duty Competitivo
   Los datos de cada equipo se sincronizan con Firebase Realtime Database
   (con copia local en el navegador).
   ============================================================ */
'use strict';

/* ---------- Datos: modos y mapas ---------- */
const MODES = {
  hp:   { name: 'Hardpoint',         short: 'HP',     maps: ['Lotus', 'Lithium', 'Munition', 'Reactor', 'Rooftops', 'Sentry'] },
  byd:  { name: 'Buscar y Destruir', short: 'ByD',    maps: ['Lotus', 'Coal', 'Munition', 'Reactor', 'Rooftops', 'Silkworm'] },
  hack: { name: 'Hackeo',            short: 'Hackeo', maps: ['Lotus', 'Lithium', 'Munition'] },
};
const MODE_KEYS = Object.keys(MODES);

/* Imágenes de mapa: de momento todo son placeholders.
   Cuando tengas fotos, súbelas a /assets/maps/ y rellena aquí, p. ej.:
   const MAP_IMAGES = { Lotus: 'assets/maps/lotus.jpg', Coal: 'assets/maps/coal.jpg' }; */
const MAP_IMAGES = {};

/* Formatos de serie predefinidos (orden de modos por partida). Editables en la interfaz. */
const FORMATS = {
  bo3: ['hp', 'byd', 'hack'],
  bo5: ['hp', 'byd', 'hack', 'hp', 'byd'],
  bo7: ['hp', 'byd', 'hack', 'hp', 'byd', 'hack', 'hp'],
};

/* ---------- Utilidades ---------- */
const $ = (sel, root = document) => root.querySelector(sel);

function el(tag, props, ...kids) {
  const n = document.createElement(tag);
  let pendingValue;
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'value') pendingValue = v;
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else if (v === true) n.setAttribute(k, '');
    else n.setAttribute(k, v);
  }
  kids.flat(Infinity).forEach(c => {
    if (c == null || c === false) return;
    n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  });
  if (pendingValue !== undefined) n.value = pendingValue; // tras crear <option>s
  return n;
}

/* ---------- Equipos y claves de equipo ----------
   Cada equipo tiene una clave. Aquí NO se guarda la clave, sino su "hash" (huella SHA-256),
   para que no se lea a simple vista en el repositorio. Para añadir un equipo:
   abre clave.html, escribe la clave y copia la línea que genera dentro de TEAMS.
   Cambia el nombre de abajo por el de tu equipo. */
const TEAMS = [
  { name: 'Mi equipo', hash: 'fd59cf08ec0199cf9aa99209fb79d1014160f060e911dd4740b68f831aad5997' },
];

const normKey = s => String(s || '').trim().toUpperCase();
async function hashWith(prefix, key) {
  if (!(window.crypto && crypto.subtle)) throw new Error('crypto no disponible');
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(prefix + normKey(key)));
  return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
}
/* hashKey: huella para comprobar la clave (la que está en TEAMS).
   roomId: nombre de la "sala" del equipo en la base de datos. Sale de la clave con otro prefijo,
   así que no se puede deducir de lo que hay en el repositorio. */
const hashKey = key => hashWith('vetolab:', key);
const roomId = key => hashWith('room:', key);

/* Equipo con el que se ha entrado. Se recuerda sólo mientras la pestaña esté abierta. */
const session = { team: null, room: null };
function sessionRead() {
  try { return { hash: sessionStorage.getItem('vetolab.team'), room: sessionStorage.getItem('vetolab.room') }; }
  catch { return { hash: null, room: null }; }
}
function sessionWrite(hash, room) {
  try {
    if (hash) { sessionStorage.setItem('vetolab.team', hash); sessionStorage.setItem('vetolab.room', room); }
    else { sessionStorage.removeItem('vetolab.team'); sessionStorage.removeItem('vetolab.room'); }
  } catch { /* nada */ }
}

/* Los datos de cada equipo se guardan separados (prefijo = parte de su hash). */
const nsKey = () => (session.team ? session.team.hash.slice(0, 12) + '.' : '');
const store = {
  get(k, d) { try { const v = localStorage.getItem('vetolab.' + nsKey() + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('vetolab.' + nsKey() + k, JSON.stringify(v)); } catch { /* sin almacenamiento */ } },
};

/* ---------- Sincronización con Firebase Realtime Database ----------
   Estructura: teams/<sala>/{opp, draft, votes}. Los votos se guardan uno por jugador
   (votes/<nombre>) para que dos personas votando a la vez no se pisen. */
const FIREBASE_CONFIG = {
  projectId: 'vetosim',
  databaseURL: 'https://vetosim-default-rtdb.europe-west1.firebasedatabase.app',
};
const FIREBASE_SDK = 'https://www.gstatic.com/firebasejs/10.12.2/';
const remote = { db: null, status: 'off', unsub: [] }; // status: off | connecting | on | error | denied

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = () => reject(new Error('No se pudo cargar ' + src));
    document.head.append(s);
  });
}
async function ensureFirebase() {
  if (!window.firebase) {
    await loadScript(FIREBASE_SDK + 'firebase-app-compat.js');
    await loadScript(FIREBASE_SDK + 'firebase-database-compat.js');
  }
  if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
  return firebase.database();
}

const remotePath = path => 'teams/' + session.room + '/' + path;
const isDenied = err => /permission/i.test(String(err && (err.code || err.message)));

function setRemoteStatus(s) {
  if (remote.status === s) return;
  remote.status = s;
  updateHeader();
  if (s === 'denied') toast('Sin permisos en Firebase: revisa las reglas de la base de datos');
}
function remoteSet(path, value) {
  if (!remote.db || !session.room) return;
  const v = value == null ? null : JSON.parse(JSON.stringify(value));
  Promise.resolve(remote.db.ref(remotePath(path)).set(v)).catch(err => setRemoteStatus(isDenied(err) ? 'denied' : 'error'));
}

/* Los cambios de otros llegan en directo; si estás escribiendo en un campo se espera a que termines. */
let remoteRenderTimer;
function remoteRerender() {
  clearTimeout(remoteRenderTimer);
  if (!session.team) return;
  const a = document.activeElement;
  if (a && /^(INPUT|TEXTAREA)$/.test(a.tagName)) { remoteRenderTimer = setTimeout(remoteRerender, 800); return; }
  rerender();
}

function disconnectRemote() {
  remote.unsub.forEach(f => { try { f(); } catch { /* nada */ } });
  remote.unsub = []; remote.status = 'off';
}
async function connectRemote() {
  disconnectRemote();
  if (!session.room) return;
  const room = session.room;
  remote.status = 'connecting'; updateHeader();
  try { remote.db = await ensureFirebase(); }
  catch { setRemoteStatus('error'); toast('No se pudo conectar con Firebase: se trabaja solo en este navegador'); return; }
  if (session.room !== room) return; // se cerró la sesión mientras cargaba

  const watch = (path, apply) => {
    const ref = remote.db.ref(remotePath(path));
    const cb = snap => { apply(snap.val()); remoteRerender(); };
    ref.on('value', cb, err => setRemoteStatus(isDenied(err) ? 'denied' : 'error'));
    remote.unsub.push(() => ref.off('value', cb));
  };
  watch('opp', applyRemoteOpp);
  watch('draft', applyRemoteDraft);
  watch('votes', applyRemoteVotes);

  const conn = remote.db.ref('.info/connected');
  const ccb = snap => { if (remote.status !== 'denied') setRemoteStatus(snap.val() ? 'on' : 'error'); };
  conn.on('value', ccb);
  remote.unsub.push(() => conn.off('value', ccb));
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    const ta = el('textarea', { style: 'position:fixed;opacity:0' });
    ta.value = text; document.body.append(ta); ta.select();
    let ok = false; try { ok = document.execCommand('copy'); } catch { /* nada */ }
    ta.remove(); return ok;
  }
}

const BLOCKED_NAMES = new Set(['__proto__', 'constructor', 'prototype']);
function cleanName(s) {
  // Firebase no admite . # $ [ ] / en los nombres de clave
  const n = String(s || '').replace(/[.#$\[\]\/]/g, '').trim().replace(/\s+/g, ' ').slice(0, 24);
  return n && !BLOCKED_NAMES.has(n) ? n : '';
}

function pct(x) { return Math.round(x * 100) + '%'; }

function pageHead(num, title, desc) {
  return el('section', { class: 'page-head' },
    el('div', { class: 'label' }, `${num} / Veto Sim`),
    el('h2', null, title),
    desc ? el('p', { class: 'lead' }, desc) : null);
}

function tabs(current, onSelect) {
  return el('div', { class: 'tabs', role: 'tablist' },
    MODE_KEYS.map(m => el('button', {
      class: 'tab' + (m === current ? ' active' : ''), type: 'button', role: 'tab',
      'aria-selected': m === current ? 'true' : 'false', onclick: () => onSelect(m),
    }, MODES[m].name)));
}

function stepper(val, set, min = 0, max = 999) {
  return el('div', { class: 'stepper' },
    el('button', { type: 'button', 'aria-label': 'Restar', onclick: () => set(Math.max(min, val - 1)) }, '−'),
    el('span', { class: 'num' }, val),
    el('button', { type: 'button', 'aria-label': 'Sumar', onclick: () => set(Math.min(max, val + 1)) }, '+'));
}

function mapImg(name) {
  const d = el('div', { class: 'map-img', 'data-map': name }, MAP_IMAGES[name] ? '' : 'Imagen');
  if (MAP_IMAGES[name]) d.style.backgroundImage = `url("${MAP_IMAGES[name]}")`;
  return d;
}

/* ---------- Router ---------- */
const routes = { '': renderMenu, predictor: renderPredictor, draft: renderDraft, votes: renderVotes };

function currentRoute() {
  const h = location.hash.replace(/^#\/?/, '');
  return Object.prototype.hasOwnProperty.call(routes, h) ? h : '';
}

function render(fade) {
  const r = currentRoute();
  const app = $('#app');
  app.replaceChildren();
  app.className = fade ? 'enter' : '';
  updateHeader();
  if (!session.team) { renderLogin(app); return; }
  routes[r](app);
  document.querySelectorAll('.site-nav a').forEach(a => a.classList.toggle('active', a.dataset.route === r));
}
function rerender() { const y = window.scrollY; render(false); window.scrollTo(0, y); }

/* Cabecera: sin clave sólo se ve la marca; con clave aparece el menú, el equipo y "Salir". */
function updateHeader() {
  const nav = $('.site-nav');
  if (nav) nav.style.display = session.team ? '' : 'none';
  let box = $('#team-box');
  if (!box) {
    box = el('div', { id: 'team-box', class: 'row center', style: 'gap:14px' });
    $('.site-header').append(box);
  }
  box.replaceChildren();
  if (session.team) {
    const statusText = { connecting: 'Conectando…', on: '● En línea', error: '○ Sin conexión', denied: '○ Sin permisos' }[remote.status];
    box.append(
      el('span', { class: 'label' }, session.team.name),
      statusText ? el('span', { class: 'label dim', title: 'Estado de la sincronización con el equipo' }, statusText) : null,
      el('button', { class: 'btn small', type: 'button', onclick: logout }, 'Salir'));
  }
}

function loadTeamData() {
  loadPred();
  draft = normalizeDraft(store.get('draft', null));
  loadVotes();
}

function logout() {
  disconnectRemote();
  session.team = null; session.room = null; sessionWrite(null);
  location.hash = '';
  render(true); window.scrollTo(0, 0);
}

function renderLogin(root) {
  const input = el('input', {
    id: 'team-key', type: 'password', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false',
    placeholder: 'Clave de equipo', 'aria-label': 'Clave de equipo', maxlength: '64',
  });
  let busy = false;
  const enter = async () => {
    if (busy) return;
    const key = normKey(input.value);
    if (!key) return toast('Introduce tu clave de equipo');
    busy = true;
    try {
      let h;
      try { h = await hashKey(key); } catch { return toast('Este navegador no permite comprobar la clave (usa la web por https)'); }
      const team = TEAMS.find(t => t.hash === h);
      if (!team) { input.value = ''; input.focus(); return toast('Clave incorrecta'); }
      const room = await roomId(key);
      session.team = team; session.room = room; sessionWrite(team.hash, room);
      loadTeamData();
      render(true); window.scrollTo(0, 0);
      connectRemote();
    } finally { busy = false; }
  };
  input.addEventListener('keydown', e => { if (e.key === 'Enter') enter(); });

  root.append(
    el('section', { class: 'hero' },
      el('div', { class: 'label' }, el('span', null, 'Acceso de equipo')),
      el('h2', null, 'Introduce tu clave de equipo'),
      el('p', { class: 'lead', style: 'margin-top:24px' }, 'Cada equipo tiene su propia clave y entra a sus propios datos.'),
      el('div', { class: 'row', style: 'margin-top:36px;max-width:460px' },
        el('div', { class: 'field', style: 'flex:1' }, input),
        el('button', { class: 'btn', type: 'button', onclick: enter }, 'Entrar'))));
  setTimeout(() => input.focus(), 0);
}

window.addEventListener('hashchange', () => { render(true); window.scrollTo(0, 0); });
window.addEventListener('DOMContentLoaded', () => {
  const saved = sessionRead();
  const team = saved.hash && saved.room && TEAMS.find(t => t.hash === saved.hash);
  if (team) { session.team = team; session.room = saved.room; loadTeamData(); }
  render(true);
  if (team) connectRemote();
});

/* ============================================================
   MENÚ PRINCIPAL
   ============================================================ */
function renderMenu(root) {
  root.append(
    el('section', { class: 'hero' },
      el('div', { class: 'label' }, el('span', null, 'Call of Duty'), el('span', null, 'Competitivo'), el('span', null, 'Picks / Bans')),
      el('h1', null, 'Veto Sim', el('sup', null, 'Miami erBetis')),
      el('p', { class: 'lead' }, 'Simulador de vetos, Picks y Bans y Votación del equipo. By DarkSergii')),
    el('nav', { class: 'menu-list', 'aria-label': 'Apartados' },
      menuItem('01', 'Predictor de vetos', 'Introduce el historial de veto de otro equipo y obtén un pronóstico de qué mapas vetará y elegirá.', '#/predictor'),
      menuItem('02', 'Picks y Bans', 'Simula la serie turno a turno: Equipo A contra Equipo B.', '#/draft'),
      menuItem('03', 'Votación del equipo', 'Cada jugador vota y veta mapas; después todos vemos cuáles preferimos jugar.', '#/votes')),
    el('div', { class: 'pool-strip' },
      MODE_KEYS.map(m => el('div', null,
        el('div', { class: 'label' }, MODES[m].name),
        el('div', { class: 'big' }, MODES[m].maps.length),
        el('div', { class: 'note' }, MODES[m].maps.join(' · '))))));
}
function menuItem(num, title, desc, href) {
  return el('a', { class: 'menu-item', href },
    el('span', { class: 'num' }, num), el('span', { class: 'title' }, title),
    el('span', { class: 'desc' }, desc), el('span', { class: 'arrow', 'aria-hidden': 'true' }, '→'));
}

/* ============================================================
   01 · PREDICTOR DE VETOS
   ============================================================ */
function emptyTeam() {
  const t = { series: {}, bans: {}, picks: {} };
  MODE_KEYS.forEach(m => {
    t.series[m] = 0; t.bans[m] = {}; t.picks[m] = {};
    MODES[m].maps.forEach(x => { t.bans[m][x] = 0; t.picks[m][x] = 0; });
  });
  return t;
}
function normalizeTeam(raw) {
  const t = emptyTeam();
  if (!raw || typeof raw !== 'object') return t;
  MODE_KEYS.forEach(m => {
    const s = Number(raw.series && raw.series[m]);
    t.series[m] = Number.isFinite(s) && s > 0 ? Math.floor(s) : 0;
    MODES[m].maps.forEach(x => {
      const b = Number(raw.bans && raw.bans[m] && raw.bans[m][x]);
      const p = Number(raw.picks && raw.picks[m] && raw.picks[m][x]);
      t.bans[m][x] = Number.isFinite(b) && b > 0 ? Math.floor(b) : 0;
      t.picks[m][x] = Number.isFinite(p) && p > 0 ? Math.floor(p) : 0;
    });
  });
  return t;
}

let pred;
function loadPred() {
  const raw = store.get('opp', {});
  const teams = Object.create(null);
  Object.keys(raw.teams || {}).forEach(n => { const c = cleanName(n); if (c) teams[c] = normalizeTeam(raw.teams[n]); });
  const names = Object.keys(teams);
  pred = { teams, current: teams[raw.current] ? raw.current : (names[0] || null), mode: MODES[raw.mode] ? raw.mode : 'hp' };
}
/* push=false cuando sólo cambia lo que ves tú (equipo o modo seleccionado), no los datos. */
function savePred(push = true) {
  store.set('opp', { teams: pred.teams, current: pred.current, mode: pred.mode });
  if (push && pred.current && pred.teams[pred.current]) remoteSet('opp/' + pred.current, pred.teams[pred.current]);
}
function applyRemoteOpp(val) {
  const teams = Object.create(null);
  Object.keys(val || {}).forEach(n => { const c = cleanName(n); if (c) teams[c] = normalizeTeam(val[n]); });
  pred.teams = teams;
  if (!teams[pred.current]) pred.current = Object.keys(teams)[0] || null;
  savePred(false);
}

function predict(team, m) {
  const s = team.series[m];
  const rows = MODES[m].maps.map(map => {
    const b = team.bans[m][map], p = team.picks[m][map];
    return { map, b, p, banRate: s ? Math.min(b / s, 1) : 0, pickRate: s ? Math.min(p / s, 1) : 0 };
  });
  const totalBans = rows.reduce((a, r) => a + r.b, 0);
  const expected = s ? Math.round(totalBans / s) : 0;
  const sorted = rows.slice().sort((x, y) => y.banRate - x.banRate || x.pickRate - y.pickRate);
  const likelyBans = sorted.slice(0, expected).filter(r => r.banRate > 0).map(r => r.map);
  return { rows, sorted, expected, likelyBans, s };
}

function renderPredictor(root) {
  root.append(pageHead('01', 'Predictor de vetos',
    'Apunta cuántas series has analizado de un rival y cuántas veces ha vetado o elegido cada mapa. El pronóstico sale de sus frecuencias.'));

  const names = Object.keys(pred.teams);
  const newInput = el('input', { type: 'text', placeholder: 'Nombre del equipo rival', maxlength: '24', 'aria-label': 'Nuevo equipo rival' });
  const addTeam = () => {
    const n = cleanName(newInput.value);
    if (!n) return toast('Escribe un nombre válido');
    if (pred.teams[n]) return toast('Ese equipo ya existe');
    pred.teams[n] = emptyTeam(); pred.current = n; savePred(); rerender();
  };
  newInput.addEventListener('keydown', e => { if (e.key === 'Enter') addTeam(); });

  root.append(el('div', { class: 'row' },
    names.length ? el('div', { class: 'field' },
      el('label', { class: 'label', for: 'teamSel' }, 'Equipo rival'),
      el('select', { id: 'teamSel', value: pred.current, onchange: e => { pred.current = e.target.value; savePred(false); rerender(); } },
        names.map(n => el('option', { value: n }, n)))) : null,
    el('div', { class: 'field' }, el('span', { class: 'label' }, 'Añadir equipo'), el('div', { class: 'row' }, newInput, el('button', { class: 'btn', type: 'button', onclick: addTeam }, 'Añadir'))),
    el('span', { class: 'spacer' }),
    pred.current ? el('button', {
      class: 'btn danger small', type: 'button',
      onclick: () => {
        if (!confirm(`¿Borrar "${pred.current}" y todos sus datos?`)) return;
        const gone = pred.current;
        delete pred.teams[gone]; pred.current = Object.keys(pred.teams)[0] || null;
        remoteSet('opp/' + gone, null); savePred(false); rerender();
      },
    }, 'Borrar equipo') : null));

  if (!pred.current) {
    root.append(el('div', { class: 'empty', style: 'margin-top:32px' }, 'Añade un equipo rival para empezar a introducir su historial de veto.'));
    return;
  }

  const team = pred.teams[pred.current];
  const m = pred.mode;
  root.append(tabs(m, k => { pred.mode = k; savePred(false); rerender(); }));

  const p = predict(team, m);
  const left = el('div', { class: 'panel' },
    el('h3', null, el('span', null, `Datos de veto · ${MODES[m].short}`)),
    el('div', { class: 'row center', style: 'margin-bottom:22px' },
      el('span', { class: 'label' }, 'Series analizadas'),
      stepper(team.series[m], v => { team.series[m] = v; savePred(); rerender(); })),
    // Una fila por mapa; se reparte sola en 1, 2 o 3 líneas según el ancho (sin tabla, que no cabe en móvil)
    el('div', { class: 'edit-list' }, p.rows.map(r => el('div', { class: 'edit-row' },
      el('span', { class: 'edit-name' }, r.map),
      el('div', { class: 'edit-cell' }, el('span', { class: 'label' }, 'Vetos'),
        stepper(r.b, v => { team.bans[m][r.map] = v; savePred(); rerender(); })),
      el('div', { class: 'edit-cell' }, el('span', { class: 'label' }, 'Picks'),
        stepper(r.p, v => { team.picks[m][r.map] = v; savePred(); rerender(); })),
      el('div', { class: 'edit-rates' },
        el('span', null, el('span', { class: 'label' }, 'Veto % '), p.s ? pct(r.banRate) : '—'),
        el('span', null, el('span', { class: 'label' }, 'Pick % '), p.s ? pct(r.pickRate) : '—'))))),
    p.rows.some(r => r.b > p.s || r.p > p.s) && p.s
      ? el('p', { class: 'warn', style: 'margin-top:14px' }, 'Algún mapa tiene más vetos/picks que series analizadas: revisa los datos.') : null);

  root.append(el('div', { class: 'grid-2' }, left, predictionPanel(p, m)));
}

function predictionPanel(p, m) {
  const panel = el('div', { class: 'panel' }, el('h3', null, el('span', null, `Pronóstico · ${MODES[m].name}`)));
  if (!p.s) {
    panel.append(el('p', { class: 'note' }, 'Indica cuántas series has analizado y los vetos/picks de cada mapa para ver el pronóstico.'));
    return panel;
  }
  const quality = p.s < 3 ? 'Muestra baja: tómalo con cautela' : p.s < 6 ? 'Muestra media' : 'Muestra sólida';
  panel.append(
    el('p', { class: 'note' }, `Vetos esperados por serie: ~${p.expected} · ${quality} (${p.s} series).`),
    el('div', { style: 'margin-top:12px' }, p.sorted.map(r => {
      const isBan = p.likelyBans.includes(r.map);
      const isPick = !isBan && r.pickRate >= 0.4;
      return el('div', { class: 'pred-row' },
        el('span', { class: 'name' }, r.map),
        el('span', { class: 'tag' + (isBan ? ' ban' : isPick ? ' pick' : '') }, isBan ? 'Veto probable' : isPick ? 'Pick probable' : 'Neutral'),
        el('div', { class: 'bar', title: `Veto ${pct(r.banRate)}` }, el('i', { style: `width:${r.banRate * 100}%` })),
        el('div', { class: 'bar pick', title: `Pick ${pct(r.pickRate)}` }, el('i', { style: `width:${r.pickRate * 100}%` })));
    })),
    el('p', { class: 'note', style: 'margin-top:18px' }, 'Barra roja: frecuencia de veto · Barra verde: frecuencia de pick.'));
  const stay = p.sorted.filter(r => !p.likelyBans.includes(r.map)).map(r => r.map);
  panel.append(el('p', { style: 'margin-top:18px' },
    p.likelyBans.length ? `Si repiten su historial, vetarán ${p.likelyBans.join(' y ')}. ` : 'No hay vetos claros en su historial. ',
    stay.length ? `Mapas que probablemente queden en juego: ${stay.join(', ')}.` : ''));
  return panel;
}

/* ============================================================
   02 · PICKS Y BANS (EQUIPO A vs EQUIPO B)
   ============================================================ */
function autoBans(games) {
  const bans = {};
  MODE_KEYS.forEach(m => {
    const g = games.filter(x => x === m).length;
    bans[m] = g ? Math.max(0, Math.min(2, Math.floor((MODES[m].maps.length - g) / 2))) : 0;
  });
  return bans;
}
function draftDefaults() {
  return { a: 'Equipo A', b: 'Equipo B', starter: 'a', format: 'bo5', games: FORMATS.bo5.slice(), bans: autoBans(FORMATS.bo5) };
}
function normalizeDraft(raw) {
  const d = draftDefaults();
  const s = raw && raw.setup;
  if (s && typeof s === 'object') {
    d.a = cleanName(s.a) || d.a; d.b = cleanName(s.b) || d.b;
    d.starter = s.starter === 'b' ? 'b' : 'a';
    if (FORMATS[s.format]) d.format = s.format;
    if (Array.isArray(s.games) && s.games.length >= 1 && s.games.length <= 9 && s.games.every(g => MODES[g])) d.games = s.games.slice();
    else d.games = FORMATS[d.format].slice();
    d.bans = autoBans(d.games);
    if (s.bans) MODE_KEYS.forEach(m => { const v = Number(s.bans[m]); if (Number.isInteger(v) && v >= 0 && v <= 3) d.bans[m] = v; });
  }
  let run = null;
  if (raw && raw.run && Array.isArray(raw.run.steps)) {
    const steps = raw.run.steps.filter(x => x && (x.team === 'a' || x.team === 'b') && MODES[x.mode] && (x.type === 'ban' || x.type === 'pick'));
    if (steps.length === raw.run.steps.length) {
      // Firebase no guarda listas vacías: sin resultados, la propiedad no existe
      const results = (Array.isArray(raw.run.results) ? raw.run.results : []).slice(0, steps.length);
      if (results.every((r, i) => MODES[steps[i].mode].maps.includes(r))) run = { steps, results };
    }
  }
  return { setup: d, run };
}
let draft;
function saveDraft() { store.set('draft', draft); remoteSet('draft', draft); }
function applyRemoteDraft(val) { draft = normalizeDraft(val); store.set('draft', draft); }

function setupError(s) {
  for (const m of MODE_KEYS) {
    const g = s.games.filter(x => x === m).length;
    if (!g) continue;
    const left = MODES[m].maps.length - 2 * s.bans[m];
    if (left < g) return `${MODES[m].name}: con ${s.bans[m]} veto(s) por equipo quedan ${left} mapa(s) y necesitas ${g}.`;
  }
  return '';
}

function buildSteps(s) {
  const first = s.starter, second = first === 'a' ? 'b' : 'a';
  const steps = [];
  const used = MODE_KEYS.filter(m => s.games.includes(m));
  used.forEach(m => {
    for (let k = 0; k < s.bans[m]; k++) {
      steps.push({ type: 'ban', team: first, mode: m });
      steps.push({ type: 'ban', team: second, mode: m });
    }
  });
  s.games.forEach((m, i) => steps.push({ type: 'pick', team: i % 2 === 0 ? second : first, mode: m, game: i }));
  return steps;
}

function runState(run) {
  const banned = {}, picked = {};
  MODE_KEYS.forEach(m => { banned[m] = {}; picked[m] = {}; });
  run.results.forEach((map, i) => {
    const st = run.steps[i];
    if (st.type === 'ban') banned[st.mode][map] = st.team; else picked[st.mode][map] = { team: st.team, game: st.game };
  });
  return { banned, picked };
}

function renderDraft(root) {
  root.append(pageHead('02', 'Picks y Bans',
    'Simulación normal de veto entre dos equipos. Primero vetos alternados por modo; después cada equipo elige el mapa de las partidas por turnos.'));
  if (draft.run) renderDraftBoard(root); else renderDraftSetup(root);
}

function renderDraftSetup(root) {
  const s = draft.setup;
  const upd = () => { saveDraft(); rerender(); };
  const nameField = (key, label) => el('div', { class: 'field' },
    el('label', { class: 'label', for: 'tn-' + key }, label),
    el('input', { id: 'tn-' + key, type: 'text', maxlength: '24', value: s[key], onchange: e => { s[key] = cleanName(e.target.value) || (key === 'a' ? 'Equipo A' : 'Equipo B'); upd(); } }));

  const err = setupError(s);
  const gameSlots = s.games.map((g, i) => el('div', { class: 'game-slot' },
    el('span', { class: 'label' }, `Partida ${i + 1}`),
    el('select', { 'aria-label': `Modo de la partida ${i + 1}`, value: g, onchange: e => { s.games[i] = e.target.value; s.bans = autoBans(s.games); upd(); } },
      MODE_KEYS.map(m => el('option', { value: m }, MODES[m].short)))));

  const usedModes = MODE_KEYS.filter(m => s.games.includes(m));
  root.append(
    el('div', { class: 'panel' },
      el('h3', null, el('span', null, 'Configuración de la serie')),
      el('div', { class: 'setup-grid' },
        nameField('a', 'Equipo A'), nameField('b', 'Equipo B'),
        el('div', { class: 'field' }, el('label', { class: 'label', for: 'starter' }, 'Empieza vetando'),
          el('select', { id: 'starter', value: s.starter, onchange: e => { s.starter = e.target.value; upd(); } },
            el('option', { value: 'a' }, s.a), el('option', { value: 'b' }, s.b))),
        el('div', { class: 'field' }, el('label', { class: 'label', for: 'fmt' }, 'Formato'),
          el('select', { id: 'fmt', value: s.format, onchange: e => { s.format = e.target.value; s.games = FORMATS[s.format].slice(); s.bans = autoBans(s.games); upd(); } },
            el('option', { value: 'bo3' }, 'Mejor de 3'), el('option', { value: 'bo5' }, 'Mejor de 5'), el('option', { value: 'bo7' }, 'Mejor de 7')))),
      el('div', { style: 'margin-top:28px' }, el('span', { class: 'label' }, 'Modos por partida (editable)'), el('div', { class: 'games-list', style: 'margin-top:10px' }, gameSlots)),
      el('div', { style: 'margin-top:28px' }, el('span', { class: 'label' }, 'Vetos por equipo y modo'),
        el('div', { class: 'row center', style: 'margin-top:10px;gap:28px' },
          usedModes.map(m => el('div', { class: 'row center' }, el('span', null, MODES[m].short),
            stepper(s.bans[m], v => { s.bans[m] = v; upd(); }, 0, 3))))),
      err ? el('p', { class: 'warn', style: 'margin-top:18px' }, err) : null,
      el('div', { class: 'row', style: 'margin-top:28px' },
        el('button', { class: 'btn', type: 'button', disabled: !!err, onclick: () => { draft.run = { steps: buildSteps(s), results: [] }; saveDraft(); rerender(); } }, 'Empezar veto'),
        el('button', { class: 'btn small', type: 'button', onclick: () => { Object.assign(s, draftDefaults()); upd(); } }, 'Restablecer'))));
}

function renderDraftBoard(root) {
  const s = draft.setup, run = draft.run;
  const name = t => s[t];
  const done = run.results.length >= run.steps.length;
  const cur = done ? null : run.steps[run.results.length];
  const { banned, picked } = runState(run);

  const stepText = st => st.type === 'ban'
    ? `${name(st.team)} veta un mapa de ${MODES[st.mode].short}`
    : `${name(st.team)} elige el mapa de la partida ${st.game + 1} (${MODES[st.mode].short})`;

  root.append(el('div', { class: 'banner' + (done ? ' done' : '') },
    el('span', { class: 'what' }, done ? 'Veto completado' : stepText(cur)),
    el('span', { class: 'label' }, done ? `${run.steps.length} pasos` : `Paso ${run.results.length + 1} de ${run.steps.length} · ${cur.type === 'ban' ? 'Veto' : 'Pick'}`)),
    el('div', { class: 'row', style: 'margin-bottom:8px' },
      el('button', { class: 'btn small', type: 'button', disabled: !run.results.length, onclick: () => { run.results.pop(); saveDraft(); rerender(); } }, 'Deshacer'),
      el('button', { class: 'btn small danger', type: 'button', onclick: () => { if (confirm('¿Reiniciar el veto?')) { draft.run = null; saveDraft(); rerender(); } } }, 'Reiniciar / Configurar')));

  MODE_KEYS.filter(m => s.games.includes(m)).forEach(m => {
    const isCur = !!cur && cur.mode === m;
    root.append(el('section', { class: 'mode-block' + (isCur ? ' current' : '') },
      el('div', { class: 'head' }, el('h3', null, MODES[m].name), el('span', { class: 'label' }, `Partidas: ${s.games.map((g, i) => g === m ? i + 1 : null).filter(Boolean).join(', ')}`)),
      el('div', { class: 'map-grid' }, MODES[m].maps.map(map => {
        const b = banned[m][map], pk = picked[m][map];
        const free = !b && !pk;
        const clickable = isCur && free;
        const status = b ? `Veto · ${name(b)}` : pk ? `Pick · ${name(pk.team)} · Partida ${pk.game + 1}` : (clickable ? (cur.type === 'ban' ? 'Disponible · vetar' : 'Disponible · elegir') : 'Disponible');
        return el('button', {
          class: 'map-card' + (b ? ' banned' : '') + (pk ? ' picked' : '') + (clickable ? ' clickable' : '') + (!isCur && free ? ' dim' : ''),
          type: 'button', disabled: !clickable,
          'aria-label': `${map} (${MODES[m].short}): ${status}`,
          onclick: () => { run.results.push(map); saveDraft(); rerender(); },
        }, mapImg(map), el('div', { class: 'body' }, el('span', { class: 'name' }, map), el('span', { class: 'status' }, status)));
      }))));
  });

  const tl = el('ol', { class: 'timeline' }, run.steps.map((st, i) => {
    const res = run.results[i];
    return el('li', { class: res ? '' : (i === run.results.length ? 'now' : 'pending') },
      el('span', { class: 'i' }, String(i + 1).padStart(2, '0')),
      el('span', null, `${st.type === 'ban' ? 'Veto' : 'Pick'} · ${name(st.team)} · ${MODES[st.mode].short}`),
      el('span', null, res || (i === run.results.length ? 'En curso' : '—')));
  }));

  const panels = [el('div', { class: 'panel', style: 'margin-top:48px' }, el('h3', null, el('span', null, 'Historial')), tl)];
  if (done) {
    const lines = s.games.map((m, i) => {
      const idx = run.steps.findIndex(st => st.type === 'pick' && st.game === i);
      return `Partida ${i + 1} · ${MODES[m].short} · ${run.results[idx]} (pick de ${name(run.steps[idx].team)})`;
    });
    const bansTxt = MODE_KEYS.filter(m => s.games.includes(m)).map(m => {
      const list = run.steps.map((st, i) => st.type === 'ban' && st.mode === m ? `${run.results[i]} (${name(st.team)})` : null).filter(Boolean);
      return list.length ? `Vetos ${MODES[m].short}: ${list.join(', ')}` : null;
    }).filter(Boolean);
    const text = `${s.a} vs ${s.b}\n${lines.join('\n')}\n${bansTxt.join('\n')}`.trim();
    panels.push(el('div', { class: 'panel' },
      el('h3', null, el('span', null, 'Serie final')),
      el('table', { class: 'data' },
        el('thead', null, el('tr', null, ['Partida', 'Modo', 'Mapa', 'Elige'].map(h => el('th', null, h)))),
        el('tbody', null, s.games.map((m, i) => {
          const idx = run.steps.findIndex(st => st.type === 'pick' && st.game === i);
          return el('tr', null, el('td', null, i + 1), el('td', null, MODES[m].short), el('td', null, run.results[idx]), el('td', { class: 'num-cell' }, name(run.steps[idx].team)));
        }))),
      el('div', { class: 'row', style: 'margin-top:22px' },
        el('button', { class: 'btn', type: 'button', onclick: async () => toast((await copyText(text)) ? 'Resumen copiado' : 'No se pudo copiar') }, 'Copiar resumen'))));
  }
  root.append(...panels);
}

/* ============================================================
   03 · VOTACIÓN DEL EQUIPO
   Valores: 1 = Jugar, -1 = Vetar, ausente = neutral.
   ============================================================ */
function sanitizeVotes(raw) {
  const v = {};
  MODE_KEYS.forEach(m => {
    v[m] = {};
    MODES[m].maps.forEach(x => {
      const n = raw && raw[m] ? raw[m][x] : 0;
      if (n === 1 || n === -1) v[m][x] = n;
    });
  });
  return v;
}
let votes;
function loadVotes() {
  const raw = store.get('votes', {});
  const players = Object.create(null);
  Object.keys(raw.players || {}).forEach(n => { const c = cleanName(n); if (c) players[c] = sanitizeVotes(raw.players[n]); });
  const me = cleanName(store.get('me', ''));
  if (me && !players[me]) players[me] = sanitizeVotes();
  votes = { players, me };
}
/* Sólo se sube el voto propio; el de los demás lo escriben ellos. */
function saveVotes() {
  store.set('votes', { players: votes.players }); store.set('me', votes.me);
  if (votes.me && votes.players[votes.me]) remoteSet('votes/' + votes.me, votes.players[votes.me]);
}
function applyRemoteVotes(val) {
  const players = Object.create(null);
  Object.keys(val || {}).forEach(n => { const c = cleanName(n); if (c) players[c] = sanitizeVotes(val[n]); });
  if (votes.me && !players[votes.me]) players[votes.me] = sanitizeVotes(); // sin votos aún
  votes.players = players;
  store.set('votes', { players });
}

/* Almacenamiento compartido: al estar en GitHub Pages no hay servidor, así que los votos se
   intercambian con "códigos" de texto (copiar / importar). Si en el futuro se añade un backend
   (Firebase, Supabase…), sólo hay que sustituir saveVotes()/votes por llamadas remotas. */
const encodeCode = obj => {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let bin = ''; bytes.forEach(b => { bin += String.fromCharCode(b); });
  return btoa(bin);
};
const decodeCode = str => {
  const bin = atob(String(str).replace(/\s+/g, ''));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))));
};
function importCode(str) {
  let obj;
  try { obj = decodeCode(str); } catch { throw new Error('Código no válido'); }
  if (!obj || obj.v !== 1 || typeof obj.players !== 'object' || !obj.players) throw new Error('Código no válido');
  let n = 0;
  Object.keys(obj.players).forEach(k => {
    const name = cleanName(k);
    if (!name) return;
    votes.players[name] = sanitizeVotes(obj.players[k]); n++;
  });
  if (!n) throw new Error('El código no contiene jugadores');
  saveVotes();
  return n;
}

function renderVotes(root) {
  root.append(pageHead('03', 'Votación del equipo',
    'Cada jugador marca qué mapas quiere jugar y cuáles quiere vetar. Abajo se ve el consenso del equipo.'));

  const nameInput = el('input', { type: 'text', maxlength: '24', placeholder: 'Tu nombre o nick', value: votes.me, 'aria-label': 'Tu nombre' });
  const setMe = () => {
    const n = cleanName(nameInput.value);
    if (!n) return toast('Escribe un nombre válido');
    votes.me = n; if (!votes.players[n]) votes.players[n] = sanitizeVotes(); saveVotes(); rerender();
  };
  nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') setMe(); });

  root.append(el('div', { class: 'panel' },
    el('h3', null, el('span', null, 'Jugador')),
    el('div', { class: 'row' },
      el('div', { class: 'field' }, el('span', { class: 'label' }, votes.me ? 'Votando como' : 'Tu nombre'), nameInput),
      el('button', { class: 'btn', type: 'button', onclick: setMe }, votes.me ? 'Cambiar nombre' : 'Entrar')),
    Object.keys(votes.players).length ? el('div', { style: 'margin-top:22px' },
      el('span', { class: 'label' }, 'Jugadores con votos'),
      el('div', { class: 'chips', style: 'margin-top:10px' }, Object.keys(votes.players).map(n => el('span', { class: 'chip' + (n === votes.me ? ' me' : '') },
        n, el('button', { type: 'button', 'aria-label': `Eliminar a ${n}`, onclick: () => {
          if (!confirm(`¿Eliminar los votos de ${n}?`)) return;
          delete votes.players[n]; if (votes.me === n) votes.me = '';
          remoteSet('votes/' + n, null); saveVotes(); rerender();
        } }, '×'))))) : null));

  if (!votes.me) {
    root.append(el('div', { class: 'empty', style: 'margin-top:32px' }, 'Escribe tu nombre para empezar a votar.'));
  } else {
    root.append(el('div', { class: 'label', style: 'margin:44px 0 6px' }, `Tus votos · ${votes.me}`));
    const mine = votes.players[votes.me];
    MODE_KEYS.forEach(m => root.append(el('section', { class: 'mode-block' },
      el('div', { class: 'head' }, el('h3', null, MODES[m].name), el('span', { class: 'label' }, 'Jugar / Vetar')),
      el('div', { class: 'map-grid' }, MODES[m].maps.map(map => {
        const val = mine[m][map] || 0;
        const setVote = want => { if (val === want) delete mine[m][map]; else mine[m][map] = want; saveVotes(); rerender(); };
        return el('div', { class: 'map-card' + (val === 1 ? ' voted-play' : val === -1 ? ' voted-veto' : '') },
          mapImg(map),
          el('div', { class: 'body' }, el('span', { class: 'name' }, map),
            el('div', { class: 'vote-btns' },
              el('button', { class: 'btn small play' + (val === 1 ? ' on' : ''), type: 'button', 'aria-pressed': String(val === 1), onclick: () => setVote(1) }, 'Jugar'),
              el('button', { class: 'btn small veto' + (val === -1 ? ' on' : ''), type: 'button', 'aria-pressed': String(val === -1), onclick: () => setVote(-1) }, 'Vetar'))));
      })))));
  }

  renderVoteResults(root);
  // Los códigos sólo hacen falta si no hay conexión con Firebase
  if (remote.status === 'error' || remote.status === 'denied') renderVoteShare(root);
}

function renderVoteResults(root) {
  const players = Object.keys(votes.players);
  root.append(el('div', { class: 'label', style: 'margin:64px 0 6px' }, `Resultados del equipo · ${players.length} jugador(es)`));
  if (!players.length) { root.append(el('div', { class: 'empty', style: 'margin-top:16px' }, 'Todavía no hay votos.')); return; }

  MODE_KEYS.forEach(m => {
    const rows = MODES[m].maps.map(map => {
      const play = players.filter(n => votes.players[n][m][map] === 1);
      const veto = players.filter(n => votes.players[n][m][map] === -1);
      return { map, play, veto, score: play.length - veto.length };
    }).sort((a, b) => b.score - a.score || b.play.length - a.play.length || a.map.localeCompare(b.map));
    const topPlay = rows[0].play.length ? rows[0] : null;
    const topVeto = rows.slice().sort((a, b) => b.veto.length - a.veto.length)[0];
    root.append(el('section', { class: 'mode-block' },
      el('div', { class: 'head' }, el('h3', null, MODES[m].name),
        el('span', { class: 'label' }, [topPlay ? `Preferido: ${topPlay.map}` : null, topVeto.veto.length ? `Más vetado: ${topVeto.map}` : null].filter(Boolean).join(' · ') || 'Sin votos')),
      el('div', { class: 'panel' }, rows.map((r, i) => el('div', { class: 'pred-row' },
        el('span', { class: 'name' }, el('span', { class: 'rank' }, String(i + 1).padStart(2, '0')), r.map),
        el('span', { class: 'tag' + (r.score > 0 ? ' pick' : r.score < 0 ? ' ban' : '') }, (r.score > 0 ? '+' : '') + r.score),
        el('div', { class: 'bar split', title: `Jugar ${r.play.length} · Vetar ${r.veto.length}` },
          el('i', { class: 'play', style: `width:${r.play.length / players.length * 100}%` }),
          el('i', { class: 'veto', style: `width:${r.veto.length / players.length * 100}%` })),
        (r.play.length || r.veto.length) ? el('div', { class: 'who', style: 'grid-column:1/-1;margin-top:0' },
          r.play.length ? [el('b', null, 'Jugar: '), r.play.join(', ')] : null,
          r.play.length && r.veto.length ? '  ·  ' : null,
          r.veto.length ? [el('b', { class: 'v' }, 'Vetar: '), r.veto.join(', ')] : null) : null)))));
  });
}

function renderVoteShare(root) {
  const area = el('textarea', { placeholder: 'Pega aquí el código de un compañero…', 'aria-label': 'Código a importar' });
  root.append(el('div', { class: 'panel', style: 'margin-top:56px' },
    el('h3', null, el('span', null, 'Compartir votos')),
    el('p', { class: 'note', style: 'margin-bottom:18px' },
      'Los votos se guardan en tu navegador. Para juntarlos: cada uno copia su código, lo pasa por Discord/WhatsApp y los demás lo importan aquí. Con el código de equipo, uno solo puede repartir los resultados de todos.'),
    el('div', { class: 'row', style: 'margin-bottom:18px' },
      el('button', { class: 'btn', type: 'button', disabled: !votes.me, onclick: async () => toast((await copyText(encodeCode({ v: 1, players: { [votes.me]: votes.players[votes.me] } }))) ? 'Tu código copiado' : 'No se pudo copiar') }, 'Copiar mi código'),
      el('button', { class: 'btn', type: 'button', disabled: !Object.keys(votes.players).length, onclick: async () => toast((await copyText(encodeCode({ v: 1, players: votes.players }))) ? 'Código de equipo copiado' : 'No se pudo copiar') }, 'Copiar código de equipo')),
    area,
    el('div', { class: 'row', style: 'margin-top:12px' },
      el('button', { class: 'btn', type: 'button', onclick: () => {
        try { const n = importCode(area.value); toast(`${n} jugador(es) importado(s)`); rerender(); }
        catch (e) { toast(e.message); }
      } }, 'Importar'),
      el('span', { class: 'spacer' }),
      el('button', { class: 'btn small danger', type: 'button', onclick: () => {
        if (!confirm('¿Borrar TODOS los votos guardados en este navegador?')) return;
        Object.keys(votes.players).forEach(k => delete votes.players[k]);
        remoteSet('votes', null);
        if (votes.me) votes.players[votes.me] = sanitizeVotes();
        saveVotes(); rerender();
      } }, 'Borrar todos los votos'))));
}
