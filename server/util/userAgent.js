// Decorates every outbound axios request the server makes (Graph, SharePoint
// REST, Azure Blob) with the same User-Agent as the PowerShell engine
// (engine/lib/UserAgent.psm1). Microsoft prioritises decorated traffic when a
// tenant is being throttled. Required once, at startup, before any request.
const axios = require('axios');
const { version } = require('../../package.json');

const MIGRATION_USER_AGENT = `NONISV|Knowall|SharePointMigrationTool/${version}`;
axios.defaults.headers.common['User-Agent'] = MIGRATION_USER_AGENT;

module.exports = { MIGRATION_USER_AGENT };
