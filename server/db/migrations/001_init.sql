-- SharePoint Migration Tool - initial schema
-- SQLite is the single source of truth for job state, so Node restarts
-- never lose progress and the PowerShell engine can be resumed cleanly.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,              -- Azure AD object id (oid)
  display_name TEXT,
  email TEXT,
  upn TEXT,
  photo_data_url TEXT,
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS mappings (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL CHECK (source_type IN ('folder','file')),
  source_site_url TEXT,
  source_site_name TEXT,
  source_library TEXT,
  source_path TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('folder','file')),
  target_site_url TEXT,
  target_site_name TEXT,
  target_library TEXT,
  target_path TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('Migrate','Migrate-selective','Archive')),
  confidence TEXT,
  origin TEXT NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual','crosswalk')),
  crosswalk_batch_id TEXT,
  crosswalk_row_ref TEXT,
  notes TEXT,
  created_by_name TEXT,
  created_by_email TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  mapping_id TEXT NOT NULL REFERENCES mappings(id),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','approved','running','paused','completed','failed','cancelled')),

  source_type TEXT NOT NULL,
  source_site_url TEXT,
  source_library TEXT,
  source_path TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_site_url TEXT,
  target_library TEXT,
  target_path TEXT NOT NULL,
  action TEXT NOT NULL,

  concurrency INTEGER NOT NULL DEFAULT 4,

  total_items INTEGER,
  total_bytes INTEGER,
  items_done INTEGER NOT NULL DEFAULT 0,
  bytes_done INTEGER NOT NULL DEFAULT 0,
  items_failed INTEGER NOT NULL DEFAULT 0,
  items_skipped INTEGER NOT NULL DEFAULT 0,
  retries_total INTEGER NOT NULL DEFAULT 0,

  checkpoint_json TEXT,          -- {lastCompletedPath, deltaToken, itemsDone, bytesDone}
  pause_requested INTEGER NOT NULL DEFAULT 0,
  cancel_requested INTEGER NOT NULL DEFAULT 0,

  error_message TEXT,

  created_by_name TEXT, created_by_email TEXT, created_by_upn TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),

  approved_by_name TEXT, approved_by_email TEXT, approved_at TEXT,

  started_at TEXT,
  paused_at TEXT,
  completed_at TEXT,

  deleted_at TEXT,               -- soft delete only: hides from active queue,
  deleted_by_name TEXT,          -- logs/audit rows remain queryable forever

  pid INTEGER,                   -- OS pid of the running pwsh process, if any
  last_heartbeat_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_deleted_at ON jobs(deleted_at);

CREATE TABLE IF NOT EXISTS job_items (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  item_type TEXT NOT NULL CHECK (item_type IN ('file','folder')),
  source_path TEXT NOT NULL,
  target_path TEXT NOT NULL,
  size_bytes INTEGER,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','success','failed','retried','skipped')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  http_status INTEGER,
  error_message TEXT,
  started_at TEXT,
  completed_at TEXT,
  UNIQUE(job_id, source_path)
);
CREATE INDEX IF NOT EXISTS idx_job_items_job_id ON job_items(job_id);
CREATE INDEX IF NOT EXISTS idx_job_items_status ON job_items(status);

-- Append-only log: every file/folder operation AND every lifecycle action
-- (approve/run/pause/resume/cancel/delete). Never deleted when a job is
-- "deleted" - that only sets jobs.deleted_at. This table is the audit trail.
CREATE TABLE IF NOT EXISTS job_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  item_id TEXT,
  event_type TEXT NOT NULL,   -- item_start|item_success|item_failed|item_retry|
                              -- throttle|job_approved|job_run|job_paused|
                              -- job_resumed|job_cancelled|job_completed|
                              -- job_failed|job_deleted|info
  source_path TEXT,
  target_path TEXT,
  action TEXT,
  outcome TEXT CHECK (outcome IN ('success','failed','retried') OR outcome IS NULL),
  bytes INTEGER,
  duration_ms INTEGER,
  http_status INTEGER,
  error_message TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  actor_name TEXT,
  actor_email TEXT,
  actor_upn TEXT,
  ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  raw_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_job_log_job_id ON job_log(job_id);
CREATE INDEX IF NOT EXISTS idx_job_log_ts ON job_log(ts);
CREATE INDEX IF NOT EXISTS idx_job_log_event_type ON job_log(event_type);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
