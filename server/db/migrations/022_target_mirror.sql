-- "Mirror the source" on a completed job: removes from the target what the
-- tool copied earlier but the source no longer has (deleted, renamed or
-- moved there since a test pass). mirror_preview_json holds the last preview
-- (what WOULD be removed - approving it is what the apply step acts on);
-- mirror_json the result of the last apply. Removed items go to the target
-- site's recycle bin; the per-item audit lives in job_log (target_removed /
-- target_kept rows).
ALTER TABLE jobs ADD COLUMN mirror_preview_json TEXT;
ALTER TABLE jobs ADD COLUMN mirror_preview_at TEXT;
ALTER TABLE jobs ADD COLUMN mirror_json TEXT;
ALTER TABLE jobs ADD COLUMN mirrored_at TEXT;
