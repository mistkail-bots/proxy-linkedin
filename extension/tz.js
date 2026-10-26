// Injected into LinkedIn pages (MAIN world) so the page sees the proxy server's timezone instead of this
// computer's. Only the page's JavaScript view changes; the computer's clock and other sites are untouched.
// Must stay self-contained: it is serialized and run inside the page.
function installTimezone(tz) {
  if (window.__tzInstalled) return;
  Object.defineProperty(window, '__tzInstalled', { value: true });

  const RealDTF = Intl.DateTimeFormat;
  const DP = Date.prototype;
  const getTime = DP.getTime;
  const origGetUTC = {};
  ['FullYear', 'Month', 'Date', 'Day', 'Hours', 'Minutes', 'Seconds', 'Milliseconds'].forEach((n) => { origGetUTC[n] = DP['getUTC' + n]; });

  const parts = new RealDTF('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
  // minutes to ADD to UTC to get wall-clock time in tz at instant t (handles daylight saving)
  function offsetAt(t) {
    const p = {};
    for (const x of parts.formatToParts(new Date(t))) p[x.type] = x.value;
    const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    return Math.round((asUTC - Math.floor(t / 1000) * 1000) / 60000);
  }

  // Proxy-wrapped functions keep their name/length and still print as "[native code]".
  const patch = (obj, name, handler) => {
    const orig = obj[name];
    Object.defineProperty(obj, name, { value: new Proxy(orig, { apply: handler }), writable: true, configurable: true, enumerable: false });
  };

  // getTimezoneOffset + local getters
  patch(DP, 'getTimezoneOffset', (t, self) => { const ms = getTime.call(self); return isNaN(ms) ? NaN : -offsetAt(ms); });
  for (const n of Object.keys(origGetUTC)) {
    patch(DP, 'get' + n, (t, self) => {
      const ms = getTime.call(self);
      if (isNaN(ms)) return NaN;
      return origGetUTC[n].call(new Date(ms + offsetAt(ms) * 60000));
    });
  }

  // Formatting
  const dtf = (opts) => new RealDTF('en-US', { timeZone: tz, ...opts });
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  function pieces(ms) {
    const p = {};
    for (const x of dtf({ weekday: 'short', month: 'short', day: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'long' }).formatToParts(new Date(ms))) p[x.type] = x.value;
    const off = offsetAt(ms);
    const sign = off < 0 ? '-' : '+';
    const a = Math.abs(off);
    p.gmt = `GMT${sign}${pad(Math.floor(a / 60))}${pad(a % 60)}`;
    return p;
  }
  const dateStr = (p) => `${p.weekday} ${p.month} ${p.day} ${p.year}`;
  const timeStr = (p) => `${p.hour}:${p.minute}:${p.second} ${p.gmt} (${p.timeZoneName})`;
  patch(DP, 'toString', (t, self) => { const ms = getTime.call(self); if (isNaN(ms)) return 'Invalid Date'; const p = pieces(ms); return `${dateStr(p)} ${timeStr(p)}`; });
  patch(DP, 'toDateString', (t, self) => { const ms = getTime.call(self); return isNaN(ms) ? 'Invalid Date' : dateStr(pieces(ms)); });
  patch(DP, 'toTimeString', (t, self) => { const ms = getTime.call(self); return isNaN(ms) ? 'Invalid Date' : timeStr(pieces(ms)); });

  // Intl and toLocale*String default to tz unless the page asks for a specific zone
  const withTz = (o) => (o && o.timeZone ? o : { ...(o || {}), timeZone: tz });
  Intl.DateTimeFormat = new Proxy(RealDTF, {
    apply: (t, self, a) => t(a[0], withTz(a[1])),
    construct: (t, a, nt) => Reflect.construct(t, [a[0], withTz(a[1])], nt),
  });
  ['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString'].forEach((n) => {
    patch(DP, n, (t, self, a) => Reflect.apply(t, self, [a[0], withTz(a[1])]));
  });
}
