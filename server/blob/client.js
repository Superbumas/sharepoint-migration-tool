const axios = require('axios');
const crypto = require('crypto');

const API_VERSION = '2019-12-12';

// Parses 'Key=Value;Key=Value;...' - either an account-key connection string
// (AccountName/AccountKey, from the Portal's "Access keys" blade) or a SAS
// connection string (BlobEndpoint/.../SharedAccessSignature, from the
// Portal's "Shared access signature" blade) - same two formats
// engine/lib/BlobTarget.psm1's ConvertFrom-BlobConnectionString parses on
// the PowerShell side.
function parseConnectionString(connectionString) {
  const parts = {};
  for (const pair of connectionString.split(';')) {
    if (!pair.trim()) continue;
    const idx = pair.indexOf('=');
    if (idx < 1) continue;
    parts[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
  }
  const protocol = parts.DefaultEndpointsProtocol || 'https';
  const endpointSuffix = parts.EndpointSuffix || 'core.windows.net';
  const blobEndpoint = parts.BlobEndpoint
    ? parts.BlobEndpoint.replace(/\/+$/, '')
    : parts.AccountName
      ? `${protocol}://${parts.AccountName}.blob.${endpointSuffix}`
      : null;

  if (parts.SharedAccessSignature) {
    if (!blobEndpoint) throw new Error('Azure Blob SAS connection string is missing BlobEndpoint.');
    return { accountName: parts.AccountName || null, accountKey: null, blobEndpoint, sas: parts.SharedAccessSignature };
  }
  if (!parts.AccountName || !parts.AccountKey) {
    throw new Error('Azure Blob connection string must contain either AccountName+AccountKey or a SharedAccessSignature.');
  }
  return { accountName: parts.AccountName, accountKey: parts.AccountKey, blobEndpoint, sas: null };
}

// Shared Key (full) authorization for the small, fixed set of account-level
// read operations this module needs (just List Containers today) - built
// with Node's own crypto module rather than a new npm dependency, mirroring
// the engine's no-new-dependency stance for its own Blob REST calls (see
// engine/lib/BlobTarget.psm1, which signs an Account SAS instead since it
// needs a bearer token good for many requests across worker threads).
function signRequest({ accountName, accountKey, method, path = '', query = {} }) {
  const date = new Date().toUTCString();
  const canonicalizedHeaders = `x-ms-date:${date}\nx-ms-version:${API_VERSION}\n`;
  let canonicalizedResource = `/${accountName}/${path}`;
  for (const key of Object.keys(query).sort()) {
    canonicalizedResource += `\n${key.toLowerCase()}:${query[key]}`;
  }
  // VERB, then 11 empty fields (Content-Encoding..Range - none apply to a
  // bodyless GET authorized via x-ms-date), then the canonicalized
  // headers/resource - see Microsoft's Shared Key authorization spec.
  const stringToSign = `${method}\n\n\n\n\n\n\n\n\n\n\n\n${canonicalizedHeaders}${canonicalizedResource}`;

  const signature = crypto
    .createHmac('sha256', Buffer.from(accountKey, 'base64'))
    .update(stringToSign, 'utf8')
    .digest('base64');

  return {
    'x-ms-date': date,
    'x-ms-version': API_VERSION,
    Authorization: `SharedKey ${accountName}:${signature}`,
  };
}

// Minimal XML pluck for the one field (<Name>) the List Containers response
// needs - not worth a new XML-parsing dependency for this.
function extractContainerNames(xml) {
  const names = [];
  const re = /<Container>[\s\S]*?<Name>([^<]+)<\/Name>/g;
  let match;
  while ((match = re.exec(xml))) names.push(match[1]);
  return names;
}

// List Containers is an account-level ("service") operation. With an
// account-key connection string it's Shared-Key signed here directly. A SAS
// connection string only works if the SAS itself was scoped with the
// service resource type (srt includes 's') - most container-scoped SAS
// tokens (srt=co, e.g. "container,object") are NOT, so this is attempted
// but expected to often fail with an authorization error; the UI's
// BlobTargetPicker already falls back to typing the container name by hand
// when this list is empty or errors.
async function listContainers(connectionString) {
  const { accountName, accountKey, blobEndpoint, sas } = parseConnectionString(connectionString);
  const query = { comp: 'list' };

  const url = `${blobEndpoint}/`;
  const requestOpts = { params: { ...query }, responseType: 'text', transformResponse: (raw) => raw };
  if (sas) {
    // Query-string SAS auth - append the token's own params rather than
    // signing anything ourselves.
    for (const pair of sas.split('&')) {
      const idx = pair.indexOf('=');
      if (idx < 1) continue;
      requestOpts.params[decodeURIComponent(pair.slice(0, idx))] = decodeURIComponent(pair.slice(idx + 1));
    }
  } else {
    requestOpts.headers = signRequest({ accountName, accountKey, method: 'GET', path: '', query });
  }

  try {
    const { data } = await axios.get(url, requestOpts);
    return extractContainerNames(data);
  } catch (err) {
    if (sas && err.response?.status === 403) {
      const e = new Error('This server\'s Azure Blob SAS token is not scoped to list containers at the account level (needs "srt=...s..."). Type the container name directly instead.');
      e.status = 403;
      throw e;
    }
    throw err;
  }
}

module.exports = { listContainers };
