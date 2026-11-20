'use strict';
// Export Buyer Finder - zero-framework Node server (needs only pdf-lib).
const http = require('http'), fs = require('fs'), path = require('path'), dns = require('dns').promises, net = require('net');
try { for (const l of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n')) { const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {}
const E = process.env, PORT = +E.PORT || 3000, EXPORT_MAPS = E.EXPORT_MAPS_FIELDS === 'true';
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const NA = 'Not publicly listed';
const cname = c => { try { return new Intl.DisplayNames(['en'], { type: 'region' }).of(c) || c; } catch { return c; } };
class ApiError extends Error { constructor(code, msg, status = 502) { super(msg); this.code = code; this.status = status; } }

// ---------- helpers ----------
async function fx(url, opts = {}, ms = 15000) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctl.signal, redirect: 'follow' }); } finally { clearTimeout(t); }
}
async function safeUrl(u) { // basic SSRF guard for fetching business sites
  const x = new URL(u); if (!/^https?:$/.test(x.protocol)) throw new Error('bad protocol');
  const addrs = net.isIP(x.hostname) ? [{ address: x.hostname }] : await dns.lookup(x.hostname, { all: true });
  for (const { address: a } of addrs) if (/^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.|::1|fc|fd|fe80)/i.test(a)) throw new Error('private address');
  return x.href;
}
const pool = async (items, n, fn) => { const out = []; let i = 0; await Promise.all(Array(Math.min(n, items.length)).fill(0).map(async () => { while (i < items.length) { const k = i++; try { out[k] = await fn(items[k], k); } catch (e) { out[k] = { error: e }; } } })); return out; };
const today = () => new Date().toISOString().slice(0, 10);

// ---------- HS classification ----------
const HS_TABLE = [
  { k: /cardamom|elaichi/i, o: [{ c: '0908', l: 'Nutmeg, mace and cardamoms (HS 0908)', note: 'Broader than cardamom: heading 0908 also includes nutmeg and mace (HS 2022 split cardamom into 090831/090832).' }] },
  { k: /black pepper|\bpepper\b/i, o: [{ c: '0904', l: 'Pepper of the genus Piper; capsicum / pimenta (HS 0904)', note: 'Includes chillies and allspice as well as pepper.' }] },
  { k: /turmeric/i, o: [{ c: '091030', l: 'Turmeric (curcuma) (HS 091030)' }] },
  { k: /saffron/i, o: [{ c: '091020', l: 'Saffron (HS 091020)' }] },
  { k: /\btea\b/i, o: [{ c: '0902', l: 'Tea, whether or not flavoured (HS 0902)' }] },
  { k: /coffee/i, o: [{ c: '0901', l: 'Coffee, roasted or not (HS 0901)' }] },
  { k: /basmati|\brice\b/i, o: [{ c: '1006', l: 'Rice (HS 1006)', note: 'Includes all rice types, not only basmati.' }] },
  { k: /cashew/i, o: [{ c: '0801', l: 'Coconuts, Brazil nuts and cashew nuts (HS 0801)', note: 'Also covers coconuts and Brazil nuts.' }] },
  { k: /\bhoney\b/i, o: [{ c: '0409', l: 'Natural honey (HS 0409)' }] },
  { k: /t-?shirt/i, o: [{ c: '6109', l: 'T-shirts, singlets and vests, knitted (HS 6109)' }] },
  { k: /cotton bag|tote|jute bag|canvas bag|\bbags?\b/i, o: [
    { c: '6305', l: 'Sacks and bags for packing goods, textile (HS 6305)', note: 'Choose this for shopping, tote or packing bags made of cotton/jute.' },
    { c: '4202', l: 'Handbags, trunks, cases and similar containers (HS 4202)', note: 'Choose this for handbags, travel or fashion bags.' }] },
];
let hsRef = null;
async function hsSearch(q) {
  if (!hsRef) { const r = await fx('https://comtradeapi.un.org/files/v1/app/reference/HS.json'); if (!r.ok) throw new ApiError('UPSTREAM', 'Could not load the HS code list from UN Comtrade.'); hsRef = (await r.json()).results || []; }
  const w = q.toLowerCase().split(/\W+/).filter(x => x.length > 2);
  return hsRef.filter(x => String(x.id).length === 6).map(x => ({ c: String(x.id), l: x.text, s: w.filter(k => String(x.text).toLowerCase().includes(k)).length })).filter(x => x.s).sort((a, b) => b.s - a.s).slice(0, 5).map(({ c, l }) => ({ c, l }));
}
const SERVICE_RE = /\b(services?|consult\w*|development|developer|software|design|marketing|outsourc\w*|training|tutor\w*|saas|programming|translation|legal|accounting|tourism|seo|bpo|support)\b/i;
async function classify({ product, forceService, hs, demo }) {
  if (hs) return { type: 'goods', matches: [{ c: hs, l: `HS ${hs}` }], ok: true };
  if (forceService || SERVICE_RE.test(product)) return { type: 'service', service: 'Services trade (EBOPS category inferred from your description)', coverage: 'Bilateral services data is sparse (OECD-WTO BaTIS / UN Comtrade services cover mainly larger economies). No live bilateral service data is wired in, so choose your destination manually.' };
  const hit = HS_TABLE.find(e => e.k.test(product));
  if (hit) return hit.o.length === 1 ? { type: 'goods', ok: true, matches: hit.o } : { type: 'goods', ok: false, matches: hit.o, question: `Which of these best describes your “${product}”?` };
  if (demo) return { type: 'goods', ok: true, matches: [{ c: '0000', l: 'Demo category (fictional)' }] };
  const m = await hsSearch(product);
  if (!m.length) throw new ApiError('NO_MATCH', `No HS category matched “${product}”. Try a more common product name, or a different spelling.`, 404);
  return { type: 'goods', ok: false, matches: m, question: `We found several possible categories for “${product}”. Which fits best?` };
}

// ---------- UN Comtrade ----------
let reporters = null;
async function loadReporters() {
  if (reporters) return reporters;
  const r = await fx('https://comtradeapi.un.org/files/v1/app/reference/Reporters.json');
  if (!r.ok) throw new ApiError('UPSTREAM', 'Could not load the country reference list from UN Comtrade.');
  return (reporters = (await r.json()).results || []);
}
async function markets({ origin, hs, label, note, demo }) {
  if (demo) return demoMarkets(origin, label);
  if (!E.COMTRADE_API_KEY) throw new ApiError('NO_KEY', 'UN Comtrade API key is missing. Add COMTRADE_API_KEY to .env (free key at comtradedeveloper.un.org) or switch on Demo mode.', 501);
  const refs = await loadReporters();
  const rep = refs.find(x => x.reporterCodeIsoAlpha2 === origin); if (!rep) throw new ApiError('NO_DATA', `${cname(origin)} is not a UN Comtrade reporter, so no export data is available.`, 404);
  const y0 = new Date().getFullYear(); let rows = null, year = null;
  for (let y = y0 - 1; y >= y0 - 5 && !rows; y--) {
    const url = `https://comtradeapi.un.org/data/v1/get/C/A/HS?reporterCode=${rep.reporterCode}&cmdCode=${hs}&flowCode=X&period=${y}&partner2Code=0&motCode=0&customsCode=C00&includeDesc=true`;
    const r = await fx(url, { headers: { 'Ocp-Apim-Subscription-Key': E.COMTRADE_API_KEY } }, 30000);
    if (r.status === 429) throw new ApiError('RATE_LIMIT', 'UN Comtrade rate limit reached. Wait a minute and press Retry.', 429);
    if (r.status === 401 || r.status === 403) throw new ApiError('BAD_KEY', 'UN Comtrade rejected the API key. Check COMTRADE_API_KEY and that the Comtrade API product is subscribed.', 401);
    if (!r.ok) throw new ApiError('UPSTREAM', `UN Comtrade returned HTTP ${r.status}.`);
    const d = (await r.json()).data || []; const keep = d.filter(x => x.partnerCode !== 0 && !x.isAggregate && x.partnerISO && x.partnerISO !== 'W00' && /^[A-Z]{3}$/.test(x.partnerISO));
    if (keep.length) { rows = keep; year = y; }
  }
  if (!rows) throw new ApiError('NO_DATA', `UN Comtrade has no reported exports of HS ${hs} from ${cname(origin)} for ${y0 - 5}–${y0 - 1}. This is missing data, not zero trade.`, 404);
  const a3 = Object.fromEntries(refs.map(x => [x.reporterCodeIsoAlpha3, x.reporterCodeIsoAlpha2]));
  const list = rows.map(x => ({ iso2: a3[x.partnerISO] || null, name: x.partnerDesc, value: x.primaryValue ?? null, currency: 'USD', year, source: 'UN Comtrade', status: x.primaryValue === 0 ? 'reported_zero' : x.primaryValue == null ? 'unavailable' : 'reported' }))
    .filter(x => x.iso2).sort((a, b) => (b.value ?? -1) - (a.value ?? -1)).map((x, i) => ({ ...x, rank: i + 1 }));
  return { year, rows: list, category: label, note: note || null, source: 'UN Comtrade (annual, exports, HS ' + hs + ')' };
}

// ---------- Google Places (New) ----------
async function places(q, region, max = 20) {
  if (!E.GOOGLE_MAPS_API_KEY) throw new ApiError('NO_KEY', 'Google Maps API key is missing. Add GOOGLE_MAPS_API_KEY to .env (enable “Places API (New)”) or switch on Demo mode.', 501);
  const r = await fx('https://places.googleapis.com/v1/places:searchText', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': E.GOOGLE_MAPS_API_KEY, 'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.internationalPhoneNumber,places.websiteUri,places.googleMapsUri,places.primaryTypeDisplayName,places.addressComponents' }, body: JSON.stringify({ textQuery: q, regionCode: region, pageSize: max }) });
  if (r.status === 429) throw new ApiError('RATE_LIMIT', 'Google Maps rate limit reached. Wait a moment and press Retry.', 429);
  if (r.status === 400 || r.status === 403 || r.status === 401) { const j = await r.json().catch(() => ({})); throw new ApiError('BAD_KEY', 'Google Maps rejected the request: ' + (j.error?.message || r.status) + ' (check key, billing and that Places API (New) is enabled).', 403); }
  if (!r.ok) throw new ApiError('UPSTREAM', `Google Maps returned HTTP ${r.status}.`);
  return ((await r.json()).places || []).map(p => ({ id: p.id, name: p.displayName?.text || '', address: p.formattedAddress || '', phone: p.internationalPhoneNumber || '', website: p.websiteUri || '', mapsUri: p.googleMapsUri || '', type: p.primaryTypeDisplayName?.text || '', city: (p.addressComponents || []).find(c => c.types?.includes('locality'))?.longText || '' }));
}

// ---------- website enrichment (independent source for contact fields) ----------
const strip = h => h.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
async function page(u) { try { const r = await fx(await safeUrl(u), { headers: { 'User-Agent': 'ExportBuyerFinder/1.0 (+contact-research)' } }, 7000); if (!r.ok || !/html/.test(r.headers.get('content-type') || '')) return null; return { url: r.url, html: (await r.text()).slice(0, 600000) }; } catch { return null; } }
async function enrich(site) {
  if (!site) return null;
  const home = await page(site); if (!home) return null;
  const pages = [home], links = [...home.html.matchAll(/href=["']([^"'#]+)["']/gi)].map(m => m[1]).filter(h => /contact|about|enquir|inquir|quote|get-in-touch/i.test(h));
  const seen = new Set([home.url]);
  for (const h of links) { let u; try { u = new URL(h, home.url).href; } catch { continue; } if (seen.has(u) || new URL(u).host !== new URL(home.url).host || pages.length >= 3) continue; seen.add(u); const p = await page(u); if (p) pages.push(p); }
  const o = { website: home.url, pages: pages.map(p => p.url), text: '', emails: [], phones: [], name: '', address: '', contactUrl: '', quoteUrl: '' };
  for (const p of pages) {
    const t = strip(p.html); o.text += ' ' + t;
    for (const m of p.html.matchAll(/mailto:([^"'?\s>]+)/gi)) o.emails.push({ v: decodeURIComponent(m[1]).trim(), src: p.url });
    for (const m of t.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) if (!/\.(png|jpe?g|gif|svg|webp)$/i.test(m[0])) o.emails.push({ v: m[0], src: p.url });
    for (const m of p.html.matchAll(/tel:([^"'\s>]+)/gi)) { const v = decodeURIComponent(m[1]).trim(); if (v.startsWith('+')) o.phones.push({ v, src: p.url }); }
    for (const m of t.matchAll(/\+\d[\d\s().-]{7,16}\d/g)) o.phones.push({ v: m[0].trim(), src: p.url });
    for (const m of p.html.matchAll(/<script[^>]+ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) { try { const walk = x => { if (Array.isArray(x)) return x.forEach(walk); if (!x || typeof x !== 'object') return; if (x.address && typeof x.address === 'object' && !o.address) o.address = [x.address.streetAddress, x.address.addressLocality, x.address.addressRegion, x.address.postalCode, x.address.addressCountry?.name || x.address.addressCountry].filter(Boolean).join(', '); if (x.name && !o.name && /Organization|Business|Store|Company/i.test(String(x['@type']))) o.name = x.name; Object.values(x).forEach(walk); }; walk(JSON.parse(m[1])); } catch {} }
    if (!o.name) o.name = (p.html.match(/property=["']og:site_name["'][^>]*content=["']([^"']+)/i) || [])[1] || '';
    if (/contact/i.test(p.url) && !o.contactUrl) o.contactUrl = p.url;
    if (!o.quoteUrl) { const q = [...p.html.matchAll(/href=["']([^"']+)["']/gi)].map(m => m[1]).find(h => /quote|enquir|inquir/i.test(h)); if (q) try { o.quoteUrl = new URL(q, p.url).href; } catch {} }
  }
  const uniq = a => [...new Map(a.map(x => [x.v.toLowerCase().replace(/[\s().-]/g, ''), x])).values()];
  o.emails = uniq(o.emails); o.phones = uniq(o.phones); o.text = o.text.trim(); return o;
}
const windows = (text, term, n = 220) => { const t = text.toLowerCase(), k = term.toLowerCase(), out = []; let i = -1; while ((i = t.indexOf(k, i + 1)) !== -1 && out.length < 8) out.push({ s: text.slice(Math.max(0, i - n), i + k.length + n).trim(), i }); return out; };
const IMPORT_RE = /\bimport(s|er|ers|ed|ing)?\b|استيراد|مستورد|importateur|importeur|importador/i;
function classifyBuyer(site, terms, originName, kind, page0) {
  const ev = (s) => ({ url: site?.website || page0 || '', snippet: s.replace(/\s+/g, ' ') });
  if (site?.text) for (const term of terms) for (const w of windows(site.text, term)) {
    const origin = new RegExp(originName, 'i').test(w.s), imp = IMPORT_RE.test(w.s);
    if (origin && imp) return { cls: 'Documented importer from ' + originName, why: `Its website links “${term}”, importing, and ${originName} in the same passage.`, evidence: ev('…' + w.s + '…') };
  }
  if (site?.text) for (const term of terms) for (const w of windows(site.text, term)) if (IMPORT_RE.test(w.s)) return { cls: 'Product importer', why: `Its website says it imports “${term}”; the origin is not confirmed.`, evidence: ev('…' + w.s + '…') };
  return { cls: 'Potential buyer', why: `Found on Google Maps as a ${kind || 'relevant business'} in the destination; purchasing relationship still needs confirmation.`, evidence: { url: '', snippet: '' } };
}

// ---------- terms, cities ----------
const CITIES = { AE: ['Dubai', 'Sharjah', 'Abu Dhabi'], SA: ['Riyadh', 'Jeddah', 'Dammam'], US: ['New York', 'Los Angeles', 'Houston', 'Chicago'], GB: ['London', 'Birmingham', 'Manchester'], DE: ['Hamburg', 'Frankfurt', 'Berlin'], NL: ['Rotterdam', 'Amsterdam'], FR: ['Paris', 'Marseille'], SG: ['Singapore'], MY: ['Kuala Lumpur', 'Penang'], IN: ['Mumbai', 'Delhi', 'Chennai', 'Kochi'], CN: ['Shanghai', 'Guangzhou', 'Shenzhen'], JP: ['Tokyo', 'Osaka'], AU: ['Sydney', 'Melbourne'], CA: ['Toronto', 'Vancouver'], EG: ['Cairo', 'Alexandria'], PK: ['Karachi', 'Lahore'], BD: ['Dhaka', 'Chittagong'], LK: ['Colombo'], KW: ['Kuwait City'], QA: ['Doha'], OM: ['Muscat'], BH: ['Manama'], ZA: ['Johannesburg', 'Cape Town'], NG: ['Lagos'], KE: ['Nairobi', 'Mombasa'], TR: ['Istanbul', 'Izmir'], MX: ['Mexico City'], BR: ['São Paulo'], ES: ['Madrid', 'Barcelona'], IT: ['Milan', 'Rome'] };
const LOCAL = { ar: { c: 'AE SA EG KW QA OM BH JO MA DZ IQ LB', w: ['مستورد', 'موزع', 'تاجر جملة'] }, fr: { c: 'FR BE SN CI', w: ['importateur', 'grossiste'] }, de: { c: 'DE AT CH', w: ['Importeur', 'Großhändler'] }, es: { c: 'ES MX AR CO CL PE', w: ['importador', 'mayorista'] }, zh: { c: 'CN TW', w: ['进口商', '批发商'] } };
const PRODUCT_LOCAL = { cardamom: { ar: 'هيل', fr: 'cardamome', de: 'Kardamom', es: 'cardamomo', zh: '豆蔻' }, turmeric: { ar: 'كركم', fr: 'curcuma', de: 'Kurkuma', es: 'cúrcuma' }, tea: { ar: 'شاي', fr: 'thé', de: 'Tee', es: 'té', zh: '茶' }, coffee: { ar: 'قهوة', fr: 'café', de: 'Kaffee', es: 'café', zh: '咖啡' }, rice: { ar: 'أرز', fr: 'riz', de: 'Reis', es: 'arroz', zh: '大米' } };
async function llmTerms(product, destName) {
  if (!E.ANTHROPIC_API_KEY) return null;
  try { const r = await fx('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': E.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: E.ANTHROPIC_MODEL || 'claude-sonnet-4-6', max_tokens: 400, messages: [{ role: 'user', content: `Return ONLY JSON {"synonyms":[up to 3 English synonyms/related trade names for "${product}"],"local":[up to 3 phrases a buyer in ${destName} would search for to find importers of "${product}", in that country's main local language]}` }] }) }, 20000); const j = await r.json(); return JSON.parse((j.content?.[0]?.text || '').replace(/```json|```/g, '')); } catch { return null; }
}
async function buildTerms(product, dest) {
  const p = product.trim().toLowerCase(), base = [p], local = [], lang = Object.entries(LOCAL).find(([, v]) => v.c.split(' ').includes(dest))?.[0];
  const L = await llmTerms(product, cname(dest)); if (L) { base.push(...(L.synonyms || [])); local.push(...(L.local || [])); }
  if (lang) { const lp = Object.entries(PRODUCT_LOCAL).find(([k]) => p.includes(k))?.[1]?.[lang]; if (lp) { base.push(lp); LOCAL[lang].w.forEach(w => local.push(`${lp} ${w}`)); } }
  return { base: [...new Set(base)].slice(0, 5), local: [...new Set(local)].slice(0, 4) };
}

// ---------- providers ----------
const PERISHABLE = /fresh|chilled|frozen|fruit|vegetable|meat|fish|seafood|dairy|flower|perishable/i;
async function providers({ product, origin, dest, pickup, demo }) {
  const O = cname(origin), D = cname(dest);
  if (demo) return demoProviders(O, D, pickup);
  const cities = pickup ? [pickup] : [O, ...(CITIES[origin] || []).slice(0, 2)];
  const kinds = ['freight forwarder', 'air cargo', 'sea freight shipping', 'international courier'];
  const qs = []; for (const c of cities) for (const k of kinds) qs.push(`${k} ${c}`);
  const res = await pool(qs.slice(0, 12), 4, q => places(q, origin, 10));
  const errs = res.filter(r => r.error); if (errs.length === res.length) throw errs[0].error;
  const map = new Map(); res.filter(r => !r.error).flat().forEach(p => { const k = p.website ? new URL(p.website).host : p.id; if (!map.has(k)) map.set(k, p); });
  const out = await pool([...map.values()].slice(0, 30), 6, async p => {
    const s = await enrich(p.website), t = s?.text || '', kinds2 = [];
    if (/air (freight|cargo)/i.test(t + p.type)) kinds2.push('Air cargo'); if (/(sea|ocean) freight|fcl|lcl|shipping line/i.test(t + p.type)) kinds2.push('Sea freight'); if (/courier|express/i.test(t + p.type)) kinds2.push('Courier'); if (/forward|logistics/i.test(t + p.type)) kinds2.push('Freight forwarding'); if (/customs/i.test(t)) kinds2.push('Customs clearance');
    let cov = null; if (t) for (const w of windows(t, D)) if (/ship|freight|cargo|deliver|export|route|service/i.test(w.s)) { cov = { text: `Documented: website mentions shipping to ${D}`, url: s.website, snippet: '…' + w.s + '…' }; break; }
    const cold = PERISHABLE.test(product) ? (/cold chain|reefer|temperature[- ]controlled|refrigerat/i.test(t) ? 'Documented on website (cold chain / temperature-controlled)' : 'Not documented — ask provider') : null;
    return mk(p, s, { services: kinds2.length ? kinds2 : [p.type || 'Logistics'], coverage: cov || { text: 'Contact provider to confirm route', url: '', snippet: '' }, cold, quote: s?.quoteUrl || '' }, D);
  });
  return { providers: out.filter(x => !x.error), attribution: true };
}
function mk(p, s, extra, D) {
  const pick = (siteV, mapsV, src) => siteV ? { v: siteV, src } : EXPORT_MAPS && mapsV ? { v: mapsV, src: 'Google Maps Places' } : null;
  const em = s?.emails[0], ph = s?.phones[0];
  return {
    id: p.id, disp: { name: p.name, address: p.address, phone: p.phone, website: p.website, mapsUri: p.mapsUri, type: p.type, city: p.city, email: em?.v || '', contactUrl: s?.contactUrl || '' }, ...extra,
    exp: { name: pick(s?.name, p.name, s?.website)?.v || 'Name not exported — see Maps link: ' + p.mapsUri, address: pick(s?.address, p.address, s?.website)?.v || NA, phone: pick(ph?.v, p.phone, ph?.src)?.v || NA, phoneSrc: ph?.src || (EXPORT_MAPS && p.phone ? 'Google Maps Places' : ''), email: em?.v || NA, emailSrc: em?.src || '', website: s?.website || NA, contactUrl: s?.contactUrl || NA, city: p.city, type: p.type, checked: today() }
  };
}

// ---------- buyers ----------
async function buyers({ product, origin, dest, demo }) {
  const O = cname(origin), D = cname(dest);
  if (demo) return demoBuyers(product, O, D, dest);
  const T = await buildTerms(product, dest), cities = CITIES[dest] || [D], types = ['importer', 'distributor', 'wholesaler', 'trade supplier'];
  const qs = []; for (const c of cities.slice(0, 4)) { for (const ty of types) qs.push({ q: `${T.base[0]} ${ty} ${c}`, c }); T.base.slice(1, 3).forEach(s => qs.push({ q: `${s} importer ${c}`, c })); T.local.forEach(l => qs.push({ q: `${l} ${c}`, c })); }
  const res = await pool(qs.slice(0, 24), 5, x => places(x.q, dest, 15).then(r => r.map(p => ({ ...p, city: p.city || x.c }))));
  const errs = res.filter(r => r.error); if (errs.length === res.length) throw errs[0].error;
  const map = new Map(); res.filter(r => !r.error).flat().forEach(p => { const k = p.website ? new URL(p.website).host.replace(/^www\./, '') : p.id; if (!map.has(k)) map.set(k, p); });
  const terms = [...T.base, ...T.local.map(l => l.split(' ')[0])];
  const out = await pool([...map.values()].slice(0, 40), 6, async p => {
    const s = await enrich(p.website), c = classifyBuyer(s, terms, O, p.type, p.website), b = mk(p, s, {}, D);
    Object.assign(b.exp, { country: D, product, cls: c.cls, why: c.why, evidenceUrl: c.evidence.url || 'No documented evidence — Google Maps listing only', evidenceText: c.evidence.snippet, contactSource: [b.exp.emailSrc, b.exp.phoneSrc].filter(Boolean).join(' ; ') || NA });
    return { ...b, cls: c.cls, why: c.why, evidence: c.evidence };
  });
  return { businesses: out.filter(x => !x.error), cities, terms: T, attribution: true };
}

// ---------- demo data (FICTIONAL) ----------
const DEMO = ' — DEMO / FICTIONAL';
function demoMarkets(origin, label) {
  const names = [['AE', 'United Arab Emirates', 98.2e6], ['SA', 'Saudi Arabia', 71.4e6], ['US', 'United States', 33.9e6], ['DE', 'Germany', 21.5e6], ['GB', 'United Kingdom', 12.2e6], ['MY', 'Malaysia', 6.1e6], ['QA', 'Qatar', 0], ['JP', 'Japan', 2.2e6]].filter(x => x[0] !== origin);
  return { year: 2024, demo: true, category: label || 'Demo category (fictional)', note: 'DEMO: these trade values are fictional.', source: 'Demo data (fictional)', rows: names.map((n, i) => ({ rank: i + 1, iso2: n[0], name: n[1], value: n[2], currency: 'USD', year: 2024, source: 'Demo data', status: n[2] === 0 ? 'reported_zero' : 'reported' })) };
}
function demoProviders(O, D, pickup) {
  const mkp = (i, n, sv, cov, cold) => ({ id: 'demo-p' + i, disp: { name: n + DEMO, address: `${i} Demo Cargo Road, ${pickup || O}`, phone: `+00 555 010 00${i}`, email: `ops@demo-forwarder${i}.example.test`, website: `https://demo-forwarder${i}.example.test`, mapsUri: '', type: 'Freight forwarder', contactUrl: `https://demo-forwarder${i}.example.test/contact` }, services: sv, coverage: cov ? { text: `Documented: website mentions shipping to ${D}`, url: `https://demo-forwarder${i}.example.test/routes`, snippet: `…weekly consolidated sailings and daily air freight to ${D}…` } : { text: 'Contact provider to confirm route', url: '', snippet: '' }, cold, quote: `https://demo-forwarder${i}.example.test/quote`, exp: { name: n + DEMO, address: `${i} Demo Cargo Road, ${pickup || O}`, phone: `+00 555 010 00${i}`, phoneSrc: `https://demo-forwarder${i}.example.test/contact`, email: `ops@demo-forwarder${i}.example.test`, emailSrc: `https://demo-forwarder${i}.example.test/contact`, website: `https://demo-forwarder${i}.example.test`, contactUrl: `https://demo-forwarder${i}.example.test/contact`, city: pickup || O, type: 'Freight forwarder', checked: today() } });
  return { demo: true, providers: [mkp(1, 'Demo Global Freight Co.', ['Air cargo', 'Sea freight', 'Customs clearance'], true, 'Documented on website (cold chain / temperature-controlled)'), mkp(2, 'Demo Ocean Lines Agency', ['Sea freight'], true, null), mkp(3, 'Demo Express Couriers', ['Courier'], false, null), mkp(4, 'Demo Air Cargo Partners', ['Air cargo', 'Freight forwarding'], false, 'Not documented — ask provider')] };
}
function demoBuyers(product, O, D, dest) {
  const cities = CITIES[dest] || [D], rows = [];
  const spec = [['Importer', 'Documented importer from ' + O, `Demo evidence page says it imports ${product} from ${O}.`], ['Importer', 'Product importer', `Demo site says it imports ${product}; origin not confirmed.`], ['Wholesaler', 'Potential buyer', 'Listed on Maps as a wholesaler; purchasing needs confirmation.'], ['Distributor', 'Potential buyer', 'Listed as a distributor; purchasing needs confirmation.'], ['Trade supplier', 'Product importer', `Demo site lists ${product} imports.`], ['Wholesaler', 'Documented importer from ' + O, `Demo customs-style listing links this firm, ${product} and ${O}.`]];
  spec.forEach((s, i) => { const c = cities[i % cities.length], n = `${c} ${product} ${s[0]} ${i + 1}${DEMO}`, host = `demo-buyer${i + 1}.example.test`, doc = s[1].startsWith('Documented'); rows.push({ id: 'demo-b' + i, disp: { name: n, address: `${i + 10} Demo Souk Street, ${c}, ${D}`, phone: i === 2 ? '' : `+000 55 000 01${i}`, email: i === 3 ? '' : `buy@${host}`, website: `https://${host}`, type: s[0], city: c, contactUrl: `https://${host}/contact` }, cls: s[1], why: s[2], evidence: doc || s[1] === 'Product importer' ? { url: `https://${host}/about`, snippet: '…' + s[2] + '…' } : { url: '', snippet: '' }, exp: { name: n, type: s[0], city: c, country: D, address: `${i + 10} Demo Souk Street, ${c}, ${D}`, email: i === 3 ? NA : `buy@${host}`, phone: i === 2 ? NA : `+000 55 000 01${i}`, website: `https://${host}`, contactUrl: `https://${host}/contact`, product, cls: s[1], why: s[2], evidenceUrl: doc || s[1] === 'Product importer' ? `https://${host}/about` : 'No documented evidence — Google Maps listing only', evidenceText: doc || s[1] === 'Product importer' ? '…' + s[2] + '…' : '', contactSource: `https://${host}/contact`, checked: today() } }); });
  return { demo: true, businesses: rows, cities, terms: { base: [product], local: [] } };
}

// ---------- reports ----------
const safeCell = v => { v = String(v ?? ''); if (/^phone:/.test(v)) return v; return /^[=@\t\r-]/.test(v) ? "'" + v : v; };
function csv(cols, rows) {
  const q = s => '"' + String(s).replace(/"/g, '""') + '"';
  const lines = [cols.map(c => q(c.h)).join(',')];
  for (const r of rows) lines.push(cols.map(c => { let v = c.v(r) ?? ''; v = v === '' ? NA : v; if (c.phone && v !== NA) return q('\t' + v); return q(safeCell(v)); }).join(','));
  return '\uFEFF' + lines.join('\r\n') + '\r\n'; // BOM = Excel reads UTF-8; leading TAB keeps "+" phone prefixes as text
}
const REPORTS = {
  providers: { title: 'Shipping Provider Report', file: 'shipping-provider-report', cols: [
    { h: 'Company name', v: r => r.exp.name }, { h: 'Services offered', v: r => (r.services || []).join('; ') }, { h: 'Office / branch', v: r => [r.exp.type, r.exp.city].filter(Boolean).join(' – ') }, { h: 'Full address', v: r => r.exp.address },
    { h: 'Phone', v: r => r.exp.phone, phone: 1 }, { h: 'Email', v: r => r.exp.email }, { h: 'Official website', v: r => r.exp.website }, { h: 'Quote-request link', v: r => r.quote || NA },
    { h: 'Route coverage', v: r => r.coverage.text }, { h: 'Coverage source', v: r => r.coverage.url || NA }, { h: 'Special handling (cold chain)', v: r => r.cold || 'Not applicable' }, { h: 'Contact-information source', v: r => [r.exp.emailSrc, r.exp.phoneSrc].filter(Boolean).join(' ; ') || NA }, { h: 'Date checked', v: r => r.exp.checked }] },
  buyers: { title: 'Buyer & Importer Contact Report', file: 'buyer-importer-contact-report', cols: [
    { h: 'Business name', v: r => r.exp.name }, { h: 'Business type', v: r => r.exp.type }, { h: 'City', v: r => r.exp.city }, { h: 'Country', v: r => r.exp.country }, { h: 'Full address', v: r => r.exp.address },
    { h: 'Email', v: r => r.exp.email }, { h: 'Phone', v: r => r.exp.phone, phone: 1 }, { h: 'Website / contact page', v: r => [r.exp.website, r.exp.contactUrl].filter(x => x && x !== NA).join(' | ') },
    { h: 'Relevant product / service', v: r => r.exp.product }, { h: 'Buyer classification', v: r => r.exp.cls }, { h: 'Why it matches', v: r => r.exp.why }, { h: 'Evidence source', v: r => r.exp.evidenceUrl }, { h: 'Evidence excerpt', v: r => r.exp.evidenceText },
    { h: 'Contact-information source', v: r => r.exp.contactSource }, { h: 'Date checked', v: r => r.exp.checked }] },
};
const win = s => String(s ?? '').replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');
async function pdf(rep, meta, rows) {
  const doc = await PDFDocument.create(), f = await doc.embedFont(StandardFonts.Helvetica), b = await doc.embedFont(StandardFonts.HelveticaBold), W = 842, H = 595, M = 40;
  let pg = doc.addPage([W, H]), y = H - M;
  const brk = (need = 12) => { if (y - need < M) { pg = doc.addPage([W, H]); y = H - M; } };
  const wrap = (font, size, text, w) => { const out = []; for (const para of win(text).split('\n')) { let line = ''; for (let word of para.split(/\s+/)) { while (font.widthOfTextAtSize(word, size) > w) { let k = word.length; while (font.widthOfTextAtSize(word.slice(0, k), size) > w) k--; if (line) { out.push(line); line = ''; } out.push(word.slice(0, k)); word = word.slice(k); } const t = line ? line + ' ' + word : word; if (font.widthOfTextAtSize(t, size) > w && line) { out.push(line); line = word; } else line = t; } out.push(line); } return out; };
  const txt = (s, size, font, x = M, color = rgb(.1, .1, .1)) => { brk(size + 4); pg.drawText(win(s), { x, y: y - size, size, font, color }); y -= size + 4; };
  txt(rep.title, 18, b); [`Product: ${meta.product}`, `Route: ${meta.origin} → ${meta.destination}`, `Research date: ${meta.date}`, `Businesses included: ${rows.length}`].forEach(s => txt(s, 10, f));
  if (meta.demo) txt('DEMO DATA — all records are fictional.', 10, b, M, rgb(.7, 0, 0));
  txt('Contact details come only from the sources listed per record. “Not publicly listed” = not found. Google Maps listings alone only qualify a business as a prospect.', 8, f, M, rgb(.35, .35, .35)); y -= 6;
  rows.forEach((r, i) => {
    brk(40); y -= 4; pg.drawRectangle({ x: M, y: y - 14, width: W - 2 * M, height: 16, color: rgb(.9, .94, .92) }); txt(`${i + 1}. ${rep.cols[0].v(r)}`, 10.5, b, M + 4);
    for (const c of rep.cols.slice(1)) { let v = c.v(r); v = v === '' || v == null ? NA : v; const ls = wrap(f, 8.5, v, W - 2 * M - 150); brk(ls.length * 11 + 2); pg.drawText(win(c.h), { x: M + 4, y: y - 8.5, size: 8.5, font: b, color: rgb(.3, .3, .3) }); ls.forEach(l => { pg.drawText(l, { x: M + 150, y: y - 8.5, size: 8.5, font: f }); y -= 11; }); }
  });
  doc.getPages().forEach((p, i, a) => p.drawText(`${rep.title} · page ${i + 1}/${a.length}`, { x: M, y: 20, size: 7, font: f, color: rgb(.5, .5, .5) }));
  return Buffer.from(await doc.save());
}

// ---------- server ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
const send = (res, code, body, type = 'application/json', extra = {}) => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra }); res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };
const API = {
  '/api/config': async () => ({ comtrade: !!E.COMTRADE_API_KEY, maps: !!E.GOOGLE_MAPS_API_KEY, llm: !!E.ANTHROPIC_API_KEY, exportMapsFields: EXPORT_MAPS }),
  '/api/classify': async b => { if (!b.product?.trim()) throw new ApiError('BAD', 'Please enter a product or service.', 400); return classify(b); },
  '/api/markets': async b => markets(b),
  '/api/providers': async b => providers(b),
  '/api/buyers': async b => buyers(b),
};
http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x');
    if (req.method === 'POST' && u.pathname.startsWith('/api/report/')) {
      const rep = REPORTS[u.pathname.split('/').pop()]; if (!rep) return send(res, 404, { error: 'unknown report' });
      const body = JSON.parse(await new Promise(r => { let d = ''; req.on('data', c => d += c); req.on('end', () => r(d || '{}')); }));
      const rows = Array.isArray(body.rows) ? body.rows : []; if (!rows.length) return send(res, 400, { code: 'EMPTY', error: 'No businesses selected for this report.' });
      const meta = { ...body.meta, date: today() }, name = `${rep.file}-${(meta.origin + '-' + meta.destination).replace(/\W+/g, '_')}-${meta.date}`;
      if (u.searchParams.get('format') === 'pdf') return send(res, 200, await pdf(rep, meta, rows), 'application/pdf', { 'Content-Disposition': `attachment; filename="${name}.pdf"` });
      return send(res, 200, csv(rep.cols, rows), 'text/csv; charset=utf-8', { 'Content-Disposition': `attachment; filename="${name}.csv"` });
    }
    if (API[u.pathname]) {
      let body = {}; if (req.method === 'POST') body = JSON.parse(await new Promise(r => { let d = ''; req.on('data', c => d += c); req.on('end', () => r(d || '{}')); }));
      return send(res, 200, await API[u.pathname](body));
    }
    const f = path.join(__dirname, 'public', u.pathname === '/' ? 'index.html' : u.pathname.replace(/\.\./g, ''));
    if (fs.existsSync(f) && fs.statSync(f).isFile()) return send(res, 200, fs.readFileSync(f), MIME[path.extname(f)] || 'application/octet-stream');
    send(res, 404, { error: 'not found' });
  } catch (e) { const known = e instanceof ApiError; if (!known) console.error(e); send(res, known ? e.status : 500, { code: known ? e.code : 'SERVER', error: known ? e.message : 'Unexpected server error: ' + e.message }); }
}).listen(PORT, () => console.log(`Export Buyer Finder on http://localhost:${PORT}`));
