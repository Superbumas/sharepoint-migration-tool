const path = require('node:path');
const fs = require('node:fs');
const express = require('express');
const session = require('express-session');
const http = require('node:http');
const { Server } = require('socket.io');

const config = require('./config');
const { getDb } = require('./db');
const authRoutes = require('./auth/routes');
const sharepointRoutes = require('./api/sharepoint');
const mappingsRoutes = require('./api/mappings');
const jobsRoutes = require('./api/jobs');
const kpisRoutes = require('./api/kpis');
const exportRoutes = require('./api/export');
const reportRoutes = require('./api/report');
const settingsRoutes = require('./api/settings');
const blobRoutes = require('./api/blob');
const projectsRoutes = require('./api/projects');
const filesystemRoutes = require('./api/filesystem');
const onedriveRoutes = require('./api/onedrive');
const permissionsRoutes = require('./api/permissions');
const orchestrator = require('./jobs/orchestrator');

// Ensure the DB (and its migrations) are applied before anything else touches it.
getDb();

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json({ limit: '5mb' }));
// Named so the same middleware instance can also gate the Socket.IO
// handshake below (io.engine.use) - without this, a raw socket.io
// connection never touches req.session at all (see the connection handler
// further down for what that used to allow).
const sessionMiddleware = session({
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: false, maxAge: 8 * 60 * 60 * 1000 },
});
app.use(sessionMiddleware);

app.use(authRoutes);
app.use('/api', sharepointRoutes);
app.use('/api', mappingsRoutes);
app.use('/api', jobsRoutes);
app.use('/api', kpisRoutes);
app.use('/api', exportRoutes);
app.use('/api', reportRoutes);
app.use('/api', settingsRoutes);
app.use('/api', blobRoutes);
app.use('/api', projectsRoutes);
app.use('/api', filesystemRoutes);
app.use('/api', onedriveRoutes);
app.use('/api', permissionsRoutes);

// Production: the same Node server hosts the built React SPA (per architecture -
// this is one app, not two). In dev, Vite's own dev server handles / and proxies
// /api, /auth, /socket.io back here (see web/vite.config.js).
const webDist = path.join(__dirname, '..', 'web', 'dist');
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get(/^(?!\/api|\/auth|\/socket\.io).*/, (req, res) => {
    res.sendFile(path.join(webDist, 'index.html'));
  });
} else {
  // Fresh clone, server started without building the SPA first (web/dist is
  // build output and never committed). Express's bare "Cannot GET /" told
  // people nothing - say exactly what to do instead.
  app.get(/^(?!\/api|\/auth|\/socket\.io).*/, (req, res) => {
    res.status(503).send(
      '<body style="font-family:system-ui;max-width:40rem;margin:4rem auto;line-height:1.6">' +
      '<h2>The web UI has not been built yet</h2>' +
      '<p>This server is running, but <code>web/dist</code> does not exist, so there is no UI to serve.</p>' +
      '<p>Either run the dev setup (UI on its own port with hot reload):</p>' +
      '<pre>npm run dev &nbsp;&nbsp;# then open http://localhost:5173</pre>' +
      '<p>or build the UI once and restart this server (UI served right here):</p>' +
      '<pre>npm run build\nnpm run start:server-only</pre>' +
      '</body>'
    );
  });
}

app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'internal_error' });
});

// Previously a raw socket.io connection never touched req.session at all -
// anyone who could reach the server, without ever signing in, could open a
// socket and receive every live job event across every tenant, and
// subscribe to any job:{uuid} by guessing it. Sharing the same session
// middleware here means the handshake sees exactly the same
// req.session.account/tenantId the REST API's requireAuth already checks.
io.engine.use(sessionMiddleware);
io.use((socket, next) => {
  const session = socket.request.session;
  if (session?.account && session?.tenantId && session?.projectId) return next();
  next(new Error('unauthorized'));
});

io.on('connection', (socket) => {
  const tenantId = socket.request.session.tenantId;
  // Server-derived from the authenticated session, never client-supplied -
  // a socket only ever joins its own tenant's dashboard room.
  socket.join(`dashboard:${tenantId}`);
  socket.on('job:subscribe', (jobId) => {
    // A job:{uuid} room is per-job, not per-tenant, so a guessed/foreign
    // UUID must be checked against this socket's own tenant before joining
    // - orchestrator.getJob is already tenant-aware for exactly this reason.
    if (orchestrator.getJob(jobId, tenantId)) socket.join(`job:${jobId}`);
  });
  socket.on('job:unsubscribe', (jobId) => socket.leave(`job:${jobId}`));
});

orchestrator.init(io);

const clog = require('./util/consoleLog');
server.listen(config.port, () => {
  clog.banner(`http://localhost:${config.port}`);
});
