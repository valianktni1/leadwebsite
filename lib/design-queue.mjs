import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readJSON, RequestError } from '../account.mjs';

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export function designQueue(configDir, demoExists) {
  const file = path.join(configDir, 'design-requests.json');
  let tail = Promise.resolve();
  async function transaction(change) {
    const operation = tail.then(async () => {
      let jobs;
      try { jobs = JSON.parse(await fs.readFile(file, 'utf8')); }
      catch (e) { if (e.code !== 'ENOENT') throw e; jobs = []; }
      const { result, write } = await change(jobs);
      if (write) {
        await fs.writeFile(file + '.tmp', JSON.stringify(jobs), { mode: 0o600 });
        await fs.rename(file + '.tmp', file);
      }
      return result;
    });
    tail = operation.catch(() => {});
    return operation;
  }
  return async function handle(req, res, pathname, json, admin) {
    if (!['/api/designs', '/api/design-worker'].includes(pathname)) return false;
    if (pathname === '/api/design-worker') {
      const token = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization || '')?.[1];
      const hash = token && createHash('sha256').update(token).digest('hex');
      const pin = hash && (await fs.readFile(path.join(configDir, 'design-worker.sha256'), 'utf8').catch(e => { if (e.code === 'ENOENT') return ''; throw e; })).trim();
      if (!pin || pin.length !== 64 || !/^[a-f0-9]+$/.test(pin) || !timingSafeEqual(Buffer.from(hash), Buffer.from(pin))) throw new RequestError(401, 'Unpaired connector.');
      if (req.method !== 'POST') throw new RequestError(405, 'Use POST.');
      const body = await readJSON(req);
      const result = await transaction(async jobs => {
        if (body.action === 'next') return { result: { job: jobs.find(j => ['Waiting for PC', 'Design in progress'].includes(j.status)) || null } };
        const job = jobs.find(j => j.id === body.id);
        if (body.action !== 'ack' || !job || !['Design in progress', 'Published', 'Check connector on PC'].includes(body.status)) throw new RequestError(400, 'Invalid acknowledgement.');
        if (body.status === 'Published') {
          if (typeof body.slug !== 'string' || !await demoExists(body.slug)) throw new RequestError(400, 'Published demo missing.');
          job.slug = body.slug;
        }
        job.status = body.status;
        return { write: true, result: { ok: true } };
      });
      json(res, 200, result); return true;
    }
    if (!admin) throw new RequestError(401, 'Sign in to request a design.');
    if (req.method === 'GET') {
      json(res, 200, await transaction(jobs => ({ result: { jobs: jobs.slice(-20).reverse().map(({ id, company, status, slug }) => ({ id, company, status, slug })) } }))); return true;
    }
    if (req.method !== 'POST') throw new RequestError(405, 'Use POST.');
    const body = await readJSON(req);
    const { id, company, sector = '', area = '', website = '', source = '', brief = '' } = body;
    for (const [value, limit] of [[company,200],[sector,200],[area,250],[website,2000],[brief,2500],[source,80]]) {
      if (typeof value !== 'string' || value.length > limit) throw new RequestError(400, 'Check the design brief.');
    }
    if (!uuid.test(id) || !company.trim() || (source && !await demoExists(source))) throw new RequestError(400, 'Choose a company and an available starting demo.');
    const job = { id, company: company.trim(), sector, area, website, source, brief, status: 'Waiting for PC' };
    json(res, 201, await transaction(async jobs => {
      if (jobs.some(j => j.id === id)) return { result: { id } };
      jobs.push(job); return { write: true, result: { id } };
    })); return true;
  };
}
