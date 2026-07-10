-- Latest engine phase-progress snapshot (enumerating / preparing folders /
-- indexing), so a page load mid-phase can render the live phase banner
-- without waiting for the next socket event. Cleared when copying starts
-- and on every terminal state - only ever meaningful while status='running'.
ALTER TABLE jobs ADD COLUMN phase_json TEXT;
