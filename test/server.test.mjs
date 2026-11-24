import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../server.mjs';

test('demo publishing, routing, authentication and file boundaries', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'leadwebsites-'));
  const server = await createApp({ dataDir: dir, password: 'test-password-unique-123', publicURL: 'https://websites.ivorydigital.uk' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await fs.rm(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const auth = `Basic ${Buffer.from('admin:test-password-unique-123').toString('base64')}`;
  const upload = body => fetch(`${base}/api/demos`, { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const content = '<!doctype html><h1>Willow & Stone</h1><link rel="stylesheet" href="./assets/site.css">';
  const body = { name: 'Willow & Stone', slug: 'willow-and-stone', files: [{ path: 'index.html', content: Buffer.from(content).toString('base64') }, { path: 'assets/site.css', content: Buffer.from('body{color:green}').toString('base64') }] };

  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  assert.match(await (await fetch(base)).text(), /Site designed by Ivory Digital/);
  assert.equal((await fetch(`${base}/api/demos`)).status, 401);
  assert.equal((await fetch(`${base}/admin`)).status, 401);
  const dashboard = await fetch(`${base}/admin`, { headers: { Authorization: auth } });
  assert.equal(dashboard.status, 200);
  assert.match(dashboard.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(dashboard.headers.get('cache-control'), 'no-store');
  assert.match(await dashboard.text(), /Demo studio/);
  const created = await upload(body);
  assert.equal(created.status, 201);
  assert.equal((await created.json()).url, 'https://websites.ivorydigital.uk/willow-and-stone/');
  const list = await (await fetch(`${base}/api/demos`, { headers: { Authorization: auth } })).json();
  assert.equal(list.demos.length, 1); assert.equal(list.demos[0].name, body.name);
  const redirect = await fetch(`${base}/willow-and-stone`, { redirect: 'manual' });
  assert.equal(redirect.status, 308); assert.equal(redirect.headers.get('location'), '/willow-and-stone/');
  const demo = await fetch(`${base}/willow-and-stone/`);
  assert.equal(await demo.text(), content);
  assert.match(demo.headers.get('content-security-policy'), /sandbox/);
  assert.equal(demo.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive');
  assert.equal(await (await fetch(`${base}/willow-and-stone/assets/site.css`)).text(), 'body{color:green}');
  assert.equal((await fetch(`${base}/willow-and-stone/`, { method: 'HEAD' })).headers.get('content-length'), String(Buffer.byteLength(content)));
  assert.equal((await upload(body)).status, 409);
  assert.equal((await upload({ ...body, slug: 'admin' })).status, 400);
  assert.equal((await upload({ ...body, slug: 'no-index', files: [body.files[1]] })).status, 400);
  assert.equal((await upload({ ...body, slug: 'unsafe', files: [...body.files, { path: '../secret.txt', content: '' }] })).status, 400);
  assert.equal((await upload({ ...body, slug: 'unsafe', files: [...body.files, { path: 'assets\\secret.txt', content: '' }] })).status, 400);
  assert.equal((await fetch(`${base}/willow-and-stone/.demo.json`)).status, 404);
  assert.equal((await fetch(`${base}/willow-and-stone/%2e%2e%2fserver.mjs`)).status, 404);
  assert.equal((await fetch(`${base}/willow-and-stone/%ZZ`)).status, 400);
  assert.equal((await fetch(`${base}/api/demos`, { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json', Origin: 'null' }, body: JSON.stringify({ ...body, slug: 'cross-site' }) })).status, 403);
  assert.equal((await fetch(`${base}/missing-company/`)).status, 404);
  // Direct filesystem updates are discovered without restarting the app.
  await fs.mkdir(path.join(dir, 'manual-company'));
  await fs.writeFile(path.join(dir, 'manual-company/index.html'), '<h1>Manual</h1>');
  assert.equal((await fetch(`${base}/manual-company/`)).status, 200);
  const updated = await (await fetch(`${base}/api/demos`, { headers: { Authorization: auth } })).json();
  assert.equal(updated.demos.length, 2);
});

test('refuses to run without a strong admin password', async () => {
  await assert.rejects(createApp({ password: 'short' }), /at least 16/);
});
