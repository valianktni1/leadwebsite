#!/usr/bin/env python3
"""Copy only an existing Highleads Apify token into Leadwebsite's private import file.

Run on TrueNAS as an administrator. No token or unrelated environment value is printed.
The app consumes the import file into encrypted storage on the next settings read/search.
"""
import os
import pathlib
import re
import tempfile

SOURCE = pathlib.Path('/mnt/apps/dockge/data/highleads')
TARGET = pathlib.Path('/mnt/apps/leadwebsite/config')

def value(text):
    match = re.search(r'^\s*(?:-\s*)?APIFY_TOKEN\s*[:=]\s*(.*?)\s*$', text, re.M)
    if not match:
        return None
    token = match.group(1).strip()
    if token[:1] in ('"', "'") and token[-1:] == token[:1]:
        return token[1:-1]
    return token.split(' #', 1)[0].strip()

def main():
    compose = next((p for p in [SOURCE/'compose.yaml', SOURCE/'compose.yml', SOURCE/'docker-compose.yml'] if p.is_file()), None)
    if compose is None:
        raise SystemExit('Highleads Compose file not found at the expected Dockge path. No changes made.')
    token = value(compose.read_text())
    if not token or token.startswith('${'):
        envfile = SOURCE/'.env'
        token = value(envfile.read_text()) if envfile.is_file() else None
    if not token or not re.fullmatch(r'[A-Za-z0-9_-]{16,256}', token):
        raise SystemExit('No usable APIFY_TOKEN was found in Highleads Compose or .env. No changes made.')
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
