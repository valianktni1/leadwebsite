import { RequestError } from '../account.mjs';

export const APIFY_ACTOR = 'compass~crawler-google-places';
export const tokenOK = token => typeof token === 'string' && /^[A-Za-z0-9_-]{16,256}$/.test(token);
export function createApifyClient({ fetchAPI = fetch } = {}) {
  async function api(route, token, { method='GET', body, signal } = {}) {
    if (!tokenOK(token)) throw new RequestError(400,'Connect your Apify account in Search settings.');
    let response;
    try { response=await fetchAPI(`https://api.apify.com/v2/${route}`, { method, redirect:'error', headers:{ Authorization:`Bearer ${token}`, ...(body ? {'Content-Type':'application/json'} : {}) }, ...(body ? {body:JSON.stringify(body)} : {}), signal:signal ? AbortSignal.any([signal,AbortSignal.timeout(45000)]) : AbortSignal.timeout(45000) }); }
    catch { throw new RequestError(502, method==='POST' ? 'Apify did not confirm whether the search started. Check your Apify runs before trying again; the app will not start a duplicate automatically.' : 'Could not reach Apify. Check the search in your Apify console.'); }
    if (!response.ok) {
      const message = response.status===401 ? 'Apify rejected the token. Update it in Search settings.' : response.status===402 ? 'Apify has insufficient credits or requires billing setup.' : response.status===403 ? 'The Apify token cannot access this Actor or run.' : response.status===429 ? 'Apify is rate-limiting requests. Try again later.' : 'Apify could not complete the request. Check the run in your Apify console.';
      throw new RequestError(502,message);
    }
    try { return await response.json(); } catch { throw new RequestError(502,'Apify returned an unreadable response.'); }
  }
  return {
    async verify(token) { await api('users/me',token); return true; },
    async search({ token, webResults=false, sector, area, limit, budget, onRun, onProgress, signal }) {
      const input={ searchStringsArray:[sector], locationQuery:`${area}, United Kingdom`, countryCode:'gb', language:'en', maxCrawledPlacesPerSearch:limit, website:'allPlaces', skipClosedPlaces:false, scrapePlaceDetailPage:false, scrapeContacts:true, maximumLeadsEnrichmentRecords:0, maxReviews:0, maxImages:0, includeWebResults:webResults, scrapeDirectories:false, enableCompetitorAnalysis:false };
      const query=new URLSearchParams({ timeout:'300', maxTotalChargeUsd:String(budget), restartOnError:'false' });
      let run=(await api(`actors/${APIFY_ACTOR}/runs?${query}`,token,{method:'POST',body:input,signal})).data;
      if (!run?.id || !/^[a-zA-Z0-9]+$/.test(run.id)) throw new RequestError(502,'Apify did not return a valid run ID. Check your Apify console before retrying.');
      await onRun?.(run.id);
      for (let poll=0; ['READY','RUNNING','TIMING-OUT','ABORTING'].includes(run.status); poll++) {
        if (poll>=20) throw new RequestError(504,'The search is still active on Apify. Its run is linked below; no replacement search was started.');
        await onProgress?.('Finding businesses on Google Maps…');
        run=(await api(`actor-runs/${run.id}?waitForFinish=30`,token,{signal})).data;
        if (!run?.id) throw new RequestError(502,'Apify returned an invalid run status.');
      }
      if (!run.defaultDatasetId || !/^[a-zA-Z0-9]+$/.test(run.defaultDatasetId)) throw new RequestError(502,'Apify did not return a result dataset.');
      const items=await api(`datasets/${run.defaultDatasetId}/items?clean=true&format=json&limit=${limit}`,token,{signal});
      if (!Array.isArray(items)) throw new RequestError(502,'Apify returned an invalid result list.');
      const warnings=[];
      if (run.status!=='SUCCEEDED') warnings.push(`Apify finished with status ${run.status}; these results may be incomplete. Review the linked run before repeating the search.`);
      return { items, warnings, runId:run.id };
    }
  };
}
