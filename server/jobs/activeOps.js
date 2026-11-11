// Which background engine run (verify / preflight / cleanup / purge) is
// active for a job right now, kept in its own module so mapJob can read it
// without requiring the orchestrator (which requires mapJob). The job page
// uses it to hide actions that depend on the stored verification while a
// new one is running - from the moment it starts, not only once the engine
// reports its first progress phase.
const ops = new Map(); // jobId -> 'verify' | 'preflight' | 'cleanup' | 'purge'

module.exports = {
  set: (jobId, op) => ops.set(jobId, op),
  clear: (jobId) => ops.delete(jobId),
  get: (jobId) => ops.get(jobId) || null,
};
