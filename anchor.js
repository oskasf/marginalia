const CONTEXT = 48;
const NEAR = 2000; // how far from the hint, in characters, the quick search looks

// Whitespace-free copy of the text, plus a map from each kept character back to its original offset
function squash(text) {
  const map = new Array(text.length);
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    // the common ASCII cases are checked directly, since a regex test per character is slow on long files
    if (c === 32 || (c >= 9 && c <= 13) || (c > 127 && /\s/.test(text[i]))) continue;
    map[n++] = i;
  }
  map.length = n;
  let s = '';
  for (let k = 0; k < n; k += 8192) s += String.fromCharCode(...map.slice(k, k + 8192).map((i) => text.charCodeAt(i)));
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
  const score = (i) => {
    let a = 0;
    while (a < before.length && a < i && doc.s[i - 1 - a] === before[before.length - 1 - a]) a++;
    let b = 0;
    while (b < after.length && doc.s[i + quote.length + b] === after[b]) b++;
    return (a > 0 && a >= Math.min(8, before.length)) + (b > 0 && b >= Math.min(8, after.length));
  };
  // usually the comment is still near the hint with both sides matching, and then no copy further away can beat it
  if (before && after) {
    let lo = 0;
    for (let hi = doc.map.length; lo < hi; ) {
      const mid = (lo + hi) >> 1;
      if (doc.map[mid] < hint) lo = mid + 1;
      else hi = mid;
    }
    let near = null;
    for (let i = doc.s.indexOf(quote, Math.max(0, lo - NEAR)); i !== -1 && i <= lo + NEAR; i = doc.s.indexOf(quote, i + 1)) {
      const dist = Math.abs(doc.map[i] - hint);
      if (score(i) === 2 && (!near || dist < near.dist)) near = { i, dist };
    }
    if (near && near.dist <= NEAR) return { start: doc.map[near.i], end: doc.map[near.i + quote.length - 1] + 1 };
  }
  let best = null;
  let copies = 0;
  for (let i = doc.s.indexOf(quote); i !== -1; i = doc.s.indexOf(quote, i + 1)) {
    copies++;
    const sc = score(i);
    const dist = Math.abs(doc.map[i] - hint);
    if (!best || sc > best.score || (sc === best.score && dist < best.dist)) best = { i, score: sc, dist };
  }
  const kept = best && { start: doc.map[best.i], end: doc.map[best.i + quote.length - 1] + 1 };
  // with words on both sides and only one matching, text may have been typed after a half-typed quote, so the words around it decide first
  const loose = best && best.score === 1 && before && after;
  if (best && !loose && (best.score > 0 || !(before || after) || (copies === 1 && quote.length >= 20))) return kept;
  return between(doc, quote, before, after, hint) || (loose ? kept : null);
}

// 2. the commented text was edited: take what sits between the surrounding words, or the file boundary where a side is empty
function between(doc, quote, before, after, hint) {
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

// Offsets where each line starts, so toPos can find a line without rescanning the text
function lineStarts(text) {
  const starts = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return starts;
}

function toPos(text, offset, starts = lineStarts(text)) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo, character: offset - starts[lo] };
}

module.exports = { squash, makeAnchor, findAnchor, lineStarts, toPos };
