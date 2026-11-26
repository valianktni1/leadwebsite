import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';

const blocked = new BlockList();
for (const [ip, prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]]) blocked.addSubnet(ip,prefix,'ipv4');
blocked.addSubnet('2001::',23,'ipv6'); blocked.addSubnet('2001:db8::',32,'ipv6'); blocked.addSubnet('2002::',16,'ipv6');
const globalV6 = new BlockList(); globalV6.addSubnet('2000::',3,'ipv6');
export const publicAddress = ip => isIP(ip) === 4 ? !blocked.check(ip,'ipv4') : isIP(ip) === 6 && globalV6.check(ip,'ipv6') && !blocked.check(ip,'ipv6');
export function websiteURL(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (url.port && !['80','443'].includes(url.port))) throw new Error('Unsupported website URL');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host.includes('.') && !isIP(host) || /(?:^|\.)(?:localhost|local|internal|home|lan|test|invalid)$/.test(host)) throw new Error('Not a public website');
  if (isIP(host) && !publicAddress(host)) throw new Error('Not a public website');
  return url;
}

// DNS is checked before each redirect, then pinned to the checked address for the request.
export async function fetchWebsite(value, { signal, resolve = lookup } = {}) {
  const deadline = AbortSignal.timeout(12000);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let url = websiteURL(value);
  for (let redirect = 0; redirect <= 4; redirect++) {
    combined.throwIfAborted();
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = isIP(host) ? [{address:host, family:isIP(host)}] : await Promise.race([
      resolve(host, { all:true, verbatim:true }),
      new Promise((_,reject) => { const fail = () => reject(new Error('Website lookup timed out')); combined.addEventListener('abort',fail,{once:true}); })
    ]);
    if (!addresses.length || addresses.some(item => !publicAddress(item.address))) throw new Error('Website resolves to a non-public address');
    const address = addresses.find(item => item.family === 4) || addresses[0];
    const response = await new Promise((resolveRequest,reject) => {
      const request = (url.protocol === 'https:' ? https : http).get(url, {
        signal:combined, agent:false,
        headers: { 'User-Agent':'IvoryDigitalWebsiteReview/1.0', Accept:'text/html,application/xhtml+xml' },
        lookup: (_hostname, options, callback) => options.all ? callback(null,[address]) : callback(null,address.address,address.family)
      }, response => {
        if ([301,302,303,307,308].includes(response.statusCode)) { response.resume(); resolveRequest({ redirect:response.headers.location }); return; }
        let length=0, truncated=false; const chunks=[];
        response.on('data',chunk => { if (length < 1024*1024) { const part=chunk.subarray(0,1024*1024-length); chunks.push(part); length += part.length; } else { truncated=true; response.destroy(); } });
        const finish = () => resolveRequest({ status:response.statusCode, type:response.headers['content-type'] || '', html:Buffer.concat(chunks).toString('utf8'), finalURL:url.href, truncated });
        response.on('end',finish); response.on('close',() => { if (truncated) finish(); }); response.on('error',error => { if (!truncated) reject(error); });
      }); request.on('error',reject);
    });
    if (!('redirect' in response)) return response;
    if (!response.redirect) throw new Error('Invalid website redirect');
    url = websiteURL(new URL(response.redirect,url).href);
  }
  throw new Error('Too many website redirects');
}

const plain = html => html.replace(/<(script|style)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi,' ').replace(/<[^>]*(?:>|$)/g,' ').replace(/\s+/g,' ').trim();
export function assessWebsite(response, year = new Date().getUTCFullYear()) {
  const { status, html='', finalURL='', type='' } = response;
  if (status < 200 || status >= 300) return { status:'unavailable', score:0, reasons:[`Website returned HTTP ${status}; this does not prove the site is old.`], finalURL };
  if (type && !/html/i.test(type)) return { status:'manual-review', score:0, reasons:['The link did not return an HTML homepage.'], finalURL };
  if (plain(html).length < 120) return { status:'manual-review', score:0, reasons:['Not enough page content to assess; the site may require JavaScript.'], finalURL };
  if (/(?:captcha|verify you are human|checking your browser|just a moment\.\.\.)/i.test(html.slice(0,15000))) return { status:'manual-review', score:0, reasons:['The website showed a verification screen, so its design was not assessed.'], finalURL };
  const reasons=[]; let score=0;
  if (!/<meta\b[^>]*\bname\s*=\s*["']?viewport\b/i.test(html)) { reasons.push('No mobile viewport declaration found in the returned HTML.'); score += 2; }
  if (finalURL.startsWith('http:')) { reasons.push('The checked homepage remained on HTTP rather than HTTPS.'); score += 2; }
  if (/<(?:frameset|frame)\b/i.test(html)) { reasons.push('Legacy frame-based page structure detected.'); score += 3; }
  if (/<(?:font|center)\b/i.test(html)) { reasons.push('Legacy presentational HTML tags detected.'); score++; }
  const footer = (/<footer\b[^>]*>([\s\S]*?)<\/footer>/i.exec(html)?.[1] || html.slice(-8000));
  const years = [...footer.matchAll(/(?:©|&copy;|&#169;|copyright)\s*(?:[A-Za-z &;.,'-]{0,60})((?:19|20)\d{2})(?:\s*[-–]\s*((?:19|20)\d{2}))?/gi)].map(match => Number(match[2] || match[1]));
  if (years.length && Math.max(...years) <= year-5) { reasons.push(`Copyright text shows ${Math.max(...years)}; this alone does not establish website age.`); score++; }
  return { status:score >= 3 ? 'needs-review' : 'no-clear-issues', score, reasons:reasons.length ? reasons : ['No clear legacy/mobile/HTTPS issues found in this limited HTML check.'], finalURL };
}

export async function inspectWebsite(value, { fetchPage = fetchWebsite, signal } = {}) {
  if (!value) return { status:'no-listed-website', score:10, reasons:['No website was listed in the Maps result. Check for an unlisted website before outreach.'] };
  let url; try { url=websiteURL(value); } catch { return { status:'manual-review', score:0, reasons:['The listed website link could not be safely checked.'] }; }
  if (/(?:^|\.)(facebook\.com|instagram\.com|tiktok\.com|linkedin\.com|yell\.com|checkatrade\.com|trustatrader\.com)$/.test(url.hostname)) return { status:'social-or-directory', score:8, reasons:['The Maps website link points to a social profile or directory rather than a standalone company website.'], finalURL:url.href };
  try { return assessWebsite(await fetchPage(url.href,{signal})); }
  catch (error) { if (signal?.aborted) throw error; return { status:'unavailable', score:0, reasons:['The website could not be checked (connection, TLS, DNS or access issue). This is not evidence of website age.'] }; }
}

export async function findOfficialWebsite(lead, fetchPage=fetchWebsite) {
  const normalName = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g,'');
  const phone = value => String(value || '').replace(/\D/g,'').slice(-10);
  if(phone(lead.phone).length!==10)return '';
  for(const candidate of (lead.possibleSites||[]).slice(0,2)){
    try{
      const page=await fetchPage(candidate);
      if(page.status!==200)continue;
      const host=new URL(page.finalURL).hostname.replace(/^www\./,'');
      for(const match of page.html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)){
        let parsed;
        try{parsed=JSON.parse(match[1]);}catch{continue;}
        for(const item of [parsed].flat().flatMap(x=>x?.['@graph']||[x])){
          if(!item?.url||normalName(item.name)!==normalName(lead.name)||phone(item.telephone)!==phone(lead.phone))continue;
          const official=websiteURL(item.url);
          if(official.hostname.replace(/^www\./,'')===host)return official.href;
        }
      }
    }catch{ /* Unconfirmed candidates stay available for manual review. */ }
  }
  return '';
}
