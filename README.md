# 纳指 · 标普 ETF 溢价率看板（Cloudflare Workers + D1）

## 结构
- `src/index.js` Worker：API + 定时任务；`src/daily.js` 日度历史抓取/对齐；`src/etfs.js` ETF 列表
- `public/index.html` 前端（单文件，ECharts CDN）：汇总卡片、全部/纳指/标普筛选、可排序列、60 日迷你走势、深浅色、移动端适配、详情弹窗（溢价历史 + 收盘价 vs 净值，1M/3M/6M/1Y/3Y/全部）、多 ETF 对比图
- `schema.sql` D1 表：`snapshots`（盘中快照）、`daily`（日度溢价）
- `scripts/backfill.mjs` 全量回填历史 → `data/daily.sql`（可直接写入本地/远程 D1）

## API
- `/api/latest` 实时（现价/IOPV/净值/溢价率）
- `/api/daily?code=513100&from=2025-01-01` 单只日度；`/api/daily?code=all&from=...` 全部（紧凑格式）
- `/api/history?code=513100&days=30` 盘中快照
- （手动触发端点 /api/collect、/api/update-daily 已在上线前移除；如需手动跑，用 `npx wrangler dev --test-scheduled` 后访问 /__scheduled）

## 口径
- 实时：现价 / IOPV − 1（无 IOPV 则用最新净值，标注 NAV）
- 日度：T 日 A 股未复权收盘价 / 估值日 T 的官方单位净值 − 1，按日期严格对齐；只有一方有数据的日期（中美假期）跳过；|溢价|>50% 视为拆分/折算口径错位剔除
- QDII 的 T 日净值包含当晚美股收盘，T+1~T+2 才公布，所以最近 1–2 个交易日暂无日度数据

## 定时任务（UTC）
- `*/2 1-7 * * 1-5`：盘中每 2 分钟快照（代码内再过滤到北京时间 9:25–11:32、12:58–15:05）
- `30 0,12 * * *`：北京时间 08:30 / 20:30 增量更新最近 40 天日度数据（UPSERT）

## 本地
    npm i
    npx wrangler d1 execute etf-premium --local --file=schema.sql
    node scripts/backfill.mjs --local      # 约 1.5 分钟
    npx wrangler dev                        # http://localhost:8787

## 部署
    npx wrangler login     # 或 export CLOUDFLARE_API_TOKEN=...（Workers Scripts:Edit + D1:Edit）
    npx wrangler d1 create etf-premium          # 把 database_id 填进 wrangler.toml
    npx wrangler d1 execute etf-premium --remote --file=schema.sql -y
    node scripts/backfill.mjs --remote          # 回填历史到远程 D1
    npx wrangler deploy

数据源为东方财富/新浪的非官方接口，可能限流或变更；仅供参考。
