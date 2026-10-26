// Authenticated forward proxy (HTTP + HTTPS CONNECT) with an admin dashboard. No dependencies.
// Only allow-listed domains (default: LinkedIn) can be reached, so it can't be abused as an open proxy.
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const cfgPath = path.join(__dirname, 'config.json');
if (!fs.existsSync(cfgPath)) {
  console.error('Missing config.json. Copy config.example.json to config.json and edit it.');
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
cfg.host = cfg.host || '0.0.0.0';
cfg.port = cfg.port || 8899;
cfg.adminHost = cfg.adminHost || '127.0.0.1';
cfg.adminPort = cfg.adminPort || 8900;
cfg.allowedDomains = cfg.allowedDomains || ['linkedin.com', 'licdn.com'];
const { DEFAULTS: PERMISSION_DEFAULTS } = require('./rules');
cfg.readOnly = { ...PERMISSION_DEFAULTS, ...(cfg.readOnly || {}) }; // true = action is blocked (except "enabled")

const PLACEHOLDER = 'CHANGE_ME_TO_A_LONG_RANDOM_PASSWORD';
for (const k of ['username', 'password', 'adminPassword']) {
  if (!cfg[k] || cfg[k] === PLACEHOLDER) {
    console.error(`Set "${k}" to a real value in config.json.`);
    process.exit(1);
  }
}

function saveConfig() {
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
}

// ---------- state ----------
const startedAt = Date.now();
const stats = { total: 0, blocked: 0, authFailed: 0, bytesUp: 0, bytesDown: 0 };
const watchers = new Set(); // extensions currently streaming /__watch
const active = new Map(); // id -> {id, client, target, since, up, down}
const events = []; // ring buffer
let nextId = 1;

function log(level, msg) {
  events.unshift({ t: Date.now(), level, msg });
  if (events.length > 300) events.pop();
  console.log(new Date().toISOString(), level.toUpperCase(), msg);
}

// ---------- proxy ----------
function safeEq(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function isAuthed(req) {
  const h = req.headers['proxy-authorization'] || '';
  const expected = 'Basic ' + Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64');
  return safeEq(h, expected);
}

function isAllowedHost(hostname) {
  hostname = hostname.toLowerCase();
  return cfg.allowedDomains.some((d) => hostname === d || hostname.endsWith('.' + d));
}

const clientIp = (s) => (s.remoteAddress || '').replace('::ffff:', '');

// Timezone the extension should present to LinkedIn: configured override, else this PC's own.
function validTimeZone(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}
function effectiveTimeZone() {
  if (cfg.timezone && validTimeZone(cfg.timezone)) return cfg.timezone;
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

// Health endpoint for the browser extension: a long-lived response with a heartbeat every second.
// If the server dies or the network drops, the stream ends and the extension blocks LinkedIn at once.
function handleWatch(req, res) {
  const expected = 'Basic ' + Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64');
  if (!safeEq(req.headers.authorization || '', expected)) {
    stats.authFailed++;
    res.writeHead(401);
    return res.end();
  }
  if (req.url.startsWith('/__info')) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ timeZone: effectiveTimeZone() }));
  }
  if (req.url.startsWith('/__health')) { res.writeHead(200, { 'Cache-Control': 'no-store' }); return res.end('ok'); }
  res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
  res.write('ok\n');
  const w = { ip: clientIp(req.socket), since: Date.now() };
  watchers.add(w);
  log('info', `Extension connected (${w.ip})`);
  const beat = setInterval(() => res.write('.\n'), 1000);
  const recycle = setTimeout(() => res.end(), 240000); // extension reconnects immediately; keeps its worker alive
  const done = () => {
    clearInterval(beat); clearTimeout(recycle);
    if (watchers.delete(w)) log('info', `Extension disconnected (${w.ip})`);
  };
  req.on('close', done);
  res.on('close', done);
}

const proxy = http.createServer((req, res) => {
  if (req.url.startsWith('/__watch') || req.url.startsWith('/__health') || req.url.startsWith('/__info')) return handleWatch(req, res);
  const ip = clientIp(req.socket);
  if (!isAuthed(req)) {
    stats.authFailed++;
    log('warn', `Auth failed from ${ip}`);
    res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="proxy"' });
    return res.end();
  }
  let url;
  try { url = new URL(req.url); } catch { res.writeHead(400); return res.end(); }
  if (!isAllowedHost(url.hostname)) {
    stats.blocked++;
    log('warn', `Blocked ${url.hostname} (from ${ip})`);
    res.writeHead(403);
    return res.end('Domain not allowed');
  }
  stats.total++;
  const headers = { ...req.headers };
  delete headers['proxy-authorization'];
  delete headers['proxy-connection'];
  const up = http.request(
    { host: url.hostname, port: url.port || 80, method: req.method, path: url.pathname + url.search, headers },
    (ur) => { res.writeHead(ur.statusCode, ur.headers); ur.pipe(res); }
  );
  up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
  req.pipe(up);
});

proxy.on('connect', (req, clientSocket, head) => {
  const ip = clientIp(clientSocket);
  if (!isAuthed(req)) {
    stats.authFailed++;
    log('warn', `Auth failed from ${ip}`);
    clientSocket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="proxy"\r\n\r\n');
    return;
  }
  const [hostname, p] = req.url.split(':');
  const targetPort = parseInt(p, 10) || 443;
  if (!isAllowedHost(hostname) || targetPort !== 443) {
    stats.blocked++;
    log('warn', `Blocked ${req.url} (from ${ip})`);
    clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    return;
  }
  stats.total++;
  const conn = { id: nextId++, client: ip, target: hostname, since: Date.now(), up: 0, down: 0 };
  const upstream = net.connect(targetPort, hostname, () => {
    active.set(conn.id, conn);
    log('info', `Tunnel ${hostname} (from ${ip})`);
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head && head.length) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });
  clientSocket.on('data', (d) => { conn.up += d.length; stats.bytesUp += d.length; });
  upstream.on('data', (d) => { conn.down += d.length; stats.bytesDown += d.length; });
  let reason = 'closed';
  const close = () => {
    if (active.delete(conn.id)) {
      const secs = ((Date.now() - conn.since) / 1000).toFixed(1);
      const lvl = conn.down === 0 ? 'warn' : 'info';
      log(lvl, `Closed ${hostname} after ${secs}s (${reason}) up ${conn.up}B / down ${conn.down}B${conn.down === 0 ? ' - no data came back' : ''}`);
    }
    upstream.destroy(); clientSocket.destroy();
  };
  upstream.on('error', (e) => {
    reason = 'upstream error: ' + e.code;
    if (!active.has(conn.id)) log('warn', `Could not reach ${hostname}: ${e.code}`);
    close();
  });
  clientSocket.on('error', (e) => { reason = 'client error: ' + e.code; close(); });
  upstream.on('close', close);
  clientSocket.on('close', close);
});

proxy.listen(cfg.port, cfg.host, () => log('info', `Proxy listening on ${cfg.host}:${cfg.port}`));

// ---------- admin dashboard ----------
const sessions = new Set();
const loginFails = new Map(); // ip -> {n, until}
const publicDir = path.join(__dirname, 'public');

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve(null); } });
  });
}

function sessionToken(req) {
  const m = /(?:^|;\s*)sid=([a-f0-9]+)/.exec(req.headers.cookie || '');
  return m && sessions.has(m[1]) ? m[1] : null;
}

const admin = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const ip = clientIp(req.socket);

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return fs.createReadStream(path.join(publicDir, 'index.html')).pipe(res);
  }

  if (url.pathname === '/api/login' && req.method === 'POST') {
    const f = loginFails.get(ip) || { n: 0, until: 0 };
    if (Date.now() < f.until) return json(res, 429, { error: 'Too many attempts. Try again later.' });
    const body = await readBody(req);
    if (body && safeEq(body.password || '', cfg.adminPassword)) {
      loginFails.delete(ip);
      const tok = crypto.randomBytes(24).toString('hex');
      sessions.add(tok);
      res.setHeader('Set-Cookie', `sid=${tok}; HttpOnly; SameSite=Strict; Path=/`);
      log('info', `Admin login from ${ip}`);
      return json(res, 200, { ok: true });
    }
    f.n++;
    if (f.n >= 5) { f.until = Date.now() + 60_000; f.n = 0; }
    loginFails.set(ip, f);
    log('warn', `Admin login failed from ${ip}`);
    return json(res, 401, { error: 'Wrong password' });
  }

  const tok = sessionToken(req);
  if (!url.pathname.startsWith('/api/')) { res.writeHead(404); return res.end(); }
  if (!tok) return json(res, 401, { error: 'Not logged in' });

  if (url.pathname === '/api/logout' && req.method === 'POST') {
    sessions.delete(tok);
    res.setHeader('Set-Cookie', 'sid=; Max-Age=0; Path=/');
    return json(res, 200, { ok: true });
  }

  if (url.pathname === '/api/status' && req.method === 'GET') {
    return json(res, 200, {
      uptime: Date.now() - startedAt,
      proxy: { host: cfg.host, port: cfg.port },
      stats: { ...stats, active: active.size, watchers: watchers.size },
      active: [...active.values()].map((c) => ({ ...c })),
      events: events.slice(0, 100),
      settings: { username: cfg.username, allowedDomains: cfg.allowedDomains, timezone: cfg.timezone || '', effectiveTimeZone: effectiveTimeZone() },
      permissions: { ...cfg.readOnly, enforced: false },
    });
  }

  if (url.pathname === '/api/settings' && req.method === 'POST') {
    const b = await readBody(req);
    if (!b) return json(res, 400, { error: 'Bad JSON' });
    if (Array.isArray(b.allowedDomains)) {
      const list = b.allowedDomains.map((d) => String(d).trim().toLowerCase()).filter(Boolean);
      if (!list.every((d) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d))) return json(res, 400, { error: 'Invalid domain in list' });
      if (!list.length) return json(res, 400, { error: 'At least one domain is required' });
      cfg.allowedDomains = list;
    }
    if (b.permissions && typeof b.permissions === 'object') {
      for (const k of ['enabled', 'deletes', 'profileEdits', 'posting', 'engagement']) {
        if (typeof b.permissions[k] === 'boolean') cfg.readOnly[k] = b.permissions[k];
      }
    }
    if (typeof b.timezone === 'string') {
      const tz = b.timezone.trim();
      if (tz && !validTimeZone(tz)) return json(res, 400, { error: 'Unknown timezone (use a name like America/New_York)' });
      cfg.timezone = tz;
    }
    if (b.username) cfg.username = String(b.username);
    if (b.password) {
      if (String(b.password).length < 12) return json(res, 400, { error: 'Password must be at least 12 characters' });
      cfg.password = String(b.password);
    }
    saveConfig();
    log('info', 'Settings updated from dashboard');
    return json(res, 200, { ok: true });
  }

  if (url.pathname === '/api/clear-log' && req.method === 'POST') {
    events.length = 0;
    return json(res, 200, { ok: true });
  }

  res.writeHead(404);
  res.end();
});

admin.listen(cfg.adminPort, cfg.adminHost, () =>
  log('info', `Dashboard at http://${cfg.adminHost === '0.0.0.0' ? 'localhost' : cfg.adminHost}:${cfg.adminPort}`)
);
