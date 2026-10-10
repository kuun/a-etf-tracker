import { spawnSync } from 'node:child_process';

if (!process.env.CLOUDFLARE_API_TOKEN?.trim()) {
  console.error('请先在 .env 中填写 CLOUDFLARE_API_TOKEN。');
  process.exit(1);
}

function run(args) {
  const result = spawnSync('wrangler', args, { stdio: 'inherit', env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

if (process.argv.includes('--migrate')) {
  // Run schema changes explicitly so routine deployments do not pause D1 queries.
  run(['d1', 'execute', 'etf-premium', '--remote', '--file=schema.sql', '-y']);
} else {
  run(['deploy']);
}
