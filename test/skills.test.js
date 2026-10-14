const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { parse } = require('../store');
const { squash, findAnchor } = require('../anchor');

const helper = path.join(__dirname, '..', 'skills', 'marginalia.py');
const python = spawnSync('python3', ['--version']).status === 0;

test('each skill carries the current helper', () => {
  for (const name of ['marginalia-feedback', 'marginalia-address']) {
    const skill = fs.readFileSync(path.join(__dirname, '..', 'skills', name, 'SKILL.md'), 'utf8');
    assert.ok(skill.includes('```python marginalia.py\n' + fs.readFileSync(helper, 'utf8') + '```\n'), `${name} has an outdated copy of skills/marginalia.py`);
  }
});

test('the helper writes lines the extension reads and places as intended', { skip: !python && 'python3 not installed' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-skill-'));
  const doc = 'We study the  effect of heat on growth.\nResults are in Table 1.\n\nWe study the effect of pressure on   growth.\n';
  fs.writeFileSync(path.join(dir, 'a.tex'), doc);
  fs.writeFileSync(path.join(dir, '.comments.jsonl'), '{"file":"a.tex","exact":"Table 1","author":"Oska","text":"Which table?"}');
  const run = (args, input) => spawnSync('python3', [helper, ...args], { cwd: dir, input, encoding: 'utf8', env: { ...process.env, MARGINALIA_ROOT: dir } });

  assert.strictEqual(run(['add'], JSON.stringify([{ file: 'a.tex', quote: 'growth', text: 'x' }])).status, 1, 'an ambiguous quote is refused');
  assert.strictEqual(run(['add'], JSON.stringify([{ file: 'a.tex', quote: 'effect of pressure on growth', near: 4, text: 'Why pressure?' }, { file: 'a.tex', quote: 'growth', near: 4, text: 'Which growth?' }])).status, 0);
  const id = [...parse(fs.readFileSync(path.join(dir, '.comments.jsonl'), 'utf8')).keys()][0];
  assert.match(run(['list'], '').stdout, new RegExp(`\\[${id}\\] a.tex:2 open`));
  assert.strictEqual(run(['reply'], JSON.stringify([{ id, text: 'Table 2.', resolved: true }])).status, 0);

  const threads = [...parse(fs.readFileSync(path.join(dir, '.comments.jsonl'), 'utf8')).values()];
  assert.deepStrictEqual(threads.map((t) => [t.messages.at(-1).author, t.messages.length, t.resolved]), [['Claude', 2, true], ['Claude', 1, false], ['Claude', 1, false]]);
  const placed = threads.slice(1).map((t) => {
    const found = findAnchor(squash(doc), t, t.offset);
    return [doc.slice(0, found.start).split('\n').length, doc.slice(found.start, found.end)];
  });
  assert.deepStrictEqual(placed, [[4, 'effect of pressure on   growth'], [4, 'growth']]);
  fs.rmSync(dir, { recursive: true });
});
