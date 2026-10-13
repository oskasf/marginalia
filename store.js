const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const str = (v) => (typeof v === 'string' ? v : '');

// A file path relative to the root, or null when it is missing or points outside the root
function cleanFile(v) {
  const file = path.posix.normalize(str(v).replace(/\\/g, '/'));
  if (!str(v) || path.posix.isAbsolute(file) || /^[a-z]:/i.test(file) || file === '..' || file.startsWith('../')) return null;
  return file;
}

// Turns the text of .comments.jsonl into a Map of threads, skipping lines that are bad or unsafe
function parse(text) {
  const threads = new Map();
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s.startsWith('{')) continue;
    let ev;
    try {
      ev = JSON.parse(s);
    } catch {
      continue;
    }
    if (!ev || typeof ev !== 'object') continue;
    const message = { author: str(ev.author) || 'unknown', ts: str(ev.ts) || undefined, text: str(ev.text) };

    if (['reply', 'status', 'anchor', 'delete', 'move'].includes(ev.t)) {
      const t = threads.get(String(ev.id));
      if (!t) continue;
      if (ev.t === 'reply' && message.text) t.messages.push(message);
      if (ev.t === 'status' && typeof ev.resolved === 'boolean') t.resolved = ev.resolved;
      if (ev.t === 'delete') threads.delete(t.id);
      if (ev.t === 'move' && cleanFile(ev.file)) t.file = cleanFile(ev.file);
      if (ev.t === 'anchor' && str(ev.exact).trim()) Object.assign(t, { exact: ev.exact, prefix: str(ev.prefix), suffix: str(ev.suffix), offset: Number.isInteger(ev.offset) ? ev.offset : 0 });
      continue;
    }

    const file = cleanFile(ev.file);
    if (!file || !str(ev.exact).trim()) continue;
    // a hand-written line without an id gets one from its content, so it keeps it when lines are added above
    const id = ev.id == null ? crypto.createHash('sha1').update(JSON.stringify([ev.file, ev.exact, ev.text, ev.ts, ev.author])).digest('hex').slice(0, 8) : String(ev.id);
    if (!/^[\w-]+$/.test(id) || threads.has(id)) continue;
    threads.set(id, {
      id,
      file,
      exact: ev.exact,
      prefix: str(ev.prefix),
      suffix: str(ev.suffix),
      offset: Number.isInteger(ev.offset) ? ev.offset : 0,
      messages: message.text ? [message] : [],
      resolved: false,
    });
  }
  return threads;
}

// The store's text, or null when it does not exist. A shared repository could make it a link to another file, which is refused
function read(file) {
  let info;
  try {
    info = fs.lstatSync(file);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  if (!info.isFile()) throw new Error(`${path.basename(file)} is not a plain file, so it is not used`);
  return fs.readFileSync(file, 'utf8');
}

function append(file, event) {
  const current = read(file);
  const lead = current && !current.endsWith('\n') ? '\n' : '';
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW ?? 0), 0o644);
  try {
    fs.writeSync(fd, lead + JSON.stringify(event) + '\n');
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { parse, read, append };
