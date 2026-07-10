-- Adds the local/DFS file share as a second possible migration SOURCE,
-- alongside the existing SharePoint source - the mirror image of
-- 003_blob_target.sql. source_provider is a NEW column, distinct from
-- source_type (folder-vs-file, untouched here). Validity
-- ('sharepoint'|'filesystem') is enforced in the API layer, same pattern as
-- target_provider - SQLite's support for CHECK constraints added through
-- ALTER TABLE ADD COLUMN is version-dependent.
--
-- No new path column: for a filesystem source the existing source_path holds
-- the absolute UNC/local directory (e.g. \\corp\dfs\Finance) and
-- source_site_url/source_library stay NULL.
ALTER TABLE mappings ADD COLUMN source_provider TEXT NOT NULL DEFAULT 'sharepoint';
ALTER TABLE jobs ADD COLUMN source_provider TEXT NOT NULL DEFAULT 'sharepoint';
