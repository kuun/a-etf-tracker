// 日度历史：A股收盘价(未复权) / 同日(估值日T)官方单位净值 - 1
const H = { "User-Agent": "Mozilla/5.0", Referer: "https://fundf10.eastmoney.com/" };
const KHOSTS = ["82.push2his.eastmoney.com", "push2his.eastmoney.com", "33.push2his.eastmoney.com"];

export async function fetchKline(code, mk, beg = "19900101") {
  for (let t = 0; t < 2; t++) for (const h of KHOSTS) {
    try {
      const r = await fetch(`https://${h}/api/qt/stock/kline/get?secid=${mk}.${code}&fields1=f1&fields2=f51,f53,f57&klt=101&fqt=0&beg=${beg}&end=20500101`, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(8000) });
      const j = JSON.parse(await r.text());
      if (j?.data?.klines) return Object.fromEntries(j.data.klines.map(l => { const [d, c, a] = l.split(","); return [d, { close: +c, amount: +a }]; }));
    } catch (e) {}
  }
  // 备用：新浪日K（无成交额，用 成交量×收盘 近似）
  const r = await fetch(`https://quotes.sina.cn/cn/api/jsonp_v2.php/x/CN_MarketDataService.getKLineData?symbol=${mk ? "sh" : "sz"}${code}&scale=240&ma=no&datalen=10000`);
  const t = await r.text(), arr = JSON.parse(t.slice(t.indexOf("(") + 1, t.lastIndexOf(")")));
  const b = beg.replace(/(\d{4})(\d\d)(\d\d)/, "$1-$2-$3");
  return Object.fromEntries(arr.filter(x => x.day >= b).map(x => [x.day, { close: +x.close, amount: +x.volume * +x.close }]));
}
// lsjz 每页最多 20 条
export async function fetchNav(code, maxPages = 1000, startDate = "") {
  const out = {};
  for (let p = 1; p <= maxPages; p++) {
    let j;
    for (let t = 0; t < 3; t++) {
      try {
        const r = await fetch(`https://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}&pageIndex=${p}&pageSize=20&startDate=${startDate}&endDate=`, { headers: H });
        j = await r.json(); break;
      } catch (e) { await new Promise(s => setTimeout(s, 800)); }
    }
    const list = j?.Data?.LSJZList || [];
    for (const x of list) if (+x.DWJZ > 0) out[x.FSRQ] = +x.DWJZ;
    if (list.length < 20) break;
  }
  return out;
}
// 剔除|溢价|>50%的点（份额拆分/折算日价格与净值口径不一致）
export function join(code, kl, nav) {
  return Object.keys(nav).filter(d => kl[d] && Math.abs(kl[d].close / nav[d] - 1) < 0.5).sort().map(d => ({
    code, date: d, close: kl[d].close, nav: nav[d], amount: kl[d].amount, premium: kl[d].close / nav[d] - 1 }));
}
