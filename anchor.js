const CONTEXT = 48;

// Whitespace-free copy of the text, plus a map from each kept character back to its original offset
function squash(text) {
  let s = '';
  const map = [];
  for (let i = 0; i < text.length; i++) {
    if (/\s/.test(text[i])) continue;
    s += text[i];
    map.push(i);
  }
  return { s, map };
}

// The context is CONTEXT non-whitespace characters on each side, so an empty side really means the start or end of the file
function makeAnchor(text, start, end) {
  const tidy = (t) => t.replace(/\s+/g, ' ').trim();
  let from = start;
  for (let n = 0; from > 0 && n < CONTEXT; from--) if (!/\s/.test(text[from - 1])) n++;
  let to = end;
  for (let n = 0; to < text.length && n < CONTEXT; to++) if (!/\s/.test(text[to])) n++;
  return {
    exact: tidy(text.slice(start, end)),
    prefix: tidy(text.slice(from, start)),
    suffix: tidy(text.slice(end, to)),
  };
}

// doc is squash(text). Returns { start, end } or null when the comment cannot be placed
function findAnchor(doc, anchor, hint = 0) {
  const quote = squash(anchor.exact).s;
  if (!quote) return null;
  const before = squash(anchor.prefix || '').s;
  const after = squash(anchor.suffix || '').s;

  // 1. the commented text is still there: take the copy with most matching sides, then the one nearest the hint
  let best = null;
  let copies = 0;
  for (let i = doc.s.indexOf(quote); i !== -1; i = doc.s.indexOf(quote, i + 1)) {
    copies++;
    let a = 0;
    while (a < before.length && a < i && doc.s[i - 1 - a] === before[before.length - 1 - a]) a++;
    let b = 0;
    while (b < after.length && doc.s[i + quote.length + b] === after[b]) b++;
    const score = (a > 0 && a >= Math.min(8, before.length)) + (b > 0 && b >= Math.min(8, after.length));
    const dist = Math.abs(doc.map[i] - hint);
    if (!best || score > best.score || (score === best.score && dist < best.dist)) best = { i, score, dist };
  }
  if (best && (best.score > 0 || !(before || after) || (copies === 1 && quote.length >= 20))) return { start: doc.map[best.i], end: doc.map[best.i + quote.length - 1] + 1 };

  // 2. the commented text was edited: take what sits between the surrounding words, or the file boundary where a side is empty
  if ((!before && !after) || [before, after].some((side) => side && side.length < 8)) return null;
  const lead = before.slice(-20);
  const trail = after.slice(0, 20);
  const starts = [];
  if (!before) starts.push(0);
  else for (let a = doc.s.indexOf(lead); a !== -1; a = doc.s.indexOf(lead, a + 1)) starts.push(a + lead.length);
  let near = null;
  for (const from of starts) {
    const to = after ? doc.s.indexOf(trail, from) : doc.s.length;
    if (to === -1 || to - from > quote.length * 3 + 200) continue;
    const dist = Math.abs(doc.map[from] - hint);
    if (!near || dist < near.dist) near = { from, to, dist };
  }
  if (!near || near.to === near.from) return null;
  return { start: doc.map[near.from], end: doc.map[near.to - 1] + 1 };
}

function toPos(text, offset) {
  const before = text.slice(0, offset);
  return { line: before.split('\n').length - 1, character: offset - (before.lastIndexOf('\n') + 1) };
}

module.exports = { squash, makeAnchor, findAnchor, toPos };
