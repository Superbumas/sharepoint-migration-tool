// Maps a raw SQLite jobs row (snake_case columns) into the camelCase, nested
// shape the frontend expects (job.source.path, job.target.path, etc).
// Shared between the REST API and the orchestrator's Socket.IO broadcasts -
// those two paths sending different shapes for the "same" job was a real bug:
// the initial page load (REST) rendered fine, but the first live update
// (raw row, no nested source/target) crashed the page on job.source.path.
function safeParse(json) {
  if (!json) return null;
  try { return JSON.parse(json); } catch { return null; }
}

function mapJob(row) {
  if (!row) return row;
  return {
    id: row.id,
    mappingId: row.mapping_id,
    name: row.name,
    status: row.status,
    source: {
      type: row.source_type, provider: row.source_provider || 'sharepoint',
      siteUrl: row.source_site_url, library: row.source_library, path: row.source_path,
    },
    target: {
      type: row.target_type, siteUrl: row.target_site_url, library: row.target_library, path: row.target_path,
      provider: row.target_provider || 'sharepoint', container: row.target_container, blobPrefix: row.target_blob_prefix,
      onedriveUpn: row.target_onedrive_upn, onedrivePath: row.target_onedrive_path, onedriveHostUrl: row.target_onedrive_host_url,
    },
    action: row.action,
    concurrency: row.concurrency,
    totals: { items: row.total_items, bytes: row.total_bytes },
    progress: { itemsDone: row.items_done, bytesDone: row.bytes_done, itemsFailed: row.items_failed, itemsSkipped: row.items_skipped, retriesTotal: row.retries_total },
    pauseRequested: !!row.pause_requested,
    cancelRequested: !!row.cancel_requested,
    phase: safeParse(row.phase_json),
    errorMessage: row.error_message,
    verification: safeParse(row.verification_json),
    verifiedAt: row.verified_at,
    cleanup: safeParse(row.cleanup_json),
    cleanedAt: row.cleaned_at,
    createdBy: { name: row.created_by_name, email: row.created_by_email, upn: row.created_by_upn },
    createdAt: row.created_at,
    approvedBy: row.approved_by_name ? { name: row.approved_by_name, email: row.approved_by_email, at: row.approved_at } : null,
    startedAt: row.started_at,
    pausedAt: row.paused_at,
    completedAt: row.completed_at,
    deleted: !!row.deleted_at,
    deletedAt: row.deleted_at,
    deletedByName: row.deleted_by_name,
  };
}

module.exports = { mapJob };
