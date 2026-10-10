# 纳指 · 标普 ETF 溢价率看板（Cloudflare Workers + D1）

这个项目跟踪 15 只 A 股场内纳指 100、标普 500 QDII ETF，展示最近入库的行情、参考溢价率和历史日度溢价，便于比较不同基金管理机构的同类产品。

## 功能概览

- **行情总览**：查看现价、涨跌、成交额、参考净值、溢价率和报价时间；名称包含基金管理机构，参考净值标明 IOPV 或 NAV 口径。
- **筛选与汇总**：按全部、纳指、标普筛选，点击表头排序；顶部显示两类 ETF 的平均参考溢价、最高和最低参考溢价，以及 IOPV/NAV 数量。
- **历史分析**：表格展示最近的日度溢价迷你走势；点开单只 ETF，可查看区间统计、日度溢价曲线及收盘价与单位净值对比；还可在多 ETF 对比图中切换 1M、3M、6M、1Y、3Y 和全部区间。
- **页面体验**：支持深浅色和手机窄屏，溢价率显示两位小数；图表组件按需加载。
- **数据更新**：页面每分钟从 D1 读取行情，盘中采集由 Worker 定时执行；日度历史每日增量更新两次，并记录行情源请求与限流退避结果。

开发约定见 [`AGENTS.md`](AGENTS.md)；按功能编号分类的当前进度、验证记录和待办见 [`DEVELOPMENT_PROGRESS.md`](DEVELOPMENT_PROGRESS.md)。

## 结构

- `src/index.js` Worker：API + 定时任务；`src/daily.js` 日度历史抓取/对齐；`src/etfs.js` ETF 列表
- `public/index.html` + `public/app.js` 前端页面与交互，图表使用按需加载的 ECharts CDN
- `schema.sql` D1 表：`latest_cache`（最近行情）、`snapshots`（盘中快照）、`daily`（日度溢价）、`quote_refresh_logs`（抓取日志）、`quote_refresh_state`（限流退避状态）
- `scripts/backfill.mjs` 全量回填历史 → `data/daily.sql`（可直接写入本地/远程 D1）；`scripts/deploy.mjs` 部署和迁移；`scripts/quote-logs.mjs` 查询采集日志
- `test/tracker.test.mjs` 关键数据流程和页面逻辑测试

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

- `*/2 1-7 * * 1-5`：周一至周五的盘中时间窗口每 2 分钟尝试抓取行情并写入最近行情和快照（代码内再过滤到北京时间 9:25–11:32、12:58–15:05）
- `30 0,12 * * *`：北京时间 08:30 / 20:30 增量更新最近 40 天日度数据（UPSERT）
- 日度任务同时删除超过 90 天的盘中快照。

时间窗口外不抓取盘中行情，但日度任务仍按上面的时间运行。当前没有交易所休市日历：若法定休市落在周一至周五，盘中时间窗口内仍会尝试请求行情源。此项待办见 `QTE-004`。

每轮行情抓取会记录东方财富和新浪的 HTTP 状态、耗时、结果及新鲜报价数量。遇到 403/429 时，不再尝试东方财富备用域名，并从 10 分钟开始指数退避，最长 60 分钟；退避期间保留数据库中的上次行情。日志保留 30 天。

    npm run logs:quotes  # 查看最近 30 条 D1 抓取日志
    node --env-file=.env node_modules/wrangler/bin/wrangler.js tail a-etf-tracker  # 实时 Worker 日志

## 本地

    npm i
    npx wrangler d1 execute etf-premium --local --file=schema.sql
    node scripts/backfill.mjs --local      # 生成历史数据并写入本地 D1
    npx wrangler dev                        # http://localhost:8787
    npm test

需要手动测试定时任务时，运行 `npx wrangler dev --test-scheduled`，再访问 `/__scheduled`。

## 部署

    cp -n .env.example .env  # 仅在 .env 不存在时创建；填写 CLOUDFLARE_API_TOKEN，且不要提交
    node --env-file=.env node_modules/wrangler/bin/wrangler.js d1 create etf-premium  # 仅新数据库需要；把 database_id 填进 wrangler.toml
    npm run db:migrate  # 创建/更新 D1 表和索引
    npm run deploy      # 部署 Worker
    node --env-file=.env scripts/backfill.mjs --remote  # 仅新数据库需要回填历史

现有数据库只需在 schema 变更时运行 `npm run db:migrate`，日常发布用 `npm run deploy`。`.env` 仅供本地部署命令读取，已加入 `.gitignore`。

数据源为东方财富/新浪的非官方接口，可能限流或变更；仅供参考。
