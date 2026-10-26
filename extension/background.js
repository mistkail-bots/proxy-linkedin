// LinkedIn goes ONLY through the proxy. If the proxy server is unreachable (or this extension is not in
// control of the browser's proxy settings), LinkedIn requests are blocked immediately so they can never
// leave on the real connection.
importScripts('tz.js'); // installTimezone()

const DOMAINS = ['linkedin.com', 'licdn.com'];
const RULE_REDIRECT = 1;
const RULE_BLOCK = 2;

const state = { serverUp: null, controlled: true, reason: 'Starting…', tz: null }; // serverUp: null = not known yet
let gen = 0; // bumped to cancel a running monitor loop

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getSettings() {
  return chrome.storage.local.get({ enabled: false, host: '', port: 8899, username: '', password: '', tzSpoof: true, serverTz: '' });
}

// No DIRECT fallback: if the proxy is down the browser fails the request instead of going direct.
function buildPac(host, port) {
  const checks = DOMAINS.map((d) => `dnsDomainIs(host, ".${d}") || host === "${d}"`).join(' || ');
  return `function FindProxyForURL(url, host) {
  if (${checks}) return "PROXY ${host}:${port}";
  return "DIRECT";
}`;
}

// ---------- instant block ----------
async function setBlocked(blocked) {
  const rules = blocked
    ? [
        {
          id: RULE_REDIRECT,
          priority: 2,
          action: { type: 'redirect', redirect: { regexSubstitution: `chrome-extension://${chrome.runtime.id}/blocked.html#\\1` } },
          condition: { regexFilter: '^(https?://(?:[^/]*\\.)?(?:linkedin\\.com|licdn\\.com)(?:[:/?#].*)?)$', resourceTypes: ['main_frame'] },
        },
        {
          id: RULE_BLOCK,
          priority: 1,
          action: { type: 'block' },
          condition: {
            requestDomains: DOMAINS,
            resourceTypes: ['sub_frame', 'stylesheet', 'script', 'image', 'font', 'object', 'xmlhttprequest', 'ping', 'media', 'websocket', 'other'],
          },
        },
      ]
    : [];
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [RULE_REDIRECT, RULE_BLOCK], addRules: rules });
}

async function refreshBlock() {
  const s = await getSettings();
  if (!s.enabled || !s.host) {
    await setBlocked(false);
    chrome.action.setBadgeText({ text: '' });
    return;
  }
  const ok = state.serverUp === true && state.controlled && (!s.tzSpoof || !!s.serverTz);
  if (state.serverUp !== null) await setBlocked(!ok); // unknown (worker just woke) keeps the previous rules
  if (ok) {
    chrome.action.setBadgeText({ text: 'ON' });
    chrome.action.setBadgeBackgroundColor({ color: '#2e7d32' });
    chrome.action.setTitle({ title: 'LinkedIn proxy connected' });
  } else if (state.serverUp !== null) {
    chrome.action.setBadgeText({ text: 'OFF' });
    chrome.action.setBadgeBackgroundColor({ color: '#c62828' });
    chrome.action.setTitle({ title: 'LinkedIn BLOCKED: ' + state.reason });
  }
}

function setUp(up, reason) {
  const changed = state.serverUp !== up || (!up && state.reason !== reason);
  state.serverUp = up;
  state.reason = up ? 'Connected' : reason;
  if (changed) refreshBlock();
}

// ---------- server timezone ----------
// Fetched from the proxy server each time the connection comes up. LinkedIn stays blocked until we have it.
async function loadTz(s) {
  const auth = btoa(unescape(encodeURIComponent(`${s.username}:${s.password}`)));
  const r = await fetch(`http://${s.host}:${s.port}/__info`, { headers: { Authorization: 'Basic ' + auth }, cache: 'no-store' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const { timeZone } = await r.json();
  if (!timeZone) throw new Error('no timezone');
  await chrome.storage.local.set({ serverTz: timeZone });
  return timeZone;
}

function injectTimezone(details) {
  getSettings().then((s) => {
    if (!s.enabled || !s.tzSpoof || !s.serverTz) return;
    chrome.scripting.executeScript({
      target: { tabId: details.tabId, frameIds: [details.frameId] },
      world: 'MAIN',
      injectImmediately: true,
      func: installTimezone,
      args: [s.serverTz],
    }).catch(() => {});
  });
}

chrome.webNavigation.onCommitted.addListener(injectTimezone, { url: [{ hostSuffix: 'linkedin.com' }, { hostSuffix: 'licdn.com' }] });

// ---------- live health watch ----------
// Holds a streaming request open; the server sends a heartbeat every second. A dropped connection or
// 3.5 s of silence flips to "down" right away, and the loop keeps retrying every second.
async function monitor(myGen) {
  while (myGen === gen) {
    const s = await getSettings();
    if (!s.enabled || !s.host) return;
    const ac = new AbortController();
    let watchdog;
    const arm = () => { clearTimeout(watchdog); watchdog = setTimeout(() => ac.abort(), 3500); };
    let reason = 'Proxy server unreachable';
    try {
      arm();
      const auth = btoa(unescape(encodeURIComponent(`${s.username}:${s.password}`)));
      const r = await fetch(`http://${s.host}:${s.port}/__watch`, { headers: { Authorization: 'Basic ' + auth }, cache: 'no-store', signal: ac.signal });
      if (r.status === 401) reason = 'Wrong proxy username/password';
      else if (!r.ok) reason = 'Proxy server error (HTTP ' + r.status + ')';
      else {
        const reader = r.body.getReader();
        for (;;) {
          const { done } = await reader.read();
          if (done) break;
          if (myGen !== gen) return ac.abort();
          arm();
          if (state.serverUp !== true) {
            if (s.tzSpoof) {
              try { await loadTz(s); } catch { reason = 'Could not read the proxy server timezone'; ac.abort(); break; }
            }
          }
          setUp(true);
        }
        reason = 'Connection to proxy server lost';
      }
    } catch {
      // network error / abort: handled below
    }
    clearTimeout(watchdog);
    if (myGen !== gen) return;
    setUp(false, reason);
    await sleep(1000);
  }
}

function startMonitor() {
  const myGen = ++gen;
  monitor(myGen);
}

// ---------- apply settings ----------
async function checkControl() {
  const cfg = await chrome.proxy.settings.get({ incognito: false });
  const mine = cfg.levelOfControl === 'controlled_by_this_extension';
  state.controlled = mine;
  if (!mine) state.reason = 'Another extension or policy controls the browser proxy';
  return mine;
}

async function applySettings() {
  const s = await getSettings();
  if (s.enabled && s.host) {
    await setBlocked(true); // fail closed until the first healthy heartbeat
    await chrome.proxy.settings.set({ value: { mode: 'pac_script', pacScript: { data: buildPac(s.host, s.port) } }, scope: 'regular' });
    await checkControl();
    state.serverUp = false;
    state.reason = 'Connecting…';
    chrome.action.setBadgeText({ text: 'OFF' });
    chrome.action.setBadgeBackgroundColor({ color: '#c62828' });
    startMonitor();
  } else {
    gen++;
    await chrome.proxy.settings.clear({ scope: 'regular' });
    await setBlocked(false);
    chrome.action.setBadgeText({ text: '' });
  }
}

// Proxy credentials for the proxy itself.
chrome.webRequest.onAuthRequired.addListener(
  (details, callback) => {
    if (!details.isProxy) return callback({});
    getSettings().then((s) => callback({ authCredentials: { username: s.username, password: s.password } }));
  },
  { urls: ['<all_urls>'] },
  ['asyncBlocking']
);

// Settings changed in the popup -> re-apply.
const APPLY_KEYS = ['enabled', 'host', 'port', 'username', 'password'];
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (APPLY_KEYS.some((k) => k in changes)) applySettings();
  else if ('serverTz' in changes || 'tzSpoof' in changes) refreshBlock();
});
chrome.runtime.onStartup.addListener(applySettings);
chrome.runtime.onInstalled.addListener(applySettings);

// If something else takes over the proxy setting, block LinkedIn immediately.
chrome.proxy.settings.onChange.addListener(async () => {
  await checkControl();
  refreshBlock();
});

// Wake-up safety net: Chrome may restart the service worker; make sure the watcher is running.
chrome.alarms.create('watch', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(async () => {
  const s = await getSettings();
  if (s.enabled && s.host && state.serverUp === null) startMonitor();
});

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg && msg.type === 'status') {
    getSettings().then((s) => reply({ enabled: s.enabled && !!s.host, up: state.serverUp === true && state.controlled, reason: state.reason, tz: s.tzSpoof ? s.serverTz : '' }));
    return true;
  }
});

// Service worker started (browser launch or restart): resume watching.
(async () => {
  const s = await getSettings();
  if (s.enabled && s.host) startMonitor();
})();
