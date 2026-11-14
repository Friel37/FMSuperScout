// FMSuperScout — lokale server (geen dependencies nodig)
// Serveert de web-app en de meest recente data-dump van de BepInEx-plugin.
'use strict';

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFile } = require('child_process');

const PORT = Number(process.env.PORT) || 8765;
const APP_DIR = __dirname;
// De plugin schrijft dumps hierheen. Zelfde bron als de plugin (%LOCALAPPDATA%): bij een
// verplaatst/redirected profiel wijkt homedir+AppData af en keken app en plugin naar
// verschillende mappen ("F9 werkt, app blijft leeg").
const DATA_DIR = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'FMSuperScout', 'FM27');

// App-modus (standalone venster): server sluit zichzelf af zodra het venster dicht is.
// Het sluiten van het venster wordt betrouwbaar gemeld via /api/bye (pagehide-beacon).
// De heartbeat is alleen een vangnet als dat beacon niet aankwam. De drempel staat ruim
// (90s): browsers knijpen timers in een achtergrondvenster af tot ~1×/min, en een te
// strakke drempel liet de server dan tijdens het spelen sneuvelen → "Nieuwe data" gaf
// daarna een fout omdat de server weg was. Elke API-aanvraag telt ook als teken van leven.
const APP_MODE = process.env.FMSS_APP === '1';
let lastBeat = Date.now();
let pendingExit = null;
if (APP_MODE) {
  setInterval(() => {
    if (Date.now() - lastBeat > 90000) { console.log('Venster gesloten (geen heartbeat), server stopt.'); process.exit(0); }
  }, 5000);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

// ---------- zelf-update ----------
// POST /api/update-install downloadt de nieuwste Setup.exe uit onze GitHub-release,
// verifieert de SHA-256 tegen het .sha256-asset uit dezelfde release en start dan de
// installer. Daarna stopt de server zichzelf, zodat de installer node.exe en de
// app-bestanden kan vervangen. GET /api/update-status geeft de voortgang aan de pagina.
let updState = { phase: 'idle' };

function httpsGet(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'FMSuperScout-updater' }, timeout: 30000 }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        resolve(httpsGet(res.headers.location, redirects - 1));
      } else if (res.statusCode !== 200) {
        res.resume(); reject(new Error('HTTP ' + res.statusCode));
      } else resolve(res);
    }).on('error', reject);
    // Zonder time-out blijft de update-pill eeuwig op "downloaden" hangen bij een
    // stille verbinding; nu valt hij netjes terug op de releasepagina-link.
    req.on('timeout', () => req.destroy(new Error('netwerk-time-out')));
  });
}
async function readAll(res) { const chunks = []; for await (const c of res) chunks.push(c); return Buffer.concat(chunks); }

async function runUpdate() {
  updState = { phase: 'downloading', pct: 0 };
  const rel = JSON.parse((await readAll(await httpsGet('https://api.github.com/repos/mavarobli/FMSuperScout/releases/latest'))).toString('utf8'));
  const exeAsset = (rel.assets || []).find(a => a.name === 'FMSuperScout-Setup.exe');
  const shaAsset = (rel.assets || []).find(a => a.name === 'FMSuperScout-Setup.exe.sha256');
  // Zonder hash-asset niet installeren: de hash-check is de enige integriteitscontrole.
  if (!exeAsset || !shaAsset) throw new Error('Release-assets onvolledig (exe of .sha256 ontbreekt)');

  const dir = path.join(DATA_DIR, 'update');
  fs.mkdirSync(dir, { recursive: true });
  const exePath = path.join(dir, 'FMSuperScout-Setup.exe');
  const res = await httpsGet(exeAsset.browser_download_url);
  const total = Number(res.headers['content-length']) || exeAsset.size || 0;
  const hash = crypto.createHash('sha256');
  let got = 0;
  const out = fs.createWriteStream(exePath);
  await new Promise((resolve, reject) => {
    res.on('data', c => {
      got += c.length; hash.update(c);
      if (total) updState = { phase: 'downloading', pct: Math.min(99, Math.round(100 * got / total)) };
    });
    res.pipe(out);
    out.on('finish', resolve);
    res.on('error', reject); out.on('error', reject);
  });

  updState = { phase: 'verifying' };
  const expect = (await readAll(await httpsGet(shaAsset.browser_download_url))).toString('utf8').trim().split(/\s+/)[0].toLowerCase();
  if (hash.digest('hex') !== expect) {
    try { fs.unlinkSync(exePath); } catch { }
    throw new Error('SHA-256 komt niet overeen, download verwijderd');
  }

  updState = { phase: 'launching' };
  // 'spawn'-event afwachten: pas als Windows het proces echt gestart heeft mag de
  // server zichzelf afsluiten. Een spawn-fout (SmartScreen-block, ontbrekend bestand)
  // wordt zo een nette foutstatus in plaats van een app die zomaar verdwijnt.
  await new Promise((resolve, reject) => {
    const child = spawn(exePath, [], { detached: true, stdio: 'ignore' });
    child.once('spawn', () => { child.unref(); resolve(); });
    child.once('error', reject);
  });
  // Korte adempauze zodat de pagina de eindstatus nog kan ophalen, dan vrij baan
  // voor de installer (die node.exe moet kunnen vervangen).
  setTimeout(() => { console.log('Installer gestart, server stopt voor de update.'); process.exit(0); }, 1500);
}

// ---------- ontwikkel-historie (trends) ----------
// De app stuurt na elke geladen dump een compacte momentopname (uid → [ca, pa, waarde, attributen]).
// Opslag is delta-only: het eerste punt per speler is de basislijn; daarna komt er alleen
// een punt bij als CA, PA of een attribuut veranderd is, of de waarde meer dan 2,5% verschoven is (FM
// herberekent waardes voortdurend een beetje — dat geruis slaan we bewust niet op).
// Een oudere in-game datum dan de laatste (save teruggeladen) gooit de "toekomst" weg.
// Bestand per manager (carrière) in DATA_DIR\history; datums yyyy-mm-dd sorteren als tekst.
const HIST_DIR = path.join(DATA_DIR, 'history');
const HIST_MAX_DATES = 120;   // ~2+ seizoenen wekelijks dumpen; daarboven oudste samenvouwen
let histCache = null, histCacheFile = null;

function histSlug(manager) {
  const s = String(manager || 'default').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return (s || 'default').slice(0, 60);
}
function histFile(manager) { return path.join(HIST_DIR, histSlug(manager) + '.json'); }
function loadHist(manager) {
  const file = histFile(manager);
  if (histCacheFile === file && histCache) return histCache;
  let h = { manager: String(manager || 'default'), dates: [], players: {} };
  try { h = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* nog geen historie */ }
  histCache = h; histCacheFile = file;
  return h;
}
// Laatst bekende [ca,pa,waarde] van een speler, in datumvolgorde.
function histLastPoint(entries, dates) {
  for (let i = dates.length - 1; i >= 0; i--) { const e = entries[dates[i]]; if (e) return e; }
  return null;
}
// Attributen: h.attrKeys legt de sleutelvolgorde vast. Een punt kan als vierde element een
// platte lijst [sleutelindex, waarde, ...] dragen met alleen de attributen die sinds het
// vorige punt veranderd zijn; het eerste punt met attributen bevat ze allemaal (basislijn).
// De stand op een datum is dus alle lijsten tot en met die datum over elkaar gelegd.
function foldAttrs(acc, flat) {
  for (let i = 0; i < flat.length; i += 2) acc[flat[i]] = flat[i + 1];
  return acc;
}
function histAttrState(entries, dates) {
  const acc = {};
  for (const d of dates) { const e = entries[d]; if (e && e[3]) foldAttrs(acc, e[3]); }
  return acc;
}
function mergeSnapshot(manager, gameDate, players, attrKeys) {
  const h = loadHist(manager);
  if (!h.attrKeys) h.attrKeys = [];
  const keyIdx = new Map(h.attrKeys.map((k, i) => [k, i]));
  // Sleutelvolgorde van de app vertalen naar de vaste volgorde in het bestand.
  const colIdx = (attrKeys || []).map(k => {
    if (!keyIdx.has(k)) { keyIdx.set(k, h.attrKeys.length); h.attrKeys.push(k); }
    return keyIdx.get(k);
  });

  // Rewind of her-dump op dezelfde datum: alle punten vanaf die datum vervallen.
  if (h.dates.length && h.dates[h.dates.length - 1] >= gameDate) {
    const drop = new Set(h.dates.filter(d => d >= gameDate));
    h.dates = h.dates.filter(d => d < gameDate);
    for (const uid of Object.keys(h.players)) {
      const e = h.players[uid];
      for (const d of drop) delete e[d];
      if (!Object.keys(e).length) delete h.players[uid];
    }
  }

  let added = 0;
  for (const uid in players) {
    const [ca, pa, val, av] = players[uid];
    const entries = h.players[uid];
    const prev = entries ? histLastPoint(entries, h.dates) : null;
    const valJump = prev ? Math.abs((val ?? 0) - (prev[2] ?? 0)) > Math.max(10000, (prev[2] ?? 0) * 0.025) : true;
    let diff = null;
    if (Array.isArray(av)) {
      const cur = entries ? histAttrState(entries, h.dates) : {};
      diff = [];
      for (let j = 0; j < av.length && j < colIdx.length; j++) {
        const v = av[j];
        if (typeof v === 'number' && cur[colIdx[j]] !== v) diff.push(colIdx[j], v);
      }
      if (!diff.length) diff = null;
    }
    if (prev && prev[0] === ca && prev[1] === pa && !valJump && !diff) continue;
    (h.players[uid] || (h.players[uid] = {}))[gameDate] = diff ? [ca, pa, val, diff] : [ca, pa, val];
    added++;
  }
  h.dates.push(gameDate);

  // Snoeien: oudste datums samenvouwen tot een nieuwe basislijn zodat het bestand
  // begrensd blijft. Per speler blijft zijn laatst bekende stand vóór de zaaglijn
  // bewaard als basispunt, dus geen reeks raakt zijn startwaarde kwijt.
  if (h.dates.length > HIST_MAX_DATES) {
    const cut = h.dates.length - HIST_MAX_DATES;
    const dropped = h.dates.slice(0, cut), newBase = h.dates[cut];
    for (const uid of Object.keys(h.players)) {
      const e = h.players[uid];
      // Attribuutlijsten van de weggevallen datums samenvouwen in het basispunt, anders
      // verliest de reeks attributen die sindsdien niet meer veranderd zijn.
      let base = null;
      const acc = {};
      for (const d of dropped) if (e[d]) { base = e[d]; if (base[3]) foldAttrs(acc, base[3]); delete e[d]; }
      if (base) {
        const nb = e[newBase];
        if (nb && nb[3]) foldAttrs(acc, nb[3]);
        const pt = (nb || base).slice(0, 3);
        const flat = Object.keys(acc).flatMap(i => [+i, acc[i]]);
        if (flat.length) pt.push(flat);
        e[newBase] = pt;
      }
      if (!Object.keys(e).length) delete h.players[uid];
    }
    h.dates = h.dates.slice(cut);
  }

  // Atomair wegschrijven: eerst .tmp, dan hernoemen — een crash halverwege laat de
  // bestaande historie intact in plaats van een half JSON-bestand achter.
  fs.mkdirSync(HIST_DIR, { recursive: true });
  const file = histFile(manager);
  fs.writeFileSync(file + '.tmp', JSON.stringify(h));
  fs.renameSync(file + '.tmp', file);
  histCache = h; histCacheFile = file;
  return { ok: true, dates: h.dates.length, added };
}

// Request-body inlezen (JSON), met limiet: een mega-save-snapshot is ~10 MB.
function readBody(req, limit = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('te groot')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function latestDump() {
  try {
    const files = fs.readdirSync(DATA_DIR)
      .filter(f => f.startsWith('dump') && f.endsWith('.json'))
      .map(f => {
        const full = path.join(DATA_DIR, f);
        const st = fs.statSync(full);
        return { full, mtime: st.mtimeMs, size: st.size };
      })
      .sort((a, b) => b.mtime - a.mtime);
    return files[0] || null;
  } catch {
    return null;
  }
}

// Installatiestaat van de mod-laag. De installer legt de gamemap vast in het register;
// zonder die sleutel (draaien vanuit de broncode, of handmatig geinstalleerd) weten we
// niets en zeggen we dat ook, zodat de app geen onzin toont.
//
// Waarom interop: BepInEx genereert die map tijdens de eerste FM-start na installatie,
// een minuut of drie achter een zwart consolevenster. Precies in dat venster denken
// mensen dat het spel vastloopt, en dat is de melding die we eerder kregen.
// ---------- shortlist naar FM27 ----------
// Schrijft een .fmf direct in de shortlistmap van FM27 (In FM: Shortlist → Laden).
// Documenten kan omgeleid zijn (OneDrive), dus de echte map komt uit het register.
const fmf = require('./fmf');
let shortlistDirCache = null;
function shortlistDir(cb) {
  if (process.env.FMSS_SHORTLIST_DIR) return cb(process.env.FMSS_SHORTLIST_DIR);
  if (shortlistDirCache) return cb(shortlistDirCache);
  execFile('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders', '/v', 'Personal'],
    { windowsHide: true, timeout: 5000 }, (err, out) => {
      const m = !err && String(out).match(/Personal\s+REG_(?:EXPAND_)?SZ\s+(.+)/);
      const docs = m ? m[1].trim().replace(/%([^%]+)%/g, (s, v) => process.env[v] ?? s) : path.join(os.homedir(), 'Documents');
      shortlistDirCache = path.join(docs, 'Sports Interactive', 'Football Manager 27', 'shortlists');
      cb(shortlistDirCache);
    });
}
// Een bestaande, door FM zelf opgeslagen player-shortlist levert de versiebytes en de
// FM-gebruikersnaam; zonder zo'n bestand valt fmf.js terug op het ingebouwde sjabloon.
function shortlistTemplate(dir) {
  let files = [];
  try {
    files = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.fmf'))
      .map(f => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
  } catch { return undefined; }
  for (const { f } of files) {
    try { return fmf.readShortlist(fs.readFileSync(path.join(dir, f))).template; } catch { }
  }
  return undefined;
}
function sanitizeListName(s) {
  return String(s || '').replace(/[\x00-\x1f<>:"/\\|?*]/g, '').trim().replace(/^[. ]+|[. ]+$/g, '').slice(0, 60);
}
function exportShortlistFmf(body, cb) {
  const name = sanitizeListName(body.name);
  const ids = Array.isArray(body.ids) ? [...new Set(body.ids)] : [];
  if (!name) return cb(400, { ok: false, error: 'name' });
  if (!ids.length || !ids.every(v => Number.isInteger(v) && v >= 0 && v <= 0xFFFFFFFF)) return cb(400, { ok: false, error: 'ids' });
  shortlistDir(dir => {
    const file = path.join(dir, name + '.fmf');
    try {
      if (!body.overwrite && fs.existsSync(file)) return cb(409, { ok: false, error: 'exists', file });
      fs.mkdirSync(dir, { recursive: true });
      const buf = fmf.buildShortlist(name, ids, shortlistTemplate(dir));
      fs.writeFileSync(file + '.tmp', buf);
      fs.renameSync(file + '.tmp', file);
      cb(200, { ok: true, file, count: ids.length });
    } catch (e) { cb(500, { ok: false, error: String(e.message || e) }); }
  });
}

const {createReader} = require('./reader-process');
const reader = createReader(path.join(__dirname, '..', 'dist', 'reader', 'FMSuperScout.Reader.exe'), DATA_DIR);
function checkSetup(cb) { reader.probe(cb); }

const server = http.createServer((req, res) => {
  // DNS-rebinding-bescherming: alleen echte localhost-hosts accepteren. Een kwaadaardige
  // website kan zijn domein naar 127.0.0.1 laten wijzen en wordt dan same-origin met deze
  // server; met een gepinde Host-header (dé standaardremedie) ketst dat af op een 403.
  const host = String(req.headers.host || '').toLowerCase();
  if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) {
    res.writeHead(403); res.end('Forbidden');
    return;
  }
  // Cross-site-bescherming bovenop de Host-check: een externe website die met fetch()
  // naar localhost praat stuurt zijn eigen Origin mee — alles wat niet van onze eigen
  // pagina komt (geen Origin = same-origin navigatie, of een localhost-Origin) ketst af.
  // Zonder dit kon een kwaadwillende site een update-install of dump triggeren.
  const origin = String(req.headers.origin || '').toLowerCase();
  if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    res.writeHead(403); res.end('Forbidden');
    return;
  }
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (['/api/version-check','/api/update-install','/api/update-status'].includes(url.pathname)) {
    res.writeHead(410, {'Content-Type':'application/json'});res.end(JSON.stringify({error:'Automatic updates are disabled for this local FM27 build.'}));return;
  }
  // Elke aanvraag is een teken dat het venster nog leeft (naast de expliciete heartbeat),
  // behalve het afscheidsbeacon zelf.
  if (url.pathname !== '/api/bye') lastBeat = Date.now();

  if (url.pathname === '/api/status') {
    const dump = latestDump();
    let plugin = null;
    try {
      const sf = path.join(DATA_DIR, 'status.json');
      if (fs.existsSync(sf)) {
        plugin = JSON.parse(fs.readFileSync(sf, 'utf8'));
        plugin.mtime = fs.statSync(sf).mtimeMs;
      }
    } catch { /* geen status */ }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      dataDir: DATA_DIR,
      hasDump: !!dump,
      dumpFile: dump ? path.basename(dump.full) : null,
      dumpTime: dump ? dump.mtime : null,
      dumpSize: dump ? dump.size : null,   // uit latestDump: geen losse stat die kan racen met een F9-herschrijf
      appMode: APP_MODE,
      reader: plugin,
      plugin, // compatibility alias for existing clients
    }));
    return;
  }

  if (url.pathname === '/api/scan-config') {
    // Scan-instellingen (nu: vrouwenvoetbal meenemen). De app schrijft, de plugin leest
    // dit bestand bij elke F9; localStorage zou de game nooit bereiken.
    const cf = path.join(DATA_DIR, 'scan-config.json');
    if (req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; if (body.length > 1024) req.destroy(); });
      req.on('end', () => {
        try {
          const inp = JSON.parse(body || '{}');
          const db = ['men', 'women', 'both'].includes(inp.db) ? inp.db : 'men';
          fs.writeFileSync(cf, JSON.stringify({ db }));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ db }));
        } catch { res.writeHead(400); res.end(); }
      });
      return;
    }
    let db = 'men';
    try {
      const raw = fs.readFileSync(cf, 'utf8');
      const m = raw.match(/"db":"(men|women|both)"/);
      // Oud schema (kort in omloop geweest): includeWomen:true betekende "beide".
      db = m ? m[1] : (raw.includes('"includeWomen":true') ? 'both' : 'men');
    } catch { }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ db }));
    return;
  }

  if (url.pathname === '/api/version-check') {
    // Update-check via het version.json-asset van de laatste release, server-side (de
    // asset-CDN staat geen browser-CORS toe). Functioneel gelijk aan de API-call, maar
    // asset-downloads hebben een publieke download-teller: checks per dag zijn zo
    // anoniem af te lezen als maat voor actieve installaties. Geen asset (oudere
    // release) of netwerkfout? 404, en de app valt terug op de gewone API-call.
    (async () => {
      try {
        const buf = await readAll(await httpsGet('https://github.com/mavarobli/FMSuperScout/releases/latest/download/version.json'));
        const tag = String(JSON.parse(buf.toString('utf8')).tag || '');
        if (!/^v\d/.test(tag)) throw new Error('geen tag in version.json');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ tag }));
      } catch { res.writeHead(404); res.end(); }
    })();
    return;
  }

  if (url.pathname === '/api/diagnostics') {
    // diagnostics.txt van de plugin, voor het voorgevulde GitHub-issue: de kopregels
    // (leesbron, geheugen, fase-timing) maken een rapport zelfvoorzienend — gebruikers
    // vergeten het bestand zelf vaak bij te voegen.
    try {
      const txt = fs.readFileSync(path.join(DATA_DIR, 'diagnostics.txt'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(txt);
    } catch { res.writeHead(404); res.end(); }
    return;
  }

  if (url.pathname === '/api/heartbeat') {
    lastBeat = Date.now();
    if (pendingExit) { clearTimeout(pendingExit); pendingExit = null; }   // herladen: toch openhouden
    res.writeHead(204); res.end();
    return;
  }

  if (url.pathname === '/api/bye' && req.method === 'POST') {   // sendBeacon = POST; GET mag de server nooit stoppen
    res.writeHead(204); res.end();
    // Venster dicht: stop, tenzij binnen 2,5s een nieuwe heartbeat komt (bij herladen).
    if (APP_MODE && !pendingExit) pendingExit = setTimeout(() => process.exit(0), 2500);
    return;
  }

  if (url.pathname === '/api/fmstatus') {   // zie checkSetup hieronder voor de installatiestaat
    reader.probe(result => {res.writeHead(200, {'Content-Type':'application/json'});res.end(JSON.stringify(result));});
    return;
  }

  if (url.pathname === '/api/setup') {
    // Staat de mod-laag klaar? BepInEx maakt zijn interop-map pas aan tijdens de eerste
    // start van FM na installatie, en dat duurt 1-3 minuten achter een zwart consolevenster.
    // Zolang die map er niet is, heeft "druk op F9" geen zin en is een andere uitleg nodig.
    checkSetup(s => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(s));
    });
    return;
  }

  if (url.pathname === '/api/refresh' && req.method === 'POST') {
    let result;
    try { result = reader.refresh(); } catch(e) { result={code:500,ok:false,error:e.message}; }
    res.writeHead(result.code, {'Content-Type':'application/json'});
    res.end(JSON.stringify(result));
    return;
  }

  if (url.pathname === '/api/history' && req.method === 'POST') {
    readBody(req).then(buf => {
      const { manager, gameDate, players, attrKeys } = JSON.parse(buf.toString('utf8'));
      if (!gameDate || !players) throw new Error('gameDate/players ontbreekt');
      const r = mergeSnapshot(manager, String(gameDate), players, Array.isArray(attrKeys) ? attrKeys : null);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r));
    }).catch(e => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
    });
    return;
  }

  if (url.pathname === '/api/shortlist-fmf' && req.method === 'POST') {
    readBody(req, 1024 * 1024).then(buf => {
      exportShortlistFmf(JSON.parse(buf.toString('utf8')), (code, r) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(r));
      });
    }).catch(e => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
    });
    return;
  }

  if (url.pathname === '/api/history/deltas') {
    // Bulk-variant van /series: per speler zijn stand op de peildatum plus de index van
    // zijn eerste waarneming. Daaruit haalt de app de groeikolom, het groeifilter en de
    // "nieuw sinds"-vraag zonder per speler een verzoek te doen (~1,3 MB op 59k spelers).
    const h = loadHist(url.searchParams.get('manager'));
    const since = String(url.searchParams.get('since') || '');
    const idx = new Map(h.dates.map((d, i) => [d, i]));
    const p = {};
    // Zonder peildatum alleen de datumlijst: de app heeft die nodig om "sinds de vorige
    // dump" te kunnen uitrekenen, en dat scheelt een payload van ruim een megabyte.
    if (!since) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ dates: h.dates, ref: null, p }));
      return;
    }
    for (const uid in h.players) {
      const e = h.players[uid];
      // Datums per speler zijn dun bezaaid; sorteren is goedkoper dan alle dates aflopen.
      const keys = Object.keys(e).sort();
      if (!keys.length) continue;
      let ref = null;
      for (const k of keys) { if (k > since) break; ref = e[k]; }
      p[uid] = ref ? [ref[0], ref[1], idx.get(keys[0]) ?? 0] : [null, null, idx.get(keys[0]) ?? 0];
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ dates: h.dates, ref: since, p }));
    return;
  }

  if (url.pathname === '/api/history/series') {
    const h = loadHist(url.searchParams.get('manager'));
    const uid = String(url.searchParams.get('uid') || '');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ dates: h.dates, attrKeys: h.attrKeys || [], entries: h.players[uid] || {} }));
    return;
  }

  if (url.pathname === '/api/update-install' && req.method === 'POST') {
    if (updState.phase === 'idle' || updState.phase === 'error')
      runUpdate().catch(e => { updState = { phase: 'error', error: String(e.message || e) }; });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (url.pathname === '/api/update-status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(updState));
    return;
  }

  if (url.pathname === '/api/dump') {
    const dump = latestDump();
    if (!dump) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Nog geen dump gevonden. Load your FM27 save and click New data.' }));
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Length': dump.size,
      'Cache-Control': 'no-store',
    });
    // Zonder error-handler is een leesfout (dump net vervangen/gelockt door de plugin) een
    // unhandled 'error'-event dat het hele proces killt. Afbreken; de app meldt dan zelf
    // een onvolledige dump en de volgende poging slaagt gewoon.
    const rs = fs.createReadStream(dump.full, { highWaterMark: 1 << 20 });
    rs.on('error', () => res.destroy());
    // De reader vervangt dump.json pas als er geen handle meer openstaat. Zonder dit
    // blijft een afgebroken of nog lopende load het bestand vasthouden en faalt
    // "Nieuwe data" met "Access to the path is denied."
    const release = () => { if (!rs.destroyed) rs.destroy(); };
    res.on('close', release);
    rs.pipe(res);
    return;
  }

  // Statische bestanden
  let file = url.pathname === '/' ? '/index.html' : url.pathname;
  file = path.normalize(file).replace(/^([.][.][\\/])+/, '');
  const full = path.join(APP_DIR, file);
  if (!full.startsWith(APP_DIR) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
    res.writeHead(404); res.end('Not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
  const sf = fs.createReadStream(full);
  sf.on('error', () => res.destroy());
  sf.pipe(res);
});

// Vangnet: één onverwachte synchrone fout in een request-handler (bestandsrace met de
// plugin, exotisch fs-gedrag) mag nooit de hele server meenemen — dat toonde zich in het
// veld als "Lost connection to the local server". Loggen en doordraaien.
process.on('uncaughtException', e => console.error('Onverwachte fout (server draait door):', e));

const URL_LOCAL = `http://localhost:${PORT}`;

// Open de app in een chromeless Edge-venster (app-modus); anders in de standaardbrowser.
function openApp() {
  const edge = [
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ].find(p => { try { return fs.existsSync(p); } catch { return false; } });
  try {
    if (edge) {
      const profile = path.join(DATA_DIR, 'window');
      spawn(edge, [`--app=${URL_LOCAL}`, `--user-data-dir=${profile}`, '--window-size=1440,900', '--no-first-run'],
        { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('cmd', ['/c', 'start', '""', URL_LOCAL], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch { /* browser openen mislukt: gebruiker kan handmatig naar de URL */ }
}

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    // Al een instantie actief: gewoon het venster (opnieuw) openen en afsluiten.
    if (APP_MODE) openApp();
    else console.error(`Poort ${PORT} is al in gebruik; open ${URL_LOCAL}`);
    process.exit(0);
  }
  throw err;
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`FMSuperScout draait op ${URL_LOCAL}`);
  console.log(`Data-map: ${DATA_DIR}`);
  if (APP_MODE) openApp();
});
