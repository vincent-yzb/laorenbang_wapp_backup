const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');

function loadIsolatedEnvironment(file = '../.local/runtime.env') {
  const values = Object.fromEntries(readFileSync(resolve(file), 'utf8').split(/\r?\n/)
    .filter(line => line.trim() && !line.trim().startsWith('#'))
    .map(line => {
      const index = line.indexOf('=');
      if (index < 1) throw new Error('Invalid isolated environment file');
      return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
    }));

  for (const name of ['DATABASE_URL', 'DIRECT_URL']) {
    let url;
    try { url = new URL(values[name]); } catch { throw new Error(`${name} is not a valid isolated URL`); }
    if (!['postgres:', 'postgresql:'].includes(url.protocol)
      || url.hostname !== '127.0.0.1' || url.port !== '55432'
      || url.pathname !== '/lrb_integration' || url.username !== 'lrb_integration') {
      throw new Error(`${name} must target the dedicated loopback integration database`);
    }
  }
  if (values.NODE_ENV !== 'development' || values.HOST !== '127.0.0.1'
    || values.PORT !== '3101' || !values.JWT_SECRET || values.JWT_SECRET.length < 32
    || values.LRB_ISOLATED_ENV !== 'true') {
    throw new Error('The explicit isolated runtime configuration is required');
  }
  return values;
}

module.exports = { loadIsolatedEnvironment };
