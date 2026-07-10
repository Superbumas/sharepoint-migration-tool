// The server terminal's look - timestamped, glyph-tagged, 256-color ANSI
// lines plus a startup banner and unicode progress bars. Zero dependencies;
// colors degrade gracefully when stdout isn't a TTY (piped, CI).
const useColor = process.stdout.isTTY || process.env.FORCE_COLOR === '1';

const esc = (code) => (useColor ? `\x1b[${code}m` : '');
const C = {
  reset: esc(0),
  dim: esc(2),
  bold: esc(1),
  red: esc(31),
  green: esc(32),
  yellow: esc(33),
  blue: esc(34),
  magenta: esc(35),
  cyan: esc(36),
  grey: esc(90),
};
// 256-color blue→violet ramp used for the banner and progress bars.
const RAMP = [39, 38, 44, 43, 49, 48, 84, 83].map((n) => esc(`38;5;${n}`));

function ts() {
  return new Date().toLocaleTimeString('en-GB', { hour12: false });
}

// One log line: `18:42:07 ✓ job      message`
function write(color, glyph, tag, message) {
  console.log(`${C.grey}${ts()}${C.reset} ${color}${glyph} ${tag.padEnd(7)}${C.reset} ${message}`);
}

// Unicode progress bar: ▰▰▰▰▰▱▱▱▱▱ colored along the ramp.
function bar(pct, width = 18) {
  const filled = Math.round((Math.max(0, Math.min(100, pct)) / 100) * width);
  let out = '';
  for (let i = 0; i < width; i++) {
    if (i < filled) out += `${RAMP[Math.floor((i / width) * RAMP.length)]}▰${C.reset}`;
    else out += `${C.grey}▱${C.reset}`;
  }
  return out;
}

// Braille spinner - advances one frame per call, so repeated progress lines
// visibly "spin" even though each is its own printed line (in-place \r
// rewriting is unreliable under npm's prefixed workspace output).
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
let spinnerIdx = 0;
function spin() {
  spinnerIdx = (spinnerIdx + 1) % SPINNER.length;
  return SPINNER[spinnerIdx];
}

// Startup banner - gradient wordmark + boxed URL.
function banner(url) {
  const mark = [
    ' ┌─┐┌─┐┌┬┐┌┬┐',
    ' └─┐├─┘│││ │ ',
    ' └─┘┴  ┴ ┴ ┴ ',
  ];
  console.log('');
  mark.forEach((line, i) => console.log(`${RAMP[i * 2] || RAMP.at(-1)}${C.bold}${line}${C.reset}${i === 1 ? `  ${C.bold}SharePoint Migration Tool${C.reset}` : ''}`));
  console.log('');
  const inner = `  ➜  ${url}  `;
  console.log(`${C.grey}┌${'─'.repeat(inner.length)}┐${C.reset}`);
  console.log(`${C.grey}│${C.reset}${C.cyan}${C.bold}${inner}${C.reset}${C.grey}│${C.reset}`);
  console.log(`${C.grey}└${'─'.repeat(inner.length)}┘${C.reset}`);
  console.log('');
}

module.exports = {
  C,
  bar,
  spin,
  banner,
  info: (tag, msg) => write(C.blue, '●', tag, msg),
  ok: (tag, msg) => write(C.green, '✓', tag, msg),
  warn: (tag, msg) => write(C.yellow, '⚠', tag, msg),
  error: (tag, msg) => write(C.red, '✗', tag, msg),
  progress: (tag, msg) => write(C.cyan, spin(), tag, msg),
  start: (tag, msg) => write(C.green, '▶', tag, msg),
  stop: (tag, msg) => write(C.yellow, '■', tag, msg),
  dim: (tag, msg) => write(C.grey, '·', tag, `${C.dim}${msg}${C.reset}`),
};
