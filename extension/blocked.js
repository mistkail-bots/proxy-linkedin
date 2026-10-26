const target = decodeURIComponent(location.hash.slice(1));

async function check() {
  try {
    const st = await chrome.runtime.sendMessage({ type: 'status' });
    document.getElementById('reason').textContent = st.up ? 'Proxy is back. Reloading…' : st.reason;
    if (st.up && /^https?:\/\//.test(target)) location.replace(target);
  } catch {
    document.getElementById('reason').textContent = 'Extension not responding';
  }
}

check();
setInterval(check, 1000);
