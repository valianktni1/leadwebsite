import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../server.mjs';
import { createApifyClient } from '../lib/apify.mjs';
import { publicAddress, websiteURL, fetchWebsite, assessWebsite, inspectWebsite } from '../lib/websites.mjs';
import { SECTORS, SECTOR_GROUPS } from '../lib/sectors.mjs';
import { csvCell, normalisePlace } from '../lib/leads.mjs';

test('broad sector list has stable unique choices',()=>{assert.ok(SECTORS.length>=350);assert.equal(new Set(SECTORS.map(s=>s.id)).size,SECTORS.length);assert.ok(SECTOR_GROUPS.length>=15);assert.ok(SECTORS.some(s=>s.id==='plumbers'));});
test('website checks reject internal addresses and unsafe URLs',async()=>{
  for(const address of ['127.0.0.1','10.1.2.3','172.16.0.2','192.168.24.10','169.254.169.254','0.0.0.0','100.64.0.1','224.1.1.1','::1','::ffff:127.0.0.1','fc00::1','fe80::1','2001:db8::1'])assert.equal(publicAddress(address),false,address);
  for(const address of ['8.8.8.8','1.1.1.1','2606:4700:4700::1111'])assert.equal(publicAddress(address),true,address);
  for(const url of ['http://localhost','http://192.168.24.10','http://2130706433','http://[::1]','file:///etc/passwd','https://user:pass@example.com','https://example.com:3000'])assert.throws(()=>websiteURL(url),undefined,url);
  await assert.rejects(fetchWebsite('https://attacker.example',{resolve:async()=>[{address:'192.168.24.10',family:4}]}),/non-public/);
  await assert.rejects(fetchWebsite('https://attacker.example',{resolve:async()=>[{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}]}),/non-public/);
});
test('website opportunities retain evidence without asserting an age',async()=>{
  const content='<p>'+('A local business offering plumbing and heating services. '.repeat(5))+'</p>';
  const current=assessWebsite({status:200,type:'text/html',finalURL:'https://example.com',html:`<meta name="viewport" content="width=device-width">${content}<footer>Copyright 2010</footer>`},2026);
  assert.equal(current.status,'no-clear-issues');assert.equal(current.score,1);
  const old=assessWebsite({status:200,type:'text/html',finalURL:'http://example.com',html:content},2026);assert.equal(old.status,'needs-review');assert.equal(old.reasons.length,2);
  assert.equal(assessWebsite({status:403,html:content}).status,'unavailable');
  assert.equal(assessWebsite({status:200,html:'<div id="app"></div>'}).status,'manual-review');
  assert.equal((await inspectWebsite('')).status,'no-listed-website');
  assert.equal((await inspectWebsite('https://facebook.com/company')).status,'social-or-directory');
  assert.equal((await inspectWebsite('https://example.com',{fetchPage:async()=>{throw new Error('timeout');}})).status,'unavailable');
  assert.match((await inspectWebsite('')).reasons[0],/unlisted website/);
});
test('Apify receives a UK query, result limit, budget and business contacts without person enrichment',async()=>{
  const calls=[],token='apify_api_test_private_token';
  const client=createApifyClient({fetchAPI:async(url,options)=>{calls.push({url,options});let data;if(url.includes('/actors/'))data={data:{id:'run123',status:'RUNNING'}};else if(url.includes('/actor-runs/'))data={data:{id:'run123',status:'SUCCEEDED',defaultDatasetId:'dataset123'}};else data=[{title:'A business',countryCode:'GB'}];return new Response(JSON.stringify(data),{status:200});}});
  let runId;const results=await client.search({token,sector:'Plumbers',area:'Liverpool',limit:25,budget:0.5,onRun:id=>{runId=id;}});
  assert.equal(runId,'run123');assert.equal(results.items.length,1);assert.equal(calls.length,3);
  const url=new URL(calls[0].url);assert.equal(url.searchParams.get('maxTotalChargeUsd'),'0.5');assert.equal(url.searchParams.get('restartOnError'),'false');
  const input=JSON.parse(calls[0].options.body);assert.equal(input.countryCode,'gb');assert.equal(input.locationQuery,'Liverpool, United Kingdom');assert.equal(input.maxCrawledPlacesPerSearch,25);assert.equal(input.scrapeContacts,true);assert.equal(input.maxReviews,0);assert.equal(input.maxImages,0);assert.equal(input.maximumLeadsEnrichmentRecords,0);assert.equal(input.enableCompetitorAnalysis,false);
  assert.equal(calls[0].options.headers.Authorization,`Bearer ${token}`);assert.equal(calls.some(call=>call.url.includes(token)),false);
});
test('ambiguous Apify start failures never create an automatic duplicate',async()=>{let attempts=0;const client=createApifyClient({fetchAPI:async()=>{attempts++;throw new Error('network error');}});await assert.rejects(client.search({token:'apify_api_test_private_token',sector:'Plumbers',area:'Leeds',limit:10,budget:0.25}),/did not confirm/);assert.equal(attempts,1);});
test('Maps data requires UK country evidence and excludes closed companies',()=>{
  const raw={title:'A Company',countryCode:'GB',address:'Liverpool L1 1AA',url:'https://www.google.com/maps?cid=123',website:'https://example.com'};
  assert.ok(normalisePlace(raw,{label:'Plumbers'},'Liverpool'));
  for(const change of [{countryCode:'US'},{countryCode:''},{permanentlyClosed:true},{temporarilyClosed:true}])assert.equal(normalisePlace({...raw,...change},{label:'Plumbers'},'Liverpool'),null);
  assert.equal(normalisePlace({...raw,website:'http://192.168.1.1'},{label:'Plumbers'},'Liverpool').invalidWebsite,true);
  assert.equal(csvCell('=HYPERLINK("bad")'),'"\'=HYPERLINK(""bad"")"');
});

test('lead search auth, encrypted token import, UK filtering, shortlist persistence and CSV',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'ivory-leads-')),configDir=path.join(root,'config');let server,base,cookie='',starts=0,verifies=0;
  const client={async verify(){verifies++;},async search(options){starts++;assert.equal(options.token,'apify_api_imported_private_token');await options.onRun('fakeRun123');return{runId:'fakeRun123',warnings:[],items:[{title:'No Site Ltd',placeId:'one',countryCode:'GB',address:'Liverpool L1 1AA',url:'https://www.google.com/maps?cid=1'},{title:'No Site Ltd duplicate',placeId:'one',countryCode:'GB'},{title:'American business',countryCode:'US'},{title:'Closed business',countryCode:'GB',permanentlyClosed:true},{title:'Legacy Site',placeId:'two',countryCode:'GB',website:'https://example.com',url:'https://www.google.com/maps?cid=2'}]};}};
  async function start(){server=await createApp({dataDir:path.join(root,'demos'),configDir,seedDir:false,publicURL:'http://localhost',apifyClient:client,inspectWebsite:async website=>({status:website?'needs-review':'no-listed-website',score:website?4:10,reasons:['Fixture evidence']})});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${server.address().port}`;}
  await start();t.after(async()=>{await new Promise(resolve=>server.close(resolve));await fs.rm(root,{recursive:true,force:true});});
  async function api(route,body){const response=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:{Cookie:cookie,...(body===undefined?{}:{Origin:'http://localhost','Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});if(response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];return response;}
  assert.equal((await api('/api/leads/sectors')).status,401);assert.equal((await api('/api/settings/search')).status,401);
  assert.equal((await api('/api/auth/setup',{email:'owner@example.com',password:'a-long-admin-password'})).status,201);
  assert.equal((await (await api('/api/leads/sectors')).json()).count,363);
  const search={sectorId:'plumbers',area:'Liverpool',limit:10,budget:0.25};
  assert.equal((await api('/api/leads/searches',search)).status,400);assert.equal(starts,0);
  await fs.writeFile(path.join(configDir,'apify-token.import'),'apify_api_imported_private_token');
  const settings=await (await api('/api/settings/search')).json();assert.equal(settings.configured,true);assert.equal(settings.token,undefined);
  assert.equal((await fs.readFile(path.join(configDir,'settings.json'),'utf8')).includes('apify_api_imported_private_token'),false);
  await assert.rejects(fs.stat(path.join(configDir,'apify-token.import')),/ENOENT/);
  assert.equal((await api('/api/settings/search/test',{})).status,200);assert.equal(verifies,1);assert.equal(starts,0);
  const updated=await Promise.all([
    api('/api/settings/search',{token:'apify_api_imported_private_token'}),
    api('/api/settings/smtp',{host:'smtp.example.com',port:465,security:'tls',fromEmail:'sales@example.com',fromName:'Ivory Digital',username:'sales@example.com',password:'test-mail-password'})
  ]);
  assert.deepEqual(updated.map(response=>response.status),[200,200]);
  assert.equal((await (await api('/api/settings/smtp')).json()).fromEmail,'sales@example.com');
  assert.equal((await (await api('/api/settings/search')).json()).configured,true);
  assert.equal((await api('/api/leads/searches',{...search,budget:20})).status,400);
  const started=await api('/api/leads/searches',search);assert.equal(started.status,202);const job=await started.json();let result;
  for(let attempt=0;attempt<100;attempt++){result=await (await api(`/api/leads/searches/${job.id}`)).json();if(result.status!=='running')break;await new Promise(resolve=>setTimeout(resolve,10));}
  assert.equal(result.status,'complete');assert.equal(result.results.length,2);assert.equal(result.excluded,3);assert.equal(starts,1);
  assert.equal((await api('/api/leads/saved',{searchId:job.id,resultId:result.results[0].id})).status,200);
  await api('/api/leads/saved',{searchId:job.id,resultId:result.results[0].id});
  let saved=(await (await api('/api/leads/saved')).json()).leads;assert.equal(saved.length,1);
  assert.equal((await api(`/api/leads/saved/${saved[0].id}`,{status:'demo-created',notes:'=Never run spreadsheet formulas'})).status,200);
  const exported=await api('/api/leads/export.csv');assert.equal(exported.status,200);assert.match(await exported.text(),/'=Never run/);
  await new Promise(resolve=>server.close(resolve));await start();await api('/api/auth/login',{email:'owner@example.com',password:'a-long-admin-password'});
  saved=(await (await api('/api/leads/saved')).json()).leads;assert.equal(saved[0].status,'demo-created');assert.equal((await (await api('/api/settings/search')).json()).configured,true);
});
