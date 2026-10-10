import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import worker, { snapshot, runQuoteRefresh } from '../src/index.js';
import { fetchNav, join } from '../src/daily.js';

test('snapshot marks old quotes stale and keeps fresh IOPV separate from NAV', async () => {
  const original = globalThis.fetch;
  const now = Math.floor(Date.now() / 1000);
  globalThis.fetch = async url => {
    if (String(url).includes('ulist.np')) return Response.json({ data: { diff: [
      { f12: '513100', f2: 1.1, f441: 1, f124: now, f14: 'Fresh' },
      { f12: '513300', f2: 1.1, f441: 1, f124: now - 3600, f14: 'Old' }
    ] } });
    return new Response('', { status: 200 });
  };
  try {
    const rows = await snapshot();
    assert.equal(rows.find(row => row.code === '513100').stale, false);
    assert.equal(rows.find(row => row.code === '513100').basis, 'IOPV');
    assert.equal(rows.find(row => row.code === '513300').stale, true);
  } finally { globalThis.fetch = original; }
});

test('snapshot returns empty values when both quote feeds fail', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('unavailable'); };
  try {
    const rows = await snapshot();
    assert.equal(rows.length, 15);
    assert.equal(rows.filter(row => row.premium != null).length, 0);
    assert.ok(rows.every(row => row.stale));
  } finally { globalThis.fetch = original; }
});

test('rate-limited quote refresh stops fallback requests, logs it, and backs off', async () => {
  const original = globalThis.fetch;
  const urls = [], logs = [];
  let state = null;
  globalThis.fetch = async url => {
    urls.push(String(url));
    return new Response('', { status: 429 });
  };
  const env = { DB: { prepare: sql => ({
    first: async () => state,
    bind: (...values) => ({ run: async () => {
      if (sql.startsWith('INSERT INTO quote_refresh_state')) state = { consecutive_limits: values[0], backoff_until: values[1] };
      if (sql.startsWith('INSERT INTO quote_refresh_logs')) logs.push({ outcome: values[1], providers: JSON.parse(values[5]) });
    } })
  }) } };
  const originalLog = console.log;
  console.log = () => {};
  try {
    await runQuoteRefresh(env);
    assert.equal(urls.length, 2);
    assert.equal(urls.filter(url => url.includes('eastmoney.com')).length, 1);
    assert.equal(state.consecutive_limits, 1);
    assert.ok(state.backoff_until > Date.now());
    assert.equal(logs[0].outcome, 'rate_limited');
    assert.equal(logs[0].providers.eastmoney.attempts[0].http, 429);
    await runQuoteRefresh(env);
    assert.equal(urls.length, 2);
    assert.equal(logs[1].outcome, 'backoff');
  } finally { globalThis.fetch = original; console.log = originalLog; }
});

test('NAV pagination failure rejects instead of returning a partial history', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async url => {
    const page = Number(new URL(url).searchParams.get('pageIndex'));
    if (page === 1) return Response.json({ Data: { LSJZList: Array.from({ length: 20 }, (_, i) => ({ FSRQ: `2026-09-${String(i + 1).padStart(2, '0')}`, DWJZ: '1' })) } });
    throw new Error('page unavailable');
  };
  try {
    await assert.rejects(fetchNav('513100', 2), /page 2/);
  } finally { globalThis.fetch = original; }
});

test('daily join only accepts matching dates', () => {
  const result = join('513100', { '2026-10-08': { close: 1.1, amount: 1 } },
    { '2026-10-08': 1, '2026-10-09': 1 });
  assert.equal(result.length, 1);
  assert.equal(result[0].date, '2026-10-08');
  assert.ok(Math.abs(result[0].premium - .1) < 1e-10);
});

test('daily API bounds the all-code daily query', async () => {
  const env = { DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: [] }) }) }) } };
  const response = await worker.fetch(new Request('https://example.com/api/daily?code=all&from=2013-01-01'), env);
  assert.equal(response.status, 400);
  const weekly = await worker.fetch(new Request('https://example.com/api/daily?code=all&from=2013-01-01&resolution=week'), env);
  assert.equal(weekly.status, 200);
  assert.equal((await weekly.json()).resolution, 'week');
});

test('latest API serves cached quotes without waiting for quote providers and updates stale flags', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('quote provider should not be called'); };
  const now = Date.now();
  const cached = { checked: now - 1000, refresh_after: now + 60000,
    rows: JSON.stringify([{ code: '159941', name: '纳指ETF', quote_ts: now - 3600000, stale: false },
      { code: '159501', name: '纳指基金', quote_ts: now - 3600000, stale: false }]) };
  const env = { DB: { prepare: () => ({ first: async () => cached }) } };
  try {
    const response = await worker.fetch(new Request('https://example.com/api/latest'), env);
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.rows[0].stale, true);
    assert.equal(result.rows[0].name, '广发纳指100ETF');
    assert.equal(result.rows[1].name, '嘉实纳指100ETF');
    assert.equal(result.checked, cached.checked);
  } finally { globalThis.fetch = original; }
});

test('expired quote cache remains read-only on visitor requests', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('visitor request must not fetch quotes'); };
  const now = Date.now();
  const cached = { checked: now - 600000, refresh_after: now - 1,
    rows: JSON.stringify([{ code: '513100', quote_ts: now - 3600000 }]) };
  let scheduled = false;
  const env = { DB: { prepare: () => ({ first: async () => cached }) } };
  try {
    const response = await worker.fetch(new Request('https://example.com/api/latest'), env,
      { waitUntil: () => { scheduled = true; } });
    assert.equal((await response.json()).checked, cached.checked);
    assert.equal(scheduled, false);
  } finally { globalThis.fetch = original; }
});

test('latest API does not fetch quotes when D1 has no snapshot', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('visitor request must not fetch quotes'); };
  try {
    const env = { DB: { prepare: () => ({ first: async () => null }) } };
    const response = await worker.fetch(new Request('https://example.com/api/latest'), env);
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /定时任务/);
  } finally { globalThis.fetch = original; }
});

test('dashboard handles empty premiums and escapes provider names', () => {
  const elements = new Map();
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, {
      innerHTML: '', textContent: '', children: [], dataset: {},
      classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } }
    });
    return elements.get(selector);
  };
  const context = vm.createContext({
    document: { querySelector: element, documentElement: { dataset: {} } },
    getComputedStyle: () => ({ getPropertyValue: () => '#fff' }),
    localStorage: {}, matchMedia: () => ({ matches: false }),
    addEventListener() {}, setInterval() {}, location: { hash: '' },
    fetch: async () => { throw new Error('offline'); }, console: { error() {} },
  });
  vm.runInContext(readFileSync(new URL('../public/app.js', import.meta.url), 'utf8'), context);
  vm.runInContext("rows = [{code:'513100',name:'<img src=x onerror=alert(1)>',index:'纳指',premium:null,stale:true,quote_ts:null}]; cards(); render();", context);
  assert.match(element('#cards').innerHTML, /暂无参考溢价/);
  assert.match(element('#tb').innerHTML, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(element('#tb').innerHTML, /<img/);
  assert.doesNotMatch(element('#tb').innerHTML, /行情已过期/);
  vm.runInContext("rows = [{code:'513100',name:'纳指 ETF',index:'纳指',premium:0.1,basis:'NAV',nav_date:'2026-10-08',stale:true,quote_ts:Date.now()-86400000}]; cards();", context);
  assert.match(element('#cards').innerHTML, /纳指平均参考溢价/);
  assert.match(element('#cards').innerHTML, /\+10\.00%/);
  assert.match(element('#cards').innerHTML, /IOPV 0 \/ NAV 1/);
  const tip = vm.runInContext("premiumTooltip([{axisValue:'2026-10-08',seriesName:'纳指',value:['2026-10-08',0.123456]}])", context);
  assert.match(tip, /\+12\.35%/);
  assert.doesNotMatch(tip, /0\.123456/);
  assert.equal(vm.runInContext('axisPct(0.123456, 8)', context), '+12.35%');
  assert.equal(vm.runInContext('premiumTooltipOptions.appendToBody && premiumTooltipOptions.confine', context), true);
});
