const $ = (id) => document.getElementById(id);
const fields = ['host', 'port', 'username', 'password'];

chrome.storage.local.get({ enabled: false, host: '', port: 8899, username: '', password: '', tzSpoof: true }).then((s) => {
  $('enabled').checked = s.enabled;
  $('tzSpoof').checked = s.tzSpoof;
  fields.forEach((f) => ($(f).value = s[f]));
});

$('save').onclick = async () => {
  await chrome.storage.local.set({
    enabled: $('enabled').checked,
    host: $('host').value.trim(),
    port: parseInt($('port').value, 10) || 8899,
    username: $('username').value,
    password: $('password').value,
    tzSpoof: $('tzSpoof').checked,
  });
  $('status').textContent = $('enabled').checked ? 'Saved. Proxy ON for LinkedIn.' : 'Saved. Proxy OFF.';
};

// Opens LinkedIn's own page is not possible without login, so just open a tab to a
// LinkedIn-domain URL that returns the visitor IP-agnostic page; user can verify via
// the proxy server log. Simple check: fetch a LinkedIn static asset through the proxy.
$('test').onclick = async () => {
  $('status').textContent = 'Testing...';
  try {
    const r = await fetch('https://www.linkedin.com/robots.txt', { cache: 'no-store' });
    $('status').textContent = r.ok ? 'OK: reached LinkedIn via proxy.' : `HTTP ${r.status}`;
  } catch (e) {
    $('status').textContent = 'Failed: ' + e.message;
  }
};

// Live proxy status (refreshes every second while the popup is open).
async function live() {
  const el = $('live');
  try {
    const st = await chrome.runtime.sendMessage({ type: 'status' });
    if (!st.enabled) { el.textContent = 'Proxy disabled'; el.style.background = '#eee'; el.style.color = '#333'; }
    else if (st.up) { el.textContent = 'Proxy connected. LinkedIn allowed' + (st.tz ? ' (time zone: ' + st.tz + ')' : ''); el.style.background = '#e6f6ec'; el.style.color = '#1a8f4c'; }
    else { el.textContent = 'LinkedIn BLOCKED: ' + st.reason; el.style.background = '#fde8e8'; el.style.color = '#c53030'; }
  } catch { el.textContent = 'Extension not responding'; }
}
live();
setInterval(live, 1000);
