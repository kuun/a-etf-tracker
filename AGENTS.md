# 项目开发约定

本文件适用于整个仓库。开始修改前先读 `README.md` 和 `DEVELOPMENT_PROGRESS.md`，确认数据口径、当前状态及待办事项。

## 项目结构

- `src/index.js`：Cloudflare Worker 的 API、行情抓取与定时任务。
- `src/daily.js`：日度收盘价和净值抓取、按估值日对齐。
- `src/etfs.js`：ETF 清单及展示名称。
- `public/index.html`、`public/app.js`：页面样式与交互。
- `schema.sql`：D1 表和索引；`test/tracker.test.mjs`：关键行为测试。
- `scripts/`：历史回填、部署及抓取日志查询。

## 修改时要保持的行为

- `/api/latest` 只读 D1。访客访问页面或自动轮询不得触发外部行情请求；行情由 Worker 的 scheduled 任务更新。
- 盘中行情按周一至周五的北京时间交易时间窗口过滤；目前没有交易所休市日历。遇到行情源 403/429 时保留限流退避，并记录抓取结果。修改 cron 时同时核对 `wrangler.toml`、Worker 代码和 README。
- 参考溢价优先按现价 / IOPV − 1 计算，无可用 IOPV 才使用 NAV；日度溢价按同一估值日的收盘价 / 官方单位净值 − 1。不要混用两个口径。
- ETF 名称应能区分基金管理机构；界面上的溢价率显示保留两位小数。新增或调整 ETF 时检查 `src/etfs.js`、汇总卡片、表格、图表和相关测试。
- D1 schema 改动需兼容已有数据库，并同步更新迁移说明；不要在页面请求中执行回填或抓取。

## 验证与发布

- 修改代码后运行 `npm test` 和 `git diff --check`；涉及界面布局时检查桌面及窄屏显示。
- 修改数据口径、定时频率、接口或部署流程时，同步更新 `README.md` 和 `DEVELOPMENT_PROGRESS.md`。
- 发布流程见 README：schema 变更先运行 `npm run db:migrate`，再运行 `npm run deploy`。发布后检查 `/api/latest` 和 `npm run logs:quotes`。
- `.env` 包含本地 Cloudflare 凭据，不能提交或输出其内容；仓库只保留 `.env.example`。

## 进度记录

按 `DEVELOPMENT_PROGRESS.md` 的“编号与更新规则”维护功能清单：开始新功能时分配固定编号，修改已有功能时沿用编号，记录状态、验收依据和下一步。测试与部署分别记录；未实际验证的事项保持“已实现”或“待办”，不要写成“已验证”。
