CREATE TABLE IF NOT EXISTS snapshots (
  ts INTEGER NOT NULL, code TEXT NOT NULL, price REAL, iopv REAL, nav REAL, nav_date TEXT,
  premium REAL, basis TEXT, PRIMARY KEY (code, ts));
CREATE INDEX IF NOT EXISTS idx_ts ON snapshots(ts);
CREATE TABLE IF NOT EXISTS daily (
  code TEXT NOT NULL, date TEXT NOT NULL, close REAL, nav REAL, amount REAL, premium REAL,
  PRIMARY KEY (code, date));
