const { existsSync } = require('node:fs');
const { resolve } = require('node:path');
const { spawn } = require('node:child_process');

// Read only the explicit isolated environment. Never fall back to the project .env.
const { loadIsolatedEnvironment } = require('./isolated-env.cjs');
const values = loadIsolatedEnvironment(process.argv[2]);

const root = resolve(__dirname, '..');
if (!existsSync(resolve(root, 'dist/main.js'))) throw new Error('Run npm run build first');
const allowed = ['DATABASE_URL', 'DIRECT_URL', 'NODE_ENV', 'HOST', 'PORT', 'JWT_SECRET',
  'JWT_EXPIRES_IN', 'WECHAT_APPID', 'WECHAT_APP_SECRET', 'ALLOW_MOCK_PAYMENT',
  'ALLOW_MOCK_SMS', 'LRB_ISOLATED_ENV'];
const environment = { PATH: process.env.PATH, TZ: process.env.TZ || 'UTC' };
for (const key of allowed) if (values[key] !== undefined) environment[key] = values[key];
const child = spawn(process.execPath, ['dist/main.js'], { cwd: root, env: environment, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
