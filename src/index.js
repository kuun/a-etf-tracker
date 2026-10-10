import { ETFS } from "./etfs.js";
import { fetchKline, fetchNav, join } from "./daily.js";
export { ETFS };
const UA = { "User-Agent": "Mozilla/5.0", Referer: "https://finance.sina.com.cn" };
const EM_HOSTS = ["82.push2.eastmoney.com", "push2.eastmoney.com", "push2his.eastmoney.com"];

async function fetchEastmoney(report = {}) {
  const secids = ETFS.map(([c, m]) => `${m}.${c}`).join(",");
  report.attempts = [];
  for (const h of EM_HOSTS) {
    const started = Date.now();
    try {
      const r = await fetch(`https://${h}/api/qt/ulist.np/get?fltt=2&secids=${secids}&fields=f2,f3,f6,f12,f14,f124,f441`, { headers: UA, signal: AbortSignal.timeout(5000) });
      report.attempts.push({ host: h, http: r.status, ms: Date.now() - started });
      if (r.status === 403 || r.status === 429) { report.state = 'rate_limited'; return {}; }
      if (!r.ok) continue;
      const j = await r.json();
      if (j?.data?.diff?.length) { report.state = 'ok'; return Object.fromEntries(j.data.diff.map(d => [d.f12, d])); }
    } catch (e) { report.attempts.push({ host: h, error: e.name || 'error', ms: Date.now() - started }); }
  }
  report.state = 'failed';
  return {};
}
async function fetchSina(report = {}) {
  const list = ETFS.flatMap(([c, m]) => [`${m ? "sh" : "sz"}${c}`, `f_${c}`]).join(",");
  const started = Date.now();
  try {
    const r = await fetch(`https://hq.sinajs.cn/list=${list}`, { headers: UA, signal: AbortSignal.timeout(5000) });
    report.http = r.status;
    if (r.status === 403 || r.status === 429) { report.state = 'rate_limited'; return {}; }
    if (!r.ok) { report.state = 'failed'; return {}; }
    const txt = new TextDecoder("gbk").decode(await r.arrayBuffer());
    const out = {};
    for (const m of txt.matchAll(/hq_str_(\w+)="([^"]*)"/g)) out[m[1]] = m[2].split(",");
    report.state = Object.keys(out).length ? 'ok' : 'empty';
    return out;
  } catch (error) {
    report.state = 'failed'; report.error = error.name || 'error';
    return {};
  } finally { report.ms = Date.now() - started; }
}
export async function snapshot(report = {}) {
  const [em, sina] = await Promise.all([fetchEastmoney(report.eastmoney = {}), fetchSina(report.sina = {})]);
  const ts = Date.now();
  return ETFS.map(([code, mk, idx, displayName]) => {
    const s = sina[`${mk ? "sh" : "sz"}${code}`] || [], f = sina[`f_${code}`] || [], e = em[code] || {};
    const emTs = epoch(e.f124), sinaTs = quoteTime(s[30], s[31]);
    const useEm = num(e.f2) != null && emTs != null && (!sinaTs || emTs >= sinaTs);
    const price = useEm ? num(e.f2) : num(s[3]);
    const quote_ts = useEm ? emTs : sinaTs;
    const stale = !quote_ts || quote_ts > ts + 60000 || ts - quote_ts > 5 * 60000;
    const prev = num(s[2]);
    const iopv = emTs && quote_ts && Math.abs(emTs - quote_ts) <= 5 * 60000 ? num(e.f441) : null;
    const nav = num(f[1]), nav_date = f[4] || null;
    let premium = null, basis = null;
    if (price && iopv) { premium = price / iopv - 1; basis = "IOPV"; }
    else if (price && nav) { premium = price / nav - 1; basis = "NAV"; }
    return { ts, code, index: idx, name: displayName || e.f14 || s[0] || f[0] || code, fund: f[0] || null,
      price, change: price && prev ? price / prev - 1 : null, amount: useEm ? num(e.f6) : num(s[9]),
      iopv, nav, nav_date, premium, basis, quote_ts, stale };
  });
}
const num = v => { const n = parseFloat(v); return Number.isFinite(n) && n > 0 ? n : null; };
const epoch = v => { const n = Number(v); return Number.isFinite(n) && n > 1e9 ? n * 1000 : null; };
const quoteTime = (date, time) => /^\d{4}-\d\d-\d\d$/.test(date || "") && /^\d\d:\d\d:\d\d$/.test(time || "")
  ? Date.parse(`${date}T${time}+08:00`) || null : null;

async function store(env, rows) {
  if (!env.DB) return;
  const fresh = rows.filter(r => !r.stale && r.premium != null);
  if (!fresh.length) return;
  await env.DB.batch(fresh.map(r => env.DB.prepare(
    "INSERT OR REPLACE INTO snapshots (ts,code,price,iopv,nav,nav_date,premium,basis) VALUES (?,?,?,?,?,?,?,?)")
    .bind(r.ts, r.code, r.price, r.iopv, r.nav, r.nav_date, r.premium, r.basis)));
}
const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "max-age=30", "access-control-allow-origin": "*" } });
async function saveLatest(env, rows) {
  const checked = Date.now();
  if (rows.some(row => !row.stale)) {
    await env.DB.prepare("INSERT INTO latest_cache (id,checked,refresh_after,rows) VALUES (1,?,?,?) " +
      "ON CONFLICT(id) DO UPDATE SET checked=excluded.checked,refresh_after=excluded.refresh_after,rows=excluded.rows")
      .bind(checked, checked, JSON.stringify(rows)).run();
  }
}
const BACKOFF_BASE_MS = 10 * 60000, BACKOFF_MAX_MS = 60 * 60000;
export async function runQuoteRefresh(env) {
  const started = Date.now(), providers = {};
  let outcome = 'error', rows = [], error = null, backoffUntil = null;
  try {
    const state = await env.DB.prepare("SELECT consecutive_limits,backoff_until FROM quote_refresh_state WHERE id=1").first();
    if (state?.backoff_until > started) {
      outcome = 'backoff'; backoffUntil = state.backoff_until;
      return;
    }
    rows = await snapshot(providers);
    const limited = [providers.eastmoney, providers.sina].some(provider => provider?.state === 'rate_limited');
    if (limited) {
      const streak = (state?.consecutive_limits || 0) + 1;
      backoffUntil = Date.now() + Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(streak - 1, 3));
      await env.DB.prepare("INSERT INTO quote_refresh_state (id,consecutive_limits,backoff_until) VALUES (1,?,?) " +
        "ON CONFLICT(id) DO UPDATE SET consecutive_limits=excluded.consecutive_limits,backoff_until=excluded.backoff_until")
        .bind(streak, backoffUntil).run();
    } else if (state?.consecutive_limits) {
      await env.DB.prepare("UPDATE quote_refresh_state SET consecutive_limits=0,backoff_until=0 WHERE id=1").run();
    }
    await saveLatest(env, rows);
    await store(env, rows);
    outcome = limited ? 'rate_limited' : rows.some(row => !row.stale) ? 'ok' : 'no_fresh_quotes';
  } catch (cause) { error = String(cause?.message || cause).slice(0, 300); }
  finally {
    const entry = { ts: started, outcome, duration_ms: Date.now() - started, fresh_count: rows.filter(row => !row.stale).length,
      quote_count: rows.filter(row => row.quote_ts).length, providers, backoff_until: backoffUntil, error };
    console.log('quote_refresh', JSON.stringify(entry));
    try {
      await env.DB.prepare("INSERT INTO quote_refresh_logs (ts,outcome,duration_ms,fresh_count,quote_count,providers,backoff_until,error) VALUES (?,?,?,?,?,?,?,?)")
        .bind(entry.ts, entry.outcome, entry.duration_ms, entry.fresh_count, entry.quote_count,
          JSON.stringify(entry.providers), entry.backoff_until, entry.error).run();
    } catch (cause) { console.error('quote_refresh_log_failed', String(cause?.message || cause)); }
  }
}
async function latest(env) {
  if (!env.DB) return null;
  const cached = await env.DB.prepare("SELECT checked,rows FROM latest_cache WHERE id=1").first();
  if (!cached) return null;
  const now = Date.now();
  const names = Object.fromEntries(ETFS.map(([code, , , name]) => [code, name]));
  return { checked: cached.checked, rows: JSON.parse(cached.rows).map(row => ({
    ...row, name: names[row.code] || row.name,
    stale: !row.quote_ts || row.quote_ts > now + 60000 || now - row.quote_ts > 5 * 60000
  })) };
}
const validDate = v => {
  if (!/^\d{4}-\d\d-\d\d$/.test(v)) return false;
  const date = new Date(`${v}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === v;
};
const ago = days => new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname === "/api/latest") {
      const result = await latest(env);
      return result ? json(result) : json({ error: "定时任务尚未生成行情" }, 503);
    }
    if (url.pathname === "/api/history") {
      const code = url.searchParams.get("code"), requestedDays = Number(url.searchParams.get("days") || 30);
      if (!Number.isInteger(requestedDays) || requestedDays < 1 || requestedDays > 365) return json({ error: "bad days" }, 400);
      const days = requestedDays;
      if (!env.DB || !/^\d{6}$/.test(code || "")) return json({ rows: [] });
      const { results } = await env.DB.prepare(
        "SELECT ts,price,iopv,nav,premium,basis FROM snapshots WHERE code=? AND ts>? ORDER BY ts").bind(code, Date.now() - days * 864e5).all();
      return json({ code, rows: results });
    }
    if (url.pathname === "/api/daily") {
      // ?code=513100&from=2025-01-01   或 ?code=all&from=... （紧凑格式，用于迷你走势/对比图）
      if (!env.DB) return json({ rows: [] });
      const code = url.searchParams.get("code") || "all", from = url.searchParams.get("from") || (code === "all" ? ago(365) : "1900-01-01");
      if (!validDate(from)) return json({ error: "bad from" }, 400);
      if (code === "all") {
        const resolution = url.searchParams.get("resolution") || "day";
        if (!['day', 'week', 'month'].includes(resolution)) return json({ error: "bad resolution" }, 400);
        if (resolution === "day" && from < ago(370)) return json({ error: "daily comparison range exceeds one year" }, 400);
        const bucket = resolution === "month" ? "substr(date,1,7)" : "strftime('%Y-%W',date)";
        const sql = resolution === "day" ? "SELECT code,date,premium FROM daily WHERE date>=? ORDER BY date"
          : `SELECT code,max(date) AS date,avg(premium) AS premium FROM daily WHERE date>=? GROUP BY code,${bucket} ORDER BY date`;
        const { results } = await env.DB.prepare(sql).bind(from).all();
        const out = {}; for (const r of results) (out[r.code] ??= []).push([r.date, r.premium]);
        return json({ from, resolution, series: out });
      }
      if (!/^\d{6}$/.test(code)) return json({ error: "bad code" }, 400);
      const { results } = await env.DB.prepare("SELECT date,close,nav,amount,premium FROM daily WHERE code=? AND date>=? ORDER BY date").bind(code, from).all();
      return json({ code, rows: results });
    }
    return env.ASSETS.fetch(req);
  },
  async scheduled(evt, env, ctx) {
    if (evt.cron === DAILY_CRON) return ctx.waitUntil(updateDaily(env));
    // cron 已限定 UTC 1-7 点；再精确到 9:25-15:05 北京时间
    const bj = new Date(Date.now() + 8 * 36e5), m = bj.getUTCHours() * 60 + bj.getUTCMinutes();
    if (m < 9 * 60 + 25 || m > 15 * 60 + 5 || (m > 11 * 60 + 32 && m < 12 * 60 + 58)) return;
    ctx.waitUntil(runQuoteRefresh(env));
  },
};

const DAILY_CRON = "30 0,12 * * *";
// 每日增量：最近 40 天收盘价 + 净值第 1-2 页，UPSERT 到 daily 表
export async function updateDaily(env) {
  const beg = new Date(Date.now() - 40 * 864e5).toISOString().slice(0, 10).replace(/-/g, "");
  for (const [code, mk] of ETFS) {
    try {
      const [kl, nav] = await Promise.all([fetchKline(code, mk, beg), fetchNav(code, 2)]);
      const rows = join(code, kl, nav);
      if (rows.length) await env.DB.batch(rows.map(r => env.DB.prepare(
        "INSERT OR REPLACE INTO daily (code,date,close,nav,amount,premium) VALUES (?,?,?,?,?,?)").bind(r.code, r.date, r.close, r.nav, r.amount, r.premium)));
    } catch (e) { console.log("daily fail", code, e.message); }
  }
  try {
    await env.DB.prepare("DELETE FROM snapshots WHERE ts < ?").bind(Date.now() - 90 * 864e5).run();
    await env.DB.prepare("DELETE FROM quote_refresh_logs WHERE ts < ?").bind(Date.now() - 30 * 864e5).run();
  } catch (e) { console.log("snapshot cleanup fail", e.message); }
}
