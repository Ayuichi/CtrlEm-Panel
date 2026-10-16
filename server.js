// CtrlEm Panel - local server. Holds the API key, proxies the CtrlEm public API,
// and uploads local files to Catbox so they can be sent as URLs.
// No dependencies: run with `node server.js` (Node 18+).

const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { exec, execFileSync } = require('child_process');

const PORT = Number(process.env.PORT) || 4777;
const HOST = '127.0.0.1';
const API = process.env.CTRLEM_API || 'https://ctrlem.com/api/v1'; // env override is for local testing
const CATBOX = 'https://catbox.moe/user/api.php';
const LITTERBOX = 'https://litterbox.catbox.moe/resources/internals/api.php';
const POMF = 'https://pomf.lain.la/upload.php';
const CATBOX_MAX = 200 * 1024 * 1024;
const POMF_MAX = 1024 * 1024 * 1024;
const EXPIRY_MS = { '1h': 3600e3, '12h': 12 * 3600e3, '24h': 24 * 3600e3, '72h': 72 * 3600e3 };
const REUSE_MARGIN_MS = 10 * 60e3; // don't reuse a link that dies within 10 minutes

const ROOT = __dirname;
const PUB = path.join(ROOT, 'public');
const CONFIG_FILE = path.join(ROOT, 'config.json');
const LIBRARY_FILE = path.join(ROOT, 'library.json');
const SEQUENCES_FILE = path.join(ROOT, 'sequences.json');
const ALBUMS_FILE = path.join(ROOT, 'albums.json');
const MIRRORS_FILE = path.join(ROOT, 'pomf-mirrors.json');
const TMP = path.join(os.tmpdir(), 'ctrlem-panel');
fs.mkdirSync(TMP, { recursive: true });

// ---------- persistence ----------

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, data) {
  fs.writeFileSync(file + '.tmp', JSON.stringify(data, null, 2));
  fs.renameSync(file + '.tmp', file);
}

// Saves wait a second, so a burst of changes (a Pomf copy of 40 files, several renames)
// is one write per file instead of one per change. Each entry reads its data when it is
// written, because albums and sequences are replaced, not only changed.
// flushSaves() runs on exit, so closing the panel window still writes what was waiting.
const SAVE_DELAY_MS = 1000;
const pendingSaves = new Map(); // file -> () => data
let saveTimer = null;
function saveSoon(file, read) {
  pendingSaves.set(file, read);
  if (!saveTimer) saveTimer = setTimeout(flushSaves, SAVE_DELAY_MS);
}
function flushSaves() {
  clearTimeout(saveTimer);
  saveTimer = null;
  const due = [...pendingSaves];
  pendingSaves.clear();
  for (const [file, read] of due) {
    try { writeJson(file, read()); }
    catch (err) {
      console.error('Could not save ' + path.basename(file) + ': ' + err.message);
      if (!pendingSaves.has(file)) pendingSaves.set(file, read);
    }
  }
  if (pendingSaves.size && !saveTimer) saveTimer = setTimeout(flushSaves, 5000);
}
process.on('exit', flushSaves);

const config = Object.assign({ apiKey: '', expiry: '24h', favorites: [], rateLimit: 20, uploadHost: 'pone', pomfCodes: [] }, readJson(CONFIG_FILE, {}));
if (!Array.isArray(config.pomfCodes)) config.pomfCodes = [];
const saveConfig = () => writeJson(CONFIG_FILE, config);

// library: hash -> { hash, url, name, type, kind, size, uploadedAt, expiresAt }
let library = readJson(LIBRARY_FILE, {});
function pruneLibrary() {
  const now = Date.now();
  for (const [h, e] of Object.entries(library)) if (typeof e.expiresAt === 'number' && e.expiresAt <= now) delete library[h];
}
pruneLibrary();
const saveLibrary = () => saveSoon(LIBRARY_FILE, () => library);

function kindOf(type, name) {
  if (/^image\//.test(type)) return 'image';
  if (/^video\//.test(type)) return 'video';
  if (/^audio\//.test(type)) return 'audio';
  const ext = path.extname(name).toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'].includes(ext)) return 'image';
  if (['.mp4', '.webm', '.mov', '.mkv', '.m4v'].includes(ext)) return 'video';
  if (['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.opus', '.aac'].includes(ext)) return 'audio';
  return 'other';
}

// ---------- upload jobs ----------

const jobs = new Map(); // id -> { id, state, received, sent, total, entry, error, updated }

function publicJob(j) {
  return { id: j.id, state: j.state, received: j.received, sent: j.sent, total: j.total, entry: j.entry, error: j.error, host: j.host || '' };
}

let albums = readJson(ALBUMS_FILE, []);
if (!Array.isArray(albums)) albums = [];
const saveAlbums = () => saveSoon(ALBUMS_FILE, () => albums);
function publicAlbums() {
  return albums.map(a => ({ id: a.id, name: a.name, hashes: a.hashes || [], count: (a.hashes || []).length }));
}
function rememberInAlbum(albumId, hash) {
  const album = albums.find(a => a.id === albumId);
  if (!album) return;
  if (!Array.isArray(album.hashes)) album.hashes = [];
  if (album.hashes.includes(hash)) return;
  album.hashes.push(hash);
  saveAlbums();
}
function forgetHash(hash) {
  let changed = false;
  for (const album of albums) {
    const hashes = album.hashes || [];
    const next = hashes.filter(h => h !== hash);
    if (next.length !== hashes.length) { album.hashes = next; changed = true; }
  }
  if (changed) saveAlbums();
}

// Still previews for the file grid. Personal, like the library. One JPEG per hash.
// A video still is one frame. The browser asks for byte ranges, and each range stays
// inside this window so a long file is not downloaded whole.
const THUMBS_DIR = path.join(ROOT, 'thumbs');
const THUMB_BYTES = 256 * 1024;
const THUMB_SOURCE_MAX = 80 * 1024 * 1024;
const THUMB_RANGE_MAX = 8 * 1024 * 1024;
const PREVIEW_TICKET_MS = 5 * 60 * 1000;
fs.mkdirSync(THUMBS_DIR, { recursive: true });
const previewTickets = new Map();
// Hashes that have a saved still. The folder is read once at start, then this set changes
// with each save and delete. Asking the disk once per file made every library request
// cost one file check per entry (about 75 ms at 1500 files).
const thumbHashes = new Set();

function thumbFile(hash) {
  return path.join(THUMBS_DIR, hash + '.jpg');
}
function thumbReady(hash) {
  return thumbHashes.has(hash);
}
function removeThumb(hash) {
  if (!/^[a-f0-9]{64}$/.test(hash)) return;
  thumbHashes.delete(hash);
  fs.rm(thumbFile(hash), { force: true }, () => {});
}
function sweepThumbs() {
  let names = [];
  try { names = fs.readdirSync(THUMBS_DIR); } catch { return; }
  for (const name of names) {
    const found = /^([a-f0-9]{64})\.jpg$/.exec(name);
    if (!found) continue;
    if (library[found[1]]) thumbHashes.add(found[1]);
    else fs.rm(path.join(THUMBS_DIR, name), { force: true }, () => {});
  }
}
function libraryView(entry) {
  const still = entry && (entry.kind === 'image' || entry.kind === 'video');
  return Object.assign({}, entry, { thumb: !!(still && thumbReady(entry.hash)) });
}
function issuePreviewTicket(hash) {
  const now = Date.now();
  for (const [token, row] of previewTickets) {
    if (row.exp <= now) previewTickets.delete(token);
  }
  const token = crypto.randomBytes(18).toString('hex');
  previewTickets.set(token, { hash, exp: now + PREVIEW_TICKET_MS });
  return token;
}
function previewTicketOk(token, hash) {
  if (!/^[a-f0-9]{36}$/.test(token || '')) return false;
  const row = previewTickets.get(token);
  if (!row || row.exp <= Date.now()) {
    if (row) previewTickets.delete(token);
    return false;
  }
  return row.hash === hash;
}
// One range, clamped. An open end would otherwise pull the rest of a long video.
function previewRange(header) {
  const raw = String(header || '').trim();
  const suffix = /^bytes=-(\d+)$/.exec(raw);
  if (suffix) {
    const n = Math.min(Math.max(Number(suffix[1]) || 1, 1), THUMB_RANGE_MAX);
    return 'bytes=-' + n;
  }
  let start = 0;
  let end = THUMB_RANGE_MAX - 1;
  const match = /^bytes=(\d+)-(\d*)$/.exec(raw);
  if (match) {
    const asked = Number(match[1]);
    if (Number.isSafeInteger(asked) && asked >= 0) start = asked;
    if (match[2] !== '') {
      const stop = Number(match[2]);
      if (Number.isSafeInteger(stop) && stop >= start) end = stop;
    } else end = start + THUMB_RANGE_MAX - 1;
    if (end < start) end = start + THUMB_RANGE_MAX - 1;
    if (end - start + 1 > THUMB_RANGE_MAX) end = start + THUMB_RANGE_MAX - 1;
  }
  return 'bytes=' + start + '-' + end;
}
function previewSendType(kind, upstreamType, name) {
  const type = String(upstreamType || '').split(';')[0].trim().toLowerCase();
  if (kind !== 'video') return type.startsWith('image/') ? type : 'application/octet-stream';
  if (type.startsWith('video/')) return type;
  const ext = path.extname(String(name || '').split(/[?#]/)[0]).toLowerCase();
  if (ext === '.webm') return 'video/webm';
  if (ext === '.mov') return 'video/quicktime';
  if (ext === '.mkv') return 'video/x-matroska';
  return 'video/mp4';
}
sweepThumbs();

function safeFileName(name) {
  const ext = path.extname(name).replace(/[^.a-zA-Z0-9]/g, '').slice(0, 10);
  const base = path.basename(name, path.extname(name)).replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 60) || 'file';
  return base + ext;
}

const HOSTS = {
  pone: { id: 'pone', label: 'pone.rs', limit: 1024 * 1024 * 1024 },
  catbox: { id: 'catbox', label: 'Catbox', limit: CATBOX_MAX },
};

function uploadMultipart(endpoint, fields, fileField, file, name, type, job, label, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) { reject(new Error('Cancelled')); return; }
    const b = '----ctrlempanel' + crypto.randomBytes(12).toString('hex');
    const field = (k, v) => `--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`;
    let preamble = '';
    for (const [k, v] of Object.entries(fields)) preamble += field(k, v);
    const head = Buffer.from(
      preamble +
      `--${b}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${safeFileName(name)}"\r\n` +
      `Content-Type: ${type || 'application/octet-stream'}\r\n\r\n`);
    const tail = Buffer.from(`\r\n--${b}--\r\n`);
    const size = fs.statSync(file).size;
    const host = label || (endpoint === CATBOX ? 'Catbox' : 'pone.rs');

    const req = https.request(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${b}`,
        'Content-Length': head.length + size + tail.length,
        'User-Agent': 'CtrlEmPanel/1.0',
      },
      timeout: 30 * 60e3,
    }, res => {
      if (stallTimer) clearInterval(stallTimer);
      let body = '';
      res.setEncoding('utf8');
      res.on('data', d => { body += d; });
      res.on('end', () => {
        body = body.trim();
        if (res.statusCode >= 200 && res.statusCode < 300 && body) resolve(body);
        else reject(new Error(`${host} ${res.statusCode}: ${body.slice(0, 200) || 'empty response'}`));
      });
    });
    req.on('timeout', () => req.destroy(new Error(host + ' timed out')));
    req.on('error', reject);
    if (signal) {
      const onAbort = () => req.destroy(new Error('Cancelled'));
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    }
    let stallTimer = null;
    if (job && job.stallMs) {
      stallTimer = setInterval(() => {
        if (Date.now() - job.updated > job.stallMs) req.destroy(new Error(host + ' stalled'));
      }, 2000);
      stallTimer.unref();
      const stopStall = () => { if (stallTimer) clearInterval(stallTimer); };
      req.on('close', stopStall);
      req.on('error', stopStall);
    }

    req.write(head);
    const rs = fs.createReadStream(file, { highWaterMark: 256 * 1024 });
    rs.on('data', chunk => {
      job.sent += chunk.length; job.updated = Date.now();
      if (!req.write(chunk)) { rs.pause(); req.once('drain', () => rs.resume()); }
    });
    rs.on('end', () => req.end(tail));
    rs.on('error', err => req.destroy(err));
  });
}

async function uploadToHost(hostId, file, name, type, job) {
  if (hostId === 'catbox') {
    const body = await uploadMultipart(CATBOX, { reqtype: 'fileupload' }, 'fileToUpload', file, name, type, job);
    if (!isHttpUrl(body)) throw new Error('Catbox: ' + body.slice(0, 200));
    return body;
  }
  const body = await uploadMultipart('https://pone.rs/upload', {}, 'files[]', file, name, type, job);
  let data;
  try { data = JSON.parse(body); } catch { throw new Error('pone.rs: ' + body.slice(0, 200)); }
  const link = data && data.files && data.files[0] && data.files[0].url;
  if (!data.success || !isHttpUrl(link)) throw new Error('pone.rs: ' + body.slice(0, 200));
  return link;
}

// pomf-mirrors.json: source URL -> Pomf URL. Library entries also keep pomfUrl when the source matches.
let pomfMirrors = readJson(MIRRORS_FILE, {});
if (!pomfMirrors || typeof pomfMirrors !== 'object' || Array.isArray(pomfMirrors)) pomfMirrors = {};
const saveMirrors = () => saveSoon(MIRRORS_FILE, () => pomfMirrors);

function linkHost(value) {
  try {
    return new URL(String(value || '')).hostname.toLowerCase().replace(/\.$/, '');
  } catch { return ''; }
}
function isPomfUrl(value) {
  const host = linkHost(value);
  return host === 'pomf.lain.la' || host === 'pomf2.lain.la';
}
// Pomf is a stand-in for u.pone.rs. A saved link on any other host is sent as it is.
function isPoneUrl(value) {
  return linkHost(value) === 'u.pone.rs';
}
function rememberedPomf(url) {
  if (isHttpUrl(pomfMirrors[url]) && isPomfUrl(pomfMirrors[url])) return pomfMirrors[url];
  for (const entry of Object.values(library)) {
    if (entry && entry.url === url && isHttpUrl(entry.pomfUrl) && isPomfUrl(entry.pomfUrl)) return entry.pomfUrl;
  }
  return '';
}
function rememberPomf(url, pomfUrl) {
  pomfMirrors[url] = pomfUrl;
  saveMirrors();
  let changed = false;
  for (const entry of Object.values(library)) {
    if (entry && entry.url === url && entry.pomfUrl !== pomfUrl) { entry.pomfUrl = pomfUrl; changed = true; }
  }
  if (changed) saveLibrary();
}
function nameFromUrl(url) {
  try {
    const last = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || '');
    if (last) return last.slice(0, 80);
  } catch { /* the caller has a fallback */ }
  return 'file';
}
function cleanEntryName(value) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
}
function mirrorName(url, requested) {
  const known = Object.values(library).find(entry => entry && entry.url === url && entry.name);
  const raw = String(requested || '').trim() || (known && known.name) || nameFromUrl(url);
  return raw.slice(0, 80) || 'file';
}

function downloadToFile(url, dest, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let activeReq = null;
    let out = null;
    const started = Date.now();
    let last = started;
    const dropFile = () => fs.rm(dest, { force: true }, () => {});
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      if (!err) { resolve(value); return; }
      if (activeReq) activeReq.destroy();
      if (out) {
        out.once('close', dropFile);
        out.destroy();
        if (out.closed) dropFile();
      } else dropFile();
      reject(err);
    };
    const timer = setInterval(() => {
      if (signal && signal.aborted) finish(new Error('Cancelled'));
      else if (Date.now() - last > 5 * 60e3) finish(new Error('Download stalled'));
      else if (Date.now() - started > 30 * 60e3) finish(new Error('Download timed out'));
    }, 2000);
    timer.unref();
    if (signal && signal.aborted) { finish(new Error('Cancelled')); return; }
    if (signal) signal.addEventListener('abort', () => finish(new Error('Cancelled')), { once: true });

    const go = (next, redirects) => {
      if (settled) return;
      let target;
      try { target = new URL(next); } catch { finish(new Error('That link is not a downloadable URL')); return; }
      const lib = target.protocol === 'https:' ? https : target.protocol === 'http:' ? http : null;
      if (!lib) { finish(new Error('That link is not a downloadable URL')); return; }
      const req = lib.request(target, {
        method: 'GET',
        headers: { 'User-Agent': 'CtrlEmPanel/1.0', Accept: '*/*' },
        timeout: 30 * 60e3,
      }, res => {
        const hop = [301, 302, 303, 307, 308];
        if (hop.includes(res.statusCode) && res.headers.location) {
          res.resume();
          if (redirects >= 5) finish(new Error('Too many redirects'));
          else go(new URL(res.headers.location, target).href, redirects + 1);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          finish(new Error('Download failed (' + res.statusCode + ')'));
          return;
        }
        const type = String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        if (type === 'text/html') {
          res.resume();
          finish(new Error('That link is a page, not the file'));
          return;
        }
        const announced = Number(res.headers['content-length']) || 0;
        if (announced > POMF_MAX) {
          res.resume();
          finish(new Error('Pomf accepts files up to 1024 MB'));
          return;
        }
        let received = 0;
        out = fs.createWriteStream(dest);
        const tooBig = () => finish(new Error('Pomf accepts files up to 1024 MB'));
        res.on('data', chunk => {
          if (settled) return;
          received += chunk.length;
          last = Date.now();
          if (received > POMF_MAX) { tooBig(); return; }
          if (!out.write(chunk)) res.pause();
        });
        out.on('drain', () => { if (!settled) res.resume(); });
        res.on('end', () => { if (!settled) out.end(); });
        out.on('finish', () => finish(null, { size: received, type }));
        out.on('error', err => finish(err));
        res.on('error', err => finish(err));
        res.on('aborted', () => finish(new Error('Download failed')));
      });
      activeReq = req;
      req.on('timeout', () => req.destroy(new Error('Download timed out')));
      req.on('error', err => { if (req === activeReq) finish(err); });
      req.end();
    };
    go(url, 0);
  });
}

async function uploadToPomf(file, name, type, signal) {
  const job = { sent: 0, updated: Date.now(), stallMs: 5 * 60e3 };
  const body = await uploadMultipart(POMF, {}, 'files[]', file, name, type, job, 'Pomf', signal);
  let data;
  try { data = JSON.parse(body); } catch { throw new Error('Pomf: ' + body.slice(0, 200)); }
  const link = data && data.files && data.files[0] && data.files[0].url;
  if (!data.success || !isHttpUrl(link) || !isPomfUrl(link)) throw new Error('Pomf: ' + body.slice(0, 200));
  return link;
}

let mirrorTail = Promise.resolve();
function queueMirror(fn) {
  const run = mirrorTail.then(fn, fn);
  mirrorTail = run.then(() => {}, () => {});
  return run;
}

async function mirrorToPomf(url, name, signal) {
  if (isPomfUrl(url) || !isPoneUrl(url)) return url;
  const known = rememberedPomf(url);
  if (known) return known;
  return queueMirror(async () => {
    if (signal && signal.aborted) throw new Error('Cancelled');
    const again = rememberedPomf(url);
    if (again) return again;
    const id = crypto.randomBytes(8).toString('hex');
    const tmpFile = path.join(TMP, 'mirror-' + id);
    const fileName = mirrorName(url, name);
    const downloaded = await downloadToFile(url, tmpFile, signal);
    try {
      if (signal && signal.aborted) throw new Error('Cancelled');
      const type = downloaded.type && downloaded.type !== 'application/octet-stream' ? downloaded.type : '';
      const link = await uploadToPomf(tmpFile, fileName, type, signal);
      rememberPomf(url, link);
      return link;
    } finally {
      fs.rm(tmpFile, () => {});
    }
  });
}

function handleUpload(req, res, url) {
  const name = url.searchParams.get('name') || 'file';
  const type = url.searchParams.get('type') || '';
  const albumId = url.searchParams.get('album') || '';
  const hostId = url.searchParams.get('host') === 'catbox' ? 'catbox' : 'pone';
  const hostInfo = HOSTS[hostId];
  const total = Number(req.headers['content-length']) || 0;
  if (total > hostInfo.limit) return sendJson(res, 413, { error: hostInfo.label + ' accepts files up to ' + Math.round(hostInfo.limit / (1024 * 1024)) + ' MB' });

  const id = crypto.randomBytes(8).toString('hex');
  const job = { id, state: 'receiving', received: 0, sent: 0, total, entry: null, error: null, updated: Date.now() };
  jobs.set(id, job);

  const tmpFile = path.join(TMP, id);
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(tmpFile);
  req.on('data', chunk => { hash.update(chunk); job.received += chunk.length; });
  req.pipe(out);

  req.on('aborted', () => { job.state = 'error'; job.error = 'Cancelled'; out.destroy(); fs.rm(tmpFile, () => {}); });
  out.on('finish', async () => {
    if (job.state === 'error') return;
    const digest = hash.digest('hex');
    job.total = job.received;
    // Reply right away; the browser polls /api/jobs/:id for the host upload.
    sendJson(res, 200, { id });

    job.host = hostId;
    const cached = library[digest];
    const cachedOk = cached && (cached.expiresAt == null || cached.expiresAt - Date.now() > REUSE_MARGIN_MS);
    if (cachedOk) {
      job.sent = job.total; job.entry = cached; job.state = 'done';
      if (albumId) rememberInAlbum(albumId, digest);
      fs.rm(tmpFile, () => {});
      return;
    }
    if (job.total > hostInfo.limit) {
      job.state = 'error';
      job.error = hostInfo.label + ' accepts files up to ' + Math.round(hostInfo.limit / (1024 * 1024)) + ' MB';
      fs.rm(tmpFile, () => {});
      return;
    }
    job.state = 'uploading';
    try {
      const link = await uploadToHost(hostId, tmpFile, name, type, job);
      const now = Date.now();
      const entry = {
        hash: digest, url: link, name, type, kind: kindOf(type, name), size: job.total, uploadedAt: now,
        expiresAt: null,
      };
      library[digest] = entry; saveLibrary();
      if (albumId) rememberInAlbum(albumId, digest);
      job.entry = entry; job.state = 'done';
    } catch (err) {
      job.state = 'error'; job.error = err.message;
    } finally {
      fs.rm(tmpFile, () => {});
    }
  });
  out.on('error', err => { job.state = 'error'; job.error = err.message; if (!res.headersSent) sendJson(res, 500, { error: err.message }); });
}

setInterval(() => {
  const cutoff = Date.now() - 15 * 60e3;
  for (const [id, j] of jobs) if (j.updated < cutoff && j.state !== 'uploading') jobs.delete(id);
  pruneLibrary();
}, 60e3).unref();

// ---------- CtrlEm proxy ----------

// CtrlEm allows 20 commands a minute. The saved cap can be lower. It cannot be higher.
const CTRL_EM_COMMAND_LIMIT = 20;
function commandLimit() {
  const n = Number(config.rateLimit);
  if (!Number.isFinite(n) || n < 1) return CTRL_EM_COMMAND_LIMIT;
  return Math.min(CTRL_EM_COMMAND_LIMIT, Math.round(n));
}

// Successful commands in the last minute, shared by the composer and (later) sequences.
const sentTimes = [];
function rateNow() {
  const cutoff = Date.now() - 60e3;
  while (sentTimes.length && sentTimes[0] < cutoff) sentTimes.shift();
  const limit = commandLimit();
  return { lastMinute: sentTimes.length, limit, nextFreeIn: sentTimes.length >= limit ? sentTimes[0] + 60e3 - Date.now() : 0 };
}

// argument: 'url' or 'text'. count is writeForMe only. screenshot and webcam stay off the API.
const COMMANDS = {
  openPage: { arg: 'url' },
  popupImage: { arg: 'url' },
  changeWallpaper: { arg: 'url' },
  sendMessage: { arg: 'text' },
  writeForMe: { arg: 'text', max: 200, count: true },
  lockinput: {},
  screenBlank: {},
  reactionTest: { arg: 'url', optional: true },
  popupSound: { arg: 'url' },
  videoOverlay: { arg: 'url' },
};

function isHttpUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch { return false; }
}

// sequences: [{ id, name, steps, updatedAt }]
// A file step is { kind: image|video|audio|wallpaper|page, url, name, wait }.
// An action step is { kind: message, text, wait }, { kind: write, text, count, wait },
// { kind: blank|lock, wait }, or { kind: reaction, wait } with an optional image url and name.
let sequences = readJson(SEQUENCES_FILE, []);
if (!Array.isArray(sequences)) sequences = [];
const saveSequences = () => saveSoon(SEQUENCES_FILE, () => sequences);

function cleanSequence(b) {
  const id = typeof b.id === 'string' && /^[a-f0-9]{8,32}$/.test(b.id) ? b.id : crypto.randomBytes(8).toString('hex');
  const name = String(b.name || '').trim().slice(0, 60);
  if (!name) throw new Error('Name the sequence');
  if (!Array.isArray(b.steps) || !b.steps.length) throw new Error('Add at least one item');
  const steps = b.steps.map(s => {
    const kind = s && (s.kind === 'image' || s.kind === 'video' || s.kind === 'audio' || s.kind === 'wallpaper' || s.kind === 'page' || s.kind === 'message' || s.kind === 'write' || s.kind === 'blank' || s.kind === 'reaction' || s.kind === 'lock') ? s.kind : '';
    if (!kind) throw new Error('Each item has to be an image, video, sound, wallpaper, page, message, write, blank screen, reaction test, or lock input');
    const wait = Math.max(3, Math.min(600, Math.round(Number(s.wait)) || 5));
    if (kind === 'message') {
      const text = String(s.text || '').trim().slice(0, 2000);
      if (!text) throw new Error('A message step needs text');
      return { kind, text, wait };
    }
    if (kind === 'write') {
      const text = String(s.text || '').trim().slice(0, 200);
      if (!text) throw new Error('A write step needs text');
      const count = Math.max(1, Math.min(5, Math.round(Number(s.count)) || 1));
      return { kind, text, count, wait };
    }
    if (kind === 'blank' || kind === 'lock') return { kind, wait };
    if (kind === 'reaction') {
      const url = String(s.url || '').trim();
      if (!url) return { kind, wait };
      if (!isHttpUrl(url) || url.length > 2000) throw new Error('A reaction test image needs an http or https link');
      return { kind, url, name: String(s.name || '').trim().slice(0, 80), wait };
    }
    const url = String(s.url || '').trim();
    if (!isHttpUrl(url) || url.length > 2000) throw new Error(kind === 'page' ? 'A page needs an http or https link' : 'Each file needs an http or https link');
    return { kind, url, name: String(s.name || '').trim().slice(0, 80), wait };
  });
  return { id, name, steps, updatedAt: Date.now() };
}

// Proxies one call and answers the browser with CtrlEm's status and body. Returns that status.
async function ctrlem(res, method, apiPath, body) {
  if (!config.apiKey) { sendJson(res, 401, { error: 'No API key set. Add it in Settings.' }); return 401; }
  try {
    const r = await fetch(API + apiPath, {
      method,
      headers: Object.assign({ Authorization: 'Bearer ' + config.apiKey, 'User-Agent': 'CtrlEmPanel/1.0' },
        body ? { 'Content-Type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20e3),
    });
    const text = await r.text();
    res.writeHead(r.status, { 'Content-Type': r.headers.get('content-type') || 'application/json', 'Cache-Control': 'no-store' });
    res.end(text);
    return r.status;
  } catch (err) {
    sendJson(res, 502, { error: 'Could not reach ctrlem.com: ' + err.message });
    return 502;
  }
}

// ---------- http plumbing ----------

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', d => { data += d; if (data.length > limit) { reject(new Error('Body too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}

function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', d => {
      size += d.length;
      if (size > limit) { reject(new Error('Body too large')); req.destroy(); return; }
      chunks.push(d);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Streams a library image or video to the page so the browser can draw one still frame.
// The address comes from the saved entry. The original file is not kept.
// Video requests carry a byte range. A host that ignores it and answers with the whole
// file is refused once that answer is larger than one range window.
function pipeRemote(url, res, signal, opts) {
  const range = opts && opts.range || '';
  const kind = opts && opts.kind === 'video' ? 'video' : 'image';
  const name = opts && opts.name || '';
  const cap = range ? THUMB_RANGE_MAX : THUMB_SOURCE_MAX;
  return new Promise((resolve, reject) => {
    let settled = false;
    let activeReq = null;
    const started = Date.now();
    let last = started;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (err && activeReq) activeReq.destroy();
      if (err) reject(err); else resolve();
    };
    const onAbort = () => finish(new Error('Cancelled'));
    const timer = setInterval(() => {
      if (signal && signal.aborted) finish(new Error('Cancelled'));
      else if (Date.now() - last > 5 * 60e3) finish(new Error('Download stalled'));
      else if (Date.now() - started > 10 * 60e3) finish(new Error('Download timed out'));
    }, 2000);
    timer.unref();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    if (signal && signal.aborted) { finish(new Error('Cancelled')); return; }

    const go = (next, redirects) => {
      if (settled) return;
      let target;
      try { target = new URL(next); } catch { finish(new Error('That link is not a downloadable URL')); return; }
      const lib = target.protocol === 'https:' ? https : target.protocol === 'http:' ? http : null;
      if (!lib) { finish(new Error('That link is not a downloadable URL')); return; }
      const headers = {
        'User-Agent': 'CtrlEmPanel/1.0',
        Accept: kind === 'video' ? 'video/*,*/*' : 'image/*,*/*',
      };
      if (range) headers.Range = range;
      const req = lib.request(target, {
        method: 'GET',
        headers,
        timeout: 10 * 60e3,
      }, upstream => {
        const hop = [301, 302, 303, 307, 308];
        if (hop.includes(upstream.statusCode) && upstream.headers.location) {
          upstream.resume();
          if (redirects >= 5) finish(new Error('Too many redirects'));
          else go(new URL(upstream.headers.location, target).href, redirects + 1);
          return;
        }
        const status = upstream.statusCode;
        const ranged = status === 206 && !!range;
        if (status !== 200 && !ranged) {
          upstream.resume();
          finish(new Error('Download failed (' + status + ')'));
          return;
        }
        const type = String(upstream.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        if (type === 'text/html') {
          upstream.resume();
          finish(new Error('That link is a page, not the file'));
          return;
        }
        const announced = Number(upstream.headers['content-length']) || 0;
        if (announced > cap) {
          upstream.destroy();
          finish(new Error('That file is too large for a preview'));
          return;
        }
        const contentRange = String(upstream.headers['content-range'] || '');
        if (ranged && !/^bytes \d+-\d+\/(\d+|\*)$/.test(contentRange)) {
          upstream.resume();
          finish(new Error('Download failed (206)'));
          return;
        }
        if (settled || res.writableEnded) { upstream.resume(); finish(new Error('Cancelled')); return; }
        const out = {
          'Content-Type': previewSendType(kind, type, name),
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        };
        if (range) out['Accept-Ranges'] = 'bytes';
        if (ranged) out['Content-Range'] = contentRange;
        if (announced) out['Content-Length'] = String(announced);
        res.writeHead(ranged ? 206 : 200, out);
        let received = 0;
        upstream.on('data', chunk => {
          if (settled) return;
          received += chunk.length;
          last = Date.now();
          if (received > cap) { finish(new Error('That file is too large for a preview')); res.destroy(); return; }
          try {
            if (!res.write(chunk)) upstream.pause();
          } catch (err) { finish(err); }
        });
        res.on('drain', () => { if (!settled) upstream.resume(); });
        upstream.on('end', () => { if (!settled) { res.end(); finish(); } });
        upstream.on('error', err => finish(err));
        upstream.on('aborted', () => finish(new Error('Download failed')));
      });
      activeReq = req;
      req.on('timeout', () => req.destroy(new Error('Download timed out')));
      req.on('error', err => { if (req === activeReq) finish(err); });
      req.end();
    };
    go(url, 0);
  });
}

async function serveLibraryFile(req, res, entry) {
  const kind = entry && (entry.kind === 'image' || entry.kind === 'video') ? entry.kind : '';
  if (!kind || !isHttpUrl(entry.url)) {
    return sendJson(res, 404, { error: 'That file is not in the list' });
  }
  const range = kind === 'video' ? previewRange(req.headers.range) : '';
  const label = entry.name && path.extname(entry.name) ? entry.name : (entry.url || entry.name || '');
  const ac = new AbortController();
  const stop = () => ac.abort();
  req.on('aborted', stop);
  res.on('close', () => { if (!res.writableEnded) stop(); });
  try {
    await pipeRemote(entry.url, res, ac.signal, { range, kind, name: label });
  } catch (err) {
    if (res.headersSent) { if (!res.writableEnded) res.destroy(); return; }
    if (ac.signal.aborted || (err && err.message === 'Cancelled')) return;
    const msg = (err && err.message) || 'Download failed';
    const status = /too large/.test(msg) ? 413 : 502;
    if (!res.writableEnded) sendJson(res, status, { error: msg });
  }
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  const file = path.resolve(PUB, rel);
  if (!file.startsWith(PUB + path.sep)) return sendJson(res, 403, { error: 'Forbidden' });
  fs.readFile(file, (err, data) => {
    if (err) return sendJson(res, 404, { error: 'Not found' });
    // Another site must not show the panel in a frame and steer clicks onto its buttons.
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(data);
  });
}

const CODE = /^[A-Za-z0-9]{3,12}$/;
function cleanCodes(list) {
  const out = [];
  if (!Array.isArray(list)) return out;
  for (const code of list) {
    const c = String(code || '').trim().toUpperCase();
    if (CODE.test(c) && !out.includes(c)) out.push(c);
  }
  return out.slice(0, 200);
}
const allowedHosts = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

// A newer build.json version on GitHub main is an update. Personal files are never in that list.
const UPDATE_REPO = 'Ayuichi/CtrlEm-Panel';
const UPDATE_HOSTS = new Set(['api.github.com', 'raw.githubusercontent.com', 'objects.githubusercontent.com', 'codeload.github.com']);
// Lower case. Windows file names ignore case, so Config.json is config.json.
const UPDATE_BAN = new Set(['config.json', 'library.json', 'albums.json', 'sequences.json', 'pomf-mirrors.json', 'agents.md']);
const UPDATE_EXT = new Set(['.js', '.md', '.css', '.html', '.svg', '.bat', '.json']);
const UPDATE_MAX = 2 * 1024 * 1024;
// build.json on GitHub has to carry a signature from this key, made by tools/sign-build.js.
// Anyone who can push to the repo still cannot ship program files without the private key.
const UPDATE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEARP+MwmbbfhQiNY2/oPdfeozJxxv7yIykz6b3yS/4kBs=
-----END PUBLIC KEY-----
`;
let updateBusy = false;

function updateUrlOk(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && UPDATE_HOSTS.has(u.hostname);
  } catch { return false; }
}
function updatePathOk(rel) {
  if (typeof rel !== 'string' || !rel || rel.length > 200) return false;
  if (rel.includes('\\') || rel.startsWith('/') || /[\u0000-\u001f:*?"<>|]/.test(rel)) return false;
  const parts = rel.toLowerCase().split('/');
  // Windows drops a trailing dot or space, so "config.json." would open config.json.
  if (parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part))) return false;
  if (UPDATE_BAN.has(parts[parts.length - 1])) return false;
  if (parts[0] === 'thumbs' || parts[0] === '.git' || parts[0].startsWith('alternative programs')) return false;
  const base = parts[parts.length - 1];
  if (base !== '.gitignore' && !UPDATE_EXT.has(path.extname(base).toLowerCase())) return false;
  const full = path.resolve(ROOT, rel);
  const root = ROOT.endsWith(path.sep) ? ROOT : ROOT + path.sep;
  return full === ROOT || full.startsWith(root);
}
function httpsGet(url, headers, limit, redirects = 0) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err) => { if (settled) return; settled = true; reject(err); };
    const done = (buf) => { if (settled) return; settled = true; resolve(buf); };
    if (!updateUrlOk(url)) { fail(new Error('Could not reach GitHub.')); return; }
    const req = https.request(url, { method: 'GET', headers, timeout: 20000 }, res => {
      const code = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(code) && res.headers.location) {
        res.resume();
        if (redirects >= 5) { fail(new Error('Could not reach GitHub.')); return; }
        let next;
        try { next = new URL(res.headers.location, url).href; } catch { fail(new Error('Could not reach GitHub.')); return; }
        httpsGet(next, headers, limit, redirects + 1).then(done, fail);
        return;
      }
      if (code !== 200) { res.resume(); fail(new Error('Could not reach GitHub.')); return; }
      const chunks = [];
      let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > limit) { fail(new Error('That update file is too large.')); req.destroy(); return; }
        chunks.push(chunk);
      });
      res.on('end', () => { if (!settled) done(Buffer.concat(chunks)); });
      res.on('error', () => fail(new Error('Could not reach GitHub.')));
    });
    req.on('timeout', () => req.destroy(new Error('Could not reach GitHub.')));
    req.on('error', () => fail(new Error('Could not reach GitHub.')));
    req.end();
  });
}
function githubRaw(rel) {
  const encoded = rel.split('/').map(encodeURIComponent).join('/');
  return 'https://api.github.com/repos/' + UPDATE_REPO + '/contents/' + encoded + '?ref=main';
}
// The signed text: version, then one "sha256 path" line per program file. build.json is not hashed.
function buildMessage(version, files, hashes) {
  const lines = ['ctrlem-panel-build', String(version)];
  for (const rel of files) if (rel !== 'build.json') lines.push(hashes[rel] + ' ' + rel);
  return lines.join('\n');
}
function verifyBuild(data) {
  const hashes = data && data.hashes;
  const ok = hashes && typeof hashes === 'object' && typeof data.signature === 'string' &&
    data.files.every(rel => rel === 'build.json' || /^[a-f0-9]{64}$/.test(hashes[rel] || '')) &&
    (() => {
      try {
        return crypto.verify(null, Buffer.from(buildMessage(data.version, data.files, hashes)),
          UPDATE_PUBLIC_KEY, Buffer.from(data.signature, 'base64'));
      } catch { return false; }
    })();
  if (!ok) {
    const err = new Error('The update is not signed by the panel author.');
    err.status = 502;
    throw err;
  }
}
function parseBuild(buf) {
  let data;
  try { data = JSON.parse(buf.toString('utf8')); } catch { data = null; }
  const version = data && data.version;
  const files = data && Array.isArray(data.files) ? data.files.filter(item => typeof item === 'string') : null;
  if (!Number.isInteger(version) || version < 1 || version > 1000000 || !files || files.length < 1 || files.length > 40 ||
      files.length !== data.files.length) {
    const err = new Error('The update list is not usable.');
    err.status = 502;
    throw err;
  }
  verifyBuild({ version, files, hashes: data.hashes, signature: data.signature });
  return { version, files, hashes: data.hashes, raw: buf };
}
function localVersion() {
  const data = readJson(path.join(ROOT, 'build.json'), {});
  return Number.isInteger(data.version) ? data.version : 0;
}
function programEdits() {
  if (!fs.existsSync(path.join(ROOT, '.git'))) return false;
  try {
    const out = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
      cwd: ROOT, encoding: 'utf8', timeout: 8000, windowsHide: true,
    });
    return out.split(/\r?\n/).some(line => {
      if (line.length < 4) return false;
      let file = line.slice(3).trim();
      const arrow = file.indexOf(' -> ');
      if (arrow !== -1) file = file.slice(arrow + 4).trim();
      if (file.startsWith('"') && file.endsWith('"')) file = file.slice(1, -1);
      return updatePathOk(file);
    });
  } catch { return true; }
}
async function remoteBuild() {
  const buf = await httpsGet(githubRaw('build.json'), {
    'User-Agent': 'CtrlEmPanel/1.0',
    Accept: 'application/vnd.github.raw',
  }, 64 * 1024);
  return parseBuild(buf);
}
async function updateStatus() {
  try {
    const remote = await remoteBuild();
    const update = remote.version > localVersion();
    return { update, version: remote.version, dirty: update ? programEdits() : false };
  } catch (err) {
    if (err && /not signed/.test(err.message)) console.warn('Update on GitHub ignored: ' + err.message);
    return { update: false };
  }
}
function replaceFile(dest, buf) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = path.join(TMP, 'update-' + crypto.randomBytes(6).toString('hex'));
  fs.writeFileSync(tmp, buf);
  try { fs.copyFileSync(tmp, dest); }
  finally { fs.rmSync(tmp, { force: true }); }
}
async function applyUpdate() {
  if (programEdits()) {
    const err = new Error('This folder has edits to the program. An update would replace them.');
    err.status = 409;
    throw err;
  }
  const remote = await remoteBuild();
  if (!(remote.version > localVersion())) {
    const err = new Error('This copy is already current.');
    err.status = 409;
    throw err;
  }
  const files = [];
  const seen = new Set();
  for (const rel of remote.files) {
    if (!updatePathOk(rel) || seen.has(rel)) continue;
    seen.add(rel);
    files.push(rel);
  }
  if (!files.includes('build.json') || !files.includes('server.js')) {
    const err = new Error('The update list is not usable.');
    err.status = 502;
    throw err;
  }
  const got = [];
  let total = 0;
  for (const rel of files) {
    // The signed list was checked once. Fetching build.json again could return a different one.
    if (rel === 'build.json') { got.push({ rel, buf: remote.raw }); continue; }
    const buf = await httpsGet(githubRaw(rel), {
      'User-Agent': 'CtrlEmPanel/1.0',
      Accept: 'application/vnd.github.raw',
    }, UPDATE_MAX);
    if (!buf.length) {
      const err = new Error('The update list is not usable.');
      err.status = 502;
      throw err;
    }
    total += buf.length;
    if (total > 8 * 1024 * 1024) {
      const err = new Error('That update is too large.');
      err.status = 413;
      throw err;
    }
    if (crypto.createHash('sha256').update(buf).digest('hex') !== remote.hashes[rel]) {
      const err = new Error(rel + ' on GitHub does not match the signed update. Nothing was changed.');
      err.status = 502;
      throw err;
    }
    got.push({ rel, buf });
  }
  got.sort((a, b) => Number(a.rel === 'build.json') - Number(b.rel === 'build.json'));
  for (const item of got) replaceFile(path.resolve(ROOT, item.rel), item.buf);
  return { ok: true, version: remote.version };
}

const server = http.createServer(async (req, res) => {
  // Refuse anything not addressed to us (blocks DNS rebinding from web pages).
  if (!allowedHosts.has(req.headers.host)) return sendJson(res, 403, { error: 'Bad host' });
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  if (!p.startsWith('/api/')) return serveStatic(res, p);
  // Custom header forces a CORS preflight that we never answer, so other sites can't call the API.
  // A video element cannot set that header. One file GET may instead carry a short-lived ticket
  // minted by a request that did. The ticket is bound to that hash.
  const fileMatch = req.method === 'GET' ? /^\/api\/library\/([a-f0-9]{64})\/file$/.exec(p) : null;
  const ticketOk = !!(fileMatch && previewTicketOk(url.searchParams.get('ticket'), fileMatch[1]));
  if (req.headers['x-panel'] !== '1' && !ticketOk) return sendJson(res, 403, { error: 'Missing X-Panel header' });

  try {
    let m;
    if (p === '/api/update' && req.method === 'GET') return sendJson(res, 200, await updateStatus());
    if (p === '/api/update' && req.method === 'POST') {
      if (updateBusy) return sendJson(res, 409, { error: 'An update is already running.' });
      updateBusy = true;
      try { return sendJson(res, 200, await applyUpdate()); }
      catch (err) { return sendJson(res, err.status || 502, { error: err.message || 'Update failed' }); }
      finally { updateBusy = false; }
    }
    if (p === '/api/config' && req.method === 'GET') {
      const k = config.apiKey;
      return sendJson(res, 200, { hasKey: !!k, keyHint: k ? k.slice(0, 3) + '…' + k.slice(-4) : '', expiry: config.expiry, favorites: config.favorites, rateLimit: commandLimit(), uploadHost: config.uploadHost === 'catbox' ? 'catbox' : 'pone', pomfCodes: cleanCodes(config.pomfCodes) });
    }
    if (p === '/api/config' && req.method === 'POST') {
      const b = await readBody(req);
      if (typeof b.apiKey === 'string') config.apiKey = b.apiKey.trim();
      if (b.expiry in EXPIRY_MS) config.expiry = b.expiry;
      if (b.uploadHost === 'pone' || b.uploadHost === 'catbox') config.uploadHost = b.uploadHost;
      if (Number(b.rateLimit) >= 1) config.rateLimit = Math.min(CTRL_EM_COMMAND_LIMIT, Math.round(Number(b.rateLimit)));
      if (Array.isArray(b.favorites)) config.favorites = b.favorites.filter(f => f && CODE.test(f.code)).map(f => ({ code: f.code.toUpperCase(), name: String(f.name || '').slice(0, 60) }));
      if (Array.isArray(b.pomfCodes)) config.pomfCodes = cleanCodes(b.pomfCodes);
      saveConfig();
      return sendJson(res, 200, { ok: true });
    }
    if (p === '/api/users' && req.method === 'GET') return ctrlem(res, 'GET', '/users');
    if ((m = p.match(/^\/api\/users\/([^/]+)(\/enabled-commands)?$/)) && req.method === 'GET') {
      if (!CODE.test(m[1])) return sendJson(res, 400, { error: 'Bad control code' });
      return ctrlem(res, 'GET', `/users/${encodeURIComponent(m[1].toUpperCase())}${m[2] || ''}`);
    }
    if (p === '/api/command' && req.method === 'POST') {
      const b = await readBody(req);
      const command = String(b.command || '');
      if (command === 'screenshot' || command === 'webcamCapture') {
        return sendJson(res, 400, { error: 'Screenshots and webcam are not available through the API.' });
      }
      const spec = COMMANDS[command];
      if (!spec) return sendJson(res, 400, { error: 'Unknown command' });
      const body = { target: String(b.target || '').toUpperCase(), command };
      if (!CODE.test(body.target)) return sendJson(res, 400, { error: 'Bad control code' });
      if (spec.arg) {
        const argument = b.argument == null ? '' : String(b.argument).trim();
        if (!argument) {
          if (!spec.optional) return sendJson(res, 400, { error: 'This command needs a value' });
        } else {
          if (spec.max && argument.length > spec.max) return sendJson(res, 400, { error: 'Text is limited to ' + spec.max + ' characters' });
          if (spec.arg === 'url' && !isHttpUrl(argument)) return sendJson(res, 400, { error: 'The link needs to start with http:// or https://' });
          body.argument = argument;
        }
      }
      if (spec.count && b.count != null) body.count = Math.max(1, Math.min(5, Math.round(Number(b.count)) || 1));
      if (b.targetDevice === 'DESKTOP' || b.targetDevice === 'ANDROID') body.targetDevice = b.targetDevice;
      const status = await ctrlem(res, 'POST', '/command', body);
      if (status >= 200 && status < 300) sentTimes.push(Date.now());
      return;
    }
    if (p === '/api/rate' && req.method === 'GET') return sendJson(res, 200, rateNow());
    if (p === '/api/upload' && req.method === 'POST') return handleUpload(req, res, url);
    if (p === '/api/mirror' && req.method === 'POST') {
      const b = await readBody(req);
      const raw = String(b.url || '').trim();
      if (!isHttpUrl(raw) || raw.length > 2000) return sendJson(res, 400, { error: 'That link needs to start with http:// or https://' });
      const ac = new AbortController();
      const stop = () => ac.abort();
      req.on('aborted', stop);
      res.on('close', () => { if (!res.writableEnded) stop(); });
      try {
        const pomfUrl = await mirrorToPomf(raw, b.name, ac.signal);
        if (res.writableEnded || ac.signal.aborted) return;
        return sendJson(res, 200, { pomfUrl });
      } catch (err) {
        if (res.writableEnded || ac.signal.aborted) return;
        return sendJson(res, 400, { error: err.message || 'Pomf copy failed' });
      }
    }
    if ((m = p.match(/^\/api\/jobs\/([a-f0-9]+)$/)) && req.method === 'GET') {
      const j = jobs.get(m[1]);
      return j ? sendJson(res, 200, publicJob(j)) : sendJson(res, 404, { error: 'Unknown job' });
    }
    if (p === '/api/library/link' && req.method === 'POST') {
      const b = await readBody(req);
      const raw = String(b.url || '').trim();
      if (!isHttpUrl(raw) || raw.length > 2000) return sendJson(res, 400, { error: 'That link needs to start with http:// or https://' });
      let filename = 'link';
      try {
        const last = decodeURIComponent(new URL(raw).pathname.split('/').filter(Boolean).pop() || '');
        if (last) filename = last.slice(0, 80);
      } catch { /* keep the fallback name */ }
      const name = String(b.name || '').trim().slice(0, 80) || filename;
      const given = String(b.kind || '');
      const kind = given === 'image' || given === 'video' || given === 'audio' ? given : kindOf('', filename);
      if (kind !== 'image' && kind !== 'video' && kind !== 'audio') return sendJson(res, 400, { error: 'This link needs to be an image, video, or sound.' });
      const albumId = String(b.album || '');
      if (albumId && !albums.some(a => a.id === albumId)) return sendJson(res, 404, { error: 'No album with that id' });
      const digest = crypto.createHash('sha256').update(raw).digest('hex');
      if (!library[digest]) {
        library[digest] = { hash: digest, url: raw, name, type: '', kind, size: 0, uploadedAt: Date.now(), expiresAt: null };
        saveLibrary();
      }
      if (albumId) rememberInAlbum(albumId, digest);
      return sendJson(res, 200, library[digest]);
    }
    if (p === '/api/library' && req.method === 'GET') {
      pruneLibrary();
      return sendJson(res, 200, Object.values(library).sort((a, b) => b.uploadedAt - a.uploadedAt).map(libraryView));
    }
    if ((m = p.match(/^\/api\/library\/([a-f0-9]{64})\/thumb$/)) && req.method === 'GET') {
      if (!library[m[1]] || !thumbReady(m[1])) return sendJson(res, 404, { error: 'No preview yet' });
      let data;
      try { data = fs.readFileSync(thumbFile(m[1])); }
      catch {
        // Removed outside the panel. Forget it so the page makes a new one.
        thumbHashes.delete(m[1]);
        return sendJson(res, 404, { error: 'No preview yet' });
      }
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
      res.end(data);
      return;
    }
    if ((m = p.match(/^\/api\/library\/([a-f0-9]{64})\/thumb$/)) && req.method === 'POST') {
      const entry = library[m[1]];
      if (!entry || (entry.kind !== 'image' && entry.kind !== 'video')) return sendJson(res, 404, { error: 'That file is not in the list' });
      let buf;
      try { buf = await readRaw(req, THUMB_BYTES); }
      catch { return sendJson(res, 413, { error: 'That preview is too large' }); }
      if (buf.length < 32 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) {
        return sendJson(res, 400, { error: 'Preview has to be a JPEG' });
      }
      const dest = thumbFile(m[1]);
      const tmp = dest + '.tmp';
      fs.mkdirSync(THUMBS_DIR, { recursive: true });
      fs.writeFileSync(tmp, buf);
      fs.rmSync(dest, { force: true });
      fs.renameSync(tmp, dest);
      thumbHashes.add(m[1]);
      return sendJson(res, 200, { ok: true });
    }
    if ((m = p.match(/^\/api\/library\/([a-f0-9]{64})\/ticket$/)) && req.method === 'POST') {
      const entry = library[m[1]];
      if (!entry || entry.kind !== 'video' || !isHttpUrl(entry.url)) return sendJson(res, 404, { error: 'That file is not in the list' });
      return sendJson(res, 200, { ticket: issuePreviewTicket(m[1]) });
    }
    if ((m = p.match(/^\/api\/library\/([a-f0-9]{64})\/file$/)) && req.method === 'GET') {
      await serveLibraryFile(req, res, library[m[1]]);
      return;
    }
    if ((m = p.match(/^\/api\/library\/([a-f0-9]{64})$/)) && req.method === 'DELETE') {
      delete library[m[1]]; saveLibrary();
      forgetHash(m[1]);
      removeThumb(m[1]);
      return sendJson(res, 200, { ok: true });
    }
    if ((m = p.match(/^\/api\/library\/([a-f0-9]{64})$/)) && req.method === 'POST') {
      const entry = library[m[1]];
      if (!entry) return sendJson(res, 404, { error: 'That file is not in the list' });
      const b = await readBody(req);
      if (!b || typeof b.name !== 'string') return sendJson(res, 400, { error: 'Name the file' });
      const name = cleanEntryName(b.name);
      if (!name) return sendJson(res, 400, { error: 'Name the file' });
      entry.name = name;
      saveLibrary();
      return sendJson(res, 200, entry);
    }
    if (p === '/api/albums' && req.method === 'GET') return sendJson(res, 200, publicAlbums());
    if (p === '/api/albums' && req.method === 'POST') {
      const b = await readBody(req);
      const name = String(b.name || '').trim().slice(0, 60);
      if (!name) return sendJson(res, 400, { error: 'Name the album' });
      const album = { id: crypto.randomBytes(8).toString('hex'), name, hashes: [] };
      albums.push(album);
      saveAlbums();
      return sendJson(res, 200, { id: album.id, name: album.name, count: 0 });
    }
    if ((m = p.match(/^\/api\/albums\/([a-f0-9]{16})$/)) && req.method === 'DELETE') {
      albums = albums.filter(a => a.id !== m[1]);
      saveAlbums();
      return sendJson(res, 200, { ok: true });
    }
    if ((m = p.match(/^\/api\/albums\/([a-f0-9]{16})\/files$/)) && req.method === 'POST') {
      const b = await readBody(req);
      const hash = String(b.hash || '');
      if (!/^[a-f0-9]{64}$/.test(hash) || !library[hash]) return sendJson(res, 400, { error: 'That file is not in the list' });
      rememberInAlbum(m[1], hash);
      const album = albums.find(a => a.id === m[1]);
      if (!album) return sendJson(res, 404, { error: 'No album with that id' });
      return sendJson(res, 200, { id: album.id, name: album.name, count: album.hashes.length });
    }
    if ((m = p.match(/^\/api\/albums\/([a-f0-9]{16})\/files\/([a-f0-9]{64})$/)) && req.method === 'DELETE') {
      const album = albums.find(a => a.id === m[1]);
      if (!album) return sendJson(res, 404, { error: 'No album with that id' });
      album.hashes = album.hashes.filter(h => h !== m[2]);
      saveAlbums();
      return sendJson(res, 200, { ok: true });
    }
    if (p === '/api/sequences' && req.method === 'GET') {
      return sendJson(res, 200, sequences);
    }
    if (p === '/api/sequences' && req.method === 'POST') {
      const seq = cleanSequence(await readBody(req, 4 * 1024 * 1024));
      const at = sequences.findIndex(s => s.id === seq.id);
      if (at >= 0) sequences[at] = seq; else sequences.push(seq);
      sequences.sort((a, b) => b.updatedAt - a.updatedAt);
      saveSequences();
      return sendJson(res, 200, seq);
    }
    if ((m = p.match(/^\/api\/sequences\/([a-f0-9]{8,32})$/)) && req.method === 'DELETE') {
      sequences = sequences.filter(s => s.id !== m[1]);
      saveSequences();
      return sendJson(res, 200, { ok: true });
    }
    sendJson(res, 404, { error: 'Unknown endpoint' });
  } catch (err) {
    if (!res.headersSent) sendJson(res, 400, { error: err.message });
  }
});

server.requestTimeout = 0; // big uploads from the browser can take a while
if (require.main === module) {
  server.on('error', err => {
    if (err.code === 'EADDRINUSE') {
      console.log(`Port ${PORT} is busy - the panel is probably already running. Opening it.`);
      exec(`start "" "http://127.0.0.1:${PORT}/"`);
      process.exit(0);
    }
    console.error(err);
    process.exit(1);
  });
  // Ctrl+C, and closing the console window (SIGHUP on Windows), end through exit, so the
  // 'exit' handler writes any save that was still waiting.
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) process.on(sig, () => process.exit(0));
  server.listen(PORT, HOST, () => {
    const link = `http://127.0.0.1:${PORT}/`;
    console.log(`CtrlEm Panel running at ${link}  (Ctrl+C to stop)`);
    if (!process.argv.includes('--no-open')) exec(`start "" "${link}"`);
  });
}

module.exports = { updatePathOk, parseBuild, buildMessage, verifyBuild, previewRange, previewTicketOk, issuePreviewTicket, pipeRemote };
