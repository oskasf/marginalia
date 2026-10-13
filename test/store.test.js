const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parse, append } = require('../store');

test('folds threads, replies, resolve, anchor updates and deletes', () => {
  const lines = [
    '{"t":"thread","id":"a1","file":"intro.tex","exact":"some text","prefix":"before","suffix":"after","author":"Oska","ts":"2026-10-13T10:00:00Z","text":"Is this right?"}',
    '{"t":"reply","id":"a1","author":"Sami","text":"Check the table."}',
    '{"t":"status","id":"a1","resolved":true}',
    '{"t":"status","id":"a1","resolved":false}',
    '{"t":"anchor","id":"a1","exact":"some new text","prefix":"before","suffix":"after"}',
    '{"t":"thread","id":"b2","file":"intro.tex","exact":"gone","text":"x"}',
    '{"t":"delete","id":"b2"}',
  ];
  const threads = parse(lines.join('\n'));
  const a = threads.get('a1');
  assert.strictEqual(a.messages.length, 2);
  assert.strictEqual(a.messages[1].author, 'Sami');
  assert.strictEqual(a.resolved, false);
  assert.strictEqual(a.exact, 'some new text');
  assert.strictEqual(threads.has('b2'), false);
});

test('skips conflict markers, junk and orphan events', () => {
  const text = [
    '<<<<<<< HEAD',
    '{"t":"thread","id":"a1","file":"x.tex","exact":"hello","text":"hi"}',
    '=======',
    '{"t":"reply","id":"a1","text":"second"}',
    '>>>>>>> branch',
    'not json at all',
    '{"broken":',
    '{"t":"reply","id":"missing","text":"orphan reply"}',
    '{"t":"thread","file":"x.tex"}',
  ].join('\n');
  const threads = parse(text);
  assert.strictEqual(threads.size, 1);
  assert.strictEqual(threads.get('a1').messages.length, 2);
});

test('accepts a minimal hand- or LLM-written line without id or type', () => {
  const threads = parse('{"file":"sections\\\\intro.tex","exact":"a claim","author":"Claude (LLM)","text":"Needs a citation."}\n');
  const [t] = threads.values();
  assert.match(t.id, /^[0-9a-f]{8}$/);
  assert.strictEqual(t.file, 'sections/intro.tex');
  assert.strictEqual(t.messages[0].text, 'Needs a citation.');
});

test('a hand-written thread keeps its replies when a line is added above it', () => {
  const hand = '{"file":"a.tex","exact":"a claim","text":"Needs a citation."}';
  const [id] = parse(hand).keys();
  const reply = JSON.stringify({ t: 'reply', id, text: 'Added one.' });
  const other = '{"file":"a.tex","exact":"another claim","text":"Also this."}';
  const threads = parse([other, hand, reply].join('\n'));
  assert.strictEqual(threads.get(id).exact, 'a claim');
  assert.strictEqual(threads.get(id).messages.length, 2);
  assert.strictEqual([...threads.values()].find((t) => t.exact === 'another claim').messages.length, 1);
});

test('skips paths outside the root, unsafe ids and fields of the wrong type', () => {
  const lines = [
    '{"id":"up","file":"../../.ssh/config","exact":"x"}',
    '{"id":"inner","file":"a/../../b.tex","exact":"x"}',
    '{"id":"abs","file":"/etc/passwd","exact":"x"}',
    '{"id":"drive","file":"C:\\\\x.tex","exact":"x"}',
    '{"id":"a)(b","file":"a.tex","exact":"x"}',
    '{"id":"num","file":"a.tex","exact":5}',
    '{"id":"ok","file":"./sub/../a.tex","exact":"x","author":{"name":"x"},"prefix":3,"text":7}',
    '{"t":"anchor","id":"ok","exact":["y"]}',
    '{"t":"reply","id":"ok","author":5,"text":"hi"}',
  ];
  const threads = parse(lines.join('\n'));
  assert.deepStrictEqual([...threads.keys()], ['ok']);
  const t = threads.get('ok');
  assert.strictEqual(t.file, 'a.tex');
  assert.strictEqual(t.exact, 'x');
  assert.strictEqual(t.prefix, '');
  assert.deepStrictEqual(t.messages, [{ author: 'unknown', ts: undefined, text: 'hi' }], 'a thread whose text is not a string starts without a message');
});

test('append adds a missing newline before the new line', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lc-')), '.comments.jsonl');
  fs.writeFileSync(file, '{"id":"h1","file":"a.tex","exact":"x"}');
  append(file, { t: 'reply', id: 'h1', text: 'y' });
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.strictEqual(lines.length, 2);
  assert.strictEqual(parse(lines.join('\n')).get('h1').messages.length, 1);
});
