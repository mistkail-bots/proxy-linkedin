// Local certificate authority used by the proxy's read-only mode.
// The CA is restricted (X.509 name constraints) to linkedin.com, so even if it is installed in a
// browser it cannot be used to impersonate any other site.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const CANDIDATES = ['openssl', 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe', 'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe'];

function run(bin, args, cwd) {
  const r = spawnSync(bin, args, { cwd, encoding: 'utf8' });
  if (r.error) return { missing: true };
  if (r.status !== 0) throw new Error(`openssl ${args[0]} failed: ${r.stderr}`);
  return {};
}

function findOpenssl(custom) {
  for (const bin of [custom, ...CANDIDATES].filter(Boolean)) {
    const r = spawnSync(bin, ['version']);
    if (!r.error && r.status === 0) return bin;
  }
  throw new Error('OpenSSL not found. Install it (it ships with Git for Windows) or set "opensslPath" in config.json.');
}

function ensureCerts(dir, hosts, opensslPath) {
  fs.mkdirSync(dir, { recursive: true });
  const f = (n) => path.join(dir, n);
  const bin = findOpenssl(opensslPath);

  if (!fs.existsSync(f('ca.crt')) || !fs.existsSync(f('ca.key'))) {
    fs.writeFileSync(f('ca.cnf'), [
      '[req]', 'distinguished_name=dn', 'x509_extensions=v3_ca', 'prompt=no',
      '[dn]', 'CN=LinkedIn Proxy Local CA',
      '[v3_ca]', 'basicConstraints=critical,CA:TRUE,pathlen:0', 'keyUsage=critical,keyCertSign,cRLSign',
      'subjectKeyIdentifier=hash', 'nameConstraints=critical,permitted;DNS:linkedin.com', '',
    ].join('\n'));
    run(bin, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt', '-days', '3650', '-config', 'ca.cnf'], dir);
  }

  // Leaf certificates are valid for 365 days (browsers reject longer); renew after 300.
  const leafAge = fs.existsSync(f('leaf.crt')) ? Date.now() - fs.statSync(f('leaf.crt')).mtimeMs : Infinity;
  if (leafAge > 300 * 86400e3) {
    fs.writeFileSync(f('leaf.ext'), ['basicConstraints=CA:FALSE', 'keyUsage=digitalSignature,keyEncipherment', 'extendedKeyUsage=serverAuth',
      'subjectAltName=' + hosts.map((h) => 'DNS:' + h).join(',')].join('\n'));
    run(bin, ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'leaf.key', '-out', 'leaf.csr', '-subj', `/CN=${hosts[0]}`], dir);
    run(bin, ['x509', '-req', '-in', 'leaf.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'leaf.crt', '-days', '365', '-extfile', 'leaf.ext'], dir);
  }
  return {
    key: fs.readFileSync(f('leaf.key')),
    cert: fs.readFileSync(f('leaf.crt')),
    caPath: f('ca.crt'),
  };
}

module.exports = { ensureCerts };
