import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { RequestError, readJSON } from '../account.mjs';
import { SECTORS, SECTOR_GROUPS } from './sectors.mjs';
import { inspectWebsite, websiteURL } from './websites.mjs';
import { createApifyClient } from './apify.mjs';

const text=(value,max=500)=>typeof value==='string'?value.slice(0,max):'';
const idFor=value=>createHash('sha256').update(value).digest('hex').slice(0,24);
const safeURL=value=>{try{return websiteURL(value).href;}catch{return '';}};
export function normalisePlace(raw, sector, area) {
  if (!raw || typeof raw!=='object' || raw.error || !text(raw.title) || raw.permanentlyClosed || raw.temporarilyClosed) return null;
  // A country code is required; search location alone does not establish UK membership.
  if (!['GB','UK'].includes(text(raw.countryCode).toUpperCase())) return null;
  let mapsURL=''; try { const url=new URL(raw.url); if (/^(?:www\.)?google\.(?:com|co\.uk)$/.test(url.hostname) && url.pathname.startsWith('/maps')) mapsURL=url.href; } catch {}
  const name=text(raw.title,200), address=text(raw.address), website=text(raw.website,2000), placeId=text(raw.placeId,200);
  return { id:idFor(placeId || `${name}|${address}`), name, address, phone:text(raw.phone,80), website:website?safeURL(website):'', websiteListed:Boolean(website), invalidWebsite:Boolean(website&&!safeURL(website)), mapsURL, placeId, sector:sector.label, area, rating:Number.isFinite(raw.totalScore)?raw.totalScore:null, reviewsCount:Number.isFinite(raw.reviewsCount)?raw.reviewsCount:null, checkedAt:new Date().toISOString() };
}
export const csvCell=value=>`"${String(value??'').replace(/^[\s]*[=+@-]/,match=>`'${match}`).replace(/"/g,'""')}"`;

export async function createLeadService({ configDir, getToken, apify=createApifyClient(), inspect=inspectWebsite }) {
  const filename=path.join(configDir,'leads.json');
  let store={ searches:[], saved:[] }, pendingSave=Promise.resolve(), current=null, closed=false;
  try { store=JSON.parse(await fs.readFile(filename,'utf8')); if (!Array.isArray(store.searches)||!Array.isArray(store.saved)) throw new Error('Invalid leads storage'); } catch(e) { if(e.code!=='ENOENT') throw e; }
  async function persist() {
    const snapshot=JSON.stringify(store);
    const operation=pendingSave.catch(()=>{}).then(async()=>{ const temp=filename+'.'+randomUUID()+'.tmp'; try{await fs.writeFile(temp,snapshot,{mode:0o600,flag:'wx'});await fs.rename(temp,filename);}finally{await fs.rm(temp,{force:true});} });
    pendingSave=operation; return operation;
  }
  for (const job of store.searches) if (job.status==='running') { job.status='interrupted'; job.message='The app restarted during this search. Check the linked Apify run; it has not been restarted automatically.'; }
  await persist();
  const summary=job=>({...job,results:undefined,resultCount:job.results.length});
  async function run(job, token) {
    try {
      const found=await apify.search({ token,sector:job.sector,area:job.area,limit:job.limit,budget:job.budget,
        onRun:async id=>{job.runId=id;await persist();}, onProgress:async message=>{job.message=message;await persist();} });
      job.warnings=found.warnings||[]; job.runId=found.runId||job.runId;
      const sector=SECTORS.find(item=>item.id===job.sectorId), unique=new Map();
      for (const raw of found.items) { const place=normalisePlace(raw,sector,job.area); if(place&&!unique.has(place.id)) unique.set(place.id,place); }
      job.found=unique.size; job.excluded=found.items.length-unique.size;
      const audited=new Map();
      for (const lead of [...unique.values()].slice(0,job.limit)) {
        if(closed) return;
        job.message=`Reviewing website ${job.results.length+1} of ${job.found}…`;
        if(lead.invalidWebsite)lead.assessment={status:'manual-review',score:0,reasons:['The source supplied a website link that could not be safely checked.']};
        else {if(!audited.has(lead.website))audited.set(lead.website,await inspect(lead.website));lead.assessment=structuredClone(audited.get(lead.website));}
        job.results.push(lead); await persist();
      }
      job.results.sort((a,b)=>b.assessment.score-a.assessment.score);
      job.status='complete'; job.message=`Checked ${job.results.length} UK businesses. Results may need manual confirmation.`; job.finishedAt=new Date().toISOString();
    } catch(error) { job.status='failed'; job.message=error instanceof RequestError?error.message:'The lead search could not finish. Any completed results are shown below.'; }
    finally { if(!closed)await persist(); current=null; }
  }
  return {
    async close(){closed=true;await pendingSave;},
    async handle(req,res,pathname,json){
      if(pathname==='/api/leads/sectors'&&req.method==='GET'){json(res,200,{groups:SECTOR_GROUPS,count:SECTORS.length});return true;}
      if(pathname==='/api/leads/searches'&&req.method==='GET'){json(res,200,{searches:store.searches.map(summary)});return true;}
      if(pathname==='/api/leads/searches'&&req.method==='POST'){
        if(current)throw new RequestError(409,'A search is already running. Wait for it to finish before starting another.');
        const body=await readJSON(req), sector=SECTORS.find(item=>item.id===body.sectorId);
        if(!sector||typeof body.area!=='string'||body.area.trim().length<2||body.area.length>100||!/\p{L}/u.test(body.area)||!/^[\p{L}\p{N} ,.'’&()\-]+$/u.test(body.area)||!Number.isInteger(body.limit)||body.limit<5||body.limit>100||!Number.isFinite(body.budget)||body.budget<0.1||body.budget>5)throw new RequestError(400,'Choose a sector, a UK area, 5–100 results and a search budget between $0.10 and $5.');
        const token=await getToken();if(!token)throw new RequestError(400,'Connect Apify in Search settings before searching.');
        if(current)throw new RequestError(409,'A search is already running.');
        const job={id:randomUUID(),sectorId:sector.id,sector:sector.label,area:body.area.trim(),limit:body.limit,budget:body.budget,status:'running',message:'Starting your UK business search…',createdAt:new Date().toISOString(),results:[],warnings:[]};
        current=job.id;store.searches.unshift(job);store.searches=store.searches.slice(0,20);
        try{await persist();}catch(e){current=null;throw e;}
        json(res,202,job);setImmediate(()=>{run(job,token).catch(()=>{current=null;});});return true;
      }
      const searchMatch=/^\/api\/leads\/searches\/([a-f0-9-]{36})$/.exec(pathname);
      if(searchMatch&&req.method==='GET'){const job=store.searches.find(item=>item.id===searchMatch[1]);if(!job)throw new RequestError(404,'Search not found.');json(res,200,job);return true;}
      if(pathname==='/api/leads/saved'&&req.method==='GET'){json(res,200,{leads:store.saved});return true;}
      if(pathname==='/api/leads/saved'&&req.method==='POST'){
        const body=await readJSON(req), lead=store.searches.find(job=>job.id===body.searchId)?.results.find(lead=>lead.id===body.resultId);
        if(!lead)throw new RequestError(404,'Choose a result from an existing search.');
        if(!store.saved.some(item=>item.id===lead.id)){if(store.saved.length>=2000)throw new RequestError(400,'The saved lead limit is 2,000. Export your list before adding more.');store.saved.unshift({...structuredClone(lead),status:'new',notes:'',savedAt:new Date().toISOString()});await persist();}
        json(res,200,{ok:true});return true;
      }
      const savedMatch=/^\/api\/leads\/saved\/([a-f0-9]{24})$/.exec(pathname);
      if(savedMatch&&req.method==='POST'){
        const lead=store.saved.find(lead=>lead.id===savedMatch[1]);if(!lead)throw new RequestError(404,'Saved lead not found.');
        const body=await readJSON(req);if(!['new','contacted','demo-created','not-suitable'].includes(body.status)||typeof body.notes!=='string'||body.notes.length>3000)throw new RequestError(400,'Choose a status and notes up to 3,000 characters.');
        lead.status=body.status;lead.notes=body.notes;await persist();json(res,200,{ok:true});return true;
      }
      if(pathname==='/api/leads/export.csv'&&req.method==='GET'){
        const rows=[['Company','Sector','Search area','Address','Phone','Website','Maps URL','Website assessment','Evidence','Checked','Status','Notes'],...store.saved.map(lead=>[lead.name,lead.sector,lead.area,lead.address,lead.phone,lead.website,lead.mapsURL,lead.assessment.status,lead.assessment.reasons.join(' | '),lead.checkedAt,lead.status,lead.notes])];
        res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="ivory-digital-leads.csv"','Cache-Control':'no-store'});res.end('\uFEFF'+rows.map(row=>row.map(csvCell).join(',')).join('\r\n'));return true;
      }
      return false;
    }
  };
}
