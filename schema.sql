CREATE TABLE IF NOT EXISTS snapshots (
  ts INTEGER NOT NULL, code TEXT NOT NULL, price REAL, iopv REAL, nav REAL, nav_date TEXT,
  premium REAL, basis TEXT, PRIMARY KEY (code, ts));
CREATE INDEX IF NOT EXISTS idx_ts ON snapshots(ts);
CREATE TABLE IF NOT EXISTS daily (
  code TEXT NOT NULL, date TEXT NOT NULL, close REAL, nav REAL, amount REAL, premium REAL,
  PRIMARY KEY (code, date));
CREATE INDEX IF NOT EXISTS idx_daily_date_code ON daily(date, code);
CREATE TABLE IF NOT EXISTS latest_cache (
  id INTEGER PRIMARY KEY CHECK (id = 1), checked INTEGER NOT NULL,
  refresh_after INTEGER NOT NULL, rows TEXT NOT NULL);
-- refresh_after 为兼容已部署的表保留；访问接口只读，行情仅由定时任务写入。
CREATE TABLE IF NOT EXISTS quote_refresh_state (
  id INTEGER PRIMARY KEY CHECK (id = 1), consecutive_limits INTEGER NOT NULL,
  backoff_until INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS quote_refresh_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, outcome TEXT NOT NULL,
  duration_ms INTEGER NOT NULL, fresh_count INTEGER NOT NULL, quote_count INTEGER NOT NULL,
  providers TEXT NOT NULL, backoff_until INTEGER, error TEXT);
CREATE INDEX IF NOT EXISTS idx_quote_refresh_logs_ts ON quote_refresh_logs(ts);
