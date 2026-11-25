import { designQueue } from './lib/design-queue.mjs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promises as fs, createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { createAccountStore, RequestError } from './account.mjs';
import { createLeadService } from './lib/leads.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.mp4': 'video/mp4', '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8', '.avif': 'image/avif' };
const RESERVED = new Set(['admin', 'api', 'healthz', 'favicon.ico', 'robots.txt']);
const slugOK = s => typeof s === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s) && s.length <= 80 && !RESERVED.has(s);
const inside = (root, candidate) => candidate === root || candidate.startsWith(root + path.sep);
const safeParts = parts => parts.every(p => p && !p.startsWith('.') && !/[\\:\x00-\x1f]/.test(p));
const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };

export async function createApp(options = {}) {
  const data = path.resolve(options.dataDir || process.env.DATA_DIR || './data');
  const publicURL = (options.publicURL || process.env.PUBLIC_URL || 'https://websites.ivorydigital.uk').replace(/\/$/, '');
  await fs.mkdir(data, { recursive: true });
  const dataReal = await fs.realpath(data);
  const configDir = path.resolve(options.configDir || process.env.CONFIG_DIR || './config');
  if (inside(dataReal, configDir)) throw new Error('CONFIG_DIR must be outside the public demo dataset.');
  const demoExists = async slug => {
    try { const real = await fs.realpath(path.join(data, slug, 'index.html')); return slugOK(slug) && inside(path.join(dataReal, slug), real); } catch { return false; }
  };
  const designs = designQueue(configDir, demoExists);
  const account = await createAccountStore({ configDir, publicURL, mailTransport: options.mailTransport, saveSentCopy: options.saveSentCopy, apifyToken: options.apifyToken, apifyClient: options.apifyClient, demoExists });
  const leads=await createLeadService({configDir,getToken:account.getApifyToken,apify:options.apifyClient,inspect:options.inspectWebsite});
  if (options.seedDir !== false) {
    const seeds = options.seedDir || path.join(ROOT, 'seed-demos');
    for (const entry of await fs.readdir(seeds, { withFileTypes: true }).catch(e => { if (e.code === 'ENOENT') return []; throw e; })) {
      if (!entry.isDirectory() || !slugOK(entry.name)) continue;
      const destination = path.join(data, entry.name);
      try { await fs.lstat(destination); continue; } catch (e) { if (e.code !== 'ENOENT') throw e; }
      const stage = path.join(data, `.seed-${randomUUID()}`);
      try { await fs.cp(path.join(seeds, entry.name), stage, { recursive: true, errorOnExist: true, force: false }); await fs.rename(stage, destination); }
      finally { await fs.rm(stage, { force: true, recursive: true }); }
    }
  }
  async function serve(res, filename, demo = false, method = 'GET') {
    let stat;
    try { stat = await fs.stat(filename); } catch { return json(res, 404, { error: 'Page not found' }); }
    if (!stat.isFile()) return json(res, 404, { error: 'Page not found' });
    const headers = { 'Content-Type': MIME[path.extname(filename).toLowerCase()] || 'application/octet-stream', 'Content-Length': stat.size, 'Cache-Control': res.getHeader('Cache-Control') || 'no-cache' };
    // Opaque origins keep uploaded demos isolated from authenticated management APIs.
    if (demo) headers['Content-Security-Policy'] = "sandbox allow-scripts allow-forms allow-popups allow-downloads; frame-ancestors 'self'";
    res.writeHead(200, headers);
    if (method === 'HEAD') return res.end();
    createReadStream(filename).on('error', () => res.destroy()).pipe(res);
  }
  let adminPage = await fs.readFile(path.join(ROOT, 'public/admin.html'), 'utf8');
  for (const script of ['app.js', 'leads.js']) {
    const bytes = await fs.readFile(path.join(ROOT, 'public', script));
    const version = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
    adminPage = adminPage.replace('{{' + script + '}}', version);
  }
  const server=http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    try {
      const url = new URL(req.url, 'http://localhost');
      const pathname = decodeURIComponent(url.pathname);
      if (pathname === '/healthz') return json(res, 200, { status: 'ok' });
      if (pathname === '/robots.txt') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('User-agent: *\nDisallow: /\n'); }
      const managed = pathname === '/admin' || pathname.startsWith('/admin/') || pathname === '/api' || pathname.startsWith('/api/');
      if (managed) {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
        if (!['GET', 'HEAD'].includes(req.method) && (req.headers['sec-fetch-site'] === 'cross-site' || ![publicURL, `http://${req.headers.host}`].includes(req.headers.origin))) throw new RequestError(403, 'Use the dashboard to make changes.');
        if (await designs(req, res, pathname, json, account.authenticated(req))) return;
        if (await account.handle(req, res, pathname, json)) return;
        if (pathname === '/admin' || pathname === '/admin/') {
          if (!account.authenticated(req)) return serve(res, path.join(ROOT, 'public/auth.html'));
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          return res.end(req.method === 'HEAD' ? undefined : adminPage);
        }
        if (['/admin/app.js', '/admin/style.css', '/admin/auth.js', '/admin/leads.js', '/admin/leads.css'].includes(pathname)) return serve(res, path.join(ROOT, 'public', path.basename(pathname)));
        if (!account.authenticated(req)) return json(res, 401, { error: 'Please sign in to manage your demos.' });
        if(await leads.handle(req,res,pathname,json))return;
        if (pathname === '/api/demos' && req.method === 'GET') {
          const entries = await fs.readdir(data, { withFileTypes: true });
          const demos = [];
          for (const entry of entries) {
            if (!entry.isDirectory() || !slugOK(entry.name)) continue;
            const dir = path.join(data, entry.name);
            try {
              const real = await fs.realpath(path.join(dir, 'index.html'));
              if (!inside(dataReal, real)) continue;
              const stat = await fs.stat(real);
              let meta = {};
              try { meta = JSON.parse(await fs.readFile(path.join(dir, '.demo.json'), 'utf8')); } catch {}
              demos.push({ slug: entry.name, name: String(meta.name || entry.name), created: meta.created || stat.mtime.toISOString(), url: `${publicURL}/${entry.name}/` });
            } catch {}
          }
          demos.sort((a, b) => b.created.localeCompare(a.created));
          return json(res, 200, { demos, publicURL });
        }
        if (pathname === '/api/demos' && req.method === 'POST') {
          if (req.headers['content-type'] !== 'application/json') return json(res, 415, { error: 'Upload from the management dashboard' });
          let size = 0;
          const chunks = [];
          for await (const chunk of req) {
            size += chunk.length;
            if (size > 72 * 1024 * 1024) return json(res, 413, { error: 'Upload is too large. Maximum total file size is 50 MB.' });
            chunks.push(chunk);
          }
          let body;
          try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { return json(res, 400, { error: 'Invalid upload data' }); }
          if (!slugOK(body.slug) || typeof body.name !== 'string' || !body.name.trim() || body.name.length > 160 || !Array.isArray(body.files) || !body.files.length || body.files.length > 1000) return json(res, 400, { error: 'Enter a company name, valid URL slug and 1–1,000 files.' });
          const files = [], seen = new Set(); let total = 0;
          for (const file of body.files) {
            if (typeof file.path !== 'string' || !safeParts(file.path.split('/')) || typeof file.content !== 'string' || file.content.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.content)) return json(res, 400, { error: 'Invalid file path or content. Hidden files are not allowed.' });
            const key = file.path.toLowerCase();
            if (seen.has(key)) return json(res, 400, { error: 'Duplicate file paths' });
            seen.add(key);
            const content = Buffer.from(file.content, 'base64'); total += content.length;
            files.push({ path: file.path, content });
          }
          if (!files.some(f => f.path === 'index.html')) return json(res, 400, { error: 'The demo needs an index.html file in its root folder.' });
          if (total > 50 * 1024 * 1024) return json(res, 413, { error: 'Maximum total file size is 50 MB.' });
          const dest = path.join(data, body.slug);
          try { await fs.lstat(dest); return json(res, 409, { error: 'That URL is already in use. Choose another slug, or update its files directly on TrueNAS.' }); } catch (e) { if (e.code !== 'ENOENT') throw e; }
          const stage = path.join(data, `.upload-${randomUUID()}`);
          try {
            await fs.mkdir(stage);
            for (const file of files) {
              const filename = path.join(stage, ...file.path.split('/'));
              await fs.mkdir(path.dirname(filename), { recursive: true });
              await fs.writeFile(filename, file.content, { flag: 'wx' });
            }
            await fs.writeFile(path.join(stage, '.demo.json'), JSON.stringify({ name: body.name.trim(), created: new Date().toISOString() }));
            await fs.rename(stage, dest);
          } finally { await fs.rm(stage, { recursive: true, force: true }); }
          return json(res, 201, { url: `${publicURL}/${body.slug}/` });
        }
        return json(res, 404, { error: 'Not found' });
      }
      if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, { error: 'Method not allowed' });
      if (pathname === '/') {
        if (!account.hasAccount()) { res.writeHead(302, { Location: '/admin' }); return res.end(); }
        return serve(res, path.join(ROOT, 'public/index.html'), false, req.method);
      }
      if (pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
      const parts = pathname.slice(1).split('/');
      if (!slugOK(parts[0])) return json(res, 404, { error: 'Demo not found' });
      if (parts.length === 1) {
        res.writeHead(308, { Location: `/${parts[0]}/${url.search}` }); return res.end();
      }
      if (parts.at(-1) === '') parts[parts.length - 1] = 'index.html';
      if (!safeParts(parts)) return json(res, 404, { error: 'Page not found' });
      let real;
      try { real = await fs.realpath(path.join(data, ...parts)); } catch { return json(res, 404, { error: 'Page not found' }); }
      const demoRoot = path.join(dataReal, parts[0]);
      if (!inside(demoRoot, real)) return json(res, 404, { error: 'Page not found' });
      return serve(res, real, true, req.method);
    } catch (error) {
      if (error instanceof RequestError) return json(res, error.status, { error: error.message });
      if (error instanceof URIError) return json(res, 400, { error: 'Invalid URL' });
      console.error('Request failed:', error.message);
      if (!res.headersSent) json(res, 500, { error: 'Unable to complete the request. Check server logs and dataset permissions.' });
      else res.destroy();
    }
  });
  server.on('close',()=>{leads.close().catch(()=>{});});
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await createApp();
  app.listen(Number(process.env.PORT || 3000), '0.0.0.0', () => console.log(`Lead websites listening on port ${process.env.PORT || 3000}`));
}
