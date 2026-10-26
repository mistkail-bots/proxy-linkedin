# LinkedIn US Proxy

Browser (any country) --[extension: only linkedin.com/licdn.com]--> proxy on US PC --> LinkedIn
LinkedIn sees the US PC's IP.

## 1. US PC: run the proxy
1. `cd server`, copy `config.example.json` to `config.json`, set a long random `password` (proxy) and `adminPassword` (dashboard).
2. `node proxy.js`
3. Open the dashboard at **http://localhost:8900** (live connections, traffic, logs, settings). It listens on localhost only by default; to use it remotely, reach it over Tailscale rather than exposing it to the internet.
4. Make it reachable from your current country (pick one):
   - **Best: Tailscale** (free) on both machines; use the US PC's Tailscale IP as the server. No port forwarding, encrypted.
   - Or forward TCP 8899 on the router + allow it in Windows Firewall; use the public IP / DDNS name.
     (Credentials are sent unencrypted in this mode; HTTPS traffic to LinkedIn itself stays end-to-end encrypted.)

## 2. Current-location PC: install the extension
Chrome/Edge -> `chrome://extensions` -> Developer mode -> Load unpacked -> select `extension/`.
Click the icon, enter server IP, port, username, password, tick Enable, Save.
Badge shows "ON". Only linkedin.com / licdn.com go through the proxy.

## Caveats
- The IP will be US, but LinkedIn can also see timezone, language and browser fingerprint. Keep the same
  browser/profile each time and avoid logging in from both places at once.
- Keep the US PC on and the proxy running whenever you use LinkedIn.
