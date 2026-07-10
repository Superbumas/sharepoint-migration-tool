-- Run-scoped progress counters. A stopped/resumed job used to accumulate
-- items_done/items_skipped across every run while total_items reflected only
-- the CURRENT run's enumeration - observed live as "3,717 of 3,164 files -
-- 100.0%" with gigabytes still transferring. jobs.run_seq increments on
-- every engine start; job_items.last_run_seq stamps which run last touched
-- each row, so live counters and the completion/verification recomputes can
-- count exactly one run's outcomes while job_items keeps its full history
-- for the audit trail.
ALTER TABLE jobs ADD COLUMN run_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE job_items ADD COLUMN last_run_seq INTEGER;
