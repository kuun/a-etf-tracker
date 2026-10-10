# 纳指 · 标普 ETF 溢价率看板（Cloudflare Workers + D1）

## 结构
- `src/index.js` Worker：API + 定时任务；`src/daily.js` 日度历史抓取/对齐；`src/etfs.js` ETF 列表
- `public/index.html` + `public/app.js` 前端（ECharts CDN）：汇总卡片、全部/纳指/标普筛选、可排序列、60 日迷你走势、深浅色、移动端适配、详情弹窗（溢价历史 + 收盘价 vs 净值，1M/3M/6M/1Y/3Y/全部）、多 ETF 对比图
- `schema.sql` D1 表：`latest_cache`（最近行情）、`snapshots`（盘中快照）、`daily`（日度溢价）、`quote_refresh_logs`（抓取日志）、`quote_refresh_state`（限流退避状态）
- `scripts/backfill.mjs` 全量回填历史 → `data/daily.sql`（可直接写入本地/远程 D1）

## API
- `/api/latest` 只读取 D1 最近行情（现价/IOPV/净值/溢价率、报价时间 `quote_ts`、内部新鲜度字段 `stale`）。访问页面和每分钟自动读取均不会请求外部行情源；数据库尚无行情时返回 503，等待定时任务首次写入。
- `/api/daily?code=513100&from=2025-01-01` 单只日度；`/api/daily?code=all&from=...` 全部（紧凑格式）。全部 ETF 的日度查询最多一年；长区间使用 `resolution=week` 或 `resolution=month`，返回每周或每月的平均溢价。
- `/api/history?code=513100&days=30` 盘中快照
- （手动触发端点 /api/collect、/api/update-daily 已在上线前移除；如需手动跑，用 `npx wrangler dev --test-scheduled` 后访问 /__scheduled）

## 口径
- 报价参考溢价：现价 / IOPV − 1（无可用 IOPV 则用最新 NAV，标注 NAV 和净值日期）。超过 5 分钟的报价在 API 中标记为过期；顶部汇总使用数据库最近一次报价中有参考溢价的 ETF，包含非交易时段的上次报价，并列出 IOPV/NAV 口径数量。
- 日度：T 日 A 股未复权收盘价 / 估值日 T 的官方单位净值 − 1，按日期严格对齐；只有一方有数据的日期（中美假期）跳过；|溢价|>50% 视为拆分/折算口径错位剔除
- QDII 的 T 日净值包含当晚美股收盘，T+1~T+2 才公布，所以最近 1–2 个交易日暂无日度数据

## 定时任务（UTC）
- `*/2 1-7 * * 1-5`：盘中每 2 分钟抓取行情并写入最近行情和快照（代码内再过滤到北京时间 9:25–11:32、12:58–15:05）
- `30 0,12 * * *`：北京时间 08:30 / 20:30 增量更新最近 40 天日度数据（UPSERT）
- 日度任务同时删除超过 90 天的盘中快照。

每轮行情抓取会记录东方财富和新浪的 HTTP 状态、耗时、结果及新鲜报价数量。遇到 403/429 时，不再尝试东方财富备用域名，并从 10 分钟开始指数退避，最长 60 分钟；退避期间保留数据库中的上次行情。日志保留 30 天。

    npm run logs:quotes  # 查看最近 30 条 D1 抓取日志
    node --env-file=.env node_modules/wrangler/bin/wrangler.js tail a-etf-tracker  # 实时 Worker 日志

## 本地
    npm i
    npx wrangler d1 execute etf-premium --local --file=schema.sql
    node scripts/backfill.mjs --local      # 约 1.5 分钟
    npx wrangler dev                        # http://localhost:8787
    npm test

## 部署
    # 在项目根目录的 .env 中填写 CLOUDFLARE_API_TOKEN；不要提交这个文件
    node --env-file=.env node_modules/wrangler/bin/wrangler.js d1 create etf-premium  # 仅新数据库需要；把 database_id 填进 wrangler.toml
    npm run db:migrate  # 创建/更新 D1 表和索引
    npm run deploy      # 部署 Worker
    node --env-file=.env scripts/backfill.mjs --remote  # 仅新数据库需要回填历史

现有数据库只需在 schema 变更时运行 `npm run db:migrate`，日常发布用 `npm run deploy`。`.env` 仅供本地部署命令读取，已加入 `.gitignore`。

数据源为东方财富/新浪的非官方接口，可能限流或变更；仅供参考。
