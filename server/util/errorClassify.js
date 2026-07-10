// Buckets a failed/retried item into one of the categories the KPI dashboard
// breaks errors down by. Order matters - checked most-specific first.
function classifyError(httpStatus, errorMessage) {
  const msg = (errorMessage || '').toLowerCase();
  const status = Number(httpStatus) || 0;

  if (status === 429 || status === 503 || msg.includes('throttl') || msg.includes('too many requests')) {
    return 'throttled';
  }
  if (status === 403 || status === 401 || msg.includes('access denied') || msg.includes('permission')) {
    return 'permission_denied';
  }
  if (msg.includes('too long') || msg.includes('path too long') || msg.includes('name is too long') || msg.includes('specified path, file name')) {
    return 'name_too_long';
  }
  if (status === 423 || msg.includes('locked') || msg.includes('checked out') || msg.includes('being used')) {
    return 'file_locked';
  }
  return 'other';
}

module.exports = { classifyError };
