-- "Only files last modified before" (the archive filter). A YYYY-MM-DD date
-- on the mapping; NULL = every file, as before. Each job takes a copy when
-- it is created, so a job's copy, Verify and "Delete source files" always
-- work on the same files even if the mapping's date is changed later.
ALTER TABLE mappings ADD COLUMN modified_before TEXT;
ALTER TABLE jobs ADD COLUMN modified_before TEXT;
