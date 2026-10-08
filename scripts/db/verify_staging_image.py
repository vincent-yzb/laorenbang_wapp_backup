#!/usr/bin/env python3
"""Run the built image against this task's isolated DB without production secrets."""
import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import secrets
import socket
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse, urlunparse
from urllib.request import Request, urlopen

from isolated_postgres import DOCKER, LOCAL, CONTAINER as DB_CONTAINER, credentials, private_file, run

NETWORK = 'lrb-staging-network-20261008'
API_CONTAINER = 'lrb-staging-api-20261008'
IMAGE = 'laorenbang-backend:staging'
API_PORT = 3102
ENV_FILE = LOCAL / 'docker-staging.env'
LABEL = 'isolated-staging-image'


def request(path, method='GET', body=None, token=None):
    headers = {'Content-Type': 'application/json'}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    req = Request(f'http://127.0.0.1:{API_PORT}/api{path}', method=method, headers=headers,
                  data=None if body is None else json.dumps(body).encode())
    try:
        with urlopen(req, timeout=3) as response:
            return response.status, json.load(response)
    except HTTPError as error:
        try:
            body = json.load(error)
        except (ValueError, OSError):
            body = None
        return error.code, body


def short_token(secret):
    encode = lambda data: base64.urlsafe_b64encode(data).rstrip(b'=')
    now = int(time.time())
    header = encode(json.dumps({'alg': 'HS256', 'typ': 'JWT'}, separators=(',', ':')).encode())
    payload = encode(json.dumps({'sub': 'migration-legacy-child', 'userType': 'child', 'iat': now, 'exp': now + 300}, separators=(',', ':')).encode())
    unsigned = header + b'.' + payload
    signature = encode(hmac.new(secret.encode(), unsigned, hashlib.sha256).digest())
    return (unsigned + b'.' + signature).decode()


def check_status(label, actual, expected):
    if actual != expected:
        print(json.dumps({'check': label, 'actualStatus': actual, 'expectedStatus': expected}), flush=True)
        raise RuntimeError('Image HTTP verification failed')
    print(json.dumps({'check': label, 'status': actual}), flush=True)


def main():
    original = credentials()  # Enforces the source URL is the dedicated loopback DB.
    _, db_label = run(DOCKER + ['inspect', '--format', '{{index .Config.Labels "lrb.purpose"}}', DB_CONTAINER], echo=False)
    if db_label.strip() != 'isolated-integration':
        raise RuntimeError('The task-owned isolated database container is required')
    _, image_user = run(DOCKER + ['image', 'inspect', IMAGE, '--format', '{{.Config.User}}'], echo=False)
    if image_user.strip() in ['', 'root', '0', '0:0']:
        raise RuntimeError('Refusing to validate a root-user runtime image')
    _, expected_image = run(DOCKER + ['image', 'inspect', IMAGE, '--format', '{{.Id}}'], echo=False)

    code, network = run(DOCKER + ['network', 'inspect', NETWORK, '--format', '{{index .Labels "lrb.purpose"}}'], check=False, echo=False)
    if code:
        run(DOCKER + ['network', 'create', '--driver', 'bridge', '--label', 'lrb.purpose=' + LABEL, NETWORK], echo=False)
    elif network.strip() != LABEL:
        raise RuntimeError('Refusing to reuse an unrelated Docker network')
    _, connections = run(DOCKER + ['inspect', DB_CONTAINER, '--format', '{{json .NetworkSettings.Networks}}'], echo=False)
    if NETWORK not in json.loads(connections):
        run(DOCKER + ['network', 'connect', '--alias', 'db', NETWORK, DB_CONTAINER], echo=False)

    code, api_label = run(DOCKER + ['inspect', '--format', '{{index .Config.Labels "lrb.purpose"}}', API_CONTAINER], check=False, echo=False)
    if code:
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', API_PORT))
        parsed = urlparse(original['DATABASE_URL'])
        docker_url = urlunparse(parsed._replace(netloc=f'{parsed.username}:{parsed.password}@db:5432'))
        values = {
            'DATABASE_URL': docker_url, 'DIRECT_URL': docker_url, 'JWT_SECRET': secrets.token_hex(32),
            'NODE_ENV': 'production', 'HOST': '0.0.0.0', 'PORT': '3001',
            'ALLOW_MOCK_PAYMENT': 'false', 'ALLOW_MOCK_SMS': 'false',
            'WECHAT_APPID': '', 'WECHAT_APP_SECRET': '', 'WECHAT_MCH_ID': '', 'WECHAT_PAY_KEY': '',
        }
        private_file(ENV_FILE, ''.join(f'{key}={value}\n' for key, value in values.items()))
        run(DOCKER + ['run', '--detach', '--name', API_CONTAINER, '--label', 'lrb.purpose=' + LABEL,
                      '--network', NETWORK, '--env-file', str(ENV_FILE),
                      '--publish', f'127.0.0.1:{API_PORT}:3001', IMAGE], echo=False)
    elif api_label.strip() != LABEL:
        raise RuntimeError('Refusing to replace an unrelated API container')
    else:
        values = dict(line.split('=', 1) for line in ENV_FILE.read_text().splitlines())
        _, connections = run(DOCKER + ['inspect', API_CONTAINER, '--format', '{{json .NetworkSettings.Networks}}'], echo=False)
        if NETWORK not in json.loads(connections):
            run(DOCKER + ['network', 'connect', NETWORK, API_CONTAINER], echo=False)
            run(DOCKER + ['restart', API_CONTAINER], echo=False)
        run(DOCKER + ['start', API_CONTAINER], echo=False)
    _, actual_image = run(DOCKER + ['inspect', '--format', '{{.Image}}', API_CONTAINER], echo=False)
    if actual_image.strip() != expected_image.strip():
        raise RuntimeError('The retained API container uses a different image; review an explicit recreation before validating the new tag')
    for _ in range(45):
        try:
            status, _ = request('/health')
            if status == 200:
                break
        except (URLError, TimeoutError, OSError):
            pass
        time.sleep(1)
    else:
        raise RuntimeError('The actual image entrypoint did not become healthy')
    check_status('health', status, 200)
    status, catalog = request('/services/types')
    check_status('service catalog', status, 200)
    items = catalog.get('data') if isinstance(catalog, dict) else catalog
    if not isinstance(items, list) or len(items) != 9:
        print(json.dumps({'check': 'catalog count', 'actualCount': len(items) if isinstance(items, list) else None, 'expectedCount': 9}), flush=True)
        raise RuntimeError('The image does not expose the isolated 9-item catalog')
    print(json.dumps({'check': 'catalog count', 'count': len(items)}), flush=True)
    check_status('payment unauthenticated', request('/payment/create', 'POST', {'orderId': 'isolated-image-check'})[0], 401)
    token = short_token(values['JWT_SECRET'])
    check_status('production payment mock disabled', request('/payment/create', 'POST', {'orderId': 'isolated-image-check'}, token)[0], 503)
    check_status('production SMS mock disabled', request('/auth/send-code', 'POST', {'phone': '13800000001', 'type': 'child'})[0], 503)
    check_status('missing WeChat configuration closed', request('/auth/wechat-login', 'POST', {'code': 'isolated-image-check', 'userType': 'child'})[0], 503)
    _, uid = run(DOCKER + ['exec', API_CONTAINER, 'node', '-e',
        "const s=require('node:fs').readFileSync('/proc/1/status','utf8');process.stdout.write(s.match(/^Uid:\\s+(\\d+)/m)[1])"], echo=False)
    if not uid.strip().isdigit() or int(uid.strip()) == 0:
        raise RuntimeError('The actual API process is running as root')
    for _ in range(45):
        _, health = run(DOCKER + ['inspect', '--format', '{{.State.Health.Status}}', API_CONTAINER], echo=False)
        if health.strip() == 'healthy':
            break
        time.sleep(1)
    else:
        raise RuntimeError('Docker healthcheck did not become healthy')
    _, bindings = run(DOCKER + ['inspect', '--format', '{{json .HostConfig.PortBindings}}', API_CONTAINER], echo=False)
    if json.loads(bindings) != {'3001/tcp': [{'HostIp': '127.0.0.1', 'HostPort': str(API_PORT)}]}:
        raise RuntimeError('Unexpected public interface binding')
    print(json.dumps({'container': API_CONTAINER, 'network': NETWORK, 'image': IMAGE, 'imageId': actual_image.strip(), 'pid1Uid': int(uid.strip()),
                      'dockerHealth': health.strip(), 'baseUrl': f'http://127.0.0.1:{API_PORT}/api',
                      'envFile': str(ENV_FILE), 'keptRunning': True}), flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Never print connection settings, JWT values, headers or environment bodies.
        reason = str(error) if isinstance(error, RuntimeError) else type(error).__name__
        print('Staging image verification failed: ' + reason, file=sys.stderr)
        sys.exit(1)
