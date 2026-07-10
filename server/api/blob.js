const express = require('express');
const { requireAuth, getTenantId } = require('../auth/middleware');
const { resolveBlobConnectionString } = require('../util/blobCredential');
const { listContainers } = require('../blob/client');

const router = express.Router();
router.use(requireAuth);

// Populates the container dropdown in BlobTargetPicker.jsx. A container may
// not exist yet - the engine creates it on first run (see
// engine/lib/BlobTarget.psm1's Confirm-BlobContainerExists) - so this list is
// a convenience, not a hard requirement; the UI also accepts a typed name.
router.get('/blob/containers', async (req, res, next) => {
  const connectionString = resolveBlobConnectionString(getTenantId(req));
  if (!connectionString) {
    return res.status(503).json({ error: 'blob_not_configured', message: 'No Azure Blob connection string is configured for this project - add one in Settings.' });
  }
  try {
    const items = await listContainers(connectionString);
    res.json({ items });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
