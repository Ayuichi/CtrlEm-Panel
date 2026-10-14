// CtrlEm Panel - browser side. Talks only to the local server (server.js), which holds the key.
'use strict';

const $ = s => document.querySelector(s);
const el = (tag, props, ...kids) => {
  const e = document.createElement(tag);
  if (props) for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v != null && v !== false) e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k);
  return e;
};

// media: file kind this command accepts. url: a link with no file upload. desktop: Android cannot run it.
const COMMANDS = [
  { id: 'popupImage', label: 'Image', media: 'image', help: 'Shows a popup image on their screen.' },
  { id: 'videoOverlay', label: 'Video', media: 'video', desktop: true, help: 'Plays a video as a transparent fullscreen overlay. Desktop only.' },
  { id: 'popupSound', label: 'Sound', media: 'audio', help: 'Plays an audio file from a URL on their device.' },
  { id: 'sendMessage', label: 'Message', text: 'Message', help: 'Types a message as them.' },
  { id: 'writeForMe', label: 'Write', text: 'Text', count: true, max: 200, help: 'Types this into the active window, up to 200 characters. Count repeats it from 1 to 5 times.' },
  { id: 'changeWallpaper', label: 'Wallpaper', media: 'image', desktop: true, help: 'Changes the desktop wallpaper.' },
  { id: 'openPage', label: 'Open page', url: true, help: 'Opens a URL in their browser.' },
  { id: 'lockinput', label: 'Lock input', desktop: true, help: 'Locks the keyboard and mouse. Desktop only.' },
  { id: 'screenBlank', label: 'Blank screen', desktop: true, help: 'Blanks the monitor. Desktop only, and at most once every 30 seconds per person.' },
  { id: 'reactionTest', label: 'Reaction test', help: 'Runs a reaction test on their screen. They have to allow it. CtrlEm sets the timer.' },
];

const state = {
  config: null,
  users: [],
  info: new Map(),       // code -> { user, devices, raw, error, enabledError }
  tab: 'online',
  targets: [],
  focus: null,
  cmd: COMMANDS[0],
  rate: null,
  library: [],
  albums: [],
  albumView: '',
  activity: [],
  sending: false,
  loadingUsers: false,
  lastSent: new Map(),   // code -> ms, so the same person is not sent twice inside 3s
  blankAt: new Map(),    // code -> ms, screenBlank is limited to once per 30s
  sequence: { id: '', name: '', steps: [] },
  sequences: [],
  seqView: 'edit',
  run: null,             // { name, steps } copied when Play is pressed
  playing: false,
  seqStop: false,
  seqIndex: -1,
  mirrorAbort: null,
};

// ---------- api ----------

async function api(path, opts = {}) {
  const r = await fetch(path, {
    method: opts.method || 'GET',
    headers: Object.assign({ 'X-Panel': '1' }, opts.body ? { 'Content-Type': 'application/json' } : {}),
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
  });
  const text = await r.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!r.ok) {
    const msg = (data && typeof data === 'object' && (data.error || data.message)) || (typeof data === 'string' && data.slice(0, 200)) || r.statusText;
    const err = new Error(String(msg || r.statusText)); err.status = r.status; err.data = data; throw err;
  }
  return data;
}

function isAbort(err) {
  return !!(err && (err.name === 'AbortError' || /aborted/i.test(err.message || '')));
}
function explain(err) {
  const detail = err && err.data && typeof err.data === 'object' && (err.data.error || err.data.message);
  const extra = detail ? String(detail) : (err && err.message) || 'Request failed.';
  if (!err || !err.status) return extra;
  if (err.status === 401) return extra || 'API key missing or rejected.';
  if (err.status === 403) return extra || 'Blocked. They have not opted in, the whitelist refused you, or the key is banned.';
  if (err.status === 404) return extra || 'No user with that control code.';
  if (err.status === 429) return extra || 'Rate limit, or the 3 second pause between commands.';
  if (err.status === 400) return extra || 'Offline, or the request was rejected.';
  return extra;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function safeHttp(value) {
  try {
    const u = new URL(String(value || '').trim());
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.href;
  } catch { /* not a url */ }
  return '';
}
function linkHost(value) {
  try {
    return new URL(String(value || '')).hostname.toLowerCase().replace(/\.$/, '');
  } catch { return ''; }
}
function isPomfHost(value) {
  const host = linkHost(value);
  return host === 'pomf.lain.la' || host === 'pomf2.lain.la';
}
// Only u.pone.rs is copied. A link saved from somewhere else is sent unchanged.
function needsPomfMirror(url) {
  return linkHost(url) === 'u.pone.rs';
}
// A page, a missing file, or a file over Pomf's limit will fail the same way again.
function pomfPermanent(err) {
  const msg = explain(err);
  return /page, not the file|Download failed \((404|410)\)|accepts files up to|not a downloadable URL|Too many redirects/i.test(msg);
}
const POMF_RETRY_MS = 20000;
function knownPomf(url) {
  if (isPomfHost(url)) return url;
  const entry = state.library.find(item => item && item.url === url && isPomfHost(item.pomfUrl));
  return entry ? safeHttp(entry.pomfUrl) : '';
}
async function mirrorUrl(url, name, signal) {
  const known = knownPomf(url);
  if (known) return known;
  if (!needsPomfMirror(url)) return '';
  const res = await api('/api/mirror', { method: 'POST', body: { url, name: name || '' }, signal });
  const link = res && safeHttp(res.pomfUrl);
  if (!isPomfHost(link)) throw new Error('Pomf did not return a link');
  for (const entry of state.library) if (entry && entry.url === url) entry.pomfUrl = link;
  return link;
}

function kindOfFile(file) {
  const type = file.type || '';
  const name = file.name || '';
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'].includes(ext)) return 'image';
  if (['.mp4', '.webm', '.mov', '.mkv', '.m4v'].includes(ext)) return 'video';
  if (['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.opus', '.aac'].includes(ext)) return 'audio';
  return 'other';
}

// ---------- users ----------

const pick = (o, ...keys) => { for (const k of keys) if (o && o[k] != null && o[k] !== '') return o[k]; };
function listOf(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') for (const k of ['users', 'data', 'items', 'results', 'online']) if (Array.isArray(data[k])) return data[k];
  return [];
}
function unwrapUser(u) {
  if (!u || typeof u !== 'object') return u;
  if (u.controlCode || u.control_code) return u;
  if (u.user && typeof u.user === 'object') return u.user;
  if (u.data && typeof u.data === 'object' && !Array.isArray(u.data)) return u.data;
  return u;
}
function normUser(raw) {
  const u = unwrapUser(raw) || {};
  if (typeof u === 'string') return { code: u.toUpperCase(), name: u, online: undefined, likes: '', limits: '', notes: '', avatar: '', verified: false, verifiedOnly: false, whitelist: false, allowApi: undefined, visible: undefined, lastSeen: '' };
  const code = String(pick(u, 'controlCode', 'control_code', 'code') || '').toUpperCase();
  let online;
  if (typeof u.isOnline === 'boolean') online = u.isOnline;
  else if (typeof u.online === 'boolean') online = u.online;
  return {
    code,
    name: String(pick(u, 'username', 'displayName', 'name') || code),
    online,
    likes: String(pick(u, 'profileLikes', 'likes') || ''),
    limits: String(pick(u, 'profileLimits', 'limits') || ''),
    notes: String(pick(u, 'profileNotes', 'notes') || ''),
    avatar: String(pick(u, 'avatarUrl', 'avatar') || ''),
    verified: u.isVerified === true || u.verified === true,
    verifiedOnly: u.verifiedOnlyMode === true,
    whitelist: u.whitelistEnabled === true,
    allowApi: typeof u.allowApiCommands === 'boolean' ? u.allowApiCommands : undefined,
    visible: typeof u.isVisible === 'boolean' ? u.isVisible : undefined,
    lastSeen: pick(u, 'lastSeen') || '',
  };
}

// null commands means the device allows every API command. An array is the allow list.
function parseDevices(data) {
  const list = data && Array.isArray(data.devices) ? data.devices : [];
  return list.filter(d => d && typeof d === 'object').map(d => {
    const listed = Object.prototype.hasOwnProperty.call(d, 'enabledCommands') && d.enabledCommands != null;
    return {
      clientType: String(d.clientType || '').toUpperCase(),
      machineId: d.machineId ? String(d.machineId) : '',
      lastSeen: d.lastSeen || '',
      commands: listed ? (Array.isArray(d.enabledCommands) ? d.enabledCommands.map(String) : []) : null,
    };
  });
}

function setStatus(text, cls) {
  const s = $('#status');
  s.className = 'status ' + (cls || '');
  s.replaceChildren();
  if (text === 'No API key. Open Settings.') {
    s.append(el('button', { type: 'button', onclick: () => openSettings() }, 'No API key. Open Settings.'));
    return;
  }
  s.textContent = text;
}

async function loadConfig() {
  state.config = await api('/api/config');
  if (!Array.isArray(state.config.favorites)) state.config.favorites = [];
  if (!Array.isArray(state.config.pomfCodes)) state.config.pomfCodes = [];
}

async function pollRate() {
  try {
    state.rate = await api('/api/rate');
    const r = state.rate, n = $('#rate');
    n.textContent = r.lastMinute + ' / ' + r.limit + ' per min' + (r.nextFreeIn > 0 ? ' · free in ' + Math.ceil(r.nextFreeIn / 1000) + 's' : '');
    n.className = 'rate ' + (r.lastMinute >= r.limit ? 'bad' : r.lastMinute >= r.limit * 0.75 ? 'warn' : '');
  } catch { /* the next action shows that the server is gone */ }
}

async function loadUsers(quiet) {
  if (!state.config || !state.config.hasKey) { setStatus('No API key. Open Settings.', 'bad'); renderUsers(); return; }
  if (state.loadingUsers) return;
  state.loadingUsers = true;
  if (!quiet) setStatus('Loading users…');
  try {
    const data = await api('/api/users');
    state.users = listOf(data).map(normUser).filter(u => u.code).map(u => Object.assign(u, { online: u.online !== false }));
    setStatus('Connected · ' + state.users.length + ' online', 'ok');
  } catch (err) {
    setStatus('Users: ' + explain(err), 'bad');
  } finally {
    state.loadingUsers = false;
  }
  renderUsers();
}

const isFav = code => state.config.favorites.some(f => f.code === code);
const isPomf = code => !!(state.config && state.config.pomfCodes.includes(code));
async function togglePomf(code) {
  if (!state.config || state.playing) return;
  const prev = state.config.pomfCodes.slice();
  const next = prev.includes(code) ? prev.filter(c => c !== code) : prev.concat(code);
  state.config.pomfCodes = next;
  renderTargets();
  try {
    await api('/api/config', { method: 'POST', body: { pomfCodes: next } });
  } catch (err) {
    state.config.pomfCodes = prev;
    renderTargets();
    logLine(explain(err), 'bad');
  }
}
async function toggleFav(u) {
  const prev = state.config.favorites.slice();
  const next = prev.some(f => f.code === u.code) ? prev.filter(f => f.code !== u.code) : prev.concat({ code: u.code, name: u.name || u.code });
  state.config.favorites = next;
  renderUsers();
  try {
    await api('/api/config', { method: 'POST', body: { favorites: next } });
  } catch (err) {
    state.config.favorites = prev;
    renderUsers();
    setStatus(explain(err), 'bad');
  }
}

function favRow(f) {
  const live = state.users.find(u => u.code === f.code);
  if (live) return live;
  const known = state.info.get(f.code);
  if (known && known.user && typeof known.user.online === 'boolean') return known.user;
  return { code: f.code, name: f.name || f.code, likes: '', limits: '', notes: '', online: false };
}

function renderUsers() {
  if (!state.config) return;
  const q = $('#search').value.trim().toLowerCase();
  const list = state.tab === 'online' ? state.users : state.config.favorites.map(favRow);
  const shown = list.filter(u => !q || (u.name + ' ' + u.code + ' ' + (u.likes || '') + ' ' + (u.limits || '') + ' ' + (u.notes || '')).toLowerCase().includes(q));
  $('#countOnline').textContent = state.users.length || '';
  $('#countFav').textContent = state.config.favorites.length || '';
  const ul = $('#userList'); ul.replaceChildren();
  if (!shown.length) ul.append(el('li', { class: 'empty' }, state.tab === 'online' ? 'Nobody online has allowed script access.' : 'No favorites yet. Star someone.'));
  for (const u of shown) {
    ul.append(el('li', { class: state.targets.includes(u.code) ? 'sel' : '', title: 'Click to add as target', onclick: () => toggleTarget(u.code) },
      el('span', { class: 'dot' + (u.online ? ' on' : '') }),
      el('div', { class: 'who' }, el('div', { class: 'name' }, u.name), el('div', { class: 'meta' }, u.code + (u.likes ? ' · ' + u.likes : ''))),
      el('button', { type: 'button', class: 'star' + (isFav(u.code) ? ' on' : ''), title: 'Favorite', onclick: e => { e.stopPropagation(); toggleFav(u); } }, isFav(u.code) ? '★' : '☆')));
  }
}

async function loadInfo(code) {
  const entry = { user: null, devices: [], raw: {}, error: '', enabledError: '' };
  state.info.set(code, entry);
  const [user, enabled] = await Promise.allSettled([
    api('/api/users/' + encodeURIComponent(code)),
    api('/api/users/' + encodeURIComponent(code) + '/enabled-commands'),
  ]);
  entry.raw.user = user.status === 'fulfilled' ? user.value : (user.reason && user.reason.data) || String(user.reason);
  entry.raw.enabledCommands = enabled.status === 'fulfilled' ? enabled.value : (enabled.reason && enabled.reason.data) || String(enabled.reason);
  if (user.status === 'fulfilled') entry.user = normUser(user.value);
  else entry.error = explain(user.reason);
  if (enabled.status === 'fulfilled') entry.devices = parseDevices(enabled.value);
  else entry.enabledError = explain(enabled.reason);
  return entry;
}

function labelOf(code) {
  const info = state.info.get(code);
  if (info && info.user && info.user.name) return info.user.name;
  const live = state.users.find(u => u.code === code);
  if (live && live.name) return live.name;
  const fav = state.config && state.config.favorites.find(f => f.code === code);
  if (fav && fav.name) return fav.name;
  return code;
}

async function toggleTarget(code) {
  code = String(code || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{3,12}$/.test(code)) { logLine('Control codes are letters and digits.', 'bad'); return; }
  if (state.targets.includes(code)) { removeTarget(code); return; }
  state.targets.push(code);
  state.focus = code;
  renderTargets();
  renderUsers();
  await loadInfo(code);
  renderTargets();
  renderUsers();
}

function removeTarget(code) {
  state.targets = state.targets.filter(c => c !== code);
  if (state.focus === code) state.focus = state.targets[state.targets.length - 1] || null;
  renderTargets();
  renderUsers();
}

function renderTargets() {
  const box = $('#targets'); box.replaceChildren();
  if (!state.targets.length) box.append(el('span', { class: 'none' }, 'Select people on the left, or look up a control code.'));
  for (const code of state.targets) {
    const name = labelOf(code);
    const marked = isPomf(code);
    box.append(el('span', { class: 'chip' + (code === state.focus ? ' active' : ''), onclick: () => { state.focus = code; renderTargets(); } },
      name === code ? code : name + ' · ' + code,
      el('button', {
        type: 'button',
        class: 'pomf' + (marked ? ' on' : ''),
        title: marked ? 'This person gets Pomf links. Click to send the original links again.' : 'Send this person Pomf links',
        onclick: e => { e.stopPropagation(); togglePomf(code); },
      }, 'Pomf'),
      el('button', { type: 'button', title: 'Remove', onclick: e => { e.stopPropagation(); removeTarget(code); } }, '×')));
  }
  renderDetails();
  renderCmdTabs();
}

function ago(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 45) return 'just now';
  const min = Math.round(s / 60);
  if (min < 60) return min + ' min ago';
  const hr = Math.round(min / 60);
  if (hr < 36) return hr + ' h ago';
  return new Date(t).toLocaleString();
}

function deviceName(d, all) {
  const base = d.clientType === 'ANDROID' ? 'Android' : d.clientType === 'DESKTOP' ? 'Desktop' : (d.clientType || 'Device');
  const same = all.filter(x => x.clientType === d.clientType).length;
  return same > 1 && d.machineId ? base + ' ' + d.machineId.slice(-4) : base;
}
function deviceCount(d) {
  if (d.commands == null) return 'all commands';
  if (d.commands.length === 1) return '1 command';
  return d.commands.length + ' commands';
}

function renderDetails() {
  const box = $('#details'); box.replaceChildren();
  const code = state.focus;
  if (!code) return;
  const info = state.info.get(code);
  if (!info) { box.textContent = 'Loading…'; return; }
  if (!info.user) {
    box.append(info.error || 'Could not load this user.');
    box.append(el('div', {}, el('a', { href: '#', onclick: e => { e.preventDefault(); showRaw(); } }, 'Raw response')));
    return;
  }
  const u = info.user;
  const who = el('div', { class: 'idline' });
  const avatar = safeHttp(u.avatar);
  if (avatar) who.append(el('img', { class: 'avatar', src: avatar, alt: '' }));
  who.append(el('div', {}, el('div', {}, u.name + (u.name === u.code ? '' : ' · ' + u.code))));
  box.append(who);
  const facts = [];
  if (u.online === true) facts.push('Online');
  else if (u.online === false) facts.push('Offline');
  if (u.verified) facts.push('Verified');
  if (u.lastSeen) facts.push('Last seen ' + ago(u.lastSeen));
  if (facts.length) box.append(el('div', {}, facts.join(' · ')));
  if (u.likes) box.append(el('div', {}, 'Likes: ' + u.likes));
  if (u.limits) box.append(el('div', {}, 'Limits: ' + u.limits));
  if (u.notes) box.append(el('div', {}, 'Notes: ' + u.notes));
  if (u.allowApi === false) box.append(el('div', { class: 'bad' }, 'Script access is off. Commands will be refused.'));
  if (u.verifiedOnly) box.append(el('div', { class: 'warn' }, 'Verified-only mode is on. You need to be verified.'));
  if (u.whitelist) box.append(el('div', { class: 'warn' }, 'Whitelist is on. You need to be on their list.'));
  if (u.visible === false) box.append(el('div', {}, 'Hidden from the public online list.'));
  if (info.enabledError) box.append(el('div', { class: 'warn' }, info.enabledError));
  if (info.devices.length) {
    const picked = selectedDevice();
    const chips = el('div', { class: 'dev-chips' });
    for (const d of info.devices) {
      const on = picked && d.clientType === picked;
      const title = d.commands == null ? 'All commands allowed' : (d.commands.join(', ') || 'No commands allowed');
      chips.append(el('button', { type: 'button', class: on ? 'on' : '', title, onclick: () => pickDevice(d.clientType) },
        deviceName(d, info.devices) + ' · ' + deviceCount(d)));
    }
    box.append(chips);
  } else if (!info.enabledError) box.append(el('div', {}, 'No device online.'));
  box.append(el('div', {}, el('a', { href: '#', onclick: e => { e.preventDefault(); showRaw(); } }, 'Raw response')));
}

function showRaw() {
  const info = state.info.get(state.focus);
  $('#rawTitle').textContent = (state.focus || 'Raw') + ' response';
  $('#rawBody').textContent = JSON.stringify(info ? info.raw : {}, null, 2);
  $('#rawDlg').showModal();
}

// ---------- commands ----------

function selectedDevice() {
  const v = $('#argDevice').value;
  return v === 'DESKTOP' || v === 'ANDROID' ? v : '';
}
function blankWaitLeft(code) {
  return 30000 - (Date.now() - (state.blankAt.get(code) || 0));
}
function deviceAllows(device, cmd) {
  if (cmd.desktop && device.clientType === 'ANDROID') return false;
  if (device.commands == null) return true;
  return device.commands.includes(cmd.id);
}
function targetAllows(code, cmd) {
  const info = state.info.get(code);
  if (!info || !info.user) return { ok: false, reason: info && info.error ? info.error : 'Still loading' };
  const u = info.user;
  if (u.allowApi === false) return { ok: false, reason: 'Script access is off' };
  if (u.online === false) return { ok: false, reason: 'Offline' };
  const picked = selectedDevice();
  if (cmd.desktop && picked === 'ANDROID') return { ok: false, reason: 'Desktop only' };
  const devices = info.devices || [];
  if (!devices.length) return { ok: false, reason: info.enabledError ? 'Could not read enabled commands' : 'No device online' };
  let relevant = devices;
  if (picked) relevant = devices.filter(d => d.clientType === picked);
  else if (cmd.desktop) relevant = devices.filter(d => d.clientType !== 'ANDROID');
  if (!relevant.length) return { ok: false, reason: picked === 'ANDROID' ? 'No Android device' : 'No desktop online' };
  if (!relevant.some(d => deviceAllows(d, cmd))) return { ok: false, reason: 'Command is turned off' };
  return { ok: true };
}
function tabOff(cmd) {
  if (cmd.desktop && selectedDevice() === 'ANDROID') return true;
  if (!state.focus) return false;
  const info = state.info.get(state.focus);
  if (!info || !info.user) return false;
  return !targetAllows(state.focus, cmd).ok;
}

function renderCmdTabs() {
  const box = $('#cmdTabs'); box.replaceChildren();
  for (const cmd of COMMANDS) {
    const off = tabOff(cmd);
    let title = cmd.help;
    if (off && cmd.desktop && selectedDevice() === 'ANDROID') title = 'Desktop only';
    else if (off && state.focus) {
      const check = targetAllows(state.focus, cmd);
      if (!check.ok) title = check.reason;
    }
    const cls = [cmd === state.cmd ? 'active' : '', off ? 'off' : ''].filter(Boolean).join(' ');
    box.append(el('button', {
      type: 'button',
      class: cls,
      title,
      onclick: () => { state.cmd = cmd; renderCmdTabs(); },
    }, cmd.label));
  }
  showForm();
}

function setHidden(node, hidden) { if (node) node.classList.toggle('hidden', !!hidden); }

function showForm() {
  const cmd = state.cmd;
  const media = !!cmd.media;
  const url = media || !!cmd.url;
  let help = cmd.help;
  if (state.focus && state.info.get(state.focus) && state.info.get(state.focus).user) {
    const check = targetAllows(state.focus, cmd);
    if (!check.ok) help += ' ' + check.reason + '.';
  }
  $('#cmdHelp').textContent = help;
  setHidden(document.querySelector('[data-for="media"]'), !url);
  setHidden($('#fileBtn'), !media);
  setHidden($('#dropZone'), !media);
  setHidden($('#uploadState'), !media);
  setHidden($('#preview'), !media);
  setHidden(document.querySelector('[data-for="text"]'), !cmd.text);
  setHidden($('#countWrap'), !cmd.count);
  const text = $('#argText');
  text.maxLength = cmd.max || 2000;
  if (cmd.max && text.value.length > cmd.max) text.value = text.value.slice(0, cmd.max);
  $('#argTextLabel').textContent = cmd.text || 'Text';
  $('#argUrlLabel').textContent = cmd.url ? 'Page URL' : cmd.media === 'video' ? 'Video URL' : cmd.media === 'audio' ? 'Audio URL' : 'Image URL';
  $('#argUrl').placeholder = media ? 'https://… or drop / pick a file' : 'https://…';
  $('#filePick').accept = cmd.media === 'image' ? 'image/*' : cmd.media === 'video' ? 'video/*' : cmd.media === 'audio' ? 'audio/*' : '';
  if (media && safeHttp($('#argUrl').value)) showPreview($('#argUrl').value, cmd.media);
  else if (!media) $('#preview').replaceChildren();
  updateSendButton();
}

function updateSendButton() {
  const btn = $('#btnSend');
  if (state.sending || !state.config || !state.config.hasKey || !state.targets.length) btn.disabled = true;
  else btn.disabled = !state.targets.some(code => targetAllows(code, state.cmd).ok);
  updateSeqButtons();
}

function pickDevice(type) {
  const v = type === 'ANDROID' || type === 'DESKTOP' ? type : '';
  if ($('#argDevice').value === v) return;
  $('#argDevice').value = v;
  renderCmdTabs();
  renderDetails();
}

function clock(d) {
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':');
}
function logLine(msg, cls) {
  state.activity.unshift({ t: new Date(), msg, cls: cls || '' });
  if (state.activity.length > 100) state.activity.pop();
  renderActivity();
}
function renderActivity() {
  const ul = $('#activity'); ul.replaceChildren();
  if (!state.activity.length) { ul.append(el('li', {}, el('span', { class: 'msg' }, 'Nothing sent yet.'))); return; }
  for (const a of state.activity) {
    ul.append(el('li', {}, el('time', {}, clock(a.t)), el('span', { class: 'msg' + (a.cls ? ' ' + a.cls : '') }, a.msg)));
  }
}

async function pausable(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (state.seqStop) return false;
    await sleep(Math.min(200, end - Date.now()));
  }
  return true;
}
async function waitRate() {
  await pollRate();
  let guard = 0;
  while (state.rate && state.rate.nextFreeIn > 0 && guard < 5) {
    if (state.seqStop) return;
    const ms = state.rate.nextFreeIn + 250;
    logLine('Waiting ' + Math.ceil(ms / 1000) + 's for the per-minute limit.', '');
    if (!await pausable(ms)) return;
    await pollRate();
    guard++;
  }
}
async function waitUserCooldown(code) {
  const wait = 3000 - (Date.now() - (state.lastSent.get(code) || 0));
  if (wait > 200) {
    if (state.seqStop) return;
    logLine('Pausing ' + Math.ceil(wait / 1000) + 's before the next command to ' + labelOf(code) + '.', '');
    await pausable(wait);
  }
}

async function postCommand(body) {
  try {
    return await api('/api/command', { method: 'POST', body });
  } catch (err) {
    if (err.status !== 429 || state.seqStop) throw err;
    logLine(labelOf(body.target) + ': rate limit. Pausing 4s and trying once more.', '');
    await sleep(4000);
    return api('/api/command', { method: 'POST', body });
  }
}

async function onSend(e) {
  e.preventDefault();
  if (state.sending) return;
  const cmd = state.cmd;
  const argument = cmd.text ? $('#argText').value.trim() : (cmd.media || cmd.url) ? $('#argUrl').value.trim() : '';
  if ((cmd.text || cmd.media || cmd.url) && !argument) {
    logLine(cmd.text ? 'Write the text first.' : 'Add a link first.', 'bad');
    return;
  }
  if ((cmd.media || cmd.url) && !safeHttp(argument)) {
    logLine('The link needs to start with http:// or https://.', 'bad');
    return;
  }
  if (cmd.max && argument.length > cmd.max) {
    logLine('That text is limited to ' + cmd.max + ' characters.', 'bad');
    return;
  }
  if (!state.targets.length) { logLine('Pick someone first.', 'bad'); return; }
  const ready = [];
  for (const code of state.targets) {
    const check = targetAllows(code, cmd);
    if (!check.ok) logLine(labelOf(code) + ': skipped, ' + check.reason + '.', 'bad');
    else ready.push(code);
  }
  if (!ready.length) return;

  state.sending = true;
  updateSendButton();
  const fileLink = cmd.media ? argument : '';
  let pomfLink = '';
  const marked = ready.filter(isPomf);
  try {
    if (fileLink && marked.length && needsPomfMirror(fileLink)) {
      logLine('Copying a file to Pomf for ' + marked.map(labelOf).join(', ') + '.', '');
      try { pomfLink = await mirrorUrl(fileLink); }
      catch (err) {
        logLine('Pomf copy failed: ' + explain(err), 'bad');
        if (!pomfPermanent(err) && !isAbort(err)) {
          logLine('Retrying the Pomf copy in 20s.', '');
          await sleep(POMF_RETRY_MS);
          try { pomfLink = await mirrorUrl(fileLink); }
          catch (err2) { logLine('Pomf copy failed again: ' + explain(err2), 'bad'); }
        }
      }
    }
    for (let i = 0; i < ready.length; i++) {
      const code = ready[i];
      if (cmd.id === 'screenBlank') {
        const left = blankWaitLeft(code);
        if (left > 0) {
          logLine(labelOf(code) + ': blank screen can run again in ' + Math.ceil(left / 1000) + 's.', 'bad');
          continue;
        }
      }
      await waitRate();
      await waitUserCooldown(code);
      let sentUrl = argument;
      if (fileLink && isPomf(code) && needsPomfMirror(fileLink)) {
        if (!pomfLink) {
          logLine(labelOf(code) + ': skipped, the Pomf copy is not available.', 'bad');
          continue;
        }
        sentUrl = pomfLink;
      }
      const body = { target: code, command: cmd.id };
      if (sentUrl) body.argument = sentUrl;
      if (cmd.count) body.count = Math.max(1, Math.min(5, Math.round(Number($('#argCount').value)) || 1));
      const picked = selectedDevice();
      // Desktop-only commands go to the desktop when Device is Any. Android cannot run them.
      if (picked) body.targetDevice = picked;
      else if (cmd.desktop) body.targetDevice = 'DESKTOP';
      try {
        const res = await postCommand(body);
        state.lastSent.set(code, Date.now());
        if (cmd.id === 'screenBlank') state.blankAt.set(code, Date.now());
        const id = res && res.commandId ? ' · ' + res.commandId : '';
        const via = sentUrl && isPomfHost(sentUrl) && sentUrl !== argument ? ' via Pomf' : '';
        if (res && res.success === false) logLine(labelOf(code) + ': ' + cmd.label + ' was refused' + via + id + '.', 'bad');
        else logLine(labelOf(code) + ': ' + cmd.label + ' sent' + via + id + '.', 'ok');
      } catch (err) {
        logLine(labelOf(code) + ': ' + explain(err), 'bad');
        if (err.status === 429) break;
      }
      await pollRate();
      if (i < ready.length - 1) await sleep(200);
    }
  } finally {
    state.sending = false;
    updateSendButton();
  }
}

// ---------- uploads ----------

const UPLOAD_AT_ONCE = 1;
const uploadRows = [];
function renderUploadRows() {
  const n = $('#uploadState');
  n.className = 'upload-state';
  n.replaceChildren();
  for (const row of uploadRows) {
    const box = el('div', { class: 'upload-row' + (row.err ? ' err' : '') }, row.name + ' — ' + row.text);
    if (row.ratio != null && !row.err) {
      const bar = el('i');
      bar.style.width = Math.max(0, Math.min(100, row.ratio * 100)) + '%';
      box.append(el('div', { class: 'bar' }, bar));
    }
    n.append(box);
  }
}
function setUploadRow(row, text, ratio, err) {
  row.text = text;
  row.ratio = ratio;
  row.err = !!err;
  renderUploadRows();
}
function showPreview(url, kind) {
  const box = $('#preview'); box.replaceChildren();
  const safe = safeHttp(url);
  if (!safe) return;
  if (kind === 'image') box.append(el('img', { src: safe, alt: '' }));
  else if (kind === 'video') box.append(el('video', { src: safe, controls: true }));
  else if (kind === 'audio') box.append(el('audio', { src: safe, controls: true }));
}
function postFile(file, row, albumId, host) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const q = new URLSearchParams({ name: file.name || 'file', type: file.type || '', host: host === 'catbox' ? 'catbox' : 'pone' });
    if (albumId) q.set('album', albumId);
    xhr.open('POST', '/api/upload?' + q);
    xhr.setRequestHeader('X-Panel', '1');
    xhr.upload.onprogress = ev => { if (ev.lengthComputable) setUploadRow(row, 'Sending to the panel', ev.loaded / ev.total); };
    xhr.onload = () => {
      let data = null; try { data = JSON.parse(xhr.responseText); } catch { data = null; }
      if (xhr.status >= 200 && xhr.status < 300 && data && data.id) resolve(data.id);
      else reject(new Error((data && data.error) || ('Upload failed (' + xhr.status + ')')));
    };
    xhr.onerror = () => reject(new Error('Upload failed'));
    xhr.send(file);
  });
}
async function pollJob(id, row) {
  const start = Date.now();
  let lastChange = start;
  let lastMark = '';
  for (;;) {
    if (Date.now() - start > 30 * 60 * 1000) throw new Error('Upload timed out');
    if (Date.now() - lastChange > 5 * 60 * 1000) throw new Error('Upload stalled');
    const job = await api('/api/jobs/' + id);
    const mark = job.state + ':' + (job.sent || 0) + ':' + (job.received || 0);
    if (mark !== lastMark) { lastMark = mark; lastChange = Date.now(); }
    if (job.state === 'done' && job.entry) return job.entry;
    if (job.state === 'error') throw new Error(job.error || 'Upload failed');
    const loaded = job.state === 'uploading' ? job.sent : job.received;
    const host = job.host === 'catbox' ? 'Catbox' : job.host === 'pone' ? 'pone.rs' : '';
    const label = job.state === 'uploading' ? ('Uploading' + (host ? ' to ' + host : '')) : 'Sending to the panel';
    setUploadRow(row, label, job.total ? loaded / job.total : 0);
    await sleep(400);
  }
}
let libraryRefresh = null;
let naming = null; // hash being renamed, plus the text box value
let libraryDraw = false;
const renameFlight = new Set();
function cleanEntryName(value) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
}
function scheduleLibrary() {
  clearTimeout(libraryRefresh);
  libraryRefresh = setTimeout(() => refreshFiles(), 250);
}
async function refreshFiles() {
  try { state.library = await api('/api/library'); }
  catch (err) { state.library = []; logLine('Library: ' + explain(err), 'bad'); }
  try { state.albums = await api('/api/albums'); }
  catch { /* keep the albums already loaded */ }
  if (state.albumView && !state.albums.some(a => a.id === state.albumView)) state.albumView = '';
  dropStaleThumbs();
  renderAlbumSelects();
  renderLibrary();
}
async function uploadOne(item) {
  const row = item.row;
  try {
    setUploadRow(row, 'Sending to the panel', 0);
    const entry = await pollJob(await postFile(item.file, row, item.albumId, item.host), row);
    const album = state.albums.find(a => a.id === item.albumId);
    setUploadRow(row, album ? 'Saved in ' + album.name : 'Saved', 1);
    if (state.cmd.media === item.kind) {
      $('#argUrl').value = entry.url;
      showPreview(entry.url, item.kind);
    }
    scheduleLibrary();
  } catch (err) {
    setUploadRow(row, err.message || 'Upload failed', null, true);
  }
}
async function runPool(items, worker) {
  let next = 0;
  const lanes = Math.min(UPLOAD_AT_ONCE, items.length);
  await Promise.all(Array.from({ length: lanes }, async () => {
    while (next < items.length) await worker(items[next++]);
  }));
}
function startUploads(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  const accepted = [];
  for (const file of files) {
    const kind = kindOfFile(file);
    const row = { name: file.name || 'file', text: 'Waiting', ratio: null, err: false };
    uploadRows.push(row);
    if (kind !== 'image' && kind !== 'video' && kind !== 'audio') {
      setUploadRow(row, 'Skipped. Not an image, video, or sound.', null, true);
      continue;
    }
    const host = $('#uploadHost') && $('#uploadHost').value === 'catbox' ? 'catbox' : 'pone';
    accepted.push({ file, kind, row, index: accepted.length, albumId: $('#uploadAlbum') ? $('#uploadAlbum').value : '', host });
  }
  renderUploadRows();
  runPool(accepted, item => uploadOne(item)).then(() => {
    setTimeout(() => {
      for (let i = uploadRows.length - 1; i >= 0; i--) if (!uploadRows[i].err) uploadRows.splice(i, 1);
      renderUploadRows();
    }, 4000);
  });
}

async function loadLibrary() {
  try { state.library = await api('/api/library'); }
  catch (err) { state.library = []; logLine('Library: ' + explain(err), 'bad'); }
  dropStaleThumbs();
  renderLibrary();
}
async function loadAlbums() {
  try { state.albums = await api('/api/albums'); }
  catch { state.albums = []; }
  if (state.albumView && !state.albums.some(a => a.id === state.albumView)) state.albumView = '';
  renderAlbumSelects();
  renderLibrary();
}
function renderAlbumSelects() {
  const view = $('#albumView');
  const upload = $('#uploadAlbum');
  const uploadValue = upload ? upload.value : '';
  if (view) {
    view.replaceChildren(el('option', { value: '' }, 'All files'));
    for (const album of state.albums) view.append(el('option', { value: album.id }, album.name));
    view.value = state.albumView || '';
  }
  if (upload) {
    upload.replaceChildren(el('option', { value: '' }, 'No album'));
    for (const album of state.albums) upload.append(el('option', { value: album.id }, album.name));
    upload.value = !uploadValue || state.albums.some(a => a.id === uploadValue) ? uploadValue : '';
  }
  const del = $('#albumDelete');
  if (del) del.disabled = !state.albumView;
}
function visibleFiles() {
  const filter = $('#libFilter').value;
  const album = state.albums.find(a => a.id === state.albumView);
  let items = state.library;
  if (album) {
    const order = new Map((album.hashes || []).map((hash, i) => [hash, i]));
    items = items.filter(e => order.has(e.hash)).sort((a, b) => order.get(a.hash) - order.get(b.hash));
  }
  return items.filter(e => !filter || e.kind === filter);
}
function renderLibrary() {
  libraryDraw = true;
  let focus = null;
  try {
    const album = state.albums.find(a => a.id === state.albumView);
    const hint = $('#libHint');
    if (hint) hint.textContent = album
      ? 'This album only groups saved links. Click a name to rename it. + adds one file to the sequence. × takes it out of the album. The Catbox file stays. Images stay still. Rest on one to play it.'
      : 'Click a file to use it once. Click its name to rename it. + adds it to the sequence. The same file again reuses its saved link. Images stay still. Rest on one to play it.';
    const items = visibleFiles();
    if (naming && !items.some(entry => entry.hash === naming.hash)) naming = null;
    const grid = $('#libGrid'); grid.replaceChildren();
    if (!items.length) { grid.append(el('p', { class: 'hint' }, album ? 'Nothing in this album yet.' : 'Nothing here yet.')); return; }
    for (const entry of items) {
      const safe = safeHttp(entry.url);
      const thumb = libraryThumb(entry, safe);
      const addBtn = (entry.kind === 'image' || entry.kind === 'video' || entry.kind === 'audio')
        ? el('button', { class: 'add', type: 'button', title: 'Add to sequence', onclick: ev => { ev.stopPropagation(); addLibraryStep(entry); } }, '+')
        : null;
      const remove = album
        ? el('button', { class: 'del', type: 'button', title: 'Remove from this album', onclick: ev => { ev.stopPropagation(); removeFromAlbum(album.id, entry.hash); } }, '×')
        : el('button', { class: 'del', type: 'button', title: 'Remove from this list', onclick: ev => { ev.stopPropagation(); removeLibrary(entry); } }, '×');
      const editing = naming && naming.hash === entry.hash;
      const cap = editing ? renameField(entry) : el('button', {
        class: 'cap',
        type: 'button',
        title: entry.name || '',
        'aria-label': 'Rename ' + (entry.name || 'file'),
        onclick: ev => { ev.stopPropagation(); beginRename(entry); },
      }, el('span', { class: 'cap-name' }, entry.name || ''), el('span', { class: 'cap-edit', 'aria-hidden': 'true' }, '✎'));
      const item = el('div', {
        class: 'lib-item',
        'data-hash': entry.hash,
        title: entry.name || '',
        onclick: ev => { if (ev.target.closest('button, input')) return; useLibrary(entry); },
      }, thumb, cap, addBtn, remove);
      grid.append(item);
      if (entry.kind === 'image' && safe) prepareImageTile(item, entry);
    }
    focus = naming ? grid.querySelector('input.cap') : null;
  } finally {
    libraryDraw = false;
  }
  if (!focus || !naming) return;
  focus.focus();
  if (naming.pick) { focus.select(); naming.pick = false; }
  else {
    const at = Number.isInteger(naming.caret) ? naming.caret : focus.value.length;
    focus.setSelectionRange(at, at);
  }
}

// Still previews. The grid never points at the remote file. One image is fetched at a time,
// drawn down to a small JPEG, and kept by the server. Hover plays that one file.
const THUMB_EDGE = 168;
const thumbBlobs = new Map();
const thumbFailed = new Set();
const thumbQueued = new Set();
const thumbLoads = new Map();
const thumbQueue = [];
const tileTimers = new WeakMap();
let thumbBusy = false;
let thumbObserver = null;

function tileByHash(hash) {
  if (!/^[a-f0-9]{64}$/.test(hash || '')) return null;
  return document.querySelector('.lib-item[data-hash="' + hash + '"]');
}
function dropStaleThumbs() {
  const keep = new Set(state.library.map(entry => entry && entry.hash).filter(Boolean));
  for (const [hash, url] of thumbBlobs) {
    if (keep.has(hash)) continue;
    URL.revokeObjectURL(url);
    thumbBlobs.delete(hash);
    thumbFailed.delete(hash);
  }
}
function stillImage(url) {
  return el('img', { class: 'still', src: url, alt: '', decoding: 'async', title: 'Rest here to play it' });
}
function libraryThumb(entry, safe) {
  if (entry.kind === 'video') return el('span', { class: 'kind', 'aria-hidden': 'true' }, '▶');
  if (entry.kind === 'image' && safe) {
    const ready = thumbBlobs.get(entry.hash);
    if (ready) return stillImage(ready);
    if (thumbFailed.has(entry.hash)) return el('span', { class: 'kind', 'aria-hidden': 'true' }, '•');
    return el('span', { class: 'kind wait', 'aria-hidden': 'true' }, '');
  }
  return el('span', { class: 'kind', 'aria-hidden': 'true' }, entry.kind === 'audio' ? '♪' : '•');
}
function prepareImageTile(item, entry) {
  bindTileMotion(item);
  if (thumbBlobs.has(entry.hash)) return;
  if (entry.thumb) { showSavedThumb(entry.hash); return; }
  if (!thumbFailed.has(entry.hash)) getThumbObserver().observe(item);
}
function getThumbObserver() {
  if (thumbObserver) return thumbObserver;
  thumbObserver = new IntersectionObserver(entries => {
    for (const seen of entries) {
      if (!seen.isIntersecting) continue;
      enqueueThumb(seen.target.dataset.hash);
    }
  }, { root: null, rootMargin: '240px 0px', threshold: 0.01 });
  return thumbObserver;
}
function enqueueThumb(hash) {
  if (!hash || thumbBlobs.has(hash) || thumbFailed.has(hash) || thumbQueued.has(hash)) return;
  const entry = state.library.find(item => item && item.hash === hash);
  if (!entry || entry.kind !== 'image' || !safeHttp(entry.url)) return;
  if (entry.thumb) { showSavedThumb(hash); return; }
  thumbQueued.add(hash);
  thumbQueue.push(hash);
  pumpThumbs();
}
async function pumpThumbs() {
  if (thumbBusy) return;
  thumbBusy = true;
  try {
    while (thumbQueue.length) {
      const hash = thumbQueue.shift();
      const tile = tileByHash(hash);
      if (!tile) { thumbQueued.delete(hash); continue; }
      try {
        await makeThumb(hash);
        const done = tileByHash(hash);
        if (done && thumbObserver) thumbObserver.unobserve(done);
      } catch {
        thumbFailed.add(hash);
        const failed = tileByHash(hash);
        if (failed && thumbObserver) thumbObserver.unobserve(failed);
        const hold = failed && failed.querySelector('.kind');
        if (hold) hold.textContent = '•';
      } finally {
        thumbQueued.delete(hash);
      }
    }
  } finally {
    thumbBusy = false;
    if (thumbQueue.length) pumpThumbs();
  }
}
function loadThumb(hash) {
  if (thumbBlobs.has(hash)) return Promise.resolve(thumbBlobs.get(hash));
  const pending = thumbLoads.get(hash);
  if (pending) return pending;
  const job = (async () => {
    const r = await fetch('/api/library/' + hash + '/thumb', { headers: { 'X-Panel': '1' } });
    if (!r.ok) throw new Error('No preview yet');
    const blob = await r.blob();
    if (!blob.size) throw new Error('No preview yet');
    const url = URL.createObjectURL(blob);
    const prev = thumbBlobs.get(hash);
    if (prev) URL.revokeObjectURL(prev);
    thumbBlobs.set(hash, url);
    return url;
  })();
  thumbLoads.set(hash, job);
  job.finally(() => { if (thumbLoads.get(hash) === job) thumbLoads.delete(hash); });
  return job;
}
async function showSavedThumb(hash) {
  try {
    await loadThumb(hash);
    const entry = state.library.find(item => item && item.hash === hash);
    if (entry) entry.thumb = true;
    paintThumb(hash);
    const tile = tileByHash(hash);
    if (tile && thumbObserver) thumbObserver.unobserve(tile);
  } catch {
    const entry = state.library.find(item => item && item.hash === hash);
    if (entry) entry.thumb = false;
    const tile = tileByHash(hash);
    if (tile && !thumbFailed.has(hash)) getThumbObserver().observe(tile);
  }
}
function paintThumb(hash) {
  const url = thumbBlobs.get(hash);
  const tile = tileByHash(hash);
  if (!url || !tile) return;
  let still = tile.querySelector('img.still');
  if (!still) {
    still = stillImage(url);
    const hold = tile.querySelector('.kind');
    if (hold) hold.replaceWith(still);
    else tile.prepend(still);
  } else if (still.getAttribute('src') !== url) still.src = url;
  if (tile.dataset.wantLive === '1' && tile.matches(':hover')) startTileMotion(tile);
}
async function makeThumb(hash) {
  const entry = state.library.find(item => item && item.hash === hash);
  if (!entry || entry.kind !== 'image') return;
  const r = await fetch('/api/library/' + hash + '/file', { headers: { 'X-Panel': '1' } });
  if (!r.ok) throw new Error('Could not make a preview');
  const blob = await r.blob();
  const sourceUrl = URL.createObjectURL(blob);
  try {
    const img = new Image();
    const loaded = new Promise((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('Could not read that image'));
    });
    img.src = sourceUrl;
    await loaded;
    if (img.decode) { try { await img.decode(); } catch { /* the load event is enough */ } }
    const sw = img.naturalWidth;
    const sh = img.naturalHeight;
    if (!sw || !sh) throw new Error('Could not read that image');
    const canvas = document.createElement('canvas');
    canvas.width = THUMB_EDGE;
    canvas.height = THUMB_EDGE;
    const ctx = canvas.getContext('2d', { alpha: false });
    const scale = Math.max(THUMB_EDGE / sw, THUMB_EDGE / sh);
    const dw = sw * scale;
    const dh = sh * scale;
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, THUMB_EDGE, THUMB_EDGE);
    ctx.drawImage(img, (THUMB_EDGE - dw) / 2, (THUMB_EDGE - dh) / 2, dw, dh);
    const jpeg = await new Promise((resolve, reject) => {
      canvas.toBlob(b => b ? resolve(b) : reject(new Error('Could not make a preview')), 'image/jpeg', 0.72);
    });
    const save = await fetch('/api/library/' + hash + '/thumb', {
      method: 'POST',
      headers: { 'X-Panel': '1', 'Content-Type': 'image/jpeg' },
      body: jpeg,
    });
    if (!save.ok) throw new Error('Could not save the preview');
    const url = URL.createObjectURL(jpeg);
    const prev = thumbBlobs.get(hash);
    if (prev) URL.revokeObjectURL(prev);
    thumbBlobs.set(hash, url);
    entry.thumb = true;
    paintThumb(hash);
  } finally {
    URL.revokeObjectURL(sourceUrl);
  }
}
function bindTileMotion(tile) {
  tile.addEventListener('pointerenter', () => {
    const prev = tileTimers.get(tile);
    if (prev) clearTimeout(prev);
    tileTimers.set(tile, setTimeout(() => {
      tileTimers.delete(tile);
      if (!tile.isConnected || !tile.matches(':hover')) return;
      tile.dataset.wantLive = '1';
      startTileMotion(tile);
    }, 400));
  });
  tile.addEventListener('pointerleave', () => {
    const prev = tileTimers.get(tile);
    if (prev) clearTimeout(prev);
    tileTimers.delete(tile);
    delete tile.dataset.wantLive;
    stopTileMotion(tile);
  });
}
function startTileMotion(tile) {
  if (!tile.isConnected || tile.querySelector('img.live')) return;
  const hash = tile.dataset.hash;
  if (!thumbBlobs.has(hash)) return;
  const entry = state.library.find(item => item && item.hash === hash);
  const remote = entry && entry.kind === 'image' ? safeHttp(entry.url) : '';
  if (!remote) return;
  const live = el('img', { class: 'live', alt: '', decoding: 'async' });
  live.addEventListener('load', () => {
    if (!tile.isConnected || !tile.matches(':hover')) { live.remove(); return; }
    live.classList.add('ready');
  });
  live.addEventListener('error', () => live.remove());
  const still = tile.querySelector('img.still');
  if (still) still.after(live); else tile.prepend(live);
  live.src = remote;
}
function stopTileMotion(tile) {
  const live = tile.querySelector('img.live');
  if (live) live.remove();
}

function beginRename(entry) {
  if (!entry || (naming && naming.hash === entry.hash)) return;
  naming = { hash: entry.hash, value: entry.name || '', pick: true, caret: 0 };
  renderLibrary();
}
function renameField(entry) {
  const input = el('input', {
    class: 'cap',
    type: 'text',
    maxlength: '80',
    value: naming.value,
    'aria-label': 'File name',
    autocomplete: 'off',
    spellcheck: 'false',
  });
  const remember = () => {
    if (!naming || naming.hash !== entry.hash) return;
    naming.value = input.value;
    naming.caret = input.selectionStart;
  };
  input.addEventListener('click', ev => ev.stopPropagation());
  input.addEventListener('input', remember);
  input.addEventListener('keyup', remember);
  input.addEventListener('keydown', ev => {
    if (ev.key !== 'Enter' && ev.key !== 'Escape') return;
    ev.preventDefault();
    input.dataset.skip = '1';
    if (ev.key === 'Escape') {
      if (naming && naming.hash === entry.hash) naming = null;
      renderLibrary();
      return;
    }
    finishRename(entry, input.value);
  });
  input.addEventListener('blur', () => {
    if (libraryDraw || input.dataset.skip === '1') return;
    const before = entry.name;
    const next = cleanEntryName(input.value);
    if (next && next !== cleanEntryName(before)) entry.name = next;
    const value = input.value;
    setTimeout(() => finishRename(entry, value, before), 0);
  });
  return input;
}
function paintLibraryName(entry) {
  const tile = document.querySelector('.lib-item[data-hash="' + entry.hash + '"]');
  if (!tile) return;
  tile.title = entry.name || '';
  const name = tile.querySelector('.cap-name');
  const btn = tile.querySelector('button.cap');
  if (name) name.textContent = entry.name || '';
  if (btn) {
    btn.title = entry.name || '';
    btn.setAttribute('aria-label', 'Rename ' + (entry.name || 'file'));
  }
}
async function finishRename(entry, raw, before) {
  if (!entry || renameFlight.has(entry.hash)) return;
  const name = cleanEntryName(raw);
  const previous = cleanEntryName(before !== undefined ? before : entry.name);
  if (!name || name === previous) {
    if (before !== undefined && cleanEntryName(entry.name) !== previous) entry.name = before;
    if (!(naming && naming.hash === entry.hash)) return;
    if (!name && previous) logLine('Library: Name the file.', 'bad');
    naming = null;
    renderLibrary();
    return;
  }
  renameFlight.add(entry.hash);
  let failed = false;
  try {
    const saved = await api('/api/library/' + entry.hash, { method: 'POST', body: { name } });
    entry.name = (saved && saved.name) || name;
  } catch (err) {
    failed = true;
    if (before !== undefined) entry.name = before;
    logLine('Library: ' + explain(err), 'bad');
  } finally {
    renameFlight.delete(entry.hash);
  }
  if (naming && naming.hash !== entry.hash) { paintLibraryName(entry); return; }
  if (failed && naming && naming.hash === entry.hash) {
    naming.value = String(raw || '');
    renderLibrary();
    return;
  }
  if (naming && naming.hash === entry.hash) naming = null;
  renderLibrary();
}
async function createAlbum() {
  const name = $('#albumName').value.trim();
  if (!name) return;
  try {
    const album = await api('/api/albums', { method: 'POST', body: { name } });
    $('#albumName').value = '';
    state.albumView = album.id;
    await loadAlbums();
    if ($('#uploadAlbum')) $('#uploadAlbum').value = album.id;
  } catch (err) { logLine('Album: ' + explain(err), 'bad'); }
}
async function deleteAlbum() {
  if (!state.albumView) return;
  try {
    await api('/api/albums/' + state.albumView, { method: 'DELETE' });
    state.albumView = '';
    await loadAlbums();
  } catch (err) { logLine('Album: ' + explain(err), 'bad'); }
}
function addVisibleToSequence() {
  const have = new Set(state.sequence.steps.map(s => s.url));
  let added = 0;
  for (const entry of visibleFiles()) {
    if (entry.kind !== 'image' && entry.kind !== 'video' && entry.kind !== 'audio') continue;
    const url = safeHttp(entry.url);
    if (!url || have.has(url)) continue;
    have.add(url);
    state.sequence.steps.push({
      kind: entry.kind,
      url,
      name: String(entry.name || nameFromUrl(url)).slice(0, 80),
      wait: defaultWait(),
    });
    added++;
  }
  renderSequence();
  setSeqStatus(added ? 'Added ' + added + ' to the sequence.' : 'Nothing new to add. Links already in the sequence were left out.', !added);
}
async function removeFromAlbum(albumId, hash) {
  try {
    await api('/api/albums/' + albumId + '/files/' + hash, { method: 'DELETE' });
    await loadAlbums();
  } catch (err) { logLine('Album: ' + explain(err), 'bad'); }
}
function useLibrary(entry) {
  if (!entry || !entry.url) return;
  if (state.cmd.media !== entry.kind) {
    const next = COMMANDS.find(c => c.media === entry.kind);
    if (next) state.cmd = next;
  }
  $('#argUrl').value = entry.url;
  renderCmdTabs();
}
async function removeLibrary(entry) {
  try {
    await api('/api/library/' + entry.hash, { method: 'DELETE' });
    await loadLibrary();
  } catch (err) { logLine('Library: ' + explain(err), 'bad'); }
}

// ---------- sequences ----------

function nameFromUrl(url) {
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop();
    return last ? decodeURIComponent(last).slice(0, 80) : 'Link';
  } catch { return 'Link'; }
}
function defaultWait() {
  return Math.max(3, Math.min(600, Math.round(Number($('#seqWait').value)) || 5));
}
function sequenceSpan(steps) {
  if (!steps.length) return 'Nothing in this sequence yet.';
  if (steps.length === 1) return 'One item. It is sent once.';
  const sec = steps.slice(0, -1).reduce((n, s) => n + Math.max(3, Number(s.wait) || 3), 0);
  const shown = sec >= 60 ? Math.floor(sec / 60) + ' min ' + (sec % 60) + ' s' : sec + 's';
  return steps.length + ' items. About ' + shown + ' from the first send to the last.';
}
function setSeqStatus(text, bad) {
  const n = $('#seqStatus');
  if (!n) return;
  n.textContent = text || '';
  n.className = 'hint' + (bad ? ' bad' : '');
}
function setRunStatus(text, bad) {
  const n = $('#seqRunStatus');
  if (!n) return;
  const name = state.run && state.run.name;
  const shown = text && name ? name + ' · ' + text : (text || '');
  n.textContent = shown;
  n.className = 'hint' + (bad ? ' bad' : '') + (shown ? '' : ' hidden');
}
function showSeqTab(which) {
  state.seqView = which === 'send' ? 'send' : 'edit';
  const edit = $('#seqEdit');
  const send = $('#seqSend');
  if (edit) edit.classList.toggle('hidden', state.seqView !== 'edit');
  if (send) send.classList.toggle('hidden', state.seqView !== 'send');
  document.querySelectorAll('.seq-tab').forEach(btn => {
    const on = btn.dataset.seqTab === state.seqView;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-selected', on ? 'true' : 'false');
  });
}
function commandForKind(kind) {
  const id = kind === 'image' ? 'popupImage'
    : kind === 'video' ? 'videoOverlay'
    : kind === 'audio' ? 'popupSound'
    : kind === 'message' ? 'sendMessage'
    : kind === 'blank' ? 'screenBlank'
    : kind === 'reaction' ? 'reactionTest'
    : kind === 'lock' ? 'lockinput'
    : '';
  return COMMANDS.find(c => c.id === id) || null;
}
function stepLabel(kind) {
  if (kind === 'audio') return 'sound';
  return kind || '';
}
function stepCaption(step) {
  if (step.kind === 'message') return step.text || 'Message';
  if (step.kind === 'blank') return 'Blank screen';
  if (step.kind === 'reaction') return 'Reaction test';
  if (step.kind === 'lock') return 'Lock input';
  return step.name || nameFromUrl(step.url);
}
function updateSeqButtons() {
  const play = $('#seqPlay');
  const stop = $('#seqStop');
  if (!play || !stop) return;
  const why = state.playing ? 'Already playing.'
    : !state.config || !state.config.hasKey ? 'Add an API key in Settings first.'
    : !state.sequence.steps.length ? 'Add at least one item in Edit.'
    : !state.targets.length ? 'Pick someone first.'
    : '';
  play.disabled = !!why;
  play.title = why;
  stop.disabled = !state.playing;
  const tab = document.querySelector('[data-seq-tab="send"]');
  if (tab) {
    tab.classList.toggle('busy', state.playing);
    if (state.playing && state.run) {
      const at = state.seqIndex >= 0 ? state.seqIndex + 1 : 0;
      tab.textContent = at ? 'Send ' + at + '/' + state.run.steps.length : 'Sending';
    } else tab.textContent = 'Send';
  }
}
function renderRun() {
  const list = $('#seqRun');
  if (!list) return;
  const label = $('#seqRunLabel');
  const live = !!(state.playing && state.run);
  const steps = live ? state.run.steps : state.sequence.steps;
  if (label) {
    if (live) label.textContent = (state.run.name || 'This send') + ' is the copy from when you pressed Play. Edit can change the next one.';
    else label.textContent = steps.length
      ? 'Play sends the sequence open in Edit, copied at that moment.'
      : 'Nothing to send yet. Add items in Edit.';
  }
  list.replaceChildren();
  if (!steps.length) list.append(el('li', { class: 'empty' }, 'Nothing here yet. Add items in Edit.'));
  steps.forEach((step, i) => {
    list.append(el('li', { class: 'seq-step' + (live && state.seqIndex === i ? ' playing' : '') },
      el('span', { class: 'k' }, stepLabel(step.kind)),
      el('span', { class: 'nm', title: step.url || step.text || '' }, stepCaption(step)),
      el('span', { class: 'wait' }, Math.max(3, Number(step.wait) || 3) + 's')));
  });
  const current = list.querySelector('.playing');
  if (current) current.scrollIntoView({ block: 'nearest' });
  updateSeqButtons();
}
function renderSeqPick() {
  const sel = $('#seqPick');
  if (!sel) return;
  const current = state.sequence.id;
  sel.replaceChildren(el('option', { value: '' }, 'Saved sequences'));
  for (const s of state.sequences) sel.append(el('option', { value: s.id }, s.name + ' (' + s.steps.length + ')'));
  sel.value = current && state.sequences.some(s => s.id === current) ? current : '';
}
function renderSequence() {
  const list = $('#seqSteps');
  if (!list) return;
  const name = $('#seqName');
  if (name && document.activeElement !== name) name.value = state.sequence.name;
  renderSeqPick();
  list.replaceChildren();
  if (!state.sequence.steps.length) list.append(el('li', { class: 'empty' }, 'Nothing here yet. Add a link, a message, a blank, a reaction test, or a lock, or use + on an uploaded file.'));
  state.sequence.steps.forEach((step, i) => {
    const wait = el('input', { type: 'number', min: '3', max: '600', value: String(step.wait) });
    wait.addEventListener('change', () => {
      const n = Math.max(3, Math.min(600, Math.round(Number(wait.value)) || 3));
      step.wait = n;
      wait.value = String(n);
      setSeqStatus(sequenceSpan(state.sequence.steps));
      if (!state.playing) renderRun();
    });
    const btn = (label, title, fn) => el('button', { type: 'button', title, onclick: fn }, label);
    const row = [
      el('span', { class: 'k' }, stepLabel(step.kind)),
      el('span', { class: 'nm', title: step.url || step.text || '' }, stepCaption(step)),
      el('label', {}, 'Wait ', wait, ' s'),
    ];
    if (step.url) row.push(btn('Save', 'Save this link in the selected album', () => saveLink(step.url, step.name, step.kind)));
    row.push(
      btn('↑', 'Move earlier', () => moveStep(i, -1)),
      btn('↓', 'Move later', () => moveStep(i, 1)),
      btn('×', 'Remove', () => removeStep(i)),
    );
    list.append(el('li', { class: 'seq-step' }, row));
  });
  updateSeqButtons();
  if (!state.playing) renderRun();
}
function addStep(step) {
  const url = safeHttp(step.url);
  if (!url) { setSeqStatus('That link needs to start with http:// or https://.', true); return; }
  if (step.kind !== 'image' && step.kind !== 'video' && step.kind !== 'audio') return;
  state.sequence.steps.push({
    kind: step.kind,
    url,
    name: String(step.name || nameFromUrl(url)).slice(0, 80),
    wait: Math.max(3, Math.min(600, Math.round(Number(step.wait)) || defaultWait())),
  });
  setSeqStatus(sequenceSpan(state.sequence.steps));
  renderSequence();
}
function chosenAlbumId() {
  const picked = $('#uploadAlbum') && $('#uploadAlbum').value;
  if (picked) return picked;
  return state.albumView || '';
}
async function saveLink(url, name, kind) {
  const safe = safeHttp(url);
  if (!safe) { setSeqStatus('That link needs to start with http:// or https://.', true); return; }
  const album = chosenAlbumId();
  if (!album) { setSeqStatus('Choose an album first. The link is saved into that folder, not into the sequence.', true); return; }
  try {
    await api('/api/library/link', { method: 'POST', body: { url: safe, name: name || '', kind: kind || '', album } });
    await refreshFiles();
    const albumName = (state.albums.find(a => a.id === album) || {}).name || 'the album';
    setSeqStatus('Saved in ' + albumName + '.');
  } catch (err) { setSeqStatus(explain(err), true); }
}
function addCurrentLink() {
  const cmd = state.cmd;
  if (!cmd.media) { setSeqStatus('Choose Image, Video, or Sound, then set a link.', true); return; }
  const url = $('#argUrl').value.trim();
  const known = state.library.find(e => e.url === url);
  addStep({ kind: cmd.media, url, name: known && known.name });
}
function addMessageStep() {
  const text = $('#argText').value.trim().slice(0, 2000);
  if (!text) { setSeqStatus('Write the message first. It is the text in the Message box.', true); return; }
  state.sequence.steps.push({ kind: 'message', text, wait: defaultWait() });
  setSeqStatus(sequenceSpan(state.sequence.steps));
  renderSequence();
}
function addPlainStep(kind) {
  state.sequence.steps.push({ kind, wait: defaultWait() });
  setSeqStatus(sequenceSpan(state.sequence.steps));
  renderSequence();
}
function addLibraryStep(entry) {
  if (!entry) return;
  addStep({ kind: entry.kind, url: entry.url, name: entry.name });
}
function moveStep(i, dir) {
  const steps = state.sequence.steps;
  const j = i + dir;
  if (j < 0 || j >= steps.length) return;
  const tmp = steps[i];
  steps[i] = steps[j];
  steps[j] = tmp;
  setSeqStatus(sequenceSpan(steps));
  renderSequence();
}
function removeStep(i) {
  state.sequence.steps.splice(i, 1);
  setSeqStatus(sequenceSpan(state.sequence.steps));
  renderSequence();
}
async function loadSequences() {
  try { state.sequences = await api('/api/sequences'); }
  catch (err) { state.sequences = []; setSeqStatus(explain(err), true); }
  renderSeqPick();
}
function applySequence(seq) {
  state.sequence = {
    id: seq.id,
    name: seq.name,
    steps: seq.steps.map(s => ({ kind: s.kind, url: s.url || '', text: s.text || '', name: s.name || '', wait: s.wait })),
  };
  const name = $('#seqName');
  if (name) name.value = seq.name;
  setSeqStatus(sequenceSpan(state.sequence.steps));
  renderSequence();
}
function newSequence() {
  state.sequence = { id: '', name: '', steps: [] };
  const name = $('#seqName');
  if (name) name.value = '';
  setSeqStatus(sequenceSpan([]));
  renderSequence();
}
async function saveSequence() {
  state.sequence.name = $('#seqName').value.trim();
  try {
    const saved = await api('/api/sequences', {
      method: 'POST',
      body: { id: state.sequence.id, name: state.sequence.name, steps: state.sequence.steps },
    });
    applySequence(saved);
    await loadSequences();
    setSeqStatus('Saved. ' + sequenceSpan(state.sequence.steps));
  } catch (err) { setSeqStatus(explain(err), true); }
}
async function deleteSequence() {
  const id = state.sequence.id;
  if (!id) { newSequence(); return; }
  try {
    await api('/api/sequences/' + id, { method: 'DELETE' });
    newSequence();
    await loadSequences();
    setSeqStatus('Deleted.');
  } catch (err) { setSeqStatus(explain(err), true); }
}
function givesUp(reason) {
  return /offline|script access is off|no device online/i.test(reason);
}
async function playSequence() {
  if (state.sending || state.playing) return;
  const steps = state.sequence.steps.map(s => Object.assign({}, s));
  if (!steps.length) { setRunStatus('Add at least one item in Edit.', true); return; }
  if (!state.config || !state.config.hasKey) { setRunStatus('Add an API key in Settings first.', true); return; }
  if (!state.targets.length) { setRunStatus('Pick someone first.', true); return; }

  state.run = { name: ($('#seqName') && $('#seqName').value.trim()) || '', steps };
  state.playing = true;
  state.sending = true;
  state.seqStop = false;
  state.seqIndex = -1;
  updateSendButton();
  renderRun();
  const alive = new Set(state.targets);
  const noted = new Set();
  try {
    for (const code of [...alive]) {
      if (state.seqStop) break;
      await loadInfo(code);
    }
    renderTargets();
    const mirrorAbort = new AbortController();
    state.mirrorAbort = mirrorAbort;
    const mirrors = new Map();
    if ([...alive].some(isPomf)) {
      const pending = [];
      const seen = new Set();
      for (const step of steps) {
        if (!step.url || !needsPomfMirror(step.url) || seen.has(step.url)) continue;
        seen.add(step.url);
        pending.push(step);
      }
      const failed = [];
      for (let n = 0; n < pending.length; n++) {
        if (state.seqStop) break;
        const step = pending[n];
        setRunStatus('Copying ' + (n + 1) + ' of ' + pending.length + ' to Pomf. Keep this page open.');
        logLine('Copying ' + (step.name || 'a file') + ' to Pomf (' + (n + 1) + ' of ' + pending.length + ').', '');
        try {
          mirrors.set(step.url, await mirrorUrl(step.url, step.name, mirrorAbort.signal));
        } catch (err) {
          if (state.seqStop || isAbort(err)) break;
          mirrors.set(step.url, '');
          logLine('Pomf copy failed for ' + (step.name || 'a file') + ': ' + explain(err), 'bad');
          if (!pomfPermanent(err)) failed.push(step);
        }
      }
      if (failed.length && !state.seqStop) {
        const noun = failed.length === 1 ? 'file' : 'files';
        logLine('Pomf rejected ' + failed.length + ' ' + noun + '. Retrying those before sending.', '');
        const retryAt = Date.now() + POMF_RETRY_MS;
        let waited = true;
        while (Date.now() < retryAt) {
          if (state.seqStop) { waited = false; break; }
          const left = Math.max(1, Math.ceil((retryAt - Date.now()) / 1000));
          setRunStatus('Pomf rejected ' + failed.length + ' ' + noun + '. Retrying in ' + left + 's. Keep this page open.');
          await sleep(Math.min(200, retryAt - Date.now()));
        }
        if (waited && !state.seqStop) {
          for (let n = 0; n < failed.length; n++) {
            if (state.seqStop) break;
            const step = failed[n];
            setRunStatus('Retrying ' + (n + 1) + ' of ' + failed.length + ' on Pomf. Keep this page open.');
            logLine('Retrying ' + (step.name || 'a file') + ' on Pomf (' + (n + 1) + ' of ' + failed.length + ').', '');
            try {
              mirrors.set(step.url, await mirrorUrl(step.url, step.name, mirrorAbort.signal));
            } catch (err) {
              if (state.seqStop || isAbort(err)) break;
              mirrors.set(step.url, '');
              logLine('Pomf copy failed again for ' + (step.name || 'a file') + ': ' + explain(err), 'bad');
            }
          }
        }
      }
    }
    for (let i = 0; i < steps.length; i++) {
      if (state.seqStop || !alive.size) break;
      state.seqIndex = i;
      renderRun();
      const step = steps[i];
      const cmd = commandForKind(step.kind);
      if (!cmd) { logLine('Skipped item ' + (i + 1) + '. It is not a known step.', 'bad'); continue; }
      setRunStatus('Sending ' + (i + 1) + ' of ' + steps.length + '. Keep this page open.');
      const ready = [];
      for (const code of alive) {
        const check = targetAllows(code, cmd);
        if (!check.ok) {
          const key = code + '|' + cmd.id + '|' + check.reason;
          if (!noted.has(key)) { noted.add(key); logLine(labelOf(code) + ': skipped ' + cmd.label + ', ' + check.reason + '.', 'bad'); }
          if (givesUp(check.reason)) alive.delete(code);
        } else ready.push(code);
      }
      for (let t = 0; t < ready.length; t++) {
        if (state.seqStop) break;
        const code = ready[t];
        if (cmd.id === 'screenBlank') {
          const left = blankWaitLeft(code);
          if (left > 0) {
            logLine(labelOf(code) + ': skipped ' + cmd.label + ' ' + (i + 1) + '/' + steps.length + ', blank screen can run again in ' + Math.ceil(left / 1000) + 's.', 'bad');
            continue;
          }
        }
        await waitRate();
        if (state.seqStop) break;
        await waitUserCooldown(code);
        if (state.seqStop) break;
        let argument = step.kind === 'message' ? step.text : (step.url || '');
        if (step.url && isPomf(code) && needsPomfMirror(step.url)) {
          argument = mirrors.get(step.url) || '';
          if (!argument) {
            logLine(labelOf(code) + ': skipped ' + cmd.label + ' ' + (i + 1) + '/' + steps.length + ', the Pomf copy is not available.', 'bad');
            continue;
          }
        }
        if ((step.kind === 'message' || step.url) && !argument) {
          logLine(labelOf(code) + ': skipped ' + cmd.label + ' ' + (i + 1) + '/' + steps.length + ', it has nothing to send.', 'bad');
          continue;
        }
        const body = { target: code, command: cmd.id };
        if (argument && (step.kind === 'message' || step.url)) body.argument = argument;
        const picked = selectedDevice();
        if (picked) body.targetDevice = picked;
        else if (cmd.desktop) body.targetDevice = 'DESKTOP';
        try {
          const res = await postCommand(body);
          if (state.seqStop) break;
          state.lastSent.set(code, Date.now());
          if (cmd.id === 'screenBlank') state.blankAt.set(code, Date.now());
          const mark = res && res.commandId ? ' · ' + res.commandId : '';
          const via = isPomfHost(argument) && argument !== step.url ? ' via Pomf' : '';
          if (res && res.success === false) logLine(labelOf(code) + ': ' + cmd.label + ' ' + (i + 1) + '/' + steps.length + ' was refused' + via + mark + '.', 'bad');
          else logLine(labelOf(code) + ': ' + cmd.label + ' ' + (i + 1) + '/' + steps.length + ' sent' + via + mark + '.', 'ok');
        } catch (err) {
          logLine(labelOf(code) + ': ' + explain(err), 'bad');
          if (err.status === 400 || err.status === 403 || err.status === 404) alive.delete(code);
          if (err.status === 429) state.seqStop = true;
        }
        await pollRate();
        if (t < ready.length - 1 && !state.seqStop) await pausable(200);
      }
      if (state.seqStop || !alive.size || i === steps.length - 1) break;
      if (!await countdown(Math.max(3, step.wait) * 1000, i, steps.length)) break;
    }
    if (state.seqStop) { logLine('Sequence stopped.', ''); setRunStatus('Stopped.'); }
    else if (!alive.size) { logLine('Sequence stopped. Nobody left who can receive it.', 'bad'); setRunStatus('Stopped. Nobody left who can receive it.', true); }
    else { logLine('Sequence finished.', 'ok'); setRunStatus('Finished. ' + sequenceSpan(steps)); }
  } finally {
    state.playing = false;
    state.sending = false;
    state.seqStop = false;
    state.mirrorAbort = null;
    state.seqIndex = -1;
    state.run = null;
    updateSendButton();
    renderRun();
  }
}
async function countdown(ms, index, total) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (state.seqStop) return false;
    const left = Math.max(0, Math.ceil((end - Date.now()) / 1000));
    setRunStatus('Sent ' + (index + 1) + ' of ' + total + '. Next in ' + left + 's. Keep this page open.');
    await sleep(Math.min(200, end - Date.now()));
  }
  return !state.seqStop;
}

// ---------- appearance ----------

const THEMES = ['dark', 'light', 'bimbo', 'night', 'nature'];
const THEME_KEY = 'ctrlem-theme';

function paintThemeIcon() {
  const icon = document.querySelector('link[rel="icon"]');
  if (!icon) return;
  const style = getComputedStyle(document.documentElement);
  const fill = (style.getPropertyValue('--accent') || '#7c6cf0').trim();
  const stroke = (style.getPropertyValue('--on-accent') || '#fff').trim();
  if (!fill) return;
  const svg = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='8' fill='"
    + fill + "'/><path d='M9 16h14M16 9v14' stroke='" + stroke + "' stroke-width='3' stroke-linecap='round'/></svg>";
  icon.href = 'data:image/svg+xml,' + encodeURIComponent(svg);
}

function applyTheme(name, persist) {
  const theme = THEMES.includes(name) ? name : 'dark';
  document.documentElement.dataset.theme = theme;
  if (persist) {
    try { localStorage.setItem(THEME_KEY, theme); } catch { /* storage unavailable */ }
  }
  const pick = $('#themePick');
  if (pick && pick.value !== theme) pick.value = theme;
  paintThemeIcon();
}

function bindTheme() {
  const pick = $('#themePick');
  const current = document.documentElement.dataset.theme || 'dark';
  if (pick && THEMES.includes(current)) pick.value = current;
  paintThemeIcon();
  if (pick) pick.addEventListener('change', () => applyTheme(pick.value, true));
}

// ---------- settings and wiring ----------

async function openSettings() {
  const dlg = $('#settings');
  if (!dlg) return;
  // Open in this click, before any await. A later showModal can be ignored by the browser.
  try {
    if (!dlg.open) dlg.showModal();
  } catch (err) {
    dlg.setAttribute('open', '');
    $('#keyHint').textContent = err.message;
  }
  if (!state.config) {
    try { await loadConfig(); }
    catch { /* the hint below covers a server that is still down */ }
  }
  $('#setKey').value = '';
  if (state.config) {
    $('#setExpiry').value = state.config.expiry || '24h';
    $('#setRate').value = state.config.rateLimit || 20;
    $('#keyHint').textContent = state.config.hasKey
      ? 'Current key ' + state.config.keyHint + '. Leave the field empty to keep it.'
      : 'No key saved yet.';
  } else {
    $('#keyHint').textContent = 'The panel server is not responding. Start it with node server.js and open http://127.0.0.1:4777/';
  }
}
async function saveSettings(e) {
  e.preventDefault();
  const rate = Number($('#setRate').value);
  if (!(rate >= 1)) { $('#keyHint').textContent = 'The limit needs to be at least 1.'; return; }
  const body = { expiry: $('#setExpiry').value, rateLimit: rate };
  const key = $('#setKey').value.trim();
  if (key) body.apiKey = key;
  $('#setSave').disabled = true;
  try {
    await api('/api/config', { method: 'POST', body });
    await loadConfig();
    $('#settings').close();
    await loadUsers();
    await pollRate();
    updateSendButton();
  } catch (err) {
    $('#keyHint').textContent = explain(err);
  } finally {
    $('#setSave').disabled = false;
  }
}

async function refreshAll() {
  await loadUsers();
  for (const code of state.targets) await loadInfo(code);
  renderTargets();
  renderUsers();
}

function bind() {
  $('#search').addEventListener('input', renderUsers);
  document.querySelectorAll('.tab').forEach(btn => btn.addEventListener('click', () => {
    state.tab = btn.dataset.tab;
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t === btn));
    renderUsers();
  }));
  $('#btnRefresh').addEventListener('click', refreshAll);
  $('#addCode').addEventListener('submit', e => {
    e.preventDefault();
    const code = $('#codeInput').value.trim();
    $('#codeInput').value = '';
    if (code) toggleTarget(code);
  });
  $('#cmdForm').addEventListener('submit', onSend);
  $('#argDevice').addEventListener('change', () => { renderCmdTabs(); renderDetails(); });
  $('#argUrl').addEventListener('input', () => {
    if (!state.cmd.media) return;
    if (safeHttp($('#argUrl').value)) showPreview($('#argUrl').value, state.cmd.media);
    else $('#preview').replaceChildren();
  });
  $('#filePick').addEventListener('change', () => {
    const picked = Array.from($('#filePick').files || []);
    $('#filePick').value = '';
    if (picked.length) startUploads(picked);
  });
  const zone = $('#dropZone');
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('over');
    const files = e.dataTransfer && e.dataTransfer.files;
    if (files && files.length) startUploads(files);
  });
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => e.preventDefault());
  $('#libFilter').addEventListener('change', renderLibrary);
  $('#albumView').addEventListener('change', () => {
    state.albumView = $('#albumView').value;
    if ($('#uploadAlbum')) $('#uploadAlbum').value = state.albumView;
    const del = $('#albumDelete');
    if (del) del.disabled = !state.albumView;
    renderLibrary();
  });
  $('#albumCreate').addEventListener('click', createAlbum);
  $('#albumName').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); createAlbum(); } });
  $('#albumDelete').addEventListener('click', deleteAlbum);
  $('#albumAddAll').addEventListener('click', addVisibleToSequence);
  $('#seqAdd').addEventListener('click', addCurrentLink);
  $('#seqAddMessage').addEventListener('click', addMessageStep);
  $('#seqAddBlank').addEventListener('click', () => addPlainStep('blank'));
  $('#seqAddReaction').addEventListener('click', () => addPlainStep('reaction'));
  $('#seqAddLock').addEventListener('click', () => addPlainStep('lock'));
  $('#saveLink').addEventListener('click', () => saveLink($('#argUrl').value, '', state.cmd.media));
  $('#uploadHost').addEventListener('change', async () => {
    const uploadHost = $('#uploadHost').value === 'catbox' ? 'catbox' : 'pone';
    state.config.uploadHost = uploadHost;
    try { await api('/api/config', { method: 'POST', body: { uploadHost } }); }
    catch (err) { setStatus(explain(err), 'bad'); }
  });
  document.querySelectorAll('.seq-tab').forEach(btn => btn.addEventListener('click', () => showSeqTab(btn.dataset.seqTab)));
  $('#seqPlay').addEventListener('click', playSequence);
  $('#seqStop').addEventListener('click', () => {
    if (!state.playing) return;
    state.seqStop = true;
    if (state.mirrorAbort) state.mirrorAbort.abort();
    setRunStatus('Stopping…');
  });
  $('#seqSave').addEventListener('click', saveSequence);
  $('#seqNew').addEventListener('click', newSequence);
  $('#seqDelete').addEventListener('click', deleteSequence);
  $('#seqName').addEventListener('input', () => { state.sequence.name = $('#seqName').value; });
  $('#seqPick').addEventListener('change', () => {
    const id = $('#seqPick').value;
    const seq = state.sequences.find(s => s.id === id);
    if (seq) applySequence(seq);
  });
  window.addEventListener('beforeunload', e => {
    if (!state.playing) return;
    e.preventDefault();
    e.returnValue = '';
  });
  $('#setCancel').addEventListener('click', () => $('#settings').close());
  $('#settingsForm').addEventListener('submit', saveSettings);
}

async function init() {
  $('#btnSettings').addEventListener('click', () => openSettings());
  bindTheme();
  try { bind(); }
  catch (err) { setStatus('This page failed to start: ' + err.message, 'bad'); }
  renderCmdTabs();
  renderActivity();
  renderSequence();
  try { await loadConfig(); }
  catch { setStatus('Panel server is not responding.', 'bad'); return; }
  if ($('#uploadHost')) $('#uploadHost').value = state.config.uploadHost === 'catbox' ? 'catbox' : 'pone';
  await loadUsers();
  await loadLibrary();
  await loadAlbums();
  await loadSequences();
  if (!$('#seqStatus').classList.contains('bad')) setSeqStatus(sequenceSpan(state.sequence.steps));
  updateSendButton();
  await pollRate();
  setInterval(() => pollRate(), 4000);
  setInterval(() => { if (!state.sending) loadUsers(true); }, 20000);
}

init();
