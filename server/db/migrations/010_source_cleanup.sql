-- Result of the post-verification "delete source files" action (archive-move
-- semantics): counts + kept-file sample as JSON, and when it ran. Only ever
-- set on completed jobs whose verification passed; the audit detail lives in
-- job_log (source_deleted / source_kept rows).
ALTER TABLE jobs ADD COLUMN cleanup_json TEXT;
ALTER TABLE jobs ADD COLUMN cleaned_at TEXT;
