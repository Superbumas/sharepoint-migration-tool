// Non-secret analysis of an Azure Storage connection string, safe to send to
// the UI: which form it is (Access-Keys vs portal SAS), the account name, and
// - for the SAS form - its baked-in expiry and permissions. Never includes
// keys, signatures, or the string itself.
function analyzeBlobConnectionString(connectionString) {
  if (!connectionString) return null;
  const parts = {};
  for (const pair of connectionString.split(';')) {
    const idx = pair.indexOf('=');
    if (idx > 0) parts[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
  }

  const accountName = parts.AccountName
    || (parts.BlobEndpoint ? (parts.BlobEndpoint.match(/https?:\/\/([^.]+)\./)?.[1] ?? null) : null);

  if (parts.SharedAccessSignature) {
    const sas = parts.SharedAccessSignature;
    const q = Object.fromEntries(
      sas.replace(/^\?/, '').split('&').map((p) => {
        const i = p.indexOf('=');
        return i > 0 ? [p.slice(0, i), decodeURIComponent(p.slice(i + 1))] : [p, ''];
      })
    );
    let expiresAt = null;
    if (q.se) {
      const d = new Date(q.se);
      if (!isNaN(d)) expiresAt = d.toISOString();
    }
    return {
      form: 'sas',
      accountName,
      sasExpiresAt: expiresAt,
      sasPermissions: q.sp || null,
      sasExpired: expiresAt ? new Date(expiresAt) <= new Date() : null,
    };
  }
  if (parts.AccountName && parts.AccountKey) {
    return { form: 'account_key', accountName, sasExpiresAt: null, sasPermissions: null, sasExpired: null };
  }
  return { form: 'unknown', accountName, sasExpiresAt: null, sasPermissions: null, sasExpired: null };
}

module.exports = { analyzeBlobConnectionString };
