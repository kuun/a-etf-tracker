const $ = selector => document.querySelector(selector);
const html = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[char]);
const pct = (value, digits = 2) => Number.isFinite(value)
  ? `${value > 0 ? '+' : ''}${(value * 100).toFixed(digits)}%` : '—';
const axisPct = value => pct(value);
const ago = days => days ? new Date(Date.now() - days * 864e5).toISOString().slice(0, 10) : '1900-01-01';
const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const dateTime = ts => ts ? new Date(ts).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '—';
const RANGES = [['1M', 30], ['3M', 91], ['6M', 182], ['1Y', 365], ['3Y', 1095], ['全部', 0]];
const COLS = [['code', '代码 / 名称', 'l'], ['index', '指数', 'l hide-m'], ['price', '现价'],
  ['change', '涨跌'], ['amount', '成交额', 'hide-m'], ['iopv', '参考净值', 'hide-m'],
  ['spark', '近60日溢价', 'hide-m'], ['premium', '溢价率']];
let rows = [], spark = {}, group = '', sortKey = 'premium', sortDirection = -1;
let compareRange = 365, current = null, currentRange = 182, lastSuccess = null;
let detailRequest = 0, modalReturnFocus = null;
const dailyCache = new Map(), charts = {};
let echartsPromise;
function loadEcharts() {
  if (window.echarts) return Promise.resolve();
  if (!echartsPromise) echartsPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js';
    script.onload = resolve;
    script.onerror = () => { echartsPromise = null; reject(new Error('图表组件加载失败')); };
    document.head.append(script);
  });
  return echartsPromise;
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}
function setStatus(message, error = false) {
  $('#status').textContent = message;
  $('#status').classList.toggle('error', error);
}
function heat(value) {
  if (!Number.isFinite(value)) return '';
  const strength = Math.min(Math.abs(value) / .15, 1);
  const color = value >= 0 ? '232,66,63' : '22,163,91';
  return `background:rgba(${color},${.12 + .55 * strength});color:${strength > .55 ? '#fff' : 'inherit'}`;
}
function head() {
  $('#hd').innerHTML = COLS.map(([key, label, cls = '']) =>
    `<th class="${cls} ${key === sortKey ? 'on' : ''}" data-k="${key}">${label}${key === sortKey ? sortDirection < 0 ? ' ↓' : ' ↑' : ''}</th>`).join('');
}
function sparkSvg(series) {
  if (!series || series.length < 2) return '';
  const values = series.map(point => point[1]);
  const min = Math.min(...values, 0), max = Math.max(...values, 0), height = max - min || 1;
  const points = values.map((value, i) => `${(i / (values.length - 1) * 108 + 1).toFixed(1)},${(28 - (value - min) / height * 26).toFixed(1)}`).join(' ');
  const zero = 28 - (0 - min) / height * 26;
  return `<line x1="0" x2="110" y1="${zero}" y2="${zero}" stroke="${css('--line')}" stroke-dasharray="2 2"/>` +
    `<polyline fill="none" stroke="${values.at(-1) >= 0 ? css('--up') : css('--dn')}" stroke-width="1.5" points="${points}"/>`;
}
function render() {
  head();
  const list = rows.filter(row => !group || row.index === group).sort((a, b) => {
    const x = a[sortKey], y = b[sortKey];
    if (x == null) return y == null ? 0 : 1;
    if (y == null) return -1;
    return (x > y ? 1 : x < y ? -1 : 0) * sortDirection;
  });
  $('#cnt').textContent = `共 ${list.length} 只`;
  $('#tb').innerHTML = list.map(row => {
    const tag = row.basis === 'NAV' ? `NAV ${row.nav_date || '日期未知'}` : row.basis || '无参考值';
    return `<tr data-code="${html(row.code)}" tabindex="0"><td class="l"><div class="nm">${html(row.name)}</div>` +
      `<div class="cd">${html(row.code)} <span class="tag">${html(tag)}</span></div></td>` +
      `<td class="l hide-m">${html(row.index)}</td><td>${row.price?.toFixed(3) ?? '—'}</td>` +
      `<td class="${row.change > 0 ? 'up' : row.change < 0 ? 'dn' : ''}">${pct(row.change)}</td>` +
      `<td class="hide-m">${row.amount ? (row.amount / 1e8).toFixed(2) + ' 亿' : '—'}</td>` +
      `<td class="hide-m">${(row.basis === 'NAV' ? row.nav : row.iopv)?.toFixed(4) ?? '—'}</td>` +
      `<td class="hide-m"><svg class="spark" viewBox="0 0 110 30" preserveAspectRatio="none">${sparkSvg(spark[row.code])}</svg></td>` +
      `<td><span class="pill" style="${heat(row.premium)}">${pct(row.premium)}</span></td></tr>`;
  }).join('');
}
function cards() {
  const available = rows.filter(row => Number.isFinite(row.premium));
  const byIndex = index => available.filter(row => row.index === index);
  const average = index => {
    const values = byIndex(index);
    return values.length ? values.reduce((sum, row) => sum + row.premium, 0) / values.length : null;
  };
  const basisSummary = index => {
    const values = byIndex(index);
    if (!values.length) return '暂无参考溢价';
    const iopv = values.filter(row => row.basis === 'IOPV').length;
    const nav = values.filter(row => row.basis === 'NAV').length;
    return `${values.length} 只 · IOPV ${iopv} / NAV ${nav}`;
  };
  const reference = row => row.basis === 'NAV' ? `NAV ${row.nav_date || '日期未知'}` : row.basis || '参考值';
  const sorted = [...available].sort((a, b) => b.premium - a.premium);
  const high = sorted[0], low = sorted.at(-1);
  const card = (label, value, sub, premium) => `<div class="card"><div class="k">${label}</div>` +
    `<div class="v" style="color:${premium == null ? 'inherit' : premium >= 0 ? css('--up') : css('--dn')}">${html(value)}</div>` +
    `<div class="s">${html(sub)}</div></div>`;
  $('#cards').innerHTML = card('纳指平均参考溢价', pct(average('纳指')), basisSummary('纳指'), average('纳指')) +
    card('标普平均参考溢价', pct(average('标普')), basisSummary('标普'), average('标普')) +
    card('最高参考溢价', pct(high?.premium), high ? `${high.name} ${high.code} · ${reference(high)}` : '暂无参考溢价', high?.premium) +
    card('最低参考溢价', pct(low?.premium), low ? `${low.name} ${low.code} · ${reference(low)}` : '暂无参考溢价', low?.premium) +
    card('最新报价（北京）', dateTime(Math.max(0, ...rows.map(row => row.quote_ts || 0))), '每分钟读取数据库 · 交易时段定时更新');
}
async function load() {
  try {
    const latest = await fetchJson('/api/latest');
    if (!Array.isArray(latest.rows) || !latest.rows.some(row => row.quote_ts)) throw new Error('行情源未返回有效报价');
    rows = latest.rows;
    lastSuccess = Date.now();
    setStatus(`最新报价：${dateTime(Math.max(...rows.map(row => row.quote_ts || 0)))}（北京）`);
    cards(); render();
  } catch (error) {
    setStatus(`行情获取失败：${error.message}。${lastSuccess ? `保留 ${dateTime(lastSuccess)} 的上次结果` : '请稍后重试'}`, true);
    if (!lastSuccess) { cards(); render(); }
  }
}
async function loadSpark() {
  try {
    const result = await fetchJson(`/api/daily?code=all&from=${ago(90)}`);
    spark = Object.fromEntries(Object.entries(result.series || {}).map(([code, series]) => [code, series.slice(-60)]));
    render();
  } catch (error) {
    console.error('迷你走势加载失败', error);
  }
}
function chart(id) {
  charts[id]?.dispose();
  return charts[id] = echarts.init(document.getElementById(id), document.documentElement.dataset.theme === 'dark' ? 'dark' : null);
}
const base = () => ({ animation: false, backgroundColor: 'transparent', grid: { left: 70, right: 20, top: 40, bottom: 60 },
  tooltip: { trigger: 'axis' }, dataZoom: [{ type: 'inside' }, { type: 'slider', height: 18, bottom: 8 }] });
function premiumTooltip(params) {
  const items = Array.isArray(params) ? params : [params];
  if (!items.length) return '';
  const date = items[0].axisValueLabel || items[0].axisValue || '';
  const hint = items.length > 8 ? `<span class="premium-tip-hint">共 ${items.length} 只，可滚动</span>` : '';
  return `<div class="premium-tip"><div class="premium-tip-date">${html(date)}${hint}</div><div class="premium-tip-grid">` + items.map(item => {
    const value = Array.isArray(item.value) ? item.value[1] : item.value;
    return `<div class="premium-tip-item"><span class="premium-tip-name" title="${html(item.seriesName)}">${html(item.seriesName)}</span><b>${pct(value)}</b></div>`;
  }).join('') + '</div></div>';
}
const premiumTooltipOptions = { trigger: 'axis', formatter: premiumTooltip, appendToBody: true, confine: true, enterable: true };
async function compare() {
  const range = compareRange;
  const resolution = range === 0 ? 'month' : range > 365 ? 'week' : 'day';
  $('#cmpNote').textContent = '对比图加载中…';
  try {
    const result = await fetchJson(`/api/daily?code=all&from=${ago(range)}&resolution=${resolution}`);
    await loadEcharts();
    if (range !== compareRange) return;
    const names = Object.fromEntries(rows.map(row => [row.code, row.name]));
    chart('cmp').setOption({ ...base(), legend: { type: 'scroll', top: 0 }, yAxis: { type: 'value', axisLabel: { formatter: axisPct } },
      xAxis: { type: 'time' }, tooltip: premiumTooltipOptions,
      series: Object.entries(result.series || {}).map(([code, series]) => ({ name: `${names[code] || code} · ${code}`, type: 'line', showSymbol: false, data: series, lineStyle: { width: 1.3 } })) });
    $('#cmpNote').textContent = resolution === 'day' ? '每日数据' : resolution === 'week' ? '每周平均溢价' : '每月平均溢价';
  } catch (error) {
    $('#cmpNote').textContent = `对比图加载失败：${error.message}`;
  }
}
function tabs(element, selected, callback) {
  element.innerHTML = RANGES.map(([label, days]) => `<button data-d="${days}" class="${days === selected ? 'on' : ''}">${label}</button>`).join('');
  element.onclick = event => {
    const days = event.target.dataset.d;
    if (days == null) return;
    [...element.children].forEach(button => button.classList.toggle('on', button === event.target));
    callback(Number(days));
  };
}
async function openModal(code) {
  const selected = rows.find(row => row.code === code);
  if (!selected) return;
  modalReturnFocus = document.activeElement;
  current = selected;
  $('#modal').classList.add('on');
  document.body.classList.add('modal-open');
  $('#mtName').textContent = selected.name;
  $('#mtMeta').textContent = `${code} · ${selected.index}`;
  tabs($('#rng'), currentRange, days => { currentRange = days; drawModal(); });
  $('#closeModal').focus();
  await drawModal();
}
function closeModal() {
  if (!current) return;
  $('#modal').classList.remove('on');
  document.body.classList.remove('modal-open');
  current = null;
  detailRequest++;
  modalReturnFocus?.focus?.();
  modalReturnFocus = null;
}
async function drawModal() {
  if (!current) return;
  const selected = current, range = currentRange, request = ++detailRequest;
  const key = `${selected.code}:${range}`;
  $('#mstats').textContent = '历史数据加载中…';
  try {
    if (!dailyCache.has(key)) dailyCache.set(key, fetchJson(`/api/daily?code=${selected.code}&from=${ago(range)}`).then(result => result.rows));
    const data = await dailyCache.get(key);
    if (request !== detailRequest || current !== selected) return;
    if (!Array.isArray(data)) throw new Error('历史数据格式错误');
    const premiums = data.map(row => row.premium).filter(Number.isFinite);
    const stats = [['当前溢价', pct(selected.premium)], ['区间均值', pct(premiums.length ? premiums.reduce((a, b) => a + b, 0) / premiums.length : null)],
      ['区间最高', pct(premiums.length ? Math.max(...premiums) : null)], ['区间最低', pct(premiums.length ? Math.min(...premiums) : null)]];
    $('#mstats').innerHTML = stats.map(([label, value]) => `<div><span>${label}</span><b>${value}</b></div>`).join('') +
      `<div style="grid-column:1/-1"><span>历史数据 ${html(data[0]?.date || '—')} ~ ${html(data.at(-1)?.date || '—')}，共 ${data.length} 个交易日</span></div>`;
    await loadEcharts();
    if (request !== detailRequest || current !== selected) return;
    chart('c1').setOption({ ...base(), title: { text: '日度溢价率', textStyle: { fontSize: 13 } },
      xAxis: { type: 'category', data: data.map(row => row.date) }, yAxis: { type: 'value', axisLabel: { formatter: axisPct } },
      tooltip: premiumTooltipOptions, series: [{ type: 'line', name: '溢价率', color: css('--up'), data: data.map(row => row.premium), showSymbol: false,
        areaStyle: { opacity: .15 }, markLine: { symbol: 'none', data: [{ yAxis: 0 }], lineStyle: { color: '#888' }, label: { show: false } } }] });
    chart('c2').setOption({ ...base(), grid: { ...base().grid, top: 60 },
      title: { text: '收盘价 vs 单位净值', textStyle: { fontSize: 13 } }, legend: { top: 27, right: 10 },
      xAxis: { type: 'category', data: data.map(row => row.date) }, yAxis: { type: 'value', scale: true },
      series: [{ type: 'line', name: '收盘价', data: data.map(row => row.close), showSymbol: false, color: '#f0a020' },
        { type: 'line', name: '单位净值', data: data.map(row => row.nav), showSymbol: false, color: css('--acc') }] });
  } catch (error) {
    dailyCache.delete(key);
    if (request === detailRequest) $('#mstats').textContent = `历史数据加载失败：${error.message}`;
  }
}

$('#hd').onclick = event => {
  const key = event.target.dataset.k;
  if (!key || key === 'spark') return;
  if (sortKey === key) sortDirection = -sortDirection;
  else { sortKey = key; sortDirection = -1; }
  render();
};
$('#tabs').onclick = event => {
  if (event.target.dataset.g == null) return;
  group = event.target.dataset.g;
  [...$('#tabs').children].forEach(button => button.classList.toggle('on', button === event.target));
  render();
};
$('#tb').onclick = event => openModal(event.target.closest('tr')?.dataset.code);
$('#tb').onkeydown = event => {
  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openModal(event.target.closest('tr')?.dataset.code); }
};
$('#closeModal').onclick = closeModal;
$('#modal').onclick = event => { if (event.target === $('#modal')) closeModal(); };
addEventListener('keydown', event => {
  if (!current) return;
  if (event.key === 'Escape') return closeModal();
  if (event.key !== 'Tab') return;
  const controls = [...$('#modal').querySelectorAll('button')];
  const first = controls[0], last = controls.at(-1);
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
});
tabs($('#cmpR'), compareRange, days => { compareRange = days; compare(); });
const themeButton = $('#theme');
function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  themeButton.textContent = theme === 'dark' ? '☀️ 浅色' : '🌙 深色';
  localStorage.theme = theme;
}
setTheme(localStorage.theme || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'));
themeButton.onclick = () => {
  setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  cards(); render(); compare(); if (current) drawModal();
};
addEventListener('resize', () => Object.values(charts).forEach(instance => instance.resize()));
loadSpark();
load().then(() => {
  compare();
  if (location.hash.length > 1) openModal(location.hash.slice(1));
});
setInterval(load, 60000);
setInterval(loadSpark, 300000);
