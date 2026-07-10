-- File-share (DFS) source roots, configurable from the Settings page instead
-- of requiring server-side .env access - same motivation as
-- 007_project_blob_credential.sql. Stored per-project as a semicolon-
-- separated list of absolute paths (the same format FS_SOURCE_ROOTS uses;
-- server/util/fsSource.js merges both). Not encrypted: these are paths, not
-- secrets - the security property is that they are an allowlist, enforced at
-- browse time, mapping creation AND engine spawn.
ALTER TABLE projects ADD COLUMN fs_source_roots TEXT;
