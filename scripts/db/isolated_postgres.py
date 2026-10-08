#!/usr/bin/env python3
"""Operate only the dedicated loopback integration database; never load .env."""
import argparse
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import sys
import time
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[2]
LOCAL = ROOT / '.local'
ENV_FILE = LOCAL / 'isolated-postgres.env'
CONTAINER_ENV = LOCAL / 'postgres-container.env'
CLI_DIR = LOCAL / 'prisma-cli'
CONTAINER = 'lrb-integration-20261008'
DB = USER = 'lrb_integration'
PORT = 55432
DOCKER = ['/usr/local/bin/docker', '--host', 'unix://' + str(Path.home() / '.docker/run/docker.sock')]
NODE = Path(os.environ.get('LRB_NODE_BIN', shutil.which('node') or str(Path.home() / '.nvm/versions/node/v22.22.0/bin/node')))


def private_file(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, 'w') as handle:
        handle.write(text)


def credentials():
    values = {}
    for line in ENV_FILE.read_text().splitlines():
        key, value = line.split('=', 1)
        values[key] = value
    for key in ['DATABASE_URL', 'DIRECT_URL']:
        parsed = urlparse(values[key])
        if (parsed.scheme != 'postgresql' or parsed.hostname != '127.0.0.1' or parsed.port != PORT
                or parsed.username != USER or parsed.path != '/' + DB or not parsed.password):
            raise RuntimeError('Refusing a database outside the dedicated local integration identity')
    return values


def run(command, *, env=None, cwd=None, check=True, echo=True):
    result = subprocess.run(command, env=env, cwd=cwd, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    output = result.stdout
    if ENV_FILE.exists():
        values = credentials()
        for value in values.values():
            output = output.replace(value, '[isolated database URL]')
        password = urlparse(values['DATABASE_URL']).password
        if password:
            output = output.replace(password, '[redacted]')
    if echo and output.strip():
        print(output.strip(), flush=True)
    if check and result.returncode:
        raise RuntimeError('Command failed with exit status ' + str(result.returncode))
    return result.returncode, output


def start():
    LOCAL.mkdir(mode=0o700, exist_ok=True)
    os.chmod(LOCAL, 0o700)
    (LOCAL / '.gitignore').write_text('*\n')
    _, existing = run(DOCKER + ['inspect', '--format', '{{index .Config.Labels "lrb.purpose"}}', CONTAINER], check=False, echo=False)
    if existing.strip() == 'isolated-integration':
        credentials()
        run(DOCKER + ['start', CONTAINER], echo=False)
    else:
        if 'no such object' not in existing.lower() and 'no such container' not in existing.lower():
            raise RuntimeError('Refusing to replace an existing container or use an unavailable Docker daemon')
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', PORT))
        password = secrets.token_hex(32)
        url = f'postgresql://{USER}:{password}@127.0.0.1:{PORT}/{DB}?schema=public&connection_limit=10&pool_timeout=10'
        private_file(ENV_FILE, f'DATABASE_URL={url}\nDIRECT_URL={url}\n')
        private_file(CONTAINER_ENV, f'POSTGRES_USER={USER}\nPOSTGRES_DB={DB}\nPOSTGRES_PASSWORD={password}\nPOSTGRES_INITDB_ARGS=--auth-host=scram-sha-256\n')
        data = LOCAL / 'postgres-data'
        data.mkdir(mode=0o700, exist_ok=True)
        run(DOCKER + ['run', '--detach', '--name', CONTAINER, '--label', 'lrb.purpose=isolated-integration',
                      '--env-file', str(CONTAINER_ENV), '--publish', f'127.0.0.1:{PORT}:5432',
                      '--mount', f'type=bind,source={data},target=/var/lib/postgresql/data', 'postgres:16-alpine'], echo=False)
    for _ in range(60):
        code, _ = run(DOCKER + ['exec', CONTAINER, 'pg_isready', '-h', '127.0.0.1', '-U', USER, '-d', DB], check=False, echo=False)
        if code == 0:
            print(json.dumps({'container': CONTAINER, 'host': '127.0.0.1', 'port': PORT, 'database': DB, 'role': USER,
                              'envFile': str(ENV_FILE), 'binding': 'loopback only'}), flush=True)
            return
        time.sleep(1)
    raise RuntimeError('Isolated PostgreSQL did not become ready')


def cli_env():
    version = subprocess.run([str(NODE), '--version'], capture_output=True, text=True, check=True).stdout.strip()
    if not version.startswith('v22.'):
        raise RuntimeError('Node22 is required; set LRB_NODE_BIN to the reviewed runtime')
    env = dict(os.environ)
    env.update(credentials())
    env['PRISMA_HIDE_UPDATE_MESSAGE'] = 'true'
    return env


def prepare_cli():
    CLI_DIR.mkdir(parents=True, exist_ok=True)
    # A separate package root prevents Prisma from discovering the repository's .env.
    (CLI_DIR / 'package.json').write_text('{"private":true}\n')
    shutil.copyfile(ROOT / 'prisma/schema.prisma', CLI_DIR / 'schema.prisma')
    return [str(NODE), str(ROOT / 'node_modules/prisma/build/index.js')]


def sync_migrations(baseline_only=False):
    destination = CLI_DIR / 'migrations'
    destination.mkdir(exist_ok=True)
    shutil.copyfile(ROOT / 'prisma/migrations/migration_lock.toml', destination / 'migration_lock.toml')
    for migration in (ROOT / 'prisma/migrations').iterdir():
        if migration.is_dir() and (not baseline_only or migration.name == '20260120_baseline'):
            shutil.copytree(migration, destination / migration.name, dirs_exist_ok=True)


def migrate():
    cli = prepare_cli()
    baseline = ROOT / 'prisma/migrations/20260120_baseline/migration.sql'
    if not baseline.exists():
        raise RuntimeError('The reviewed repository baseline migration is required')
    # Deploy only the baseline first so the additive identity migration is checked
    # against actual pre-existing rows, not merely a completely empty final schema.
    sync_migrations(baseline_only=True)
    run(cli + ['migrate', 'deploy', '--schema', str(CLI_DIR / 'schema.prisma')], env=cli_env(), cwd=CLI_DIR)
    legacy_sql = '''
INSERT INTO "users" ("id", "phone", "name", "updatedAt")
VALUES ('migration-legacy-child', '13800000001', '隔离迁移虚构子女', NOW()) ON CONFLICT ("id") DO NOTHING;
INSERT INTO "angels" ("id", "phone", "name", "updatedAt")
VALUES ('migration-legacy-angel', '13800000002', '隔离迁移虚构天使', NOW()) ON CONFLICT ("id") DO NOTHING;
INSERT INTO "elderly" ("id", "name", "phone", "relation", "address", "inviteCode", "userId", "updatedAt")
VALUES ('migration-legacy-elderly', '隔离迁移虚构老人', '13800000003', '父亲', '隔离测试地址', 'C859FD56', 'migration-legacy-child', NOW())
ON CONFLICT ("id") DO NOTHING;
'''
    run(DOCKER + ['exec', '--interactive', CONTAINER, 'psql', '-U', USER, '-d', DB, '-v', 'ON_ERROR_STOP=1', '-c', legacy_sql], echo=False)
    sync_migrations()
    run(cli + ['migrate', 'deploy', '--schema', str(CLI_DIR / 'schema.prisma')], env=cli_env(), cwd=CLI_DIR)
    check()


def check():
    cli = prepare_cli()
    run(cli + ['migrate', 'status', '--schema', str(CLI_DIR / 'schema.prisma')], env=cli_env(), cwd=CLI_DIR)
    run(cli + ['migrate', 'diff', '--from-schema-datasource', str(CLI_DIR / 'schema.prisma'),
               '--to-schema-datamodel', str(CLI_DIR / 'schema.prisma'), '--exit-code', '--script'], env=cli_env(), cwd=CLI_DIR)
    print('Verified: migration history is current and PostgreSQL matches the canonical Prisma schema.', flush=True)


def test():
    env = cli_env()
    env.update({'LRB_INTEGRATION_DB': 'true', 'NODE_ENV': 'development', 'ALLOW_MOCK_PAYMENT': 'true', 'WECHAT_PAY_ENABLED': 'false', 'WECHAT_TRANSFER_ENABLED': 'false'})
    run([str(NODE), '--require', 'ts-node/register/transpile-only', '--test', 'test/integration/postgres.test.ts'], env=env, cwd=ROOT)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('command', choices=['start', 'migrate', 'check', 'test'])
    args = parser.parse_args()
    try:
        globals()[args.command]()
    except Exception as error:
        # Do not print exception text, environment dictionaries or connection URLs.
        print('Isolated database operation failed: ' + type(error).__name__, file=sys.stderr)
        sys.exit(1)
