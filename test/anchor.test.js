const test = require('node:test');
const assert = require('node:assert');
const { squash, makeAnchor, findAnchor, toPos } = require('../anchor');

const base = [
  'We study how funding shapes the direction of research.',
  'Our main estimate is a 12\\% increase in citations \\cite{smith2020} for treated papers.',
  'The effect is robust to alternative controls $x^2$ and clustering choices.',
  'We conclude that targeted grants matter.',
].join('\n');

const locate = (text, sentence) => {
  const start = text.indexOf(sentence);
  return { start, end: start + sentence.length };
};
const place = (text, anchor, hint) => {
  const found = findAnchor(squash(text), anchor, hint);
  return found && { ...found, text: text.slice(found.start, found.end) };
};

test('finds the exact text again and ignores edits elsewhere', () => {
  const sentence = 'Our main estimate is a 12\\% increase in citations \\cite{smith2020} for treated papers.';
  const { start, end } = locate(base, sentence);
  const anchor = makeAnchor(base, start, end);
  const edited = 'A new opening line.\n\n' + base.replace('We conclude', 'Overall, we conclude');
  const found = place(edited, anchor);
  assert.strictEqual(found.text, sentence);
});

test('survives reflow and one-sentence-per-line formatting', () => {
  const sentence = 'The effect is robust to alternative controls $x^2$ and clustering choices.';
  const { start, end } = locate(base, sentence);
  const anchor = makeAnchor(base, start, end);
  const reflowed = base.replace(/\s+/g, ' ').replace(/(.{30,}?) /g, '$1\n');
  const found = place(reflowed, anchor);
  assert.strictEqual(squash(found.text).s, squash(sentence).s);
});

test('follows an edit inside the commented text', () => {
  const sentence = 'We conclude that targeted grants matter.';
  const { start, end } = locate(base, sentence);
  const anchor = makeAnchor(base, start, end);
  const edited = base.replace(sentence, 'We conclude that targeted grants matter a great deal.');
  const found = place(edited, anchor);
  assert.strictEqual(found.text, 'We conclude that targeted grants matter a great deal.');
});

test('follows an edit to the first sentence of a file', () => {
  const sentence = 'We study how funding shapes the direction of research.';
  const anchor = makeAnchor(base, 0, sentence.length);
  const edited = base.replace(sentence, 'We study how public funding shapes the direction of research.');
  const found = place(edited, anchor);
  assert.strictEqual(found.text, 'We study how public funding shapes the direction of research.');
});

test('does not stretch an end-of-file comment over text added after it', () => {
  const sentence = 'We conclude that targeted grants matter.';
  const { start, end } = locate(base, sentence);
  const anchor = makeAnchor(base, start, end);
  const edited = base.replace(sentence, 'We conclude otherwise.') + '\n' + 'x'.repeat(2000);
  assert.strictEqual(place(edited, anchor), null);
});

test('returns null when the commented text is deleted', () => {
  const sentence = 'The effect is robust to alternative controls $x^2$ and clustering choices.';
  const { start, end } = locate(base, sentence);
  const anchor = makeAnchor(base, start, end);
  assert.strictEqual(place(base.replace(sentence + '\n', ''), anchor), null);
});

test('picks the right copy of a repeated sentence using its surroundings', () => {
  const repeated = 'See Table 1 for details.';
  const text = `Alpha result is large. ${repeated}\n\nBeta result is small. ${repeated}\n\nGamma result is zero. ${repeated}`;
  const second = text.indexOf(repeated, text.indexOf('Beta'));
  const anchor = makeAnchor(text, second, second + repeated.length);
  const found = place('Intro added here. ' + text, anchor, 0);
  assert.strictEqual(found.start, 'Intro added here. '.length + second);
});

test('breaks exact ties using the hint', () => {
  const text = 'same words here. same words here.';
  const anchor = { exact: 'same words here.', prefix: '', suffix: '' };
  assert.strictEqual(place(text, anchor, 0).start, 0);
  assert.strictEqual(place(text, anchor, 20).start, 17);
});

test('toPos handles LF and CRLF text', () => {
  assert.deepStrictEqual(toPos('ab\ncd', 4), { line: 1, character: 1 });
  assert.deepStrictEqual(toPos('ab\r\ncd', 5), { line: 1, character: 1 });
});

test('random edits outside the comment never move it to the wrong place', () => {
  let seed = 7;
  const rand = (n) => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed % n;
  };
  const topics = ['funding', 'patents', 'citations', 'tenure', 'mobility', 'grants'];
  const paragraphs = [];
  for (let p = 0; p < 40; p++) {
    const sentences = [];
    for (let s = 0; s < 4; s++) {
      sentences.push(`In specification ${p * 4 + s} we relate ${topics[rand(6)]} to ${topics[rand(6)]} with estimate ${rand(1000)}.`);
    }
    if (p % 5 === 0) sentences.push('See Table~\\ref{tab:main} for details.');
    paragraphs.push(sentences.join(' '));
  }
  const doc = paragraphs.join('\n\n');
  let correct = 0;
  let trials = 0;
  for (let k = 0; k < 300; k++) {
    const p = rand(paragraphs.length);
    const sentences = paragraphs[p].split('. ').map((s) => (s.endsWith('.') ? s : s + '.'));
    const sentence = sentences[rand(sentences.length)];
    const start = doc.indexOf(sentence, doc.indexOf(paragraphs[p]));
    const anchor = makeAnchor(doc, start, start + sentence.length);
    let changed = doc;
    const kind = rand(3);
    const at = rand(doc.length);
    if (kind === 0 && (at < start - 60 || at > start + sentence.length + 60)) changed = doc.slice(0, at) + ' inserted words ' + doc.slice(at);
    if (kind === 1) changed = doc.replace(/\n\n/g, '\n').replace(/(.{40,}?) /g, '$1\n');
    if (kind === 2) changed = doc.slice(0, doc.indexOf(paragraphs[(p + 7) % 40])) + doc.slice(doc.indexOf(paragraphs[(p + 7) % 40]) + paragraphs[(p + 7) % 40].length);
    const found = place(changed, anchor, start);
    trials++;
    if (found && squash(found.text).s === squash(sentence).s) correct++;
  }
  assert.strictEqual(correct, trials);
});

test('does not jump to another copy of the text once the commented one is deleted', () => {
  const text = 'Alpha holds here.\nLemma 2 holds.\nBeta follows.\n\nGamma is next. Lemma 2 holds. Delta ends.\n\nEpsilon too. Lemma 2 holds. Zeta stops.';
  const start = text.indexOf('Lemma 2 holds.');
  const anchor = makeAnchor(text, start, start + 'Lemma 2 holds.'.length);
  assert.strictEqual(place(text.replace('Lemma 2 holds.\n', ''), anchor, start), null);
});

test('does not stretch a deleted comment over the next copy of its suffix', () => {
  const text = 'Intro words go here. Removed sentence goes here. See Table 1 for details. More text. See Table 1 for details.';
  const start = text.indexOf('Removed');
  const anchor = makeAnchor(text, start, start + 'Removed sentence goes here.'.length);
  assert.strictEqual(place(text.replace('Removed sentence goes here. ', ''), anchor, start), null);
});
