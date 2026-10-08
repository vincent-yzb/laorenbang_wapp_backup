#!/usr/bin/env node
'use strict';
// No normal .env, cloud targets or merchant credentials are accepted.
const fs = require('node:fs'), path = require('node:path'), { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
function guard(value) { if (!value) throw new Error('Explicit private dedicated loopback PostgreSQL and Node22 are required'); }
try {
  guard(process.versions.node.startsWith('22.'));
  const file = path.join(root, '.local/isolated-postgres.env'), info = fs.lstatSync(file);
  guard(info.isFile() && !info.isSymbolicLink() && !(info.mode & 0o077));
  const values = Object.fromEntries(fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).map(line => {
    const i = line.indexOf('='); guard(i > 0); return [line.slice(0, i), line.slice(i + 1)];
  }));
  guard(Object.keys(values).length === 2 && values.DATABASE_URL === values.DIRECT_URL);
  const url = new URL(values.DATABASE_URL);
  guard(url.protocol === 'postgresql:' && url.hostname === '127.0.0.1' && url.port === '55432' &&
    url.pathname === '/lrb_integration' && url.username === 'lrb_integration' && !!url.password);
  const files = ['test/integration/postgres.test.ts', 'test/integration/payment-ledger-migration.test.ts',
    'test/integration/real-payment.test.ts', 'test/integration/funds-ledger.test.ts'];
  guard(files.every(file => fs.existsSync(path.join(root, file))));
  const result = spawnSync(process.execPath, ['--require', 'ts-node/register/transpile-only', '--test', ...files], {
    cwd: root, env: { ...process.env, ...values, LRB_INTEGRATION_DB: 'true', NODE_ENV: 'development',
      ALLOW_MOCK_PAYMENT: 'true', WECHAT_PAY_ENABLED: 'false', WECHAT_TRANSFER_ENABLED: 'false' },
    encoding: 'utf8', timeout: 180000, maxBuffer: 4 * 1024 * 1024,
  });
  let output = (result.stdout || '') + (result.stderr || '');
  for (const secret of [values.DATABASE_URL, values.DIRECT_URL, decodeURIComponent(url.password)]) output = output.split(secret).join('[redacted]');
  process.stdout.write(output);
  process.exitCode = result.status === 0 ? 0 : 1;
} catch { console.error('Financial tests refused or failed; private details withheld'); process.exitCode = 1; }
