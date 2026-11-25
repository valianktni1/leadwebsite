import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../server.mjs';
import nodemailer from 'nodemailer';

const email = 'owner@example.com', password = 'test-password-unique-123';
async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'leadwebsites-'));
  const data = path.join(root, 'demos'), config = path.join(root, 'config');
  let server, base, cookie = '';
  const start = async () => {
    server = await createApp({ dataDir: data, configDir: config, publicURL: 'https://websites.ivorydigital.uk', seedDir: false, ...options });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${server.address().port}`;
  };
  await start();
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await fs.rm(root, { recursive: true, force: true }); });
  return {
    data, config, get base() { return base; }, get cookie() { return cookie; },
    async api(route, body, custom = {}) {
      const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST', headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { Origin: 'https://websites.ivorydigital.uk', 'Content-Type': 'application/json' }), ...custom }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
      return response;
    },
    async setup() { const response = await this.api('/api/auth/setup', { email, password }); assert.equal(response.status, 201); return response; },
    async restart() { await new Promise(resolve => server.close(resolve)); await start(); }
  };
}

test('first-run setup, login/logout, password hashing and persistence', async t => {
  const f = await fixture(t);
  assert.equal((await fetch(f.base, { redirect: 'manual' })).headers.get('location'), '/admin');
  assert.equal((await (await f.api('/api/auth/status')).json()).needsSetup, true);
  assert.match(await (await f.api('/admin')).text(), /Create admin account|auth-form/);
  assert.equal((await f.api('/api/demos')).status, 401);
  assert.equal((await f.api('/api/auth/setup', { email, password: 'short' })).status, 400);
  const setup = await f.setup();
  assert.match(setup.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.match(setup.headers.get('set-cookie'), /Secure/);
  assert.equal((await (await f.api('/api/auth/status')).json()).email, email);
  assert.equal((await f.api('/api/auth/setup', { email: 'other@example.com', password })).status, 409);
  const stored = await fs.readFile(path.join(f.config, 'settings.json'), 'utf8');
  assert.equal(stored.includes(password), false); assert.equal(JSON.parse(stored).admin.hash.length, 128);
  assert.match(await (await f.api('/admin')).text(), /Email settings/);
  assert.equal((await f.api('/admin')).headers.get('cache-control'), 'no-store');
  await f.api('/api/auth/logout', {});
  assert.equal((await f.api('/api/demos')).status, 401);
  assert.equal((await f.api('/api/auth/login', { email, password: 'incorrect' })).status, 401);
  assert.equal((await f.api('/api/auth/login', { email, password })).status, 200);
  await f.restart();
  assert.equal((await (await f.api('/api/auth/status')).json()).needsSetup, false);
  assert.equal((await f.api('/api/demos')).status, 401);
  assert.equal((await f.api('/api/auth/login', { email: email.toUpperCase(), password })).status, 200);
  assert.equal((await f.api('/api/demos')).status, 200);
});

test('setup is single use even for simultaneous requests; origins and brute force blocked', async t => {
  const f = await fixture(t);
  assert.equal((await f.api('/api/auth/setup', { email, password }, { Origin: 'null' })).status, 403);
  const results = await Promise.all([f.api('/api/auth/setup', { email, password }), f.api('/api/auth/setup', { email, password })]);
  assert.deepEqual(results.map(r => r.status).sort(), [201, 409]);
  for (let i = 0; i < 16; i++) await f.api('/api/auth/login', { email, password: 'incorrect' });
  assert.equal((await f.api('/api/auth/login', { email, password })).status, 429);
});

test('demo uploads, assets, traversal protection and direct filesystem discovery', async t => {
  const f = await fixture(t); await f.setup();
  const content = '<h1>Willow & Stone</h1><link rel="stylesheet" href="./assets/site.css">';
  const body = { name: 'Willow & Stone', slug: 'willow-and-stone', files: [{ path: 'index.html', content: Buffer.from(content).toString('base64') }, { path: 'assets/site.css', content: Buffer.from('body{color:green}').toString('base64') }] };
  assert.equal((await fetch(`${f.base}/healthz`)).status, 200);
  assert.match(await (await fetch(f.base)).text(), /Site designed by Ivory Digital/);
  const created = await f.api('/api/demos', body); assert.equal(created.status, 201);
  assert.equal((await created.json()).url, 'https://websites.ivorydigital.uk/willow-and-stone/');
  const list = await (await f.api('/api/demos')).json(); assert.equal(list.demos.length, 1); assert.equal(list.demos[0].name, body.name);
  const redirect = await fetch(`${f.base}/willow-and-stone`, { redirect: 'manual' }); assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.get('location'), '/willow-and-stone/');
  const demo = await fetch(`${f.base}/willow-and-stone/`); assert.equal(await demo.text(), content);
  assert.match(demo.headers.get('content-security-policy'), /sandbox/);
  assert.equal(demo.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive');
  assert.equal(await (await fetch(`${f.base}/willow-and-stone/assets/site.css`)).text(), 'body{color:green}');
  assert.equal((await fetch(`${f.base}/willow-and-stone/`, { method: 'HEAD' })).headers.get('content-length'), String(Buffer.byteLength(content)));
  assert.equal((await f.api('/api/demos', body)).status, 409);
  assert.equal((await f.api('/api/demos', { ...body, slug: 'admin' })).status, 400);
  assert.equal((await f.api('/api/demos', { ...body, slug: 'no-index', files: [body.files[1]] })).status, 400);
  for (const badPath of ['../secret.txt', 'assets\\secret.txt', '.demo.json']) assert.equal((await f.api('/api/demos', { ...body, slug: 'unsafe', files: [...body.files, { path: badPath, content: '' }] })).status, 400);
  assert.equal((await fetch(`${f.base}/willow-and-stone/.demo.json`)).status, 404);
  assert.equal((await fetch(`${f.base}/willow-and-stone/%2e%2e%2fserver.mjs`)).status, 404);
  assert.equal((await fetch(`${f.base}/willow-and-stone/%ZZ`)).status, 400);
  assert.equal((await f.api('/api/demos', body, { Origin: 'null' })).status, 403);
  await fs.mkdir(path.join(f.data, 'manual-company')); await fs.writeFile(path.join(f.data, 'manual-company/index.html'), '<h1>Manual</h1>');
  assert.equal((await fetch(`${f.base}/manual-company/`)).status, 200);
  assert.equal((await (await f.api('/api/demos')).json()).demos.length, 2);
});

test('encrypted SMTP settings, password retention, test and demo messages, delivery failures', async t => {
  const calls = []; let fail = false;
  const f = await fixture(t, { mailTransport: settings => ({ async sendMail(message) { calls.push({ settings, message }); if (fail) throw new Error('Sensitive server diagnostic'); return { accepted: [message.to.address], rejected: [] }; } }) });
  assert.equal((await f.api('/api/settings/smtp')).status, 401); await f.setup();
  assert.equal((await f.api('/api/email/test', {})).status, 400);
  const settings = { host: 'smtp.example.com', port: 587, security: 'starttls', fromName: 'Ivory Digital', fromEmail: 'hello@example.com', username: 'hello@example.com', password: 'mail-test-secret-123' };
  assert.equal((await f.api('/api/settings/smtp', settings)).status, 200);
  const saved = await (await f.api('/api/settings/smtp')).json(); assert.equal(saved.passwordSaved, true); assert.equal(saved.password, undefined); assert.equal(saved.secret, undefined);
  assert.equal((await fs.readFile(path.join(f.config, 'settings.json'), 'utf8')).includes(settings.password), false);
  assert.equal((await f.api('/api/settings/smtp', { ...settings, password: '', fromName: 'New name' })).status, 200);
  assert.equal((await f.api('/api/settings/smtp', { ...settings, host: 'other.example.com', password: '' })).status, 400);
  assert.equal((await f.api('/api/settings/smtp', { ...settings, security: 'none' })).status, 400);
  assert.equal((await f.api('/api/email/test', {})).status, 200);
  assert.equal(calls[0].message.to.address, email); assert.equal(calls[0].settings.auth.pass, settings.password);
  assert.equal(calls[0].settings.requireTLS, true); assert.equal(calls[0].settings.secure, false);
  await fs.mkdir(path.join(f.data, 'company')); await fs.writeFile(path.join(f.data, 'company/index.html'), '<h1>Company</h1>');
  const message = { to: 'lead@example.com', subject: 'Your new website', message: 'Please take a look.', slug: 'company' };
  assert.equal((await f.api('/api/email/send', message)).status, 200);
  assert.match(calls[1].message.text, /https:\/\/websites.ivorydigital.uk\/company\//);
  assert.equal((await f.api('/api/email/send', { ...message, to: 'a@example.com,b@example.com' })).status, 400);
  assert.equal((await f.api('/api/email/send', { ...message, subject: 'Subject\r\nBcc: x@example.com' })).status, 400);
  assert.equal((await f.api('/api/email/send', { ...message, slug: 'missing' })).status, 404);
  await fs.mkdir(path.join(f.data, 'studio'));
  await fs.writeFile(path.join(f.data, 'studio/index.html'), '<h1>Studio</h1>');
  const draft = { to: message.to, subject: message.subject, message: 'Edited introduction.' };
  for (const slugs of [[], ['studio'], ['studio', 'company']]) {
    assert.equal((await f.api('/api/email/send', { ...draft, slugs })).status, 200);
    const sent = calls.at(-1).message;
    assert.ok(sent.text.startsWith(draft.message));
    assert.deepEqual(sent.text.match(/https:\/\/[^\s]+/g) || [], slugs.map(slug => `https://websites.ivorydigital.uk/${slug}/`));
  }
  const before = calls.length;
  for (const slugs of [['studio', 'studio'], ['studio', 'company', 'third'], 'studio']) {
    assert.equal((await f.api('/api/email/send', { ...draft, slugs })).status, 400);
  }
  assert.equal((await f.api('/api/email/send', { ...draft, slugs: ['studio', 'missing'] })).status, 404);
  assert.equal(calls.length, before);
  await f.restart(); await f.api('/api/auth/login', { email, password });
  assert.equal((await f.api('/api/email/test', {})).status, 200);
  assert.equal(calls.at(-1).settings.auth.pass, settings.password);
  fail = true; const failure = await f.api('/api/email/test', {}); assert.equal(failure.status, 502); assert.equal((await failure.text()).includes('Sensitive'), false);
});

test('saved sales sender reaches actual MIME headers and envelope for both send routes', async t => {
  const deliveries = [];
  const copies = [];
  const f = await fixture(t, { saveSentCopy: async (auth, raw) => {
    assert.equal(auth.user, 'sales@ivorydigital.uk');
    copies.push(raw);
    if (copies.length === 2) throw new Error('IMAP unavailable');
  }, mailTransport: settings => {
    const transport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
    return { async sendMail(message) { const result = await transport.sendMail(message); deliveries.push({ settings, result }); return result; } };
  } });
  await f.setup();
  const smtp = { host: 'smtp.hostinger.com', port: 465, security: 'tls', fromName: 'Ivory Digital', fromEmail: 'email@ivorydigital.uk', username: 'sales@ivorydigital.uk', password: 'test-mailbox-password' };
  assert.equal((await f.api('/api/settings/smtp', smtp)).status, 200);
  const saved = await f.api('/api/settings/smtp', { ...smtp, fromEmail: 'sales@ivorydigital.uk', password: '' });
  assert.equal((await saved.json()).fromEmail, 'sales@ivorydigital.uk');
  await f.restart(); await f.api('/api/auth/login', { email, password });
  const tested = await f.api('/api/email/test', {}); assert.equal(tested.status, 200);
  const receipt = await tested.json(); assert.equal(receipt.fromEmail, 'sales@ivorydigital.uk'); assert.ok(receipt.messageId);
  assert.equal(receipt.sentCopy, 'saved');
  assert.ok(copies[0].includes('Message-ID: ' + receipt.messageId));
  assert.match(receipt.message, /Email from sales@ivorydigital.uk accepted by smtp.hostinger.com/);
  await fs.mkdir(path.join(f.data, 'company')); await fs.writeFile(path.join(f.data, 'company/index.html'), '<h1>Company</h1>');
  const demo = await f.api('/api/email/send', { to: 'lead@example.com', subject: 'Your demo', message: 'Take a look.', slug: 'company' });
  assert.equal(demo.status, 200);
  assert.equal((await demo.json()).sentCopy, 'unconfirmed');
  assert.equal(deliveries.length, 2);
  assert.equal(copies.length, 2);
  for (const [index, copy] of copies.entries()) {
    assert.equal(copy.toString().trimEnd(), deliveries[index].result.message.toString().replace(/\r?\n/g, '\r\n').trimEnd());
  }
  for (const { settings, result } of deliveries) {
    assert.equal(settings.auth.user, 'sales@ivorydigital.uk'); assert.equal(settings.secure, true);
    assert.equal(result.envelope.from, 'sales@ivorydigital.uk');
    const mime = result.message.toString();
    assert.match(mime, /^From: Ivory Digital <sales@ivorydigital.uk>\r?$/m);
    assert.match(mime, /^Reply-To: Ivory Digital <sales@ivorydigital.uk>\r?$/m);
    assert.match(mime, /^X-Ivory-Digital-App: leadwebsite\r?$/m);
    assert.equal(mime.includes('email@ivorydigital.uk'), false);
  }
  assert.deepEqual(deliveries.map(d => d.result.envelope.to), [[email], ['lead@example.com']]);
});

test('bundled demos seed once and never overwrite dataset edits', async t => {
  const f = await fixture(t, { seedDir: path.resolve('seed-demos') }); await f.setup();
  const list = await (await f.api('/api/demos')).json(); assert.equal(list.demos.length, 2);
  for (const slug of ['alder-and-ash', 'vale-plumbing']) {
    const html = await (await fetch(`${f.base}/${slug}/`)).text(); assert.match(html, /Site designed by Ivory Digital/);
    assert.equal((await fetch(`${f.base}/${slug}/style.css`)).status, 200);
  }
  await fs.writeFile(path.join(f.data, 'vale-plumbing/index.html'), '<h1>Edited locally</h1>'); await f.restart();
  assert.equal(await (await fetch(`${f.base}/vale-plumbing/`)).text(), '<h1>Edited locally</h1>');
});

test('private design queue keeps briefs across a restart and requires a paired connector to acknowledge', async t => {
  const { randomUUID, randomBytes, createHash } = await import('node:crypto');
  const f = await fixture(t);
  const job = { id: randomUUID(), company: 'Studio Test', brief: 'A clean homepage' };
  assert.equal((await f.api('/api/designs', job)).status, 401);
  await f.setup();
  assert.equal((await f.api('/api/designs', { ...job, source: 'missing' })).status, 400);
  for (let i = 0; i < 2; i++) assert.equal((await f.api('/api/designs', job)).status, 201);
  assert.equal((await (await f.api('/api/designs')).json()).jobs.length, 1);
  const token = randomBytes(32).toString('hex');
  await fs.writeFile(path.join(f.config, 'design-worker.sha256'), createHash('sha256').update(token).digest('hex'));
  await f.restart();
  const next = { action: 'next' }, headers = { Authorization: 'Bearer ' + token };
  assert.equal((await f.api('/api/design-worker', next)).status, 401);
  assert.equal((await (await f.api('/api/design-worker', next, headers)).json()).job.id, job.id);
  const ack = { action: 'ack', id: job.id, status: 'Published', slug: 'company' };
  assert.equal((await f.api('/api/design-worker', ack, headers)).status, 400);
  await fs.mkdir(path.join(f.data, 'company'));
  await fs.writeFile(path.join(f.data, 'company', 'index.html'), 'Example');
  assert.equal((await f.api('/api/design-worker', ack, headers)).status, 200);
  assert.equal((await (await f.api('/api/design-worker', next, headers)).json()).job, null);
});
