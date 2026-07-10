-- Latest verification result for a job (JSON summary emitted by the engine's
-- verification_summary event), and when it was produced. Overwritten on each
-- verification run (post-job automatic or on-demand via the Verify button);
-- full per-run history stays in job_log.
ALTER TABLE jobs ADD COLUMN verification_json TEXT;
ALTER TABLE jobs ADD COLUMN verified_at TEXT;
