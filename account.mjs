import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import nodemailer from 'nodemailer';
import { createApifyClient, tokenOK } from './lib/apify.mjs';

const scrypt = promisify(scryptCallback);
export class RequestError extends Error { constructor(status, message) { super(message); this.status = status; } }
export const emailOK = email => typeof email === 'string' && email.length <= 254 && /^[^\s@<>;,\r\n]+@[^\s@<>;,\r\n]+\.[^\s@<>;,\r\n]+$/.test(email);
export async function readJSON(req, max = 100_000) {
  if (req.headers['content-type'] !== 'application/json') throw new RequestError(415, 'Send JSON from the dashboard.');
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > max) throw new RequestError(413, 'Request is too large.'); chunks.push(chunk); }
  try { const result = JSON.parse(Buffer.concat(chunks).toString()); if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error(); return result; }
  catch { throw new RequestError(400, 'Invalid request data.'); }
}

export async function createAccountStore({ configDir, publicURL, mailTransport, demoExists, apifyToken, apifyClient=createApifyClient() }) {
  await fs.mkdir(configDir, { recursive: true, mode: 0o700 });
  const statePath = path.join(configDir, 'settings.json'), keyPath = path.join(configDir, 'mail.key');
  let state = {};
  try { state = JSON.parse(await fs.readFile(statePath, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  let key;
  try { key = await fs.readFile(keyPath); } catch (e) {
    if (e.code !== 'ENOENT' || state.smtp?.secret) throw e;
    key = randomBytes(32); await fs.writeFile(keyPath, key, { mode: 0o600, flag: 'wx' });
  }
  if (key.length !== 32) throw new Error('Invalid mail encryption key. Restore the config backup.');
  const sessions = new Map(), attempts = new Map(); let settingUp = false;
  let pendingStateSave=Promise.resolve();
  async function save(patch) {
    const operation=pendingStateSave.catch(()=>{}).then(async()=>{
      const next={...state,...patch},temp = `${statePath}.${randomBytes(8).toString('hex')}.tmp`;
      try { await fs.writeFile(temp, JSON.stringify(next), { mode: 0o600, flag: 'wx' }); await fs.rename(temp, statePath); state = next; }
      finally { await fs.rm(temp, { force: true }); }
    });pendingStateSave=operation;return operation;
  }
  function encrypt(value) { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), value: encrypted.toString('base64') }; }
  function decrypt(secret) { const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(secret.iv, 'base64')); cipher.setAuthTag(Buffer.from(secret.tag, 'base64')); return Buffer.concat([cipher.update(Buffer.from(secret.value, 'base64')), cipher.final()]).toString('utf8'); }
  let tokenImport=null;
  async function consumeTokenImport() {
    const filename=path.join(configDir,'apify-token.import');
    let token;try{token=(await fs.readFile(filename,'utf8')).trim();}catch(e){if(e.code==='ENOENT')return;throw e;}
    if(!tokenOK(token))throw new RequestError(400,'The Apify import file does not contain a valid token.');
    await save({search:{secret:encrypt(token)}});await fs.unlink(filename);
  }
  async function importToken(){if(!tokenImport)tokenImport=consumeTokenImport().finally(()=>{tokenImport=null;});return tokenImport;}
  async function getApifyToken(){await importToken();return state.search?.secret?decrypt(state.search.secret):(apifyToken||process.env.APIFY_TOKEN||'').trim();}
  const tokenHash = value => createHash('sha256').update(value).digest('hex');
  function token(req) { return /(?:^|;\s*)ivory_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1]; }
  function cookie(res, value, age = 43200) { res.setHeader('Set-Cookie', `ivory_session=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}${publicURL.startsWith('https:') ? '; Secure' : ''}`); }
  function login(res) {
    const now = Date.now(); for (const [key, expiry] of sessions) if (expiry < now) sessions.delete(key);
    if (sessions.size >= 50) sessions.delete(sessions.keys().next().value);
    const value = randomBytes(32).toString('hex'); sessions.set(tokenHash(value), now + 43200_000); cookie(res, value);
  }
  function authenticated(req) { const value = token(req), expiry = value && sessions.get(tokenHash(value)); return Boolean(expiry && expiry > Date.now()); }
  function throttle(req) {
    const ip = req.socket.remoteAddress, now = Date.now();
    for (const [key, item] of attempts) if (item.until <= now) attempts.delete(key);
    if (attempts.size > 1000 && !attempts.has(ip)) throw new RequestError(429, 'Too many sign-in attempts. Try again in 15 minutes.');
    const item = attempts.get(ip) || { count: 0, until: now + 900_000 }; item.count++; attempts.set(ip, item);
    if (item.count > 15) throw new RequestError(429, 'Too many sign-in attempts. Try again in 15 minutes.');
  }
  function smtp(settings) {
    if (!settings) throw new RequestError(400, 'Save your SMTP settings first.');
    return (mailTransport || nodemailer.createTransport)({ host: settings.host, port: settings.port, secure: settings.security === 'tls', requireTLS: settings.security === 'starttls', auth: { user: settings.username, pass: decrypt(settings.secret) }, connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 20000, dnsTimeout: 15000, disableFileAccess: true, disableUrlAccess: true, logger: false, debug: false });
  }
  return {
    hasAccount: () => Boolean(state.admin), authenticated, getApifyToken,
    async handle(req, res, pathname, json) {
      if (pathname === '/api/auth/status' && req.method === 'GET') { json(res, 200, { needsSetup: !state.admin, authenticated: authenticated(req), email: authenticated(req) ? state.admin.email : undefined }); return true; }
      if (pathname === '/api/auth/setup' && req.method === 'POST') {
        if (state.admin || settingUp) throw new RequestError(409, 'An admin account already exists. Please sign in.');
        throttle(req); const body = await readJSON(req);
        if (!emailOK(body.email) || typeof body.password !== 'string' || body.password.length < 12 || body.password.length > 128) throw new RequestError(400, 'Enter a valid email and a password of 12–128 characters.');
        if (state.admin || settingUp) throw new RequestError(409, 'An admin account already exists. Please sign in.');
        settingUp = true;
        try {
          const salt = randomBytes(32).toString('hex'), hash = (await scrypt(body.password, salt, 64)).toString('hex');
          await save({ admin: { email: body.email.trim().toLowerCase(), salt, hash } }); login(res); json(res, 201, { ok: true });
        } finally { settingUp = false; }
        return true;
      }
      if (pathname === '/api/auth/login' && req.method === 'POST') {
        throttle(req); const body = await readJSON(req);
        if (typeof body.password !== 'string' || body.password.length > 128 || typeof body.email !== 'string') throw new RequestError(401, 'Email or password is incorrect.');
        const salt = state.admin?.salt || 'unused-login-salt', hash = await scrypt(body.password, salt, 64);
        if (!state.admin || body.email.trim().toLowerCase() !== state.admin.email || !timingSafeEqual(hash, Buffer.from(state.admin.hash, 'hex'))) throw new RequestError(401, 'Email or password is incorrect.');
        attempts.delete(req.socket.remoteAddress); login(res); json(res, 200, { ok: true }); return true;
      }
      if (pathname === '/api/auth/logout' && req.method === 'POST') { const value = token(req); if (value) sessions.delete(tokenHash(value)); cookie(res, '', 0); json(res, 200, { ok: true }); return true; }
      if (!authenticated(req)) return false;
      if(pathname==='/api/settings/search'&&req.method==='GET'){
        const token=await getApifyToken();json(res,200,{configured:tokenOK(token),source:state.search?.secret?'saved':tokenOK(token)?'environment':'none',provider:'Apify',actor:'compass/crawler-google-places'});return true;
      }
      if(pathname==='/api/settings/search'&&req.method==='POST'){
        const body=await readJSON(req);if(!tokenOK(body.token))throw new RequestError(400,'Enter a valid Apify token.');
        await save({search:{secret:encrypt(body.token)}});json(res,200,{ok:true,configured:true});return true;
      }
      if(pathname==='/api/settings/search/test'&&req.method==='POST'){
        await readJSON(req);const token=await getApifyToken();await apifyClient.verify(token);json(res,200,{ok:true,message:'Apify connection verified. No search was started.'});return true;
      }
      if (pathname === '/api/settings/smtp' && req.method === 'GET') {
        const { secret, ...settings } = state.smtp || {};
        json(res, 200, { ...settings, passwordSaved: Boolean(secret), adminEmail: state.admin.email }); return true;
      }
      if (pathname === '/api/settings/smtp' && req.method === 'POST') {
        const body = await readJSON(req);
        if (typeof body.host !== 'string' || !/^[a-zA-Z0-9.-]{1,253}$/.test(body.host) || !Number.isInteger(body.port) || body.port < 1 || body.port > 65535 || !['tls', 'starttls'].includes(body.security) || !emailOK(body.fromEmail) || typeof body.fromName !== 'string' || body.fromName.length > 120 || /[\r\n]/.test(body.fromName) || typeof body.username !== 'string' || !body.username.trim() || body.username.length > 254 || /[\r\n]/.test(body.username) || (body.password !== undefined && (typeof body.password !== 'string' || body.password.length > 2048))) throw new RequestError(400, 'Check your SMTP server, port, sender email and login details.');
        const changedIdentity = state.smtp && (body.host !== state.smtp.host || body.username !== state.smtp.username);
        if ((!state.smtp?.secret || changedIdentity) && !body.password) throw new RequestError(400, 'Enter the SMTP password for this mail server and username.');
        await save({ smtp: { host: body.host, port: body.port, security: body.security, fromEmail: body.fromEmail.trim(), fromName: body.fromName.trim(), username: body.username.trim(), secret: body.password ? encrypt(body.password) : state.smtp.secret } });
        json(res, 200, { ok: true, fromEmail: state.smtp.fromEmail }); return true;
      }
      if (['/api/email/test', '/api/email/send'].includes(pathname) && req.method === 'POST') {
        const body = await readJSON(req);
        // Keep credentials and message identity together even if settings change mid-send.
        const settings = state.smtp;
        if (!settings) throw new RequestError(400, 'Save your SMTP settings first.');
        let to, subject, text;
        if (pathname.endsWith('/test')) { to = state.admin.email; subject = 'Your Ivory Digital email settings are working'; text = `This test email was sent by your website demo studio.\n\nSender: ${settings.fromEmail}\nSMTP server: ${settings.host}\nWebsite: ${publicURL}\n\nThe visible From, Reply-To and SMTP envelope sender are set to the sender address above.`; }
        else {
          if (!emailOK(body.to) || typeof body.subject !== 'string' || !body.subject.trim() || body.subject.length > 200 || /[\r\n]/.test(body.subject) || typeof body.message !== 'string' || !body.message.trim() || body.message.length > 20000 || typeof body.slug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(body.slug)) throw new RequestError(400, 'Enter one recipient, a subject and a message.');
          if (!await demoExists(body.slug)) throw new RequestError(404, 'This demo is no longer available.');
          to = body.to; subject = body.subject; text = `${body.message.trim()}\n\nView your website demo: ${publicURL}/${body.slug}/`;
        }
        const transport = smtp(settings);
        try {
          const sender = { name: settings.fromName, address: settings.fromEmail };
          const result = await transport.sendMail({
            from: sender,
            replyTo: sender,
            envelope: { from: settings.fromEmail, to: [to] },
            to: { address: to }, subject, text,
            headers: { 'X-Ivory-Digital-App': 'leadwebsite' }
          });
          if (result.rejected?.length) throw new Error('Recipient rejected');
          json(res, 200, { ok: true, fromEmail: settings.fromEmail, messageId: result.messageId, message: `Email from ${settings.fromEmail} accepted by ${settings.host} for ${to}.${result.messageId ? ` Message ID: ${result.messageId}` : ''}` });
        } catch { throw new RequestError(502, 'The mail server could not send this email. Check the saved SMTP credentials, sender address and TLS settings.'); }
        finally { transport.close?.(); }
        return true;
      }
      return false;
    }
  };
}
