import { spawnSync } from 'node:child_process';

if (!process.env.CLOUDFLARE_API_TOKEN?.trim()) {
  console.error('请先在 .env 中填写 CLOUDFLARE_API_TOKEN。');
  process.exit(1);
}

const sql = "SELECT datetime(ts/1000,'unixepoch','+8 hours') AS beijing_time,outcome,duration_ms,fresh_count,quote_count,providers,datetime(backoff_until/1000,'unixepoch','+8 hours') AS backoff_until,error FROM quote_refresh_logs ORDER BY ts DESC LIMIT 30";
const result = spawnSync('wrangler', ['d1', 'execute', 'etf-premium', '--remote', `--command=${sql}`],
  { stdio: 'inherit', env: process.env });
if (result.error) throw result.error;
process.exit(result.status || 0);
