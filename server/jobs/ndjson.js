const readline = require('node:readline');

// Wraps a child process's stdout in a line reader and JSON.parses each line as
// one engine event. A line that fails to parse is reported via onParseError
// rather than crashing the ingestion loop - a stray Write-Host from a module
// the engine depends on should not take down progress tracking for the job.
function attachNdjsonParser(stream, onEvent, onParseError) {
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const event = JSON.parse(trimmed);
      onEvent(event);
    } catch (err) {
      onParseError(trimmed, err);
    }
  });
  return rl;
}

module.exports = { attachNdjsonParser };
