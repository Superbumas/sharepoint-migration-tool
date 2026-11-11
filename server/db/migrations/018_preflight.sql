-- Pre-flight content check result (engine/lib/Preflight.psm1): target paths
-- over SharePoint's 400-character limit, files over 250 GB, items with unique
-- permissions. Written by every run and by the on-demand "Pre-flight check".
ALTER TABLE jobs ADD COLUMN preflight_json TEXT;
ALTER TABLE jobs ADD COLUMN preflight_at TEXT;
