import { ETFS } from "./etfs.js";
import { fetchKline, fetchNav, join } from "./daily.js";
export { ETFS };
const UA = { "User-Agent": "Mozilla/5.0", Referer: "https://finance.sina.com.cn" };
const EM_HOSTS = ["82.push2.eastmoney.com", "push2.eastmoney.com", "push2his.eastmoney.com"];

async function fetchEastmoney() {
  const secids = ETFS.map(([c, m]) => `${m}.${c}`).join(",");
  for (const h of EM_HOSTS) {
    try {
      const r = await fetch(`https://${h}/api/qt/ulist.np/get?fltt=2&secids=${secids}&fields=f2,f3,f6,f12,f14,f441`, { headers: UA });
      const j = await r.json();
      if (j?.data?.diff) return Object.fromEntries(j.data.diff.map(d => [d.f12, d]));
    } catch (e) {}
  }
  return {};
}
async function fetchSina() {
  const list = ETFS.flatMap(([c, m]) => [`${m ? "sh" : "sz"}${c}`, `f_${c}`]).join(",");
  const r = await fetch(`https://hq.sinajs.cn/list=${list}`, { headers: UA });
  const txt = new TextDecoder("gbk").decode(await r.arrayBuffer());
  const out = {};
  for (const m of txt.matchAll(/hq_str_(\w+)="([^"]*)"/g)) out[m[1]] = m[2].split(",");
  return out;
}
export async function snapshot() {
  const [em, sina] = await Promise.all([fetchEastmoney(), fetchSina().catch(() => ({}))]);
  const ts = Date.now();
  return ETFS.map(([code, mk, idx]) => {
    const s = sina[`${mk ? "sh" : "sz"}${code}`] || [], f = sina[`f_${code}`] || [], e = em[code] || {};
    const price = num(e.f2) ?? num(s[3]);
    const prev = num(s[2]);
    const iopv = num(e.f441);
    const nav = num(f[1]), nav_date = f[4] || null;
    let premium = null, basis = null;
    if (price && iopv) { premium = price / iopv - 1; basis = "IOPV"; }
    else if (price && nav) { premium = price / nav - 1; basis = "NAV"; }
    return { ts, code, index: idx, name: e.f14 || s[0] || f[0] || code, fund: f[0] || null,
      price, change: price && prev ? price / prev - 1 : null, amount: num(e.f6) ?? num(s[9]),
      iopv, nav, nav_date, premium, basis };
  });
}
const num = v => { const n = parseFloat(v); return Number.isFinite(n) && n > 0 ? n : null; };

async function store(env, rows) {
  if (!env.DB) return;
  await env.DB.batch(rows.map(r => env.DB.prepare(
    "INSERT OR REPLACE INTO snapshots (ts,code,price,iopv,nav,nav_date,premium,basis) VALUES (?,?,?,?,?,?,?,?)")
    .bind(r.ts, r.code, r.price, r.iopv, r.nav, r.nav_date, r.premium, r.basis)));
}
const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "max-age=30", "access-control-allow-origin": "*" } });

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname === "/api/latest") {
      const rows = await snapshot();
      return json({ updated: Date.now(), rows });
    }
    if (url.pathname === "/api/history") {
      const code = url.searchParams.get("code"), days = Math.min(+url.searchParams.get("days") || 30, 365);
      if (!env.DB || !/^\d{6}$/.test(code || "")) return json({ rows: [] });
      const { results } = await env.DB.prepare(
        "SELECT ts,price,iopv,nav,premium,basis FROM snapshots WHERE code=? AND ts>? ORDER BY ts").bind(code, Date.now() - days * 864e5).all();
      return json({ code, rows: results });
    }
    if (url.pathname === "/api/daily") {
      // ?code=513100&from=2025-01-01   或 ?code=all&from=... （紧凑格式，用于迷你走势/对比图）
      if (!env.DB) return json({ rows: [] });
      const code = url.searchParams.get("code") || "all", from = url.searchParams.get("from") || "1900-01-01";
      if (code === "all") {
        const { results } = await env.DB.prepare("SELECT code,date,premium FROM daily WHERE date>=? ORDER BY date").bind(from).all();
        const out = {}; for (const r of results) (out[r.code] ??= []).push([r.date, r.premium]);
        return json({ from, series: out });
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
    ctx.waitUntil(snapshot().then(r => store(env, r)));
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
}
