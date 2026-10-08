#!/usr/bin/env node
'use strict';

// Render API schema checked against the official OpenAPI spec on 2026-10-08:
// https://api-docs.render.com/openapi/render-public-api-1.json
// No PATCH, DELETE, paid plan, environment-group inheritance, or automatic retry.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const net = require('node:net');

const ROOT = path.resolve(__dirname, '../..');
const DEFAULT_CONFIG = path.resolve(ROOT, '../.local/render.env');
const REPO = 'https://github.com/vincent-yzb/laorenbang_wapp_backup';
const API = 'https://api.render.com/v1';
const COMMANDS = ['plan', 'preflight', 'create-db', 'db-status', 'prepare-db', 'migrate', 'create-web', 'status'];
const ALLOWED_KEYS = new Set([
  'RENDER_API_KEY', 'RENDER_OWNER_ID', 'RENDER_REGION', 'RENDER_SERVICE_NAME', 'RENDER_DATABASE_NAME',
  'RENDER_REPO', 'RENDER_BRANCH', 'RENDER_EXPECTED_COMMIT', 'RENDER_MIGRATION_CIDR',
  'WECHAT_APPID', 'WECHAT_APP_SECRET', 'JWT_SECRET', 'JWT_EXPIRES_IN', 'CORS_ORIGIN',
]);
class DeploymentError extends Error {}
const fail = message => { throw new DeploymentError(message); };
const requireValue = (value, label) => value || fail(`${label} is required`);
const sha = value => crypto.createHash('sha256').update(value).digest('hex');

function parseEnv(text) {
  const result = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match || !ALLOWED_KEYS.has(match[1])) fail('Unsupported config entry; use the documented variable names only');
    if (Object.hasOwn(result, match[1])) fail(`Duplicate config variable: ${match[1]}`);
    let value = match[2].trim();
    if (value.startsWith('"') || value.startsWith("'")) {
      if (value.at(-1) !== value[0]) fail(`Unclosed quote for ${match[1]}`);
      value = value.slice(1, -1);
    }
    if (/[\r\n\0]/.test(value)) fail(`Invalid value for ${match[1]}`);
    result[match[1]] = value;
  }
  return result;
}

function validateConfig(input) {
  const config = {
    ...input,
    RENDER_REGION: input.RENDER_REGION || 'singapore',
    RENDER_SERVICE_NAME: input.RENDER_SERVICE_NAME || 'laorenbang-staging-20261008',
    RENDER_DATABASE_NAME: input.RENDER_DATABASE_NAME || 'laorenbang-staging-db-20261008',
    RENDER_REPO: input.RENDER_REPO || REPO,
    RENDER_BRANCH: input.RENDER_BRANCH || 'staging-20261008',
  };
  for (const key of ['RENDER_SERVICE_NAME', 'RENDER_DATABASE_NAME']) {
    if (!/^laorenbang-staging(?:-[a-z0-9]+)*$/.test(config[key]) || config[key].length > 63) fail(`${key} must be a new laorenbang-staging* name`);
  }
  if (config.RENDER_SERVICE_NAME === config.RENDER_DATABASE_NAME) fail('Web service and database names must differ');
  if (config.RENDER_REGION !== 'singapore') fail('This deployment is restricted to the reviewed Singapore region');
  if (config.RENDER_REPO !== REPO) fail('Only the reviewed canonical GitHub repository is supported');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9/_-]*$/.test(config.RENDER_BRANCH) || ['main', 'master', 'production', 'prod'].includes(config.RENDER_BRANCH)) fail('Use a dedicated staging release branch');
  if (config.RENDER_OWNER_ID && !/^(usr|tea)-[a-z0-9]+$/.test(config.RENDER_OWNER_ID)) fail('Invalid RENDER_OWNER_ID');
  if (config.RENDER_EXPECTED_COMMIT && !/^[a-f0-9]{40}$/.test(config.RENDER_EXPECTED_COMMIT)) fail('RENDER_EXPECTED_COMMIT must be a full Git SHA');
  return config;
}

function privateRead(file) {
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077)) fail('Private configuration/state must be a regular file with chmod 600');
  return fs.readFileSync(file, 'utf8');
}

function privateWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (fs.existsSync(file)) privateRead(file);
  fs.writeFileSync(file, data, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

function loadContext(configFile, { optional = false } = {}) {
  const resolved = path.resolve(configFile);
  if (path.basename(path.dirname(resolved)) !== '.local') fail('Store Render configuration in a private .local directory');
  const config = validateConfig(fs.existsSync(resolved) ? parseEnv(privateRead(resolved)) : optional ? {} : fail('Private Render config file is missing'));
  const directory = path.dirname(resolved);
  const files = {
    config: resolved, state: path.join(directory, 'render-staging-state.json'),
    migrationEnv: path.join(directory, 'render-staging-migration.env'),
    runtimeEnv: path.join(directory, 'render-staging-runtime.env'),
    cli: path.join(directory, 'render-staging-prisma'),
  };
  return { config, files, api: createClient(config.RENDER_API_KEY), print: value => console.log(JSON.stringify(value, null, 2)) };
}

function createClient(token, fetchImpl = globalThis.fetch) {
  return async (method, endpoint, body) => {
    requireValue(token, 'RENDER_API_KEY');
    if (!['GET', 'POST'].includes(method) || (method === 'POST' && !['/postgres', '/services'].includes(endpoint))) fail('Unsupported Render mutation');
    if (!endpoint.startsWith('/') || endpoint.includes('://')) fail('Invalid Render endpoint');
    let response;
    try {
      response = await fetchImpl(API + endpoint, {
        method, redirect: 'error', signal: AbortSignal.timeout(30000),
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch { fail(`Render ${method} request failed; no automatic retry was performed`); }
    // Error bodies can contain request credentials or environment values: never log them.
    if (!response.ok) fail(`Render ${method} failed (HTTP ${response.status}); no upgrade or retry was performed`);
    try { return await response.json(); } catch { fail('Render returned an invalid JSON response'); }
  };
}

async function listAll(api, endpoint, wrapper, ownerId) {
  const items = [];
  let cursor;
  for (let page = 0; page < 100; page++) {
    const query = new URLSearchParams({ limit: '100', ...(ownerId ? { ownerId } : {}), ...(cursor ? { cursor } : {}) });
    const rows = await api('GET', `${endpoint}?${query}`);
    if (!Array.isArray(rows)) fail('Render list response shape changed; refusing to continue');
    for (const row of rows) {
      if (!row[wrapper] || !row[wrapper].id || !row[wrapper].name) fail('Render list item shape changed');
      items.push(row[wrapper]);
    }
    if (rows.length < 100) return items;
    const next = rows.at(-1)?.cursor;
    if (!next || next === cursor) fail('Render pagination is incomplete; refusing a name collision check');
    cursor = next;
  }
  fail('Render pagination exceeded the safety limit');
}

const ownerOf = db => db.owner?.id;
function safeOwner(owner) { return { id: owner.id, name: owner.name, type: owner.type }; }
function safeDb(db) {
  return { id: db.id, name: db.name, ownerId: ownerOf(db), plan: db.plan, region: db.region, status: db.status, createdAt: db.createdAt, expiresAt: db.expiresAt || null };
}
function safeService(service) {
  let domain = null;
  try { domain = new URL(service.serviceDetails?.url).hostname; } catch { /* Not available during creation. */ }
  return { id: service.id, name: service.name, ownerId: service.ownerId, type: service.type, plan: service.serviceDetails?.plan, region: service.serviceDetails?.region, branch: service.branch, domain };
}

async function inventory(context) {
  const { api, config: c } = context;
  const owners = await listAll(api, '/owners', 'owner');
  if (c.RENDER_OWNER_ID && !owners.some(owner => owner.id === c.RENDER_OWNER_ID)) fail('Configured workspace is not accessible with this API key');
  const [services, databases] = await Promise.all([
    listAll(api, '/services', 'service', c.RENDER_OWNER_ID),
    listAll(api, '/postgres', 'postgres', c.RENDER_OWNER_ID),
  ]);
  return { owners, services, databases };
}

function noCollision(c, found) {
  const names = new Set([c.RENDER_SERVICE_NAME, c.RENDER_DATABASE_NAME]);
  if ([...found.services, ...found.databases].some(item => names.has(item.name))) fail('A target name already exists; existing resources will not be adopted or overwritten');
}

function identity(c) {
  return { ownerId: c.RENDER_OWNER_ID, region: c.RENDER_REGION, serviceName: c.RENDER_SERVICE_NAME, databaseName: c.RENDER_DATABASE_NAME, repo: c.RENDER_REPO, branch: c.RENDER_BRANCH };
}
function loadState(context) {
  if (!fs.existsSync(context.files.state)) fail('No local creation receipt; existing cloud resources cannot be adopted');
  const state = JSON.parse(privateRead(context.files.state));
  if (state.version !== 1 || JSON.stringify(state.identity) !== JSON.stringify(identity(context.config))) fail('Creation receipt does not match this deployment configuration');
  return state;
}
const saveState = (context, state) => privateWrite(context.files.state, JSON.stringify(state, null, 2) + '\n');

function databasePayload(c) {
  requireValue(c.RENDER_OWNER_ID, 'RENDER_OWNER_ID');
  const [ip, mask] = requireValue(c.RENDER_MIGRATION_CIDR, 'RENDER_MIGRATION_CIDR').split('/');
  if ((net.isIP(ip) !== 4 || mask !== '32') && (net.isIP(ip) !== 6 || mask !== '128')) fail('RENDER_MIGRATION_CIDR must be one public client IP (/32 or /128), never a broad network');
  if (ip === '0.0.0.0' || ip === '::' || ip === '127.0.0.1' || ip === '::1') fail('Migration allowlist must use the migration client public egress IP');
  return {
    name: c.RENDER_DATABASE_NAME, ownerId: c.RENDER_OWNER_ID, plan: 'free', region: c.RENDER_REGION,
    version: '16', databaseName: 'laorenbang_staging', databaseUser: 'laorenbang_staging',
    enableHighAvailability: false, enableDiskAutoscaling: false, connectionPool: 'none',
    ipAllowList: [{ cidrBlock: c.RENDER_MIGRATION_CIDR, description: 'Dedicated staging migration client' }],
  };
}

async function ownedDatabase(context, state, available = false) {
  const dbId = requireValue(state.database?.id, 'A newly created database receipt');
  if (!/^dpg-[a-z0-9-]+$/.test(dbId)) fail('Invalid database receipt ID');
  const db = await context.api('GET', `/postgres/${dbId}`);
  const c = context.config;
  if (db.id !== dbId || db.name !== c.RENDER_DATABASE_NAME || ownerOf(db) !== c.RENDER_OWNER_ID || db.plan !== 'free' || db.region !== c.RENDER_REGION || db.databaseName !== 'laorenbang_staging' || db.databaseUser !== 'laorenbang_staging') fail('Database ownership, isolation or free plan no longer matches the creation receipt');
  if (available && db.status !== 'available') fail('The new database is not yet available; run db-status later');
  return db;
}

function checkedConnection(raw, db, external) {
  let url;
  try { url = new URL(raw); } catch { fail('Invalid database connection response'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.password || decodeURIComponent(url.username) !== db.databaseUser || decodeURIComponent(url.pathname) !== '/' + db.databaseName) fail('Connection identity does not match the newly created database');
  if (external ? !(url.hostname.startsWith(db.id + '.') && url.hostname.endsWith('.render.com')) : url.hostname !== db.id) fail('Connection host does not match the newly created Render database');
  if (url.port && url.port !== '5432') fail('Unexpected Render PostgreSQL port');
  if (external) url.searchParams.set('sslmode', 'require');
  url.searchParams.set('schema', 'public');
  url.searchParams.set('connection_limit', '5');
  url.searchParams.set('pool_timeout', '10');
  return url.toString();
}

function migrationDigest() {
  const entries = [];
  const walk = directory => {
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name);
      if (fs.statSync(file).isDirectory()) walk(file);
      else entries.push(path.relative(ROOT, file), fs.readFileSync(file));
    }
  };
  entries.push(fs.readFileSync(path.join(ROOT, 'prisma/schema.prisma')));
  walk(path.join(ROOT, 'prisma/migrations'));
  return sha(Buffer.concat(entries.map(entry => Buffer.isBuffer(entry) ? entry : Buffer.from(entry))));
}

function releaseReady(c) {
  requireValue(c.RENDER_EXPECTED_COMMIT, 'RENDER_EXPECTED_COMMIT');
  const git = args => {
    const result = spawnSync('git', ['-C', ROOT, ...args], { encoding: 'utf8', timeout: 30000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    if (result.status !== 0) fail('Release Git verification failed; no code was pushed');
    return result.stdout.trim();
  };
  if (git(['rev-parse', 'HEAD']) !== c.RENDER_EXPECTED_COMMIT || git(['branch', '--show-current']) !== c.RENDER_BRANCH) fail('Run from the reviewed release worktree at RENDER_EXPECTED_COMMIT');
  if (git(['status', '--porcelain', '--untracked-files=normal'])) fail('Release worktree must be clean before cloud migration or Web Service creation');
  const remote = git(['ls-remote', c.RENDER_REPO, `refs/heads/${c.RENDER_BRANCH}`]);
  if (remote.split(/\s+/)[0] !== c.RENDER_EXPECTED_COMMIT) fail('The remote staging branch does not match the reviewed commit; this script will not push');
}

function runtimeValues(c, databaseUrl, jwtSecret) {
  requireValue(c.WECHAT_APPID, 'WECHAT_APPID');
  requireValue(c.WECHAT_APP_SECRET, 'WECHAT_APP_SECRET');
  if (jwtSecret.length < 32 || /laorenbang-jwt-secret|change.?me|placeholder/i.test(jwtSecret)) fail('JWT_SECRET must be a separate strong secret of at least 32 characters');
  return {
    NODE_ENV: 'production', HOST: '0.0.0.0', ALLOW_MOCK_PAYMENT: 'false', ALLOW_MOCK_SMS: 'false',
    DATABASE_URL: databaseUrl, DIRECT_URL: databaseUrl, JWT_SECRET: jwtSecret,
    JWT_EXPIRES_IN: c.JWT_EXPIRES_IN || '7d', WECHAT_APPID: c.WECHAT_APPID, WECHAT_APP_SECRET: c.WECHAT_APP_SECRET,
    ...(c.CORS_ORIGIN ? { CORS_ORIGIN: c.CORS_ORIGIN } : {}),
  };
}
function webPayload(c, values) {
  return {
    type: 'web_service', name: c.RENDER_SERVICE_NAME, ownerId: c.RENDER_OWNER_ID,
    repo: c.RENDER_REPO, branch: c.RENDER_BRANCH, rootDir: '.', autoDeployTrigger: 'off',
    envVars: Object.entries(values).map(([key, value]) => ({ key, value })),
    serviceDetails: {
      runtime: 'docker', plan: 'free', region: c.RENDER_REGION, numInstances: 1,
      healthCheckPath: '/api/health',
      envSpecificDetails: { dockerfilePath: './Dockerfile', dockerContext: '.', dockerCommand: '' },
    },
  };
}

async function migrateEmptyDatabase(context, state, db) {
  (context.releaseReady || releaseReady)(context.config);
  if (!state.connections || !fs.existsSync(context.files.migrationEnv)) fail('Run prepare-db before migration');
  // Deliberately parse only the generated private file, never the project .env.
  const entries = Object.fromEntries(privateRead(context.files.migrationEnv).trim().split('\n').map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
  const url = checkedConnection(entries.DATABASE_URL, db, true);
  if (entries.DIRECT_URL !== entries.DATABASE_URL || sha(url) !== state.connections.externalHash) fail('Generated migration connection changed; refusing to connect');
  const { PrismaClient } = require(path.join(ROOT, 'node_modules/@prisma/client'));
  const prisma = new PrismaClient({ datasources: { db: { url } }, log: [] });
  try {
    const [actual] = await prisma.$queryRawUnsafe('SELECT current_database() AS database, current_user AS role');
    if (actual.database !== db.databaseName || actual.role !== db.databaseUser) fail('Connected database identity differs from the newly created database');
    const tables = await prisma.$queryRawUnsafe("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'");
    if (tables.length) fail('New staging database is no longer empty; do not reset or resolve it automatically');
  } finally { await prisma.$disconnect(); }
  if (fs.existsSync(context.files.cli)) fail('Migration CLI workspace already exists; review an earlier attempt before continuing');
  fs.mkdirSync(context.files.cli, { recursive: true, mode: 0o700 });
  privateWrite(path.join(context.files.cli, 'package.json'), '{"private":true}\n');
  fs.copyFileSync(path.join(ROOT, 'prisma/schema.prisma'), path.join(context.files.cli, 'schema.prisma'));
  fs.cpSync(path.join(ROOT, 'prisma/migrations'), path.join(context.files.cli, 'migrations'), { recursive: true });
  const schema = path.join(context.files.cli, 'schema.prisma');
  const env = { PATH: process.env.PATH || '', HOME: process.env.HOME || '', DATABASE_URL: url, DIRECT_URL: url, PRISMA_HIDE_UPDATE_MESSAGE: 'true', CHECKPOINT_DISABLE: '1' };
  for (const args of [
    ['migrate', 'deploy', '--schema', schema],
    ['migrate', 'status', '--schema', schema],
    ['migrate', 'diff', '--from-schema-datasource', schema, '--to-schema-datamodel', schema, '--exit-code', '--script'],
  ]) {
    const result = spawnSync(process.execPath, [path.join(ROOT, 'node_modules/prisma/build/index.js'), ...args], { cwd: context.files.cli, env, encoding: 'utf8', timeout: 120000 });
    if (result.status !== 0) fail(`Controlled Prisma ${args[1]} failed; raw output withheld to protect credentials. Review the new staging database before retrying`);
  }
  state.migration = { databaseId: db.id, commit: context.config.RENDER_EXPECTED_COMMIT, digest: migrationDigest(), verifiedAt: new Date().toISOString() };
  saveState(context, state);
  context.print({ migrated: db.id, schemaDiff: 'empty', commit: state.migration.commit });
}

async function runCommand(command, context) {
  const c = context.config;
  if (command === 'plan') {
    context.print({ mode: 'offline-plan', ...identity(c), expectedCommit: c.RENDER_EXPECTED_COMMIT || null, webPlan: 'free', databasePlan: 'free', databaseVersion: '16', autoDeployTrigger: 'off', NODE_ENV: 'production', ALLOW_MOCK_PAYMENT: 'false', configuredVariableNames: Object.entries(c).filter(([, value]) => value).map(([key]) => key), steps: COMMANDS, changes: 'none' });
    return;
  }
  if (command === 'preflight') {
    const found = await inventory(context);
    context.print({ mode: 'read-only', owners: found.owners.map(safeOwner), services: found.services.map(safeService), databases: found.databases.map(safeDb), targetNameCollisions: [...found.services, ...found.databases].filter(item => [c.RENDER_SERVICE_NAME, c.RENDER_DATABASE_NAME].includes(item.name)).map(item => ({ id: item.id, name: item.name })), changes: 'none' });
    return;
  }
  requireValue(c.RENDER_OWNER_ID, 'RENDER_OWNER_ID');
  if (command === 'create-db') {
    const payload = databasePayload(c);
    if (fs.existsSync(context.files.state)) fail('A creation receipt already exists; use db-status, never silently create another database');
    const found = await inventory(context);
    noCollision(c, found);
    if (found.databases.some(db => ownerOf(db) === c.RENDER_OWNER_ID && db.plan === 'free')) fail('This workspace already has a Free PostgreSQL database; no existing database will be reused, removed, or upgraded');
    const db = await context.api('POST', '/postgres', payload);
    if (!/^dpg-[a-z0-9-]+$/.test(db.id) || db.name !== c.RENDER_DATABASE_NAME || ownerOf(db) !== c.RENDER_OWNER_ID || db.plan !== 'free') fail('Database response differs from the requested new free resource; inspect Render before doing anything else');
    saveState(context, { version: 1, identity: identity(c), database: { id: db.id, createdAt: db.createdAt }, receiptCreatedAt: new Date().toISOString() });
    context.print({ createdDatabase: safeDb(db), next: 'db-status; then prepare-db once available', changes: 'one new free database' });
    return;
  }
  const state = loadState(context);
  if (command === 'status') {
    const db = await ownedDatabase(context, state);
    let service = null;
    let deploy = null;
    if (state.service?.id) {
      if (!/^srv-[a-z0-9]+$/.test(state.service.id)) fail('Invalid service receipt ID');
      const found = await context.api('GET', `/services/${state.service.id}`);
      if (found.id !== state.service.id || found.name !== c.RENDER_SERVICE_NAME || found.ownerId !== c.RENDER_OWNER_ID) fail('Service ownership differs from the creation receipt');
      service = safeService(found);
      if (state.service.deployId) {
        if (!/^dep-[a-z0-9]+$/.test(state.service.deployId)) fail('Invalid deploy receipt ID');
        const result = await context.api('GET', `/services/${state.service.id}/deploys/${state.service.deployId}`);
        if (result.id !== state.service.deployId) fail('Deploy response differs from the creation receipt');
        deploy = { id: result.id, status: result.status, commit: result.commit?.id || null, expectedCommit: state.service.commit, commitMatches: result.commit?.id === state.service.commit, live: result.status === 'live', startedAt: result.startedAt || null, finishedAt: result.finishedAt || null };
      }
    }
    context.print({ database: safeDb(db), service, deploy, changes: 'none' });
    return;
  }
  const db = await ownedDatabase(context, state, command !== 'db-status');
  if (command === 'db-status') { context.print({ database: safeDb(db), changes: 'none' }); return; }
  if (command === 'prepare-db') {
    if (state.migration || state.service) fail('Connections are already in use; refusing to replace deployment credentials');
    const info = await context.api('GET', `/postgres/${db.id}/connection-info`);
    const external = checkedConnection(info.externalConnectionString, db, true);
    const internal = checkedConnection(info.internalConnectionString, db, false);
    privateWrite(context.files.migrationEnv, `DATABASE_URL=${external}\nDIRECT_URL=${external}\n`);
    // Only the newly created database URL is persisted; no existing service env is read.
    privateWrite(context.files.runtimeEnv, `DATABASE_URL=${internal}\nDIRECT_URL=${internal}\n`);
    state.connections = { externalHash: sha(external), internalHash: sha(internal) };
    saveState(context, state);
    context.print({ preparedDatabase: db.id, externalDomain: new URL(external).hostname, internalDomain: new URL(internal).hostname, privateFiles: [context.files.migrationEnv, context.files.runtimeEnv], changes: 'local private files only' });
    return;
  }
  if (command === 'migrate') { await migrateEmptyDatabase(context, state, db); return; }
  if (command === 'create-web') {
    if (state.service) fail('A Web Service creation receipt already exists; this script will not update or redeploy it');
    if (!state.migration || state.migration.databaseId !== db.id || state.migration.commit !== c.RENDER_EXPECTED_COMMIT || state.migration.digest !== migrationDigest()) fail('Verified empty-database migration at this reviewed commit is required before Web Service creation');
    (context.releaseReady || releaseReady)(c);
    const found = await inventory(context);
    if (!found.databases.some(database => database.id === db.id && ownerOf(database) === c.RENDER_OWNER_ID)) fail('New database is missing from the workspace inventory');
    if (found.services.some(service => [c.RENDER_SERVICE_NAME, c.RENDER_DATABASE_NAME].includes(service.name)) || found.databases.some(database => database.name === c.RENDER_SERVICE_NAME || (database.name === c.RENDER_DATABASE_NAME && database.id !== db.id))) fail('A target name already exists; refusing to overwrite or adopt it');
    const line = privateRead(context.files.runtimeEnv).split('\n').find(value => value.startsWith('DATABASE_URL='));
    const internal = checkedConnection(requireValue(line, 'Generated runtime database connection').slice('DATABASE_URL='.length), db, false);
    if (sha(internal) !== state.connections?.internalHash) fail('Runtime database connection changed');
    const values = runtimeValues(c, internal, c.JWT_SECRET || crypto.randomBytes(40).toString('hex'));
    privateWrite(context.files.runtimeEnv, Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n') + '\n');
    const response = await context.api('POST', '/services', webPayload(c, values));
    if (!response.service || !/^srv-[a-z0-9]+$/.test(response.service.id) || response.service.name !== c.RENDER_SERVICE_NAME || response.service.ownerId !== c.RENDER_OWNER_ID || response.service.serviceDetails?.plan !== 'free' || response.service.serviceDetails?.region !== c.RENDER_REGION) fail('Unexpected Web Service creation response; inspect Render before retrying');
    state.service = { id: response.service.id, deployId: response.deployId || null, commit: c.RENDER_EXPECTED_COMMIT };
    saveState(context, state);
    context.print({ createdService: safeService(response.service), deployId: response.deployId || null, envVariableNames: Object.keys(values), changes: 'one new free Web Service; first deployment started' });
    return;
  }
  fail('Unknown deployment command');
}

async function main(args) {
  if (!args.length || args[0] === '--help') {
    console.log('Usage: node scripts/deploy/render-staging.cjs <' + COMMANDS.join('|') + '> [--config /private/.local/render.env]');
    return;
  }
  const [command, flag, configFile] = args;
  if (!COMMANDS.includes(command) || (flag && (flag !== '--config' || !configFile)) || args.length > 3) fail('Invalid command arguments');
  if (Number(process.versions.node.split('.')[0]) !== 22) fail('Use the reviewed Node 22 runtime');
  await runCommand(command, loadContext(configFile || DEFAULT_CONFIG, { optional: command === 'plan' }));
}

module.exports = { parseEnv, validateConfig, createClient, databasePayload, checkedConnection, runtimeValues, webPayload, loadContext, runCommand, migrationDigest, main };
if (require.main === module) main(process.argv.slice(2)).catch(error => {
  // All intentional errors are fixed messages; never print raw API/Prisma errors or stacks.
  const safe = error instanceof DeploymentError ? error.message : 'Deployment stopped; sensitive error details withheld';
  console.error(safe);
  process.exitCode = 1;
});
