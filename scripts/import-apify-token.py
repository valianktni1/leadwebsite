#!/usr/bin/env python3
"""Copy only an existing Highleads Apify token into Leadwebsite's private import file.

Run on TrueNAS as an administrator. No token or unrelated environment value is printed.
The app consumes the import file into encrypted storage on the next settings read/search.
"""
import os
import json
import pathlib
import re
import subprocess
import tempfile

SOURCE = pathlib.Path('/mnt/apps/dockge/data/highleads')
TARGET = pathlib.Path('/mnt/apps/leadwebsite/config')
KEYS = ('APIFY_TOKEN', 'APIFY_API_TOKEN', 'APIFY_API_KEY', 'APIFY_KEY')

def usable(token):
    return bool(token and re.fullmatch(r'[A-Za-z0-9_-]{16,256}', token)
                and not any(word in token.lower() for word in ('paste-your', 'replace-with', 'your-token', 'your-actual', 'example-token')))

def value(text):
    for line in text.splitlines():
        match = re.match(r'^\s*(?:-\s*)?(?:export\s+)?(?:' + '|'.join(KEYS) + r')\s*[:=]\s*(.*?)\s*$', line)
        if not match:
            continue
        raw = match.group(1).strip()
        if raw[:1] in ('"', "'"):
            token = raw[1:].split(raw[0], 1)[0]
        else:
            token = raw.split(' #', 1)[0].strip()
        if usable(token):
            return token
    return None

def docker_output(args):
    try:
        result = subprocess.run(['docker', *args], capture_output=True, text=True, timeout=20, check=False)
        return result.stdout if result.returncode == 0 else ''
    except (OSError, subprocess.TimeoutExpired):
        return ''

def container_token():
    # Scope inspection to the known Highleads project, plus its known container names.
    ids = docker_output(['ps', '-aq', '--filter', 'label=com.docker.compose.project=highleads']).split()
    candidates = list(dict.fromkeys(ids + ['highleads-highleads-1', 'highleads']))
    for container in candidates:
        output = docker_output(['inspect', '--format', '{{json .Config.Env}}', container])
        if not output:
            continue
        try:
            environment = json.loads(output)
        except (ValueError, TypeError):
            continue
        if isinstance(environment, list):
            token = value('\n'.join(item for item in environment if isinstance(item, str)))
            if token:
                return token
    return None

def main():
    compose = next((p for p in [SOURCE/'compose.yaml', SOURCE/'compose.yml', SOURCE/'docker-compose.yml'] if p.is_file()), None)
    token = container_token()
    if not token and compose is not None:
        token = value(compose.read_text())
    if not token:
        envfile = SOURCE/'.env'
        token = value(envfile.read_text()) if envfile.is_file() else None
    if not usable(token):
        raise SystemExit('No usable Apify token found in the Highleads container, Compose or .env. No changes made. Enter your existing token directly in Leadwebsite Search settings; do not paste it into chat.')
    if not TARGET.is_dir():
        raise SystemExit('Leadwebsite config folder is missing. Create it before importing. No changes made.')
    destination = TARGET/'apify-token.import'
    if destination.exists():
        raise SystemExit('An import file already exists. Let the app consume it before importing again.')
    handle, temp = tempfile.mkstemp(prefix='.apify-import-', dir=TARGET)
    try:
        os.fchmod(handle, 0o600)
        os.fchown(handle, 1000, 1000)
        with os.fdopen(handle, 'w') as stream:
            stream.write(token)
        os.rename(temp, destination)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)
    print('Apify token imported privately. Open Search settings in the updated app to finish encrypted storage.')

if __name__ == '__main__':
    main()
