import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { RequestError, readJSON, emailOK } from '../account.mjs';
import { SECTORS, SECTOR_GROUPS } from './sectors.mjs';
import { inspectWebsite, websiteURL, findOfficialWebsite } from './websites.mjs';
import { createApifyClient } from './apify.mjs';

const text=(value,max=500)=>typeof value==='string'?value.slice(0,max):'';
const idFor=value=>createHash('sha256').update(value).digest('hex').slice(0,24);
const safeURL=value=>{try{return websiteURL(value).href;}catch{return '';}};
function businessEmail(raw) {
  const candidates = [raw.email, ...(Array.isArray(raw.emails) ? raw.emails : [])]
    .filter(value => emailOK(value) && !/[?#%]/.test(value) && !/^no[._-]?reply@/i.test(value));
  return candidates.find(value => /^(info|hello|office|sales|contact|reception|enquiries)@/i.test(value)) || candidates[0] || '';
}
export function normalisePlace(raw, sector, area) {
  if (!raw || typeof raw!=='object' || raw.error || !text(raw.title) || raw.permanentlyClosed || raw.temporarilyClosed) return null;
  // A country code is required; search location alone does not establish UK membership.
  if (!['GB','UK'].includes(text(raw.countryCode).toUpperCase())) return null;
  let mapsURL=''; try { const url=new URL(raw.url); if (/^(?:www\.)?google\.(?:com|co\.uk)$/.test(url.hostname) && url.pathname.startsWith('/maps')) mapsURL=url.href; } catch {}
  const name=text(raw.title,200), address=text(raw.address), website=text(raw.website,2000), placeId=text(raw.placeId,200);
  const services=[raw.categoryName,raw.description,...(Array.isArray(raw.categories)?raw.categories:[])].filter(x=>typeof x==='string').join(' ').slice(0,1800);
  const possibleSites=(Array.isArray(raw.webResults)?raw.webResults:[]).map(x=>safeURL(x?.url)).filter(Boolean).slice(0,4);
  return { services,possibleSites,id:idFor(placeId || `${name}|${address}`), name, address, phone:text(raw.phone,80), email:businessEmail(raw), website:website?safeURL(website):'', websiteListed:Boolean(website), invalidWebsite:Boolean(website&&!safeURL(website)), mapsURL, placeId, sector:sector.label, area, rating:Number.isFinite(raw.totalScore)?raw.totalScore:null, reviewsCount:Number.isFinite(raw.reviewsCount)?raw.reviewsCount:null, checkedAt:new Date().toISOString() };
}
export const csvCell=value=>`"${String(value??'').replace(/^[\s]*[=+@-]/,match=>`'${match}`).replace(/"/g,'""')}"`;

export async function createLeadService({ configDir, getToken, apify=createApifyClient(), inspect=inspectWebsite }) {
  const filename=path.join(configDir,'leads.json');
  let store={ searches:[], saved:[] }, pendingSave=Promise.resolve(), current=null, closed=false;
  try { store=JSON.parse(await fs.readFile(filename,'utf8')); if (!Array.isArray(store.searches)||!Array.isArray(store.saved)) throw new Error('Invalid leads storage'); } catch(e) { if(e.code!=='ENOENT') throw e; }
  store.campaigns ??= [];
  // Optional, privately researched practice contacts, matched to the listing and its location.
  let contacts=[];
  try { contacts=JSON.parse(await fs.readFile(path.join(configDir,'business-contacts.json'),'utf8')); }
  catch(error) { if(error.code!=='ENOENT')throw error; }
  function applyContact(lead) {
    const match=contacts.find(row=>row.name===lead.name && row.location && lead.address?.includes(row.location) && emailOK(row.email) && safeURL(row.source));
    if(match){lead.email=match.email;lead.emailSource=match.source;}
    return lead;
  }
  for(const lead of store.saved)applyContact(lead);
  for(const job of store.searches)for(const lead of job.results)applyContact(lead);
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
      const found=await apify.search({ token,webResults:Boolean(job.campaignId),sector:job.sector,area:job.area,limit:job.limit,budget:job.budget,
        onRun:async id=>{job.runId=id;await persist();}, onProgress:async message=>{job.message=message;await persist();} });
      job.warnings=found.warnings||[]; job.runId=found.runId||job.runId;
      const sector=SECTORS.find(item=>item.id===job.sectorId), unique=new Map();
      for (const raw of found.items) { const place=normalisePlace(raw,sector,job.area); if(place&&!unique.has(place.id)) unique.set(place.id,place); }
      job.found=unique.size; job.excluded=found.items.length-unique.size;
      const audited=new Map();
      for (const lead of [...unique.values()].slice(0,job.limit)) {
        if(closed) return;
        job.message=`Reviewing website ${job.results.length+1} of ${job.found}…`;
        if(job.campaignId&&!lead.website&&!lead.invalidWebsite&&lead.possibleSites.length)
          lead.website=await findOfficialWebsite(lead);
        if(lead.invalidWebsite)lead.assessment={status:'manual-review',score:0,reasons:['The source supplied a website link that could not be safely checked.']};
        else {if(!audited.has(lead.website))audited.set(lead.website,await inspect(lead.website));lead.assessment=structuredClone(audited.get(lead.website));}
        applyContact(lead);
        const saved = store.saved.find(item => item.id === lead.id);
        if(saved && job.campaignId){
          saved.services=lead.services;saved.possibleSites=lead.possibleSites;
          if(lead.website||!saved.website){saved.assessment=lead.assessment;saved.checkedAt=lead.checkedAt;}
          if(lead.website){saved.website=lead.website;saved.websiteVerifiedAbsent=false;}
        }
        if (saved && !saved.email && lead.email) { saved.email = lead.email; saved.emailSource = lead.emailSource; }
        job.results.push(lead);
        const campaign=store.campaigns.find(c=>c.id===job.campaignId);
        if(campaign && (saved||store.saved.length<2000))attach(lead,campaign);
        await persist();
      }
      job.results.sort((a,b)=>b.assessment.score-a.assessment.score);
      job.status='complete'; job.message=`Checked ${job.results.length} UK businesses. Results may need manual confirmation.`; job.finishedAt=new Date().toISOString();
    } catch(error) { job.status='failed'; job.message=error instanceof RequestError?error.message:'The lead search could not finish. Any completed results are shown below.'; }
    finally { if(!closed)await persist(); current=null; }
  }
  const WEEK=7*86400000;
  function validateSearch(body){
    const sector=SECTORS.find(item=>item.id===body.sectorId);
        if(!sector||typeof body.area!=='string'||body.area.trim().length<2||body.area.length>100||!/\p{L}/u.test(body.area)||!/^[\p{L}\p{N} ,.'’&()\-]+$/u.test(body.area)||!Number.isInteger(body.limit)||body.limit<5||body.limit>100||!Number.isFinite(body.budget)||body.budget<0.1||body.budget>5)throw new RequestError(400,'Choose a sector, a UK area, 5–100 results and a search budget between $0.10 and $5.');
    return sector;
  }
  async function startSearch(body,campaign,scheduled=false){
    const sector=validateSearch(body);
        const token=await getToken();if(closed)throw new RequestError(503,'Studio is restarting.');if(!token)throw new RequestError(400,'Connect Apify in Search settings before searching.');
        if(current)throw new RequestError(409,'A search is already running.');
        const job={campaignId:campaign?.id,id:randomUUID(),sectorId:sector.id,sector:sector.label,area:body.area.trim(),limit:body.limit,budget:body.budget,status:'running',message:'Starting your UK business search…',createdAt:new Date().toISOString(),results:[],warnings:[]};
        if(campaign){
          if(scheduled && (!campaign.weekly || campaign.nextRun>Date.now()))return;
          campaign.lastRun=Date.now();campaign.nextRun=Date.now()+WEEK;campaign.lastError='';
        }
        current=job.id;store.searches.unshift(job);store.searches=store.searches.slice(0,20);
        try{await persist();}catch(e){current=null;throw e;}
    setImmediate(()=>run(job,token).catch(()=>{current=null;}));return job;
  }
  function ensureLead(id){
    let lead=store.saved.find(x=>x.id===id);
    if(lead)return lead;
    const found=store.searches.flatMap(x=>x.results).find(x=>x.id===id);
    if(!found)throw new RequestError(404,'Lead no longer available.');
    if(store.saved.length>=2000)throw new RequestError(409,'Saved lead limit reached.');
    lead={...structuredClone(found),status:'new',notes:'',savedAt:new Date().toISOString()};
    store.saved.unshift(lead);return lead;
  }
  function membership(lead,c){
    return lead.campaignIds?.includes(c.id)||(lead.sector===c.sector && lead.area.toLowerCase()===c.area.toLowerCase());
  }
  function rank(lead,c){
    const hay=[lead.name,lead.services].join(' ').toLowerCase();
    const hits=c.include.filter(x=>hay.includes(x));
    const penalties=c.exclude.filter(x=>hay.includes(x));
    return {score:(lead.assessment.score||0)+hits.length*6-penalties.length*8,
      reasons:[...hits.map(x=>'Listing mentions '+x),...penalties.map(x=>'Lower priority: '+x),...lead.assessment.reasons]};
  }
  function attach(lead,c){
    const record=ensureLead(lead.id);
    record.campaignIds=[...new Set([...(record.campaignIds||[]),c.id])];
  }
  function identityKeys(l){
    return [l.id,l.phone?.replace(/\D/g,'').replace(/^44/,'0'),l.email?.toLowerCase()].filter(Boolean);
  }
  function campaignView(c){
    const eligible=store.saved.filter(l=>membership(l,c));
    const suppressed=new Set(store.saved.filter(l=>l.mail?.length||['contacted','not-suitable'].includes(l.status)).flatMap(identityKeys));
    const seen=new Set(), ready=[],review=[];
    const ranked=eligible.map(l=>({...l,...rank(l,c)})).sort((a,b)=>b.score-a.score);
    for(const lead of ranked){
      const keys=identityKeys(lead);
      if(keys.some(k=>suppressed.has(k)||seen.has(k))||lead.status==='not-suitable')continue;
      const opportunity=['needs-review','social-or-directory'].includes(lead.assessment.status)||lead.websiteVerifiedAbsent;
      if(lead.email && opportunity){ready.push(lead);keys.forEach(k=>seen.add(k));}
      else if(lead.assessment.status==='no-listed-website'||opportunity)review.push(lead);
    }
    return {...c,ready:ready.slice(0,5),review:review.filter(l=>!identityKeys(l).some(k=>seen.has(k))),contacted:eligible.filter(l=>l.mail?.length),followups:eligible.filter(l=>l.followupAt&&l.followupAt<=Date.now()&&l.status!=='not-suitable'),lastSearch:store.searches.find(j=>j.campaignId===c.id)?.message};
  }
  let ticking=false;
  async function tick(){
    if(current||closed||ticking)return;
    const c=store.campaigns.find(x=>x.weekly&&x.nextRun<=Date.now());
    if(!c)return;
    ticking=true;
    try{await startSearch(c,c,true);}catch(e){if(!current){c.lastError=e.message;c.nextRun=Date.now()+WEEK;await persist();}}
    finally{ticking=false;}
  }
  const timer=setInterval(()=>tick().catch(()=>{}),30000);timer.unref();
  return {
    tick,
    async prepareLead(id){const lead=ensureLead(id);await persist();return lead;},
    async recordMail(id,entry){const lead=ensureLead(id);lead.mail??=[];lead.mail.unshift(entry);lead.status='contacted';lead.followupAt=Date.now()+WEEK;await persist();},
    async attachDemo(id,slug){const lead=ensureLead(id);lead.demoSlugs=[slug,...(lead.demoSlugs||[]).filter(x=>x!==slug)];if(lead.status==='new')lead.status='demo-created';await persist();},
    async close(){closed=true;clearInterval(timer);await pendingSave;},
    async handle(req,res,pathname,json){
      if(pathname==='/api/campaigns'&&req.method==='GET'){json(res,200,{campaigns:store.campaigns.map(campaignView)});return true;}
      if(pathname==='/api/campaigns'&&req.method==='POST'){
        const b=await readJSON(req),sector=validateSearch(b);
        if(typeof b.name!=='string'||!b.name.trim()||b.name.length>100||typeof b.weekly!=='boolean'||![b.include,b.exclude].every(list=>Array.isArray(list)&&list.length<=24&&list.every(x=>typeof x==='string'&&x.length<=80))||!Array.isArray(b.demos)||b.demos.length>2||!b.demos.every(x=>typeof x==='string'&&/^[a-z0-9-]{1,80}$/.test(x)))throw new RequestError(400,'Check campaign name, keywords and examples.');
        const c=b.id?store.campaigns.find(x=>x.id===b.id):{id:randomUUID()};
        if(!c)throw new RequestError(404,'Campaign not found.');
        if(!c.weekly&&b.weekly)c.nextRun=Date.now()+WEEK;
        Object.assign(c,{name:b.name.trim(),sectorId:sector.id,sector:sector.label,area:b.area.trim(),limit:b.limit,budget:b.budget,weekly:b.weekly,include:b.include.map(x=>x.trim().toLowerCase()).filter(Boolean),exclude:b.exclude.map(x=>x.trim().toLowerCase()).filter(Boolean),demos:[...new Set(b.demos)]});
        if(!b.id)store.campaigns.push(c);
        for(const job of store.searches)if(job.sectorId===c.sectorId&&job.area.toLowerCase()===c.area.toLowerCase())for(const l of job.results)if(store.saved.length<2000)attach(l,c);
        await persist();json(res,200,{id:c.id});return true;
      }
      const runCampaign=/^\/api\/campaigns\/([a-f0-9-]{36})\/run$/.exec(pathname);
      if(runCampaign&&req.method==='POST'){
        const c=store.campaigns.find(x=>x.id===runCampaign[1]);if(!c)throw new RequestError(404,'Campaign not found.');
        const job=await startSearch(c,c);json(res,202,{id:job.id});return true;
      }
      if(pathname==='/api/leads/review'&&req.method==='POST'){
        const b=await readJSON(req),lead=ensureLead(b.id);
        if(b.action==='confirm' && !lead.website){lead.websiteVerifiedAbsent=true;lead.assessment={...lead.assessment,reasons:['You checked for an official website and found none.']};}
        else if(b.action==='website' && safeURL(b.website)){lead.website=safeURL(b.website);lead.websiteVerifiedAbsent=false;lead.assessment=await inspect(lead.website);}
        else if(b.action==='done')lead.followupAt=null;
        else if(b.action==='email' && emailOK(b.email))lead.email=b.email;
        else throw new RequestError(400,'Check the review details.');
        await persist();json(res,200,{ok:true});return true;
      }
      if(pathname==='/api/leads/sectors'&&req.method==='GET'){json(res,200,{groups:SECTOR_GROUPS,count:SECTORS.length});return true;}
      if(pathname==='/api/leads/searches'&&req.method==='GET'){json(res,200,{searches:store.searches.map(summary)});return true;}
      if(pathname==='/api/leads/searches'&&req.method==='POST'){
        if(current)throw new RequestError(409,'A search is already running. Wait for it to finish before starting another.');
        const job=await startSearch(await readJSON(req));json(res,202,job);return true;
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
        const rows=[['Company','Sector','Search area','Address','Phone','Email','Email source','Website','Maps URL','Website assessment','Evidence','Checked','Status','Notes'],...store.saved.map(lead=>[lead.name,lead.sector,lead.area,lead.address,lead.phone,lead.email,lead.emailSource,lead.website,lead.mapsURL,lead.assessment.status,lead.assessment.reasons.join(' | '),lead.checkedAt,lead.status,lead.notes])];
        res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="ivory-digital-leads.csv"','Cache-Control':'no-store'});res.end('\uFEFF'+rows.map(row=>row.map(csvCell).join(',')).join('\r\n'));return true;
      }
      return false;
    }
  };
}
