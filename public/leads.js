(() => {
  const $=id=>document.getElementById(id);
  const state={groups:[],searches:[],job:null,saved:[],notesId:null,timer:null,connected:false};
  const labels={'no-listed-website':'No listed website','needs-review':'Website needs review','social-or-directory':'Social / directory only','unavailable':'Website check unavailable','manual-review':'Manual check needed','no-clear-issues':'No clear issues found'};
  const statuses={'new':'New','contacted':'Contacted','demo-created':'Demo created','not-suitable':'Not suitable'};
  function node(tag,className='',text=''){const item=document.createElement(tag);item.className=className;item.textContent=text;return item;}
  async function api(url,body){const response=await fetch(url,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});if(response.status===401){location.replace('/admin');throw new Error('Please sign in again.');}const data=await response.json();if(!response.ok)throw new Error(data.error||'Unable to complete this request.');return data;}
  function error(id,message){$(id).textContent=message;$(id).hidden=!message;}
  function tab(panel){for(const button of document.querySelectorAll('.studio-nav [role=tab]')){const active=button.dataset.panel===panel;button.setAttribute('aria-selected',String(active));button.tabIndex=active?0:-1;$(button.dataset.panel).hidden=!active;}if(panel==='campaign-panel')refreshCampaigns().catch(campaignError);if(panel==='saved-panel')loadSaved().catch(e=>error('saved-notice',e.message));}
  $('footer-find-leads').onclick=event=>{event.preventDefault();tab('find-panel');$('tab-find').focus();};
  const tabs=[...document.querySelectorAll('.studio-nav [role=tab]')];
  for(const button of tabs){button.onclick=()=>tab(button.dataset.panel);button.onkeydown=event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();let index=tabs.indexOf(button);index=event.key==='Home'?0:event.key==='End'?tabs.length-1:(index+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;tabs[index].focus();tab(tabs[index].dataset.panel);};}
  function sectors(){const current=$('lead-sector').value,query=$('sector-filter').value.toLowerCase();$('lead-sector').replaceChildren();for(const group of state.groups){const options=group.sectors.filter(sector=>`${sector.label} ${group.name}`.toLowerCase().includes(query));if(!options.length)continue;const optgroup=document.createElement('optgroup');optgroup.label=group.name;for(const sector of options){const option=node('option','',sector.label);option.value=sector.id;optgroup.append(option);}$('lead-sector').append(optgroup);}if([...$('lead-sector').options].some(o=>o.value===current))$('lead-sector').value=current;else if(!query&&[...$('lead-sector').options].some(o=>o.value==='plumbers'))$('lead-sector').value='plumbers';}
  $('sector-filter').oninput=sectors;
  function searchButton(){$('start-lead-search').disabled=!state.connected||state.searches.some(job=>job.status==='running');}
  async function connection(){const data=await api('/api/settings/search');state.connected=data.configured;$('search-connection').textContent=data.configured?'Apify connected · UK businesses only':'Connect Apify in Search settings to get started.';$('apify-state').textContent=data.configured?`Token connected (${data.source==='saved'?'saved securely':'server environment'}). Enter a new token only to replace it.`:'No token is connected yet.';$('verify-apify').disabled=!data.configured;searchButton();return data;}
  $('open-search-settings').onclick=async()=>{$('search-settings-dialog').showModal();$('apify-token').value='';error('apify-error','');$('apify-status').textContent='';try{await connection();}catch(e){error('apify-error',e.message);}};
  $('close-search-settings').onclick=()=>$('search-settings-dialog').close();
  $('search-settings-form').onsubmit=async event=>{event.preventDefault();error('apify-error','');$('save-apify').disabled=true;try{await api('/api/settings/search',{token:$('apify-token').value.trim()});$('apify-token').value='';$('apify-status').textContent='Token saved securely.';await connection();}catch(e){error('apify-error',e.message);}finally{$('save-apify').disabled=false;}};
  $('verify-apify').onclick=async()=>{error('apify-error','');$('verify-apify').disabled=true;$('apify-status').textContent='Checking connection…';try{$('apify-status').textContent=(await api('/api/settings/search/test',{})).message;}catch(e){$('apify-status').textContent='';error('apify-error',e.message);}finally{$('verify-apify').disabled=false;}};
  function history(){const select=$('lead-history');select.replaceChildren();if(!state.searches.length){select.append(node('option','','No searches yet'));return;}for(const job of state.searches){const option=node('option','',`${job.sector} · ${job.area} · ${new Date(job.createdAt).toLocaleDateString('en-GB')}`);option.value=job.id;select.append(option);}if(state.job)select.value=state.job.id;}
  async function loadSaved(){state.saved=(await api('/api/leads/saved')).leads;$('saved-count').textContent=state.saved.length;renderSaved();renderResults();}
  function external(label,url){const a=node('a','button light',label);a.href=url;a.target='_blank';a.rel='noopener noreferrer';return a;}
  function card(lead,saved=false){
    lead={...lead,...state.saved.find(item=>item.id===lead.id),campaignDemos:lead.campaignDemos};
    const card=node('article','lead-card');const top=node('div','lead-card-top');top.append(node('span',`lead-tag assessment-${lead.assessment.status}`,labels[lead.assessment.status]||'Manual check needed'));if(saved)top.append(node('span','lead-status',statuses[lead.status]));card.append(top,node('h3','',lead.name),node('p','lead-category',`${lead.sector} · ${lead.area}`),node('p','lead-address',lead.address||'Address not supplied'));
    if(lead.phone)card.append(node('p','lead-phone',lead.phone));
    const contact=node('p','lead-contact');
    if(lead.email){
      const link=node('a','',lead.email);
      link.href='mailto:'+encodeURIComponent(lead.email).replace('%40','@');
      contact.append('Email: ',link);
      if(lead.emailSource)contact.append(' · ',external('Contact source',lead.emailSource));
    }else contact.textContent='Business email unavailable';
    card.append(contact);
    if(lead.rating!==null)card.append(node('p','help',`${lead.rating} / 5 · ${lead.reviewsCount??0} Google reviews`));
    const evidence=node('ul','lead-evidence');for(const reason of lead.assessment.reasons)evidence.append(node('li','',reason));card.append(evidence);
    const actions=node('div','lead-card-actions');if(lead.mapsURL)actions.append(external('View on Maps',lead.mapsURL));if(lead.website)actions.append(external('Visit website',lead.website));
    for(const slug of lead.demoSlugs||[])card.append(external('View personalised demo', '/'+encodeURIComponent(slug)+'/'));
    if(lead.mail?.length){
      const details=node('details');details.append(node('summary','', 'Email history ('+lead.mail.length+')'));
      for(const entry of lead.mail){details.append(node('h4','',entry.subject),node('p','help',new Date(entry.at).toLocaleString('en-GB')+' · '+entry.to),node('pre','lead-notes',entry.text));}
      card.append(details);
    }
    if(lead.followupAt)card.append(node('p','help','Follow up '+new Date(lead.followupAt).toLocaleDateString('en-GB')));
    const emailButton=node('button','button dark',lead.followup?'Prepare follow-up':lead.campaignDemos?'Prepare outreach':'Email lead');
    emailButton.onclick=()=>openEmailComposer({lead,followup:lead.followup});
    const designButton=node('button','button light','Design a website');
    designButton.onclick=()=>openDesignBrief(lead);
    actions.prepend(emailButton,designButton);
    if(saved){const notes=node('button','button dark','Notes & status');notes.onclick=()=>{state.notesId=lead.id;$('notes-company').textContent=lead.name;$('notes-status').value=lead.status;$('notes-text').value=lead.notes;error('notes-error','');$('lead-notes-dialog').showModal();};actions.append(notes);if(lead.notes)card.append(node('p','lead-notes',lead.notes));}
    else {const exists=state.saved.some(item=>item.id===lead.id),save=node('button','button dark',exists?'Saved':'Save lead');save.disabled=exists;save.onclick=async()=>{save.disabled=true;try{await api('/api/leads/saved',{searchId:state.job.id,resultId:lead.id});await loadSaved();}catch(e){save.disabled=false;error('lead-error',e.message);}};actions.append(save);}
    card.append(actions,node('p','lead-checked',`Checked ${new Date(lead.checkedAt).toLocaleString('en-GB')}`));return card;
  }
  function empty(container,title,description){const item=node('div','empty');item.append(node('h3','',title),node('p','',description));container.append(item);}
  function renderResults(){const container=$('lead-results');container.replaceChildren();if(!state.job){empty(container,'Your next lead starts here','Choose a sector and a UK area to start a search.');return;}const filter=$('lead-filter').value,query=$('lead-result-query').value.toLowerCase();const leads=state.job.results.filter(lead=>(filter==='all'||filter==='opportunities'&&['no-listed-website','needs-review','social-or-directory'].includes(lead.assessment.status)||filter===lead.assessment.status)&&`${lead.name} ${lead.address}`.toLowerCase().includes(query));for(const lead of leads)container.append(card(lead));if(!leads.length)empty(container,state.job.status==='running'?'Your search is running':'No matching businesses in this view',state.job.status==='running'?'Results will appear as they are checked. You can switch tabs and come back.':'Try “All results”, another sector, or a different area. No website age is inferred from a failed check.');}
  function renderSaved(){const container=$('saved-results');container.replaceChildren();const query=$('saved-query').value.toLowerCase(),filter=$('saved-filter').value;for(const lead of state.saved.filter(lead=>(filter==='all'||filter===lead.status)&&`${lead.name} ${lead.address} ${lead.sector}`.toLowerCase().includes(query)))container.append(card(lead,true));if(!container.children.length)empty(container,'Keep the right opportunities','Save businesses from your search results to build a shortlist.');}
  function progress(){const box=$('lead-progress');box.replaceChildren();box.hidden=!state.job;if(!state.job)return;box.append(node('strong','',state.job.message));box.append(node('p','help',`${state.job.results.length} reviewed · ${state.job.sector} · ${state.job.area}${state.job.excluded?` · ${state.job.excluded} non-UK, closed or duplicate records excluded`:''}`));for(const warning of state.job.warnings||[])box.append(node('p','help',warning));if(state.job.runId)box.append(external('View Apify run',`https://console.apify.com/view/runs/${encodeURIComponent(state.job.runId)}`));searchButton();}
  async function showJob(id){clearTimeout(state.timer);state.job=await api(`/api/leads/searches/${id}`);const index=state.searches.findIndex(job=>job.id===id);if(index>=0)state.searches[index]=state.job;history();progress();renderResults();if(state.job.status==='running')state.timer=setTimeout(()=>showJob(id).catch(e=>error('lead-error',e.message)),3000);}
  $('lead-history').onchange=()=>{if($('lead-history').value)showJob($('lead-history').value).catch(e=>error('lead-error',e.message));};
  $('lead-search-form').onsubmit=async event=>{event.preventDefault();error('lead-error','');$('start-lead-search').disabled=true;try{const job=await api('/api/leads/searches',{sectorId:$('lead-sector').value,area:$('lead-area').value.trim(),limit:Number($('lead-limit').value),budget:Number($('lead-budget').value)});state.searches.unshift(job);await showJob(job.id);}catch(e){error('lead-error',e.message);searchButton();}};
  for(const id of ['lead-filter','lead-result-query'])$(id).addEventListener('input',renderResults);for(const id of ['saved-query','saved-filter'])$(id).addEventListener('input',renderSaved);
  $('close-lead-notes').onclick=()=>$('lead-notes-dialog').close();
  $('lead-notes-form').onsubmit=async event=>{event.preventDefault();error('notes-error','');$('save-lead-notes').disabled=true;try{await api(`/api/leads/saved/${state.notesId}`,{status:$('notes-status').value,notes:$('notes-text').value});$('lead-notes-dialog').close();await loadSaved();if(!$('campaign-panel').hidden)await refreshCampaigns();}catch(e){error('notes-error',e.message);}finally{$('save-lead-notes').disabled=false;}};
  let campaigns=[],activeId='',editId='',refreshVersion=0;
  const campaignError=e=>error('campaign-notice',e.message);
  const activeCampaign=()=>campaigns.find(c=>c.id===activeId);
  function action(title,fn){
    const b=node('button','button light',title);b.type='button';
    b.onclick=async()=>{b.disabled=true;try{await fn();}catch(e){campaignError(e);}finally{b.disabled=false;}};return b;
  }
  async function refreshCampaigns(){
    const version=++refreshVersion;
    const [result,saved]=await Promise.all([api('/api/campaigns'),api('/api/leads/saved')]);
    if(version!==refreshVersion)return;
    state.saved=saved.leads;$('saved-count').textContent=state.saved.length;
    campaigns=result.campaigns;
    if(!activeCampaign())activeId=campaigns[0]?.id||'';
    $('campaign-select').replaceChildren(...campaigns.map(c=>new Option(c.name,c.id)));
    $('campaign-select').value=activeId;error('campaign-notice','');renderCampaign();
  }
  async function review(lead,action,value){
    await api('/api/leads/review',{id:lead.id,action,...value});await refreshCampaigns();
  }
  function renderCampaign(){
    const c=activeCampaign(),summary=$('campaign-summary'),work=$('campaign-work');
    summary.replaceChildren();work.replaceChildren();
    if(!c){empty(work,'Create your first campaign','Choose a sector, search area and website examples. Matching saved leads can be used immediately.');return;}
    summary.append(node('p','',c.sector+' · '+c.area+' · '+c.limit+' results · $'+c.budget.toFixed(2)+' maximum per run'),
      node('p','help',c.weekly?'Weekly · next search '+new Date(c.nextRun).toLocaleString('en-GB'):'Manual searches only'));
    if(c.lastSearch||c.lastError)summary.append(node('p','help',c.lastError||c.lastSearch));
    const controls=node('div','lead-card-actions');
    controls.append(action('Edit campaign',()=>editCampaign(c)),action('Run search · up to $'+c.budget.toFixed(2),async()=>{
      const job=await api('/api/campaigns/'+c.id+'/run',{});await refreshCampaigns();
      async function check(){
        const current=await api('/api/leads/searches/'+job.id);
        if(current.status==='running'){setTimeout(()=>check().catch(campaignError),3000);return;}
        if(!$('campaign-panel').hidden)await refreshCampaigns();
      }
      await check();
    }),action('Refresh shortlist',refreshCampaigns));summary.append(controls);
    for(const [title,items,kind] of [['Ready to contact',c.ready,'ready'],['Due for follow-up',c.followups,'follow'],['Needs a website or email check',c.review,'review'],['Contact history',c.contacted,'history']]){
      const section=node(['review','history'].includes(kind)?'details':'section');
      section.append(node(['review','history'].includes(kind)?'summary':'h2','',title+' ('+items.length+')'));
      const grid=node('div','lead-results');
      if(!items.length)grid.append(node('p','help',kind==='ready'?'Leads with an email and a checked website opportunity appear here.':kind==='follow'?'No follow-ups due.':'No outstanding checks.'));
      for(const l of items){
        const row=card({...l,campaignDemos:c.demos,followup:kind==='follow'||kind==='history'},true);
        if(kind==='ready')row.prepend(node('p','help',(l.reasons||[]).filter(x=>x.startsWith('Listing mentions')||x.startsWith('Lower priority')).join(' · ')));
        if(kind==='follow')row.append(action('Complete follow-up',()=>review(l,'done')));
        if(kind==='review'){
          if(!l.website && !l.websiteVerifiedAbsent){
            row.append(external('Check for official website','https://www.google.co.uk/search?q='+encodeURIComponent(l.name+' '+l.address+' official website')));
            for(const url of l.possibleSites||[])row.append(external('Check candidate · '+new URL(url).hostname,url));
            const input=document.createElement('input');input.type='url';input.placeholder='https://';const label=node('label','','Official website found');label.append(input);
            row.append(label,action('Assess this website',()=>review(l,'website',{website:input.value.trim()})),action('Checked · no official site found',()=>review(l,'confirm')));
          }
          if(!l.email){
            const input=document.createElement('input');input.type='email';const label=node('label','','Published business email');label.append(input);
            row.append(label,action('Save contact email',()=>review(l,'email',{email:input.value.trim()})));
          }
        }
        grid.append(row);
      }
      section.append(grid);work.append(section);
    }
  }
  function recommend(){
    const sector=$('camp-sector').selectedOptions[0]?.textContent.toLowerCase()||'';
    const words=sector.match(/plumb|heat|dent|bridal|wedding|kitchen/g)||[];
    const picks=[...$('camp-demo1').options].filter(o=>o.value&&words.some(w=>o.text.toLowerCase().includes(w)));
    $('camp-demo1').value=picks[0]?.value||'';$('camp-demo2').value=picks[1]?.value||'';
  }
  async function editCampaign(c){
    const [collection,sectors]=await Promise.all([api('/api/demos'),api('/api/leads/sectors')]);
    editId=c?.id||''; $('camp-error').textContent='';
    $('camp-sector').replaceChildren(...sectors.groups.flatMap(g=>g.sectors.map(s=>new Option(s.label,s.id))));
    $('camp-sector').value=c?.sectorId||$('lead-sector').value||'plumbers';
    for(const id of ['camp-demo1','camp-demo2'])$(id).replaceChildren(new Option('No example',''),...collection.demos.map(d=>new Option(d.name,d.slug)));
    $('camp-name').value=c?.name||'';$('camp-area').value=c?.area||$('lead-area').value;
    $('camp-limit').value=c?.limit||20;$('camp-budget').value=c?.budget||1;
    $('camp-weekly').value=c?.weekly?'on':'off';
    $('camp-include').value=(c?.include||[]).join(', ');$('camp-exclude').value=(c?.exclude||[]).join(', ');
    if(c){$('camp-demo1').value=c.demos[0]||'';$('camp-demo2').value=c.demos[1]||'';}else recommend();
    $('campaign-editor').showModal();
  }
  $('camp-sector').onchange=recommend;
  $('campaign-close').onclick=()=>$('campaign-editor').close();
  $('campaign-new').onclick=()=>editCampaign().catch(campaignError);
  $('campaign-select').onchange=()=>{activeId=$('campaign-select').value;renderCampaign();};
  $('campaign-form').onsubmit=async event=>{
    event.preventDefault();const button=event.submitter;if(button)button.disabled=true;
    const phrases=id=>$(id).value.split(',').map(x=>x.trim()).filter(Boolean);
    try{
      const result=await api('/api/campaigns',{id:editId,name:$('camp-name').value,sectorId:$('camp-sector').value,area:$('camp-area').value,
        budget:Number($('camp-budget').value),limit:Number($('camp-limit').value),weekly:$('camp-weekly').value==='on',
        include:phrases('camp-include'),exclude:phrases('camp-exclude'),demos:[$('camp-demo1').value,$('camp-demo2').value].filter(Boolean)});
      activeId=result.id;$('campaign-editor').close();await refreshCampaigns();
    }catch(e){$('camp-error').textContent=e.message;}finally{if(button)button.disabled=false;}
  };
  window.addEventListener('lead-updated',()=>{loadSaved().catch(campaignError);if(!$('campaign-panel').hidden)refreshCampaigns().catch(campaignError);});
  async function init(){try{const [sectorsData,searchData]=await Promise.all([api('/api/leads/sectors'),api('/api/leads/searches')]);state.groups=sectorsData.groups;state.searches=searchData.searches;sectors();history();await Promise.all([connection(),loadSaved()]);if(state.searches.length)await showJob(state.searches[0].id);else renderResults();}catch(e){error('lead-error',e.message);}}
  init();
})();
