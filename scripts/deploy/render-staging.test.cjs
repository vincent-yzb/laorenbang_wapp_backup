'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const deploy = require('./render-staging.cjs');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'lrb-render-offline-'));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));
let sequence = 0;
const base = {
  RENDER_API_KEY: 'offline-test-api-key', RENDER_OWNER_ID: 'tea-offlinetest',
  RENDER_MIGRATION_CIDR: '203.0.113.10/32', WECHAT_APPID: 'offline-app-id', WECHAT_APP_SECRET: 'offline-app-secret',
};
function context(api, extra = {}) {
  const directory = path.join(scratch, String(++sequence), '.local');
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'render.env');
  fs.writeFileSync(file, Object.entries({ ...base, ...extra }).map(([key, value]) => `${key}=${value}`).join('\n'), { mode: 0o600 });
  const value = deploy.loadContext(file);
  value.api = api;
  value.output = [];
  value.print = result => value.output.push(result);
  return value;
}
const owner = { id: base.RENDER_OWNER_ID, name: 'Offline workspace', type: 'team', email: 'never-print@example.test' };
const database = (overrides = {}) => ({
  id: 'dpg-offline-a', name: 'laorenbang-staging-db-20261008', owner,
  plan: 'free', region: 'singapore', status: 'available', databaseName: 'laorenbang_staging', databaseUser: 'laorenbang_staging',
  createdAt: '2026-10-08T00:00:00Z', ...overrides,
});
function inventoryApi(extra = {}) {
  const calls = [];
  let created = false;
  const api = async (method, endpoint, body) => {
    calls.push({ method, endpoint, body });
    if (endpoint.startsWith('/owners?')) return [{ owner, cursor: 'owner-cursor' }];
    if (endpoint.startsWith('/services?')) return (extra.services || []).map(service => ({ service, cursor: 'service-cursor' }));
    if (endpoint.startsWith('/postgres?')) return (extra.databases || (created ? [database()] : [])).map(postgres => ({ postgres, cursor: 'database-cursor' }));
    if (method === 'POST' && endpoint === '/postgres') { created = true; return database(); }
    if (method === 'GET' && endpoint === '/postgres/dpg-offline-a') return database(extra.database);
    if (endpoint.endsWith('/connection-info')) return {
      internalConnectionString: 'postgresql://laorenbang_staging:offline-db-secret@dpg-offline-a/laorenbang_staging',
      externalConnectionString: 'postgresql://laorenbang_staging:offline-db-secret@dpg-offline-a.singapore-postgres.render.com/laorenbang_staging',
    };
    throw new Error('Unexpected offline API call');
  };
  return { api, calls };
}

test('offline plan makes no API call or local creation receipt and does not print credentials', async () => {
  const c = context(() => assert.fail('plan must never call API'));
  await deploy.runCommand('plan', c);
  assert.equal(fs.existsSync(c.files.state), false);
  assert.equal(c.output[0].webPlan, 'free');
  for (const secret of [base.RENDER_API_KEY, base.WECHAT_APP_SECRET]) assert.equal(JSON.stringify(c.output).includes(secret), false);
});

test('preflight only reads metadata and omits workspace email and connection secrets', async () => {
  const fake = inventoryApi({ databases: [database()] });
  const c = context(fake.api);
  await deploy.runCommand('preflight', c);
  assert.ok(fake.calls.every(call => call.method === 'GET'));
  assert.equal(JSON.stringify(c.output).includes(owner.email), false);
  assert.equal(fs.existsSync(c.files.state), false);
});

test('new database is free, narrowly allowlisted and has a private creation receipt', async () => {
  const fake = inventoryApi();
  const c = context(fake.api);
  await deploy.runCommand('create-db', c);
  const writes = fake.calls.filter(call => call.method === 'POST');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].endpoint, '/postgres');
  assert.equal(writes[0].body.plan, 'free');
  assert.equal(writes[0].body.enableDiskAutoscaling, false);
  assert.equal(writes[0].body.ipAllowList[0].cidrBlock, base.RENDER_MIGRATION_CIDR);
  assert.equal(fs.statSync(c.files.state).mode & 0o777, 0o600);
  await assert.rejects(deploy.runCommand('create-db', c), /receipt already exists/);
  assert.equal(fake.calls.filter(call => call.method === 'POST').length, 1);
});

test('same-name and occupied free-database slot both block every cloud write', async () => {
  for (const options of [
    { services: [{ id: 'srv-existing', name: 'laorenbang-staging-20261008' }] },
    { databases: [database({ name: 'existing-production-free-db' })] },
  ]) {
    const fake = inventoryApi(options);
    await assert.rejects(deploy.runCommand('create-db', context(fake.api)), /already/);
    assert.equal(fake.calls.filter(call => call.method === 'POST').length, 0);
  }
});

test('prepare-db uses only newly-created database connection info and never prints its password or full URL', async () => {
  const fake = inventoryApi();
  const c = context(fake.api);
  await deploy.runCommand('create-db', c);
  await deploy.runCommand('prepare-db', c);
  const generated = fs.readFileSync(c.files.migrationEnv, 'utf8');
  assert.match(generated, /sslmode=require/);
  assert.equal(fs.statSync(c.files.migrationEnv).mode & 0o777, 0o600);
  assert.equal(JSON.stringify(c.output).includes('offline-db-secret'), false);
  assert.equal(JSON.stringify(c.output).includes('postgresql://'), false);
  await assert.rejects(deploy.runCommand('create-web', c), /migration/);
  assert.equal(fake.calls.filter(call => call.endpoint === '/services' && call.method === 'POST').length, 0);
});

test('receipt ownership changes block retrieval of sensitive connection info', async () => {
  const fake = inventoryApi({ database: { owner: { id: 'tea-someoneelse' } } });
  const c = context(fake.api);
  await deploy.runCommand('create-db', c);
  await assert.rejects(deploy.runCommand('prepare-db', c), /ownership/);
  assert.equal(fake.calls.filter(call => call.endpoint.endsWith('/connection-info')).length, 0);
});

test('config cannot inherit production URLs, paid settings, unsafe names, broad allowlists or different repositories', () => {
  assert.throws(() => deploy.parseEnv('DATABASE_URL=postgresql://production'), /Unsupported/);
  assert.throws(() => deploy.parseEnv('RENDER_PLAN=starter'), /Unsupported/);
  assert.throws(() => deploy.validateConfig({ RENDER_SERVICE_NAME: 'laorenbang-backend' }), /new laorenbang-staging/);
  assert.throws(() => deploy.validateConfig({ RENDER_REPO: 'https://github.com/other/repo' }), /canonical/);
  assert.throws(() => deploy.databasePayload(deploy.validateConfig({ ...base, RENDER_MIGRATION_CIDR: '0.0.0.0/0' })), /one public client IP/);
  assert.throws(() => deploy.checkedConnection('postgresql://laorenbang_staging:secret@production.example/laorenbang_staging', database(), true), /host/);
});

test('Web Service payload fixes production, no mock, free, Docker, no autodeploy and a new independent database', () => {
  const config = deploy.validateConfig(base);
  const runtime = deploy.runtimeValues(config, 'postgresql://new-private-db', 'x'.repeat(40));
  const payload = deploy.webPayload(config, runtime);
  assert.equal(payload.serviceDetails.plan, 'free');
  assert.equal(payload.serviceDetails.runtime, 'docker');
  assert.equal(payload.autoDeployTrigger, 'off');
  assert.equal(payload.autoDeploy, undefined);
  assert.equal(payload.serviceDetails.preDeployCommand, undefined);
  assert.equal(runtime.NODE_ENV, 'production');
  assert.equal(runtime.ALLOW_MOCK_PAYMENT, 'false');
  assert.equal(runtime.ALLOW_MOCK_SMS, 'false');
  assert.equal(runtime.DATABASE_URL, runtime.DIRECT_URL);
});

test('HTTP failures and redirects cannot reveal Render response secrets or trigger paid retries', async () => {
  let calls = 0;
  const api = deploy.createClient('secret-render-token', async (_url, options) => {
    calls++;
    assert.equal(options.redirect, 'error');
    return { ok: false, status: 402, json: () => assert.fail('error body must not be parsed') };
  });
  await assert.rejects(api('POST', '/services', {}), /HTTP 402/);
  assert.equal(calls, 1);
  await assert.rejects(api('PATCH', '/services/srv-existing', {}), /Unsupported/);
  assert.equal(calls, 1);
});

test('verified migration permits one free Web Service and status distinguishes building from live with the actual commit', async () => {
  const fake = inventoryApi();
  const expectedCommit = 'a'.repeat(40);
  const service = { id: 'srv-offline', name: 'laorenbang-staging-20261008', ownerId: owner.id, type: 'web_service', branch: 'staging-20261008', serviceDetails: { plan: 'free', region: 'singapore', url: 'https://laorenbang-staging-20261008.onrender.com' } };
  let deploymentStatus = 'build_in_progress';
  const writes = [];
  const c = context(async (method, endpoint, body) => {
    if (method === 'POST' && endpoint === '/services') { writes.push(body); return { service, deployId: 'dep-offline' }; }
    if (endpoint === '/services/srv-offline') return service;
    if (endpoint === '/services/srv-offline/deploys/dep-offline') return { id: 'dep-offline', status: deploymentStatus, commit: { id: expectedCommit, message: 'Must not print commit message' } };
    return fake.api(method, endpoint, body);
  }, { RENDER_EXPECTED_COMMIT: expectedCommit });
  let releaseChecks = 0;
  c.releaseReady = () => { releaseChecks++; };
  await deploy.runCommand('create-db', c);
  await deploy.runCommand('prepare-db', c);
  const state = JSON.parse(fs.readFileSync(c.files.state, 'utf8'));
  // This is a mocked reviewed migration receipt. No DB is contacted in this test.
  state.migration = { databaseId: 'dpg-offline-a', commit: expectedCommit, digest: deploy.migrationDigest() };
  fs.writeFileSync(c.files.state, JSON.stringify(state));
  await deploy.runCommand('create-web', c);
  assert.equal(releaseChecks, 1);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].serviceDetails.plan, 'free');
  assert.equal(writes[0].envVars.find(row => row.key === 'NODE_ENV').value, 'production');
  await deploy.runCommand('status', c);
  assert.equal(c.output.at(-1).deploy.live, false);
  assert.equal(c.output.at(-1).deploy.status, 'build_in_progress');
  deploymentStatus = 'live';
  await deploy.runCommand('status', c);
  assert.equal(c.output.at(-1).deploy.live, true);
  assert.equal(c.output.at(-1).deploy.commitMatches, true);
  assert.equal(c.output.at(-1).deploy.commit, expectedCommit);
  assert.equal(JSON.stringify(c.output).includes('Must not print commit message'), false);
  await assert.rejects(deploy.runCommand('create-web', c), /receipt already exists/);
  assert.equal(writes.length, 1);
});
