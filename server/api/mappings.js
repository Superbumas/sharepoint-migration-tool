const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const { v4: uuid } = require('uuid');
const { requireAuth, getActor, getTenantId, ownerScope } = require('../auth/middleware');
const { getDb } = require('../db');
const { ensureEngineSiteAccess } = require('../graph/siteAccess');
const { verifyUserHasDrive } = require('../graph/onedriveAccess');
const { fsSourceEnabled, isAllowedFsPath, normalizeFsPath } = require('../util/fsSource');
const config = require('../config');

const router = express.Router();
router.use(requireAuth);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// Only 'Migrate' is accepted for new mappings. The engine was always
// copy-only, so the old 'Migrate-selective'/'Archive' labels changed nothing
// and just invited wrong assumptions; the DB CHECK constraint still allows
// them so historical rows keep working.
const VALID_ACTIONS = new Set(['Migrate']);

function mapRow(row) {
  return {
    id: row.id,
    sourceType: row.source_type,
    sourceProvider: row.source_provider || 'sharepoint',
    sourceSiteUrl: row.source_site_url,
    sourceSiteName: row.source_site_name,
    sourceLibrary: row.source_library,
    sourcePath: row.source_path,
    targetType: row.target_type,
    targetProvider: row.target_provider || 'sharepoint',
    targetSiteUrl: row.target_site_url,
    targetSiteName: row.target_site_name,
    targetLibrary: row.target_library,
    targetPath: row.target_path,
    targetContainer: row.target_container,
    targetBlobPrefix: row.target_blob_prefix,
    targetOnedriveUpn: row.target_onedrive_upn,
    targetOnedrivePath: row.target_onedrive_path,
    targetOnedriveHostUrl: row.target_onedrive_host_url,
    action: row.action,
    confidence: row.confidence,
    origin: row.origin,
    crosswalkBatchId: row.crosswalk_batch_id,
    crosswalkRowRef: row.crosswalk_row_ref,
    notes: row.notes,
    group: row.group_name || null,
    createdByName: row.created_by_name,
    createdByEmail: row.created_by_email,
    ownerUserId: row.owner_user_id,
    createdAt: row.created_at,
  };
}

router.get('/mappings', (req, res) => {
  const db = getDb();
  const owner = ownerScope(req);
  const rows = db.prepare(`SELECT * FROM mappings WHERE tenant_id = ?${owner.sql} ORDER BY created_at DESC`)
    .all(getTenantId(req), ...owner.params);
  // Latest job per mapping (any status, including soft-deleted jobs - the
  // question "has this mapping been migrated?" doesn't reset when the job is
  // cleaned out of the queue view).
  const latestJobStmt = db.prepare(
    `SELECT id, status, items_done, items_failed, total_items, completed_at, verification_json
     FROM jobs WHERE mapping_id = ? ORDER BY created_at DESC LIMIT 1`
  );
  const items = rows.map((row) => {
    const job = latestJobStmt.get(row.id);
    let verificationOk = null;
    if (job?.verification_json) {
      try { verificationOk = !!JSON.parse(job.verification_json).ok; } catch {}
    }
    return {
      ...mapRow(row),
      latestJob: job
        ? {
            id: job.id,
            status: job.status,
            itemsDone: job.items_done,
            itemsFailed: job.items_failed,
            totalItems: job.total_items,
            completedAt: job.completed_at,
            verificationOk,
          }
        : null,
    };
  });
  res.json({ items });
});

// Downloadable starter workbook whose headers exactly match what the importer
// parses (see HEADER_ALIASES) - fill it in, save, and upload it back. Must be
// registered BEFORE /mappings/:id or that route captures the path with
// id="crosswalk-template" and returns not_found.
router.get('/mappings/crosswalk-template', (req, res) => {
  const rows = [
    {
      'Source Site': 'https://yourtenant.sharepoint.com/sites/OldSite',
      'Source Path': 'Shared Documents/Company Docs',
      'Target Site': 'https://yourtenant.sharepoint.com/sites/Hub',
      'Target Library': 'Shared Documents',
      'Target Folder': '',
      'Project': 'Teams consolidation',
      'Confidence': 'high',
    },
    {
      'Source Site': 'https://yourtenant.sharepoint.com/sites/OldSite',
      'Source Path': 'Shared Documents/Research/ANALYSIS',
      'Target Site': 'https://yourtenant.sharepoint.com/sites/Hub',
      'Target Library': 'Shared Documents',
      'Target Folder': 'Research',
      'Project': 'Teams consolidation',
      'Confidence': 'medium',
    },
  ];
  const instructions = [
    ['Field', 'Required', 'What to put in it'],
    ['Source Site', 'yes', 'Full URL of the site the folder is on now, e.g. https://yourtenant.sharepoint.com/sites/OldSite'],
    ['Source Path', 'yes', 'Library + folder path on the source site, e.g. "Shared Documents/Company Docs" (the first part is the library). The folder itself is recreated at the target.'],
    ['Target Site', 'yes', 'Full URL of the destination site, e.g. https://yourtenant.sharepoint.com/sites/Hub'],
    ['Target Library', 'yes', 'Destination document library, usually "Shared Documents"'],
    ['Target Folder', 'no', 'Folder inside the target library to put it in. Empty = the library root.'],
    ['Project', 'no', 'A name to group this row under on the Mappings page, e.g. "Teams consolidation". Empty = no project.'],
    ['Confidence', 'no', 'Free-text note on how sure the mapping is (high / medium / low) - shown in the mappings list'],
    [],
    ['Delete the example rows before importing. Extra columns are ignored.'],
    ['The migration engine is granted access to each site automatically when the job runs.'],
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Crosswalk');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(instructions), 'Instructions');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename="Migration_Crosswalk_Template.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

router.get('/mappings/:id', (req, res) => {
  const db = getDb();
  const owner = ownerScope(req);
  const row = db.prepare(`SELECT * FROM mappings WHERE id = ? AND tenant_id = ?${owner.sql}`)
    .get(req.params.id, getTenantId(req), ...owner.params);
  if (!row) return res.status(404).json({ error: 'not_found' });
  res.json(mapRow(row));
});

// The mapping's group ("project" in the UI): trimmed free text, '' -> none.
function cleanGroup(value) {
  const name = String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
  return name || null;
}

const VALID_TARGET_PROVIDERS = new Set(['sharepoint', 'azure_blob', 'onedrive']);
const VALID_SOURCE_PROVIDERS = new Set(['sharepoint', 'filesystem']);

// Manual picker save: source + target (folder or file) chosen by hand in the UI.
// Wrapped so a rejection (Graph error in the OneDrive check, a DB constraint)
// reaches the error handler: Express 4 does not catch async handlers, and an
// unhandled promise rejection terminates the Node process.
router.post('/mappings', (req, res, next) => {
  createMapping(req, res).catch(next);
});

async function createMapping(req, res) {
  const result = await insertMapping(req, req.body || {}, new Map());
  if (result.error) return res.status(result.error.status).json(result.error.body);
  const grantResults = await ensureSites(req, result.sites);
  res.status(201).json({ ...mapRow(getDb().prepare('SELECT * FROM mappings WHERE id = ?').get(result.id)), engineAccess: grantResults });
}

// Many mappings in one request - the "add many sites" builder and Duplicate
// use this. Each row is validated exactly like a single save; a bad row is
// reported and the rest still go in. Engine access is ensured once per
// distinct site afterwards, not once per row: forty rows into one hub used
// to mean forty identical grant checks against the same target site.
const BULK_LIMIT = 500;
router.post('/mappings/bulk', (req, res, next) => {
  (async () => {
    const items = req.body?.items;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'items array is required' });
    }
    if (items.length > BULK_LIMIT) {
      return res.status(400).json({ error: 'too_many', message: `At most ${BULK_LIMIT} mappings can be added at once.` });
    }
    const driveChecks = new Map();
    const createdIds = [];
    const failed = [];
    const sites = [];
    for (let i = 0; i < items.length; i += 1) {
      const result = await insertMapping(req, items[i] || {}, driveChecks);
      if (result.error) {
        failed.push({ index: i, message: result.error.body.message || result.error.body.error });
      } else {
        createdIds.push(result.id);
        sites.push(...result.sites);
      }
    }
    const engineAccess = await ensureSites(req, sites);
    const db = getDb();
    const get = db.prepare('SELECT * FROM mappings WHERE id = ?');
    res.status(201).json({ items: createdIds.map((id) => mapRow(get.get(id))), failed, engineAccess });
  })().catch(next);
});

// Auto-grant: ensure the engine has fullcontrol on every site involved the
// moment a mapping is saved, using the signed-in admin's own token - the
// manual "Grant migration engine access" button still exists as a status
// display/fallback, but saving a mapping is enough by itself. Failures don't
// block the save (the mapping is already valid); they're reported so the UI
// can surface them.
//
// Also attempted for onedrive (the derived personal site) even though the
// engine's actual reads/writes there go through Graph's Files.ReadWrite.All,
// never this grant - Connect-PnPOnline still needs its SharePoint-audience
// handshake to succeed to mint that connection at all for a filesystem
// source (see 015_onedrive_target.sql). If Sites.Selected on personal
// sites turns out not to be needed (or not to work) in a given tenant,
// this failing here is harmless - it's a best-effort belt-and-braces
// attempt, not a requirement the onedrive target depends on.
async function ensureSites(req, siteUrls) {
  const results = [];
  const seen = new Set();
  for (const siteUrl of siteUrls.filter(Boolean)) {
    const key = siteUrl.toLowerCase().replace(/\/+$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      results.push(await ensureEngineSiteAccess(req, siteUrl));
    } catch (err) {
      results.push({ siteUrl, ok: false, error: err.message });
    }
  }
  return results;
}

// Validates one mapping body and inserts it. Returns { id, sites } (the sites
// the engine needs access to) or { error: { status, body } }. driveChecks
// caches the OneDrive lookup per UPN across one bulk request.
async function insertMapping(req, b, driveChecks) {
  const fail = (status, body) => ({ error: { status, body } });
  // '' is a legitimate path - it means "the root of the library" (e.g. picking
  // a document library that has no subfolders yet, like a freshly created Hub
  // site). Only reject when the field is genuinely absent (null/undefined),
  // not when the picker deliberately sent an empty relative path.
  if (b.sourcePath == null) {
    return fail(400, { error: 'sourcePath is required' });
  }
  const sourceProvider = b.sourceProvider || 'sharepoint';
  if (!VALID_SOURCE_PROVIDERS.has(sourceProvider)) {
    return fail(400, { error: `sourceProvider must be one of ${[...VALID_SOURCE_PROVIDERS].join(', ')}` });
  }
  const targetProvider = b.targetProvider || 'sharepoint';
  if (!VALID_TARGET_PROVIDERS.has(targetProvider)) {
    return fail(400, { error: `targetProvider must be one of ${[...VALID_TARGET_PROVIDERS].join(', ')}` });
  }
  if (sourceProvider === 'filesystem') {
    if (!fsSourceEnabled(getTenantId(req))) {
      return fail(409, { error: 'fs_source_disabled', message: 'No file-share roots are configured - add them on the Settings page.' });
    }
    // A file-share source's sourcePath is the absolute directory itself -
    // '' has no "library root" meaning here, and every path must stay inside
    // this project's allowlist (same check the browse API and the
    // orchestrator's pre-spawn guard apply).
    if (!String(b.sourcePath).trim()) {
      return fail(400, { error: 'sourcePath (the share directory) is required for a file-share source' });
    }
    if (!isAllowedFsPath(b.sourcePath, getTenantId(req))) {
      return fail(403, { error: 'path_not_allowed', message: 'That path is outside this project\'s allowed file-share roots (see Settings).' });
    }
    if (targetProvider !== 'sharepoint' && targetProvider !== 'onedrive') {
      return fail(400, { error: 'A file-share source can only migrate into SharePoint or a OneDrive.' });
    }
  }
  if (targetProvider === 'azure_blob' && !b.targetContainer) {
    return fail(400, { error: 'targetContainer is required when targetProvider is azure_blob' });
  }
  if (targetProvider === 'sharepoint' && b.targetPath == null) {
    return fail(400, { error: 'targetPath is required' });
  }
  let onedriveHostUrl = null;
  if (targetProvider === 'onedrive') {
    if (!config.onedriveTargetEnabled) {
      return fail(409, { error: 'onedrive_target_disabled', message: 'The OneDrive target is not enabled on this server - see ENGINE_ONEDRIVE_TARGET_ENABLED in .env.' });
    }
    if (!b.targetOnedriveUpn) {
      return fail(400, { error: 'targetOnedriveUpn is required when targetProvider is onedrive' });
    }
    // Save-time sanity check so a typo'd UPN or an unlicensed user is caught
    // here, not hours into a job run. Also resolves the real SharePoint URL
    // for this user's OneDrive host (see server/graph/onedriveAccess.js) -
    // stored so a filesystem-source job has something to hand
    // Connect-PnPOnline for its Graph token (it has no SharePoint site of
    // its own to connect to otherwise).
    const upnKey = String(b.targetOnedriveUpn).toLowerCase();
    if (!driveChecks.has(upnKey)) driveChecks.set(upnKey, await verifyUserHasDrive(req, b.targetOnedriveUpn));
    const driveCheck = driveChecks.get(upnKey);
    if (!driveCheck.ok) {
      return fail(400, { error: 'onedrive_not_found', message: driveCheck.error });
    }
    onedriveHostUrl = driveCheck.hostUrl;
  }
  if (b.action && !VALID_ACTIONS.has(b.action)) {
    return fail(400, { error: `action must be one of ${[...VALID_ACTIONS].join(', ')}` });
  }
  const actor = getActor(req);
  const db = getDb();
  const id = uuid();
  // target_path stays NOT NULL for every row (a full SQLite table rebuild
  // would be needed to relax it) - azure_blob/onedrive rows write their own
  // path field into it too, purely to satisfy that legacy constraint. All
  // blob/onedrive code reads target_blob_prefix/target_onedrive_path, never
  // target_path.
  const targetPath = targetProvider === 'azure_blob' ? (b.targetBlobPrefix || '')
    : targetProvider === 'onedrive' ? (b.targetOnedrivePath || '')
    : b.targetPath;
  db.prepare(
    `INSERT INTO mappings (
      id, tenant_id, owner_user_id, source_type, source_provider, source_site_url, source_site_name, source_library, source_path,
      target_type, target_site_url, target_site_name, target_library, target_path,
      target_provider, target_container, target_blob_prefix, target_onedrive_upn, target_onedrive_path, target_onedrive_host_url,
      action, confidence, origin, notes, group_name, created_by_name, created_by_email
    ) VALUES (
      @id, @tenantId, @ownerUserId, @sourceType, @sourceProvider, @sourceSiteUrl, @sourceSiteName, @sourceLibrary, @sourcePath,
      @targetType, @targetSiteUrl, @targetSiteName, @targetLibrary, @targetPath,
      @targetProvider, @targetContainer, @targetBlobPrefix, @targetOnedriveUpn, @targetOnedrivePath, @targetOnedriveHostUrl,
      @action, @confidence, 'manual', @notes, @groupName, @createdByName, @createdByEmail
    )`
  ).run({
    id,
    tenantId: getTenantId(req),
    ownerUserId: actor.id,
    sourceType: b.sourceType || 'folder',
    sourceProvider,
    sourceSiteUrl: sourceProvider === 'filesystem' ? null : (b.sourceSiteUrl || null),
    sourceSiteName: sourceProvider === 'filesystem' ? null : (b.sourceSiteName || null),
    sourceLibrary: sourceProvider === 'filesystem' ? null : (b.sourceLibrary || null),
    sourcePath: sourceProvider === 'filesystem' ? normalizeFsPath(b.sourcePath) : b.sourcePath,
    targetType: b.targetType || 'folder',
    targetSiteUrl: (targetProvider === 'azure_blob' || targetProvider === 'onedrive') ? null : (b.targetSiteUrl || null),
    targetSiteName: (targetProvider === 'azure_blob' || targetProvider === 'onedrive') ? null : (b.targetSiteName || null),
    targetLibrary: (targetProvider === 'azure_blob' || targetProvider === 'onedrive') ? null : (b.targetLibrary || null),
    targetPath,
    targetProvider,
    targetContainer: targetProvider === 'azure_blob' ? b.targetContainer : null,
    targetBlobPrefix: targetProvider === 'azure_blob' ? (b.targetBlobPrefix || '') : null,
    targetOnedriveUpn: targetProvider === 'onedrive' ? b.targetOnedriveUpn : null,
    targetOnedrivePath: targetProvider === 'onedrive' ? (b.targetOnedrivePath || '') : null,
    targetOnedriveHostUrl: targetProvider === 'onedrive' ? onedriveHostUrl : null,
    action: b.action || 'Migrate',
    confidence: b.confidence || null,
    notes: b.notes || null,
    groupName: cleanGroup(b.group),
    createdByName: actor.name,
    createdByEmail: actor.email,
  });
  return {
    id,
    sites: [
      b.sourceSiteUrl,
      targetProvider === 'sharepoint' ? b.targetSiteUrl : null,
      targetProvider === 'onedrive' ? onedriveHostUrl : null,
    ].filter(Boolean),
  };
}

// Characters SharePoint refuses in a folder name (same set the picker's
// "New folder" uses, minus the slash, which separates segments here).
const ILLEGAL_SEGMENT_CHARS = /["*:<>?|]/;

// 'Teams\\Finance/ ' -> 'Teams/Finance'. Returns null when a segment is not
// a name SharePoint would accept, so a typo is caught at edit time and not as
// a failed job.
function cleanTargetPath(value) {
  const segments = String(value ?? '').split(/[\\/]+/).map((seg) => seg.trim()).filter(Boolean);
  for (const seg of segments) {
    if (ILLEGAL_SEGMENT_CHARS.test(seg) || seg.endsWith('.') || seg.length > 255) return null;
  }
  return segments.join('/');
}

// Edits to saved mappings: the target (site, library, folder) and the notes.
// The target is only editable while the mapping has no job - once something
// has been copied, changing where the mapping points would make its history
// and its "migrated" badge describe a different place. Notes and the group
// can always change. Returns the sites that now need engine access, or an error.
function applyMappingUpdate(req, id, b) {
  const db = getDb();
  const owner = ownerScope(req);
  const row = db.prepare(`SELECT * FROM mappings WHERE id = ? AND tenant_id = ?${owner.sql}`)
    .get(id, getTenantId(req), ...owner.params);
  if (!row) return { error: { status: 404, body: { error: 'not_found' } } };
  const touchesTarget = ['targetSiteUrl', 'targetSiteName', 'targetLibrary', 'targetPath'].some((k) => b[k] !== undefined);
  const next = {
    id: row.id,
    targetSiteUrl: row.target_site_url,
    targetSiteName: row.target_site_name,
    targetLibrary: row.target_library,
    targetPath: row.target_path,
    notes: b.notes !== undefined ? (String(b.notes || '').trim() || null) : row.notes,
    groupName: b.group !== undefined ? cleanGroup(b.group) : row.group_name,
  };
  if (touchesTarget) {
    if ((row.target_provider || 'sharepoint') !== 'sharepoint') {
      return { error: { status: 400, body: { error: 'not_editable', message: 'Only a SharePoint target can be edited here.' } } };
    }
    const inUse = db.prepare('SELECT COUNT(*) AS n FROM jobs WHERE mapping_id = ?').get(row.id);
    if (inUse.n > 0) {
      return { error: { status: 409, body: { error: 'mapping_has_jobs', message: 'This mapping already has a job, so its target can no longer be changed. Duplicate it and edit the copy.' } } };
    }
    if (b.targetSiteUrl !== undefined) {
      const url = String(b.targetSiteUrl || '').trim();
      if (!/^https:\/\//i.test(url)) return { error: { status: 400, body: { error: 'invalid_site', message: 'The target site must be a full https:// site URL.' } } };
      next.targetSiteUrl = url;
      // A new site without a new name would keep showing the old site's name.
      next.targetSiteName = b.targetSiteName ? String(b.targetSiteName) : null;
    } else if (b.targetSiteName !== undefined) {
      next.targetSiteName = b.targetSiteName ? String(b.targetSiteName) : null;
    }
    if (b.targetLibrary !== undefined) {
      const lib = String(b.targetLibrary || '').trim().replace(/^\/+|\/+$/g, '');
      if (!lib) return { error: { status: 400, body: { error: 'invalid_library', message: 'The target library is required.' } } };
      next.targetLibrary = lib;
    }
    if (b.targetPath !== undefined) {
      const cleaned = cleanTargetPath(b.targetPath);
      if (cleaned === null) {
        return { error: { status: 400, body: { error: 'invalid_path', message: 'Folder names can\'t contain " * : < > ? | or end with a full stop.' } } };
      }
      next.targetPath = cleaned;
    }
  }
  db.prepare(
    `UPDATE mappings SET target_site_url = @targetSiteUrl, target_site_name = @targetSiteName,
       target_library = @targetLibrary, target_path = @targetPath, notes = @notes, group_name = @groupName WHERE id = @id`
  ).run(next);
  return { id: row.id, sites: b.targetSiteUrl !== undefined ? [next.targetSiteUrl] : [] };
}

router.patch('/mappings/:id', (req, res, next) => {
  (async () => {
    const result = applyMappingUpdate(req, req.params.id, req.body || {});
    if (result.error) return res.status(result.error.status).json(result.error.body);
    const engineAccess = await ensureSites(req, result.sites);
    res.json({ ...mapRow(getDb().prepare('SELECT * FROM mappings WHERE id = ?').get(result.id)), engineAccess });
  })().catch(next);
});

// The same edit applied to many rows (find and replace, "move selected to
// this folder"). Each row succeeds or fails on its own; engine access for a
// changed target site is ensured once at the end.
router.post('/mappings/bulk-update', (req, res, next) => {
  (async () => {
    const updates = req.body?.updates;
    if (!Array.isArray(updates) || updates.length === 0) {
      return res.status(400).json({ error: 'updates array is required' });
    }
    if (updates.length > BULK_LIMIT) {
      return res.status(400).json({ error: 'too_many', message: `At most ${BULK_LIMIT} mappings can be changed at once.` });
    }
    const updatedIds = [];
    const failed = [];
    const sites = [];
    for (const u of updates) {
      const result = applyMappingUpdate(req, u?.id, u || {});
      if (result.error) failed.push({ id: u?.id, message: result.error.body.message || result.error.body.error });
      else { updatedIds.push(result.id); sites.push(...result.sites); }
    }
    const engineAccess = await ensureSites(req, sites);
    res.json({ updatedCount: updatedIds.length, failed, engineAccess });
  })().catch(next);
});

// Deletes every listed mapping that has no jobs; the ones that do are left
// alone and counted, same rule as the single delete below.
router.post('/mappings/bulk-delete', (req, res) => {
  const ids = req.body?.ids;
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids array is required' });
  const db = getDb();
  const owner = ownerScope(req);
  const find = db.prepare(`SELECT id FROM mappings WHERE id = ? AND tenant_id = ?${owner.sql}`);
  const countJobs = db.prepare('SELECT COUNT(*) AS n FROM jobs WHERE mapping_id = ?');
  const del = db.prepare('DELETE FROM mappings WHERE id = ?');
  let deleted = 0;
  let skippedInUse = 0;
  db.transaction(() => {
    for (const id of ids) {
      const mapping = find.get(id, getTenantId(req), ...owner.params);
      if (!mapping) continue;
      if (countJobs.get(mapping.id).n > 0) { skippedInUse += 1; continue; }
      del.run(mapping.id);
      deleted += 1;
    }
  })();
  res.json({ deleted, skippedInUse });
});

router.delete('/mappings/:id', (req, res) => {
  const db = getDb();
  const owner = ownerScope(req);
  const mapping = db.prepare(`SELECT id FROM mappings WHERE id = ? AND tenant_id = ?${owner.sql}`)
    .get(req.params.id, getTenantId(req), ...owner.params);
  if (!mapping) return res.status(404).json({ error: 'not_found' });
  const inUse = db.prepare('SELECT COUNT(*) AS n FROM jobs WHERE mapping_id = ?').get(mapping.id);
  if (inUse.n > 0) {
    return res.status(409).json({ error: 'mapping_has_jobs', message: 'This mapping already has jobs created from it and cannot be deleted.' });
  }
  db.prepare('DELETE FROM mappings WHERE id = ?').run(mapping.id);
  res.status(204).end();
});

const HEADER_ALIASES = {
  sourceSite: ['source site', 'sourcesite', 'source site url'],
  sourceLibrary: ['source library', 'source document library'],
  targetFolder: ['target folder', 'target path', 'targetpath'],
  sourcePath: ['source path', 'source folder', 'source', 'sourcepath'],
  targetSite: ['target site', 'targetsite', 'target site url', 'site'],
  targetLibrary: ['target library', 'library', 'target document library'],
  action: ['action', 'action type'],
  confidence: ['confidence', 'confidence level', 'match confidence'],
  group: ['project', 'group', 'workstream'],
};

function normalizeHeader(h) {
  return String(h || '').trim().toLowerCase();
}

function findField(rowNormalized, aliases) {
  for (const alias of aliases) {
    if (alias in rowNormalized) return rowNormalized[alias];
  }
  return undefined;
}

// Bulk import from the Master_Migration_Crosswalk.xlsx "Crosswalk" tab (or the
// first sheet if that tab isn't found). This is a convenience path into the same
// mappings table the manual picker writes to - not a separate mechanism.
router.post('/mappings/import', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file is required (multipart field "file")' });

  let workbook;
  try {
    workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
  } catch (err) {
    return res.status(400).json({ error: 'invalid_workbook', message: err.message });
  }

  const sheetName =
    workbook.SheetNames.find((n) => n.trim().toLowerCase() === 'crosswalk') || workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

  const actor = getActor(req);
  const tenantId = getTenantId(req);
  const db = getDb();
  const batchId = uuid();
  const insert = db.prepare(
    `INSERT INTO mappings (
      id, tenant_id, owner_user_id, source_type, source_site_url, source_library, source_path, target_type, target_site_url, target_library, target_path,
      action, confidence, origin, crosswalk_batch_id, crosswalk_row_ref, notes, group_name, created_by_name, created_by_email
    ) VALUES (
      @id, @tenantId, @ownerUserId, 'folder', @sourceSiteUrl, @sourceLibrary, @sourcePath, 'folder', @targetSiteUrl, @targetLibrary, @targetPath,
      @action, @confidence, 'crosswalk', @batchId, @rowRef, @notes, @groupName, @createdByName, @createdByEmail
    )`
  );

  const imported = [];
  const skipped = [];

  const insertMany = db.transaction((rows) => {
    rows.forEach((raw, idx) => {
      const normalized = {};
      for (const key of Object.keys(raw)) normalized[normalizeHeader(key)] = raw[key];

      const sourcePath = findField(normalized, HEADER_ALIASES.sourcePath);
      const targetSiteUrl = findField(normalized, HEADER_ALIASES.targetSite);
      const targetLibrary = findField(normalized, HEADER_ALIASES.targetLibrary);
      let action = findField(normalized, HEADER_ALIASES.action);
      const confidence = findField(normalized, HEADER_ALIASES.confidence);

      const rowRef = `row ${idx + 2}`; // +2: header row + 1-indexing

      if (!sourcePath || !String(sourcePath).trim()) {
        skipped.push({ rowRef, reason: 'missing source path' });
        return;
      }
      if (!targetLibrary) {
        skipped.push({ rowRef, reason: 'missing target library' });
        return;
      }
      // Rows used to be imported with no source site and no source library
      // (and the target library repeated as the target folder), so every
      // job made from them failed at preflight or landed one folder too deep.
      const sourceSiteUrl = String(findField(normalized, HEADER_ALIASES.sourceSite) || '').trim();
      if (!/^https:\/\//i.test(sourceSiteUrl)) {
        skipped.push({ rowRef, reason: 'missing or invalid Source Site URL' });
        return;
      }
      if (!targetSiteUrl || !/^https:\/\//i.test(String(targetSiteUrl).trim())) {
        skipped.push({ rowRef, reason: 'missing or invalid Target Site URL' });
        return;
      }
      // Source Library column, or else the first segment of Source Path.
      const cleanPath = String(sourcePath).trim().replace(/^\/+|\/+$/g, '');
      let sourceLibrary = String(findField(normalized, HEADER_ALIASES.sourceLibrary) || '').trim().replace(/^\/+|\/+$/g, '');
      let sourcePathInLib = cleanPath;
      if (sourceLibrary) {
        if (cleanPath.toLowerCase().startsWith(`${sourceLibrary.toLowerCase()}/`)) sourcePathInLib = cleanPath.slice(sourceLibrary.length + 1);
      } else {
        const slash = cleanPath.indexOf('/');
        sourceLibrary = slash > 0 ? cleanPath.slice(0, slash) : cleanPath;
        sourcePathInLib = slash > 0 ? cleanPath.slice(slash + 1) : '';
      }
      const targetFolder = String(findField(normalized, HEADER_ALIASES.targetFolder) || '').trim().replace(/^\/+|\/+$/g, '');
      // The crosswalk's Action column may still say Migrate-selective/Archive;
      // the engine copies identically regardless, so normalize to 'Migrate'
      // and preserve the original label for audit in notes.
      const originalAction = action ? String(action).trim() : '';
      action = 'Migrate';

      const id = uuid();
      insert.run({
        id,
        tenantId,
        ownerUserId: actor.id,
        sourceSiteUrl,
        sourceLibrary,
        sourcePath: sourcePathInLib,
        targetSiteUrl: String(targetSiteUrl).trim(),
        targetLibrary: String(targetLibrary).trim(),
        targetPath: targetFolder,
        action,
        confidence: confidence ? String(confidence).trim() : null,
        notes: originalAction && originalAction !== 'Migrate' ? `Crosswalk action: ${originalAction}` : null,
        groupName: cleanGroup(findField(normalized, HEADER_ALIASES.group)),
        batchId,
        rowRef,
        createdByName: actor.name,
        createdByEmail: actor.email,
      });
      imported.push(id);
    });
  });

  insertMany(rawRows);

  res.status(201).json({
    batchId,
    sheetUsed: sheetName,
    totalRows: rawRows.length,
    importedCount: imported.length,
    skippedCount: skipped.length,
    skipped,
  });
});

module.exports = router;
