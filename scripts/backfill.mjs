// 用法: node scripts/backfill.mjs [--local|--remote]   生成 data/daily.sql 并可直接写入 D1
import { writeFileSync } from "fs";
import { execSync } from "child_process";
import { ETFS } from "../src/etfs.js";
import { fetchKline, fetchNav, join } from "../src/daily.js";
const all = [], stat = [];
await Promise.all([0, 1, 2].map(async w => {
  for (let i = w; i < ETFS.length; i += 3) {
    const [code, mk] = ETFS[i];
    const [kl, nav] = await Promise.all([fetchKline(code, mk), fetchNav(code)]);
    const rows = join(code, kl, nav);
    if (!rows.length || rows.length < Math.min(Object.keys(kl).length, Object.keys(nav).length) * .6)
      throw new Error(`${code}: historical data coverage is incomplete`);
    all.push(...rows);
    stat.push({ code, kline: Object.keys(kl).length, nav: Object.keys(nav).length, joined: rows.length, from: rows[0]?.date, to: rows.at(-1)?.date });
    console.error(code, rows.length, rows[0]?.date, rows.at(-1)?.date);
  }
}));
if (stat.length !== ETFS.length) throw new Error('Not all ETFs were backfilled');
console.table(stat.sort((a, b) => a.code.localeCompare(b.code)));
writeFileSync("data/daily.json", JSON.stringify(all));
const sql = [];
for (let i = 0; i < all.length; i += 200) sql.push("INSERT OR REPLACE INTO daily (code,date,close,nav,amount,premium) VALUES " +
  all.slice(i, i + 200).map(r => `('${r.code}','${r.date}',${r.close},${r.nav},${r.amount || 0},${r.premium.toFixed(6)})`).join(",") + ";");
writeFileSync("data/daily.sql", sql.join("\n"));
const flag = process.argv.find(a => a === "--local" || a === "--remote");
if (flag) execSync(`npx wrangler d1 execute etf-premium ${flag} --file=data/daily.sql -y`, { stdio: "inherit" });
