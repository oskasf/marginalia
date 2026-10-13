const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const str = (v) => (typeof v === 'string' ? v : '');

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

    if (['reply', 'status', 'anchor', 'delete'].includes(ev.t)) {
      const t = threads.get(String(ev.id));
      if (!t) continue;
      if (ev.t === 'reply' && message.text) t.messages.push(message);
      if (ev.t === 'status' && typeof ev.resolved === 'boolean') t.resolved = ev.resolved;
      if (ev.t === 'delete') threads.delete(t.id);
      if (ev.t === 'anchor' && str(ev.exact).trim()) Object.assign(t, { exact: ev.exact, prefix: str(ev.prefix), suffix: str(ev.suffix), offset: Number.isInteger(ev.offset) ? ev.offset : 0 });
      continue;
    }

    const file = path.posix.normalize(str(ev.file).replace(/\\/g, '/'));
    if (!str(ev.file) || !str(ev.exact).trim() || path.posix.isAbsolute(file) || /^[a-z]:/i.test(file) || file === '..' || file.startsWith('../')) continue;
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

function append(file, event) {
  let lead = '';
  if (fs.existsSync(file)) {
    const current = fs.readFileSync(file, 'utf8');
    if (current.length && !current.endsWith('\n')) lead = '\n';
  }
  fs.appendFileSync(file, lead + JSON.stringify(event) + '\n');
}

module.exports = { parse, append };
