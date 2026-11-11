-- Run queue: an approved job with run_queued_at set is waiting its turn to
-- run. The orchestrator starts queued jobs a few at a time (RUN_QUEUE_MAX_JOBS)
-- and starts the next one as each finishes, so forty approved jobs can be
-- sent off in one click without forty engines hitting the tenant at once.
-- run_queued_by_json keeps who queued it, for the audit log entry written
-- when the queue actually starts the job.
ALTER TABLE jobs ADD COLUMN run_queued_at TEXT;
ALTER TABLE jobs ADD COLUMN run_queued_by_json TEXT;
