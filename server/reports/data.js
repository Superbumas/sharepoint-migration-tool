// Report data, built only from what the DB already stores (job_items,
// verification_json, job_log), so both reports work for jobs that finished
// long before this code existed.

const path = require('path');
const { parseDate } = require('./pdf');

// Same list as engine/lib/Verification.psm1's $script:OfficeExtensions.
// SharePoint re-stamps document properties inside these on ingestion, so a
// size/hash difference is expected and not a failed copy. Verifications that
// ran before .msg joined that list (PR #34) recorded .msg rewrites as size
// mismatches - effectiveVerification() reclassifies them here, so old jobs
// report the same way new ones do without re-running anything.
const OFFICE_EXTENSIONS = new Set(['.docx', '.xlsx', '.pptx', '.doc', '.xls', '.ppt', '.docm', '.xlsm', '.pptm', '.one', '.vsdx', '.msg']);

function extOf(p) {
  return path.posix.extname(String(p || '').replace(/\\/g, '/')).toLowerCase();
}
function isOfficeFile(p) {
  return OFFICE_EXTENSIONS.has(extOf(p));
}

function safeParse(json) {
  if (!json) return null;
  try { return JSON.parse(json); } catch { return null; }
}

// Item paths repeat the same root (server-relative for SharePoint, absolute
// UNC/local for a file share). Strip it so a path reads the way the client
// sees it inside the migrated folder.
function sourceRoot(job) {
  if ((job.source_provider || 'sharepoint') === 'filesystem') {
    return String(job.source_path || '').replace(/\\/g, '/').replace(/\/+$/, '') + '/';
  }
  try {
    return `${new URL(job.source_site_url).pathname}/${job.source_library}/${job.source_path}/`.replace(/\/{2,}/g, '/');
  } catch {
    return '';
  }
}
function relativizer(job) {
  const root = sourceRoot(job);
  const rootLc = root.toLowerCase();
  return (p) => {
    const s = String(p || '').replace(/\\/g, '/');
    if (root && s.toLowerCase().startsWith(rootLc)) return s.slice(root.length);
    return s;
  };
}
function folderName(job) {
  const parts = String(job.source_path || '').replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] || job.source_library || job.name;
}

// The verification verdict with expected Office/Outlook rewrites taken out.
// state: 'verified' | 'exceptions' | 'unverified'.
function effectiveVerification(verification) {
  if (!verification) return { state: 'unverified', problems: [], problemCount: 0, expectedRewrites: 0, confirmed: 0 };
  const listed = Array.isArray(verification.problems) ? verification.problems : [];
  const reclassified = listed.filter((p) => p.reason !== 'missing' && isOfficeFile(p.path));
  const problems = listed.filter((p) => !(p.reason !== 'missing' && isOfficeFile(p.path)));
  const rawCount = (verification.missing ?? 0) + (verification.sizeMismatch ?? 0) + (verification.hashMismatch ?? 0);
  const problemCount = Math.max(problems.length, rawCount - reclassified.length);
  const expectedRewrites = (verification.officeRewritten ?? 0) + reclassified.length;
  return {
    state: problemCount === 0 ? 'verified' : 'exceptions',
    problems,
    problemCount,
    expectedRewrites,
    reclassified: reclassified.length,
    identical: verification.identical ?? 0,
    confirmed: (verification.identical ?? 0) + expectedRewrites,
    sourceFiles: verification.sourceFiles ?? 0,
    targetFiles: verification.targetFiles ?? 0,
    truncated: !!verification.problemsTruncated,
  };
}

const PROBLEM_LABEL = {
  missing: 'Not found at the destination',
  size: 'Size differs from the original',
  hash: 'Content differs from the original',
  failed: 'Could not be copied',
};

// Final state of one job, regardless of how many runs, resumes or retries it
// took: every file the job ever saw, deduplicated (job_items is unique per
// path), classified as at-destination or not.
function jobOutcome(db, job) {
  const rel = relativizer(job);
  const items = db.prepare(
    `SELECT source_path, target_path, status, size_bytes, attempt_count, duration_ms, error_message, item_type, last_run_seq, completed_at
     FROM job_items WHERE job_id = ? ORDER BY source_path`
  ).all(job.id).filter((i) => i.item_type !== 'folder');
  const verification = safeParse(job.verification_json);
  const ver = effectiveVerification(verification);
  const problemPaths = new Set(ver.problems.map((p) => p.path.toLowerCase()));

  const migrated = [];
  const notMigrated = [];
  for (const i of items) {
    const r = rel(i.source_path);
    const atDestination = i.status === 'success' || i.status === 'skipped'
      // A clean (effective) verification proves the copy landed even if the
      // copy step itself reported an error.
      || (i.status === 'failed' && ver.state === 'verified');
    if (atDestination && !problemPaths.has(r.toLowerCase())) {
      migrated.push({ path: r, size: i.size_bytes, item: i });
    } else if (i.status === 'failed') {
      notMigrated.push({ path: r, reason: 'failed', detail: i.error_message });
    } else if (i.status === 'pending' || i.status === 'retried') {
      notMigrated.push({ path: r, reason: 'failed', detail: 'Copy did not finish' });
    }
  }
  // Verification problems not already on the list (e.g. never itemised).
  const listed = new Set(notMigrated.map((n) => n.path.toLowerCase()));
  for (const p of ver.problems) {
    if (!listed.has(p.path.toLowerCase())) notMigrated.push({ path: p.path, reason: p.reason });
  }

  let bytes = migrated.reduce((s, f) => s + (f.size || 0), 0);
  // Rows from before sizes were captured on item_start have NULL size_bytes;
  // for a cleanly verified tree the enumeration total is the honest number.
  if (ver.state === 'verified' && job.total_bytes && bytes < job.total_bytes) bytes = job.total_bytes;

  const folders = new Set();
  for (const f of migrated) {
    const parts = f.path.split('/');
    for (let k = 1; k < parts.length; k++) folders.add(parts.slice(0, k).join('/').toLowerCase());
  }

  return { job, items, migrated, notMigrated, bytes, folderCount: folders.size, verification, ver };
}

function fileTypeBreakdown(files, top = 8) {
  const byExt = new Map();
  for (const f of files) {
    const e = extOf(f.path) || '(no extension)';
    const cur = byExt.get(e) || { ext: e, count: 0, bytes: 0 };
    cur.count++; cur.bytes += f.size || 0;
    byExt.set(e, cur);
  }
  const sorted = [...byExt.values()].sort((a, b) => b.count - a.count);
  if (sorted.length <= top) return sorted;
  const rest = sorted.slice(top - 1).reduce((acc, r) => ({ ext: 'Other', count: acc.count + r.count, bytes: acc.bytes + r.bytes }), { ext: 'Other', count: 0, bytes: 0 });
  return [...sorted.slice(0, top - 1), rest];
}

// Which jobs a client report covers. Explicit ids, or every completed job
// in scope. Several jobs for the same mapping (a job deleted and re-created,
// a second pass) collapse to the latest completed one - the client sees one
// line per migrated folder, in its final state.
function pickLatestPerMapping(jobs) {
  const byMapping = new Map();
  const rank = (j) => [j.status === 'completed' ? 1 : 0, parseDate(j.completed_at || j.created_at)?.getTime() || 0];
  for (const j of jobs) {
    const key = j.mapping_id || j.id;
    const cur = byMapping.get(key);
    if (!cur) { byMapping.set(key, j); continue; }
    const [a1, a2] = rank(j);
    const [b1, b2] = rank(cur);
    if (a1 > b1 || (a1 === b1 && a2 > b2)) byMapping.set(key, j);
  }
  return [...byMapping.values()];
}

// Where the folder actually landed: recovered from a stored item's target
// path minus its relative path, so it is exact whichever folder convention
// the engine used when the job ran.
function landedRoot(outcome) {
  for (const f of outcome.migrated) {
    const tp = String(f.item.target_path || '').replace(/\\/g, '/');
    if (tp && f.path && tp.toLowerCase().endsWith(`/${f.path.toLowerCase()}`)) return tp.slice(0, tp.length - f.path.length - 1);
  }
  return null;
}

function describeTarget(job, mapping, outcome) {
  const provider = job.target_provider || 'sharepoint';
  if (provider === 'azure_blob') return { kind: 'Azure Blob Storage', where: `${job.target_container}/${job.target_blob_prefix || ''}`.replace(/\/$/, '') };
  if (provider === 'onedrive') return { kind: 'OneDrive', where: `${job.target_onedrive_upn} › ${job.target_onedrive_path || ''}` };
  const site = mapping?.target_site_name || job.target_site_url;
  const root = outcome ? landedRoot(outcome) : null;
  let sitePath = '';
  let origin = '';
  try { const u = new URL(job.target_site_url); sitePath = u.pathname.replace(/\/$/, ''); origin = u.origin; } catch {}
  if (root && root.toLowerCase().startsWith(`${sitePath.toLowerCase()}/`)) {
    return { kind: 'SharePoint Online', where: `${site} › ${root.slice(sitePath.length + 1)}`, url: origin ? encodeURI(origin + root) : null };
  }
  return { kind: 'SharePoint Online', where: `${site} › ${job.target_library}${job.target_path ? `/${job.target_path}` : ''}`, url: job.target_site_url };
}
function describeSource(job, mapping) {
  if ((job.source_provider || 'sharepoint') === 'filesystem') return { kind: 'File share', where: job.source_path };
  const site = mapping?.source_site_name || job.source_site_url;
  return { kind: 'SharePoint Online', where: `${site} › ${job.source_library}${job.source_path ? `/${job.source_path}` : ''}` };
}

function buildClientData(db, jobs) {
  const getMapping = db.prepare('SELECT * FROM mappings WHERE id = ?');
  const folders = pickLatestPerMapping(jobs).map((job) => {
    const outcome = jobOutcome(db, job);
    const mapping = job.mapping_id ? getMapping.get(job.mapping_id) : null;
    return {
      ...outcome,
      name: folderName(job),
      source: describeSource(job, mapping),
      target: describeTarget(job, mapping, outcome),
      completedAt: job.completed_at,
      startedAt: job.started_at,
    };
  }).sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));

  const allFiles = folders.flatMap((f) => f.migrated);
  const starts = folders.map((f) => parseDate(f.startedAt)).filter(Boolean);
  const ends = folders.map((f) => parseDate(f.completedAt)).filter(Boolean);
  return {
    folders,
    totals: {
      folders: folders.length,
      files: allFiles.length,
      bytes: folders.reduce((s, f) => s + f.bytes, 0),
      subfolders: folders.reduce((s, f) => s + f.folderCount, 0),
      notMigrated: folders.reduce((s, f) => s + f.notMigrated.length, 0),
      verifiedFolders: folders.filter((f) => f.ver.state === 'verified').length,
      unverifiedFolders: folders.filter((f) => f.ver.state === 'unverified').length,
      expectedRewrites: folders.reduce((s, f) => s + f.ver.expectedRewrites, 0),
      from: starts.length ? new Date(Math.min(...starts)) : null,
      to: ends.length ? new Date(Math.max(...ends)) : null,
    },
    fileTypes: fileTypeBreakdown(allFiles),
  };
}

module.exports = {
  OFFICE_EXTENSIONS, PROBLEM_LABEL, isOfficeFile, extOf, safeParse,
  sourceRoot, relativizer, folderName, effectiveVerification, jobOutcome,
  fileTypeBreakdown, pickLatestPerMapping, buildClientData,
};
