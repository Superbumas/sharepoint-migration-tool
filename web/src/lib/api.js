async function request(method, path, body, isForm) {
  const opts = { method, credentials: 'include', headers: {} };
  if (body && !isForm) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  } else if (body && isForm) {
    opts.body = body; // FormData - browser sets the multipart boundary header itself
  }
  const res = await fetch(path, opts);
  if (res.status === 401) {
    const err = new Error('not_authenticated');
    err.status = 401;
    throw err;
  }
  if (!res.ok) {
    let message = `${method} ${path} failed with ${res.status}`;
    try {
      const data = await res.json();
      message = data.message || data.error || message;
    } catch {}
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  if (res.status === 204) return null;
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) return res.json();
  return res.text();
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body) => request('POST', path, body ?? {}),
  patch: (path, body) => request('PATCH', path, body ?? {}),
  del: (path) => request('DELETE', path),
  postForm: (path, formData) => request('POST', path, formData, true),
};
