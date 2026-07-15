const axios = require('axios');
const { getGraphToken } = require('../auth/msal');

const GRAPH_ROOT = 'https://graph.microsoft.com/v1.0';

async function graphRequest(req, method, urlPath, { params, body, headers } = {}) {
  const token = await getGraphToken(req);
  if (!token) {
    const err = new Error('No valid Graph token for signed-in user');
    err.status = 401;
    throw err;
  }
  try {
    const { data } = await axios.request({
      url: `${GRAPH_ROOT}${urlPath}`,
      method,
      headers: { Authorization: `Bearer ${token}`, ...headers },
      params,
      data: body,
    });
    return data;
  } catch (err) {
    if (err.response) {
      const e = new Error(err.response.data?.error?.message || err.message);
      e.status = err.response.status;
      e.graphError = err.response.data?.error;
      throw e;
    }
    throw err;
  }
}

// All SharePoint browsing uses the signed-in user's own delegated token, so
// the picker only ever shows sites/libraries/folders that user can already see.
// `headers` is optional - only the OneDrive user search needs it so far
// (Graph's $search on /users requires ConsistencyLevel: eventual).
function graphGet(req, urlPath, params = {}, headers) {
  return graphRequest(req, 'GET', urlPath, { params, headers });
}

function graphPost(req, urlPath, body) {
  return graphRequest(req, 'POST', urlPath, { body });
}

function graphDelete(req, urlPath) {
  return graphRequest(req, 'DELETE', urlPath, {});
}

module.exports = { graphGet, graphPost, graphDelete, GRAPH_ROOT };
