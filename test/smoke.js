// Smoke test of the demo workflow + both downloads. Run: node server.js (other terminal) then npm test
const base = process.env.BASE || 'http://localhost:3000';
const post = (p, b) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
const ok = (c, m) => { if (!c) { console.error('FAIL', m); process.exit(1); } console.log('ok  ', m); };
(async () => {
  const cls = await (await post('/api/classify', { product: 'cardamom', origin: 'IN', demo: true })).json(); ok(cls.ok && cls.matches[0].c === '0908', 'cardamom → HS 0908');
  const amb = await (await post('/api/classify', { product: 'cotton bags', origin: 'IN', demo: true })).json(); ok(!amb.ok && amb.matches.length > 1, 'cotton bags asks a clarifying question');
  const svc = await (await post('/api/classify', { product: 'web development services', origin: 'IN' })).json(); ok(svc.type === 'service', 'services detected');
  const m = await (await post('/api/markets', { origin: 'IN', hs: '0908', label: 'x', demo: true })).json(); ok(m.rows.length && !m.rows.some(r => /world/i.test(r.name)), 'markets ranked, no World');
  ok(m.rows.some(r => r.status === 'reported_zero'), 'reported zero distinguished');
  const pr = await (await post('/api/providers', { product: 'cardamom', origin: 'IN', dest: 'AE', demo: true })).json(); ok(pr.providers.length >= 3, 'providers loaded');
  const by = await (await post('/api/buyers', { product: 'cardamom', origin: 'IN', dest: 'AE', demo: true })).json(); ok(by.businesses.length >= 5, 'buyers loaded');
  ok(by.businesses.filter(b => b.cls.startsWith('Documented')).every(b => b.evidence.url), 'every documented importer has evidence');
  const meta = { product: 'cardamom', origin: 'India', destination: 'United Arab Emirates', demo: true };
  const c1 = await post('/api/report/buyers?format=csv', { rows: by.businesses, meta }); const raw = Buffer.from(await c1.arrayBuffer()), t = raw.toString('utf8');
  ok(raw[0] === 0xEF && raw[1] === 0xBB && raw[2] === 0xBF && t.includes('Not publicly listed') && t.includes('\t+000'), 'buyer CSV: BOM, missing marked, phone prefix preserved');
  const p1 = Buffer.from(await (await post('/api/report/buyers?format=pdf', { rows: by.businesses.slice(0, 2), meta })).arrayBuffer()); ok(p1.slice(0, 4).toString() === '%PDF', 'buyer PDF (selected only)');
  const c2 = await (await post('/api/report/providers?format=csv', { rows: pr.providers, meta })).text(); ok(c2.includes('Route coverage') && c2.includes('Contact provider to confirm route'), 'provider CSV');
  const p2 = Buffer.from(await (await post('/api/report/providers?format=pdf', { rows: pr.providers, meta })).arrayBuffer()); ok(p2.slice(0, 4).toString() === '%PDF', 'provider PDF');
  const e = await post('/api/markets', { origin: 'IN', hs: '0908', label: 'x' }); const ej = await e.json(); ok(e.status === 501 && ej.code === 'NO_KEY', 'live mode without key → specific NO_KEY message (no invented data)');
  const m2 = await (await post('/api/buyers', { product: 'cardamom', origin: 'IN', dest: 'SA', demo: true })).json(); ok(m2.businesses[0].exp.country === 'Saudi Arabia', 'changing destination changes buyer report data');
  console.log('ALL PASSED');
})();
