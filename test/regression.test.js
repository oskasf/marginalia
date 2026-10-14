const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createFake, activate, Range } = require('./fake-vscode');
const { parse } = require('../store');
const { squash, makeAnchor, findAnchor } = require('../anchor');

// Cases found by trying to break the extension, kept so they stay fixed

const offsetOf = (text, p) => text.split('\n').slice(0, p.line).reduce((n, l) => n + l.length + 1, 0) + p.character;
const anchorOn = (text, quote, nth = 0) => {
  let i = -1;
  for (let k = 0; k <= nth; k++) i = text.indexOf(quote, i + 1);
  return [i, i + quote.length];
};
const thread = (id, file, text, start, end, extra = {}) => ({ t: 'thread', id, file, ...makeAnchor(text, start, end), author: 'A', ts: '2026-10-01T10:00:00Z', text: 'note', ...extra });

// Activates the extension on a folder holding `files` and a store of `store` (events or raw text), with the files in `open` open in editors
async function setup({ files = {}, store = '', open = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-reg-'));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  const storePath = path.join(dir, '.comments.jsonl');
  fs.writeFileSync(storePath, typeof store === 'string' ? store : store.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const fake = createFake(dir);
  const { vscode, seen } = fake;
  const marks = new Map();
  const h = { dir, storePath, seen, vscode, marks };

  h.openDoc = (rel, text) => {
    const doc = {
      uri: vscode.Uri.file(path.join(dir, rel)),
      getText: () => text,
      offsetAt: (p) => offsetOf(text, p),
      lineAt: (n) => ({ range: new Range(n, 0, n, text.split('\n')[n].length) }),
    };
    const docs = vscode.workspace.textDocuments;
    const i = docs.findIndex((d) => d.uri.fsPath === doc.uri.fsPath);
    if (i >= 0) docs[i] = doc;
    else docs.push(doc);
    let editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.fsPath === doc.uri.fsPath);
    if (!editor) {
      editor = { selection: new Range(0, 0, 0, 0), setDecorations: (_type, ranges) => marks.set(rel, ranges) };
      vscode.window.visibleTextEditors.push(editor);
    }
    editor.document = doc;
    vscode.window.activeTextEditor = editor;
    return editor;
  };
  for (const rel of open) h.openDoc(rel, files[rel]);
  Object.assign(h, await activate(fake));
  h.state = () => h.posted.filter((m) => m.type === 'state').pop();
  h.card = (id) => h.state().cards.find((c) => c.id === id);
  h.stored = () => fs.readFileSync(storePath, 'utf8');
  h.tree = seen.views['marginalia.threads'].treeDataProvider;
  h.storage = seen.views['marginalia.storage'].treeDataProvider;
  return h;
}

test('deleting the commented sentence detaches the comment instead of jumping to an unrelated occurrence of the same word', () => {
  const text = ['Our results show that funding raises citations for treated papers in every field we study.', 'Much later in the paper, the robustness section repeats the word results once more here.'].join('\n');
  const anchor = makeAnchor(text, ...anchorOn(text, 'results'));
  assert.strictEqual(findAnchor(squash(text.split('\n')[1]), anchor), null);
});

test('a comment on one of several identical passages with identical surroundings is shown where it was made', async () => {
  const row = 'This boilerplate sentence appears verbatim in two places of the document.';
  const text = ['\\section{A}', row, row, row, row, '\\section{B}'].join('\n');
  const h = await setup({ files: { 'main.tex': text }, open: ['main.tex'] });
  h.vscode.window.activeTextEditor.selection = new Range(3, 0, 3, row.length);
  await h.seen.handlers['marginalia.addOnSelection']();
  await h.send({ type: 'create', text: 'Delete this copy' });
  const id = h.state().activeId;
  assert.strictEqual(h.card(id).line, 3);
  assert.strictEqual(JSON.parse(h.stored()).offset, anchorOn(text, row, 2)[0], 'the position is stored so a restart finds the same copy');
});

test('duplicating a paragraph keeps the comment on the original, not the pasted copy', () => {
  const para = 'Commented sentence that the co-author asked us to rewrite completely.';
  const text = 'Intro.\n\n\n\n        ' + para + '\nThe following paragraph is long enough to fill the suffix context window.';
  const [s, e] = anchorOn(text, para);
  const dup = text.replace(para, para + '\n' + para);
  assert.strictEqual(findAnchor(squash(dup), makeAnchor(text, s, e), s).start, s);
});

test('editing text that follows a long run of whitespace does not stretch the comment back to the start of the file', () => {
  const text = 'Title line of the document.\n' + ' '.repeat(50) + 'The quick brown fox jumps over the lazy dog.\nMore text after this sentence goes here.';
  const anchor = makeAnchor(text, ...anchorOn(text, 'The quick brown fox jumps over the lazy dog.'));
  assert.strictEqual(anchor.prefix, 'Title line of the document.', 'the context skips whitespace');
  const edited = text.replace('quick', 'slow');
  const found = findAnchor(squash(edited), anchor);
  assert.strictEqual(edited.slice(found.start, found.end), 'The slow brown fox jumps over the lazy dog.');
});

test('a thread whose live anchor fails falls back to the stored anchor, as after a co-author re-anchors and git pull', async () => {
  const v1 = 'Opening sentence of the paper.\nThe estimate is large and significant in every specification.\nClosing remarks.';
  const h = await setup({ files: { 'main.tex': v1 }, store: [thread('a1', 'main.tex', v1, ...anchorOn(v1, 'The estimate is large and significant in every specification.'))] });
  assert.strictEqual(h.card('a1').status, 'exact');
  const v2 = 'Totally rewritten introduction here.\nOur preferred estimate is modest but precisely measured.\nNew ending.';
  fs.writeFileSync(path.join(h.dir, 'main.tex'), v2);
  fs.appendFileSync(h.storePath, JSON.stringify({ t: 'anchor', id: 'a1', ...makeAnchor(v2, ...anchorOn(v2, 'Our preferred estimate is modest but precisely measured.')) }) + '\n');
  await h.seen.events.storeChange();
  assert.deepStrictEqual([h.card('a1').status, h.card('a1').line], ['exact', 1]);
});

test('an anchor event is validated like a thread event (whitespace or non-string exact is ignored)', () => {
  const lines = [
    '{"t":"thread","id":"a1","file":"main.tex","exact":"good text","text":"hi"}',
    '{"t":"anchor","id":"a1","exact":"   "}',
    '{"t":"thread","id":"b1","file":"main.tex","exact":"other text"}',
    '{"t":"anchor","id":"b1","exact":42}',
  ];
  const threads = parse(lines.join('\n'));
  assert.strictEqual(threads.get('a1').exact, 'good text');
  assert.strictEqual(threads.get('b1').exact, 'other text');
});

test('a status line resolves only with a real true or false', () => {
  const lines = ['{"t":"thread","id":"a1","file":"main.tex","exact":"good text"}', '{"t":"status","id":"a1","resolved":"false"}'];
  assert.strictEqual(parse(lines.join('\n')).get('a1').resolved, false);
  lines.push('{"t":"status","id":"a1","resolved":true}', '{"t":"status","id":"a1","resolved":1}');
  assert.strictEqual(parse(lines.join('\n')).get('a1').resolved, true);
});

test('the sidebar does not throw on a thread with no message whose anchor event had a numeric exact', async () => {
  const h = await setup({ files: { 'main.tex': 'Some other text here.' }, store: '{"t":"thread","id":"b1","file":"main.tex","exact":"other text"}\n{"t":"anchor","id":"b1","exact":42}\n' });
  assert.strictEqual(h.tree.getTreeItem({ kind: 'thread', id: 'b1' }).label, 'other text');
});

test('a hand-written comment with "file":"./main.tex" is highlighted like "main.tex"', async () => {
  const text = 'We conclude that targeted grants matter.';
  const h = await setup({ files: { 'main.tex': text }, store: '{"file":"./main.tex","exact":"targeted grants","author":"Claude (LLM)","text":"Cite."}\n', open: ['main.tex'] });
  assert.deepStrictEqual(h.state().cards.map((c) => [c.file, c.status]), [['main.tex', 'exact']]);
  assert.strictEqual(h.marks.get('main.tex').length, 1);
});

test('files whose name starts with ".." inside the root can be commented on', async () => {
  const h = await setup({ files: { '..draft.tex': 'Draft paragraph to discuss.' }, open: ['..draft.tex'] });
  h.vscode.window.activeTextEditor.selection = new Range(0, 0, 0, 5);
  await h.seen.handlers['marginalia.addOnSelection']();
  assert.deepStrictEqual(h.seen.warnings, []);
  assert.strictEqual(h.state().compose.file, '..draft.tex');
});

test('the comments file view shortens the root to ~ only when it is really inside the home folder', async () => {
  const h = await setup();
  const real = os.homedir;
  try {
    os.homedir = () => h.dir.slice(0, -3); // a sibling folder whose name starts like the root's
    assert.strictEqual(h.storage.getChildren()[1].description, h.dir);
    os.homedir = () => path.dirname(h.dir);
    assert.strictEqual(h.storage.getChildren()[1].description, '~' + path.sep + path.basename(h.dir));
  } finally {
    os.homedir = real;
  }
});

test('clicking the card of a comment whose .tex file was removed explains why instead of failing', async () => {
  const text = 'Section text that will be deleted with its file.';
  const h = await setup({ files: { 'sections/old.tex': text }, store: [thread('x1', 'sections/old.tex', text, 0, 12)] });
  fs.unlinkSync(path.join(h.dir, 'sections/old.tex'));
  await h.seen.handlers['marginalia.reload']();
  assert.strictEqual(h.card('x1').status, 'detached');
  await h.send({ type: 'go', id: 'x1' });
  assert.match(h.seen.warnings.join('\n'), /cannot open sections\/old\.tex/);
  assert.deepStrictEqual(h.seen.revealed, []);
});

test('resolve, reopen and reply from a stale hover do nothing for a deleted thread', async () => {
  const text = 'We conclude that targeted grants matter.';
  const h = await setup({ files: { 'main.tex': text }, store: [thread('a1', 'main.tex', text, 17, 32)] });
  await h.send({ type: 'delete', id: 'a1' });
  const before = h.stored();
  await h.seen.handlers['marginalia.resolve']('a1');
  await h.seen.handlers['marginalia.reopen']('a1');
  assert.strictEqual(h.stored(), before);
  await h.seen.handlers['marginalia.reply']('a1');
  assert.notStrictEqual(h.state().activeId, 'a1');
});

test('sidebar label truncation does not split an emoji into a lone surrogate', async () => {
  const msg = 'x'.repeat(66) + '😀 and then a lot more words after the emoji';
  const h = await setup({ files: { 'main.tex': 'Some text.' }, store: [thread('a1', 'main.tex', 'Some text.', 0, 4, { text: msg })] });
  assert.strictEqual(h.tree.getTreeItem({ kind: 'thread', id: 'a1' }).label, 'x'.repeat(66) + '😀...');
});

test('a comment that cannot be written says so and stays in its card to try again', async () => {
  const text = 'We conclude that targeted grants matter.';
  const h = await setup({ files: { 'main.tex': text }, open: ['main.tex'] });
  h.vscode.window.activeTextEditor.selection = new Range(0, 17, 0, 32);
  await h.seen.handlers['marginalia.addOnSelection']();
  const real = fs.writeSync;
  fs.writeSync = () => {
    throw new Error('EACCES: permission denied');
  };
  try {
    await h.send({ type: 'create', text: 'Cite something.' });
  } finally {
    fs.writeSync = real;
  }
  assert.match(h.seen.errors[0], /could not save .*EACCES/);
  assert.deepStrictEqual(h.posted.pop(), { type: 'restore', id: 'new', text: 'Cite something.' }, 'the text goes back into the box');
  assert.strictEqual(h.stored(), '', 'nothing was written');
  assert.strictEqual(h.state().compose.exact, 'targeted grants');
  await h.send({ type: 'create', text: 'Cite something.' });
  assert.strictEqual(h.state().compose, null);
  assert.strictEqual(h.state().cards[0].messages[0].text, 'Cite something.');
});

test('saving a file with several edited comments stores each new wording, even when one write fails', async () => {
  const v1 = 'First sentence has some words in it.\nMiddle line stays the same here.\nSecond sentence has other words too.';
  const v2 = v1.replace('some words', 'many words').replace('other words', 'more words');
  const store = [thread('a1', 'main.tex', v1, ...anchorOn(v1, 'First sentence has some words in it.')), thread('b1', 'main.tex', v1, ...anchorOn(v1, 'Second sentence has other words too.'))];
  const h = await setup({ files: { 'main.tex': v1 }, store, open: ['main.tex'] });
  const doc = h.openDoc('main.tex', v2).document;
  const real = fs.writeSync;
  let calls = 0;
  fs.writeSync = (...args) => {
    if (calls++ === 0) throw new Error('EBUSY: resource busy');
    return real(...args);
  };
  try {
    h.seen.events.save(doc);
  } finally {
    fs.writeSync = real;
  }
  assert.strictEqual(h.seen.errors.length, 1);
  assert.deepStrictEqual([h.card('a1').status, h.card('b1').status], ['edited', 'exact']);
  h.seen.events.save(doc);
  assert.deepStrictEqual([h.card('a1').status, h.card('b1').status], ['exact', 'exact']);
  const anchors = h.stored().trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.t === 'anchor');
  assert.deepStrictEqual(anchors.map((e) => [e.id, e.exact]), [['b1', 'Second sentence has more words too.'], ['a1', 'First sentence has many words in it.']]);
});

test('coming back to VS Code rechecks git, and a .tex file changed on disk is redrawn', async (t) => {
  const v1 = 'Opening sentence of the paper.\nThe estimate is large and significant in every specification.';
  const h = await setup({ files: { 'main.tex': v1 }, store: [thread('a1', 'main.tex', v1, ...anchorOn(v1, 'The estimate is large and significant in every specification.'))] });
  assert.strictEqual(h.storage.getChildren()[2].label, 'Stays on this computer');
  execFileSync('git', ['init', '-q'], { cwd: h.dir });
  await h.seen.events.windowState({ focused: true });
  assert.strictEqual(h.storage.getChildren()[2].label, 'Not shared yet');

  t.mock.timers.enable({ apis: ['setTimeout'] });
  fs.writeFileSync(path.join(h.dir, 'main.tex'), 'A new first line.\n' + v1);
  h.seen.events.filesChange(h.vscode.Uri.file(path.join(h.dir, 'main.tex')));
  t.mock.timers.tick(300);
  assert.strictEqual(h.card('a1').line, 2);
});

test('a Markdown file cannot be commented on until its file type is enabled, and then works like a .tex file', async () => {
  const md = '# Notes\n\nThe second experiment needs a larger sample than the first one had.';
  const h = await setup({ files: { 'main.tex': 'Some text.', 'notes.md': md } });
  const editor = h.openDoc('notes.md', md);
  await h.seen.events.activeEditor(editor);
  assert.strictEqual(h.seen.context['marginalia.enabledFile'], false);
  editor.selection = new Range(2, 30, 2, 43);
  await h.seen.handlers['marginalia.addOnSelection']();
  assert.match(h.seen.infos.pop(), /Enable comments for this file type/);
  assert.strictEqual(h.state().compose, null);

  await h.seen.handlers['marginalia.enableFileType']();
  assert.deepStrictEqual(h.seen.updates.at(-1), ['files', ['**/*.tex', '**/*.md'], h.vscode.ConfigurationTarget.Workspace]);
  assert.deepStrictEqual(h.seen.watched.slice(-3), ['.comments.jsonl', '**/*.tex', '**/*.md'], 'files of the new type are watched on disk too');
  assert.strictEqual(h.seen.context['marginalia.enabledFile'], true);
  await h.seen.handlers['marginalia.addOnSelection']();
  assert.strictEqual(h.state().compose.exact, 'larger sample');
  await h.send({ type: 'create', text: 'How large?' });
  assert.deepStrictEqual([...parse(h.stored()).values()].map((t) => [t.file, t.exact]), [['notes.md', 'larger sample']]);
  assert.strictEqual(h.marks.get('notes.md').length, 1);
  assert.match(h.seen.providers.hover.provideHover(editor.document, { line: 2, character: 35 }).contents[0].value, /How large\?/);

  await h.seen.handlers['marginalia.enableFileType']();
  assert.deepStrictEqual(h.seen.config.files, ['**/*.tex', '**/*.md'], 'enabling twice adds the pattern once');
});

test('a comment on a file type that is not enabled stays in the sidebar but is not highlighted or hovered', async () => {
  const py = 'def mean(xs):\n    return sum(xs) / len(xs)\n';
  const h = await setup({ files: { 'script.py': py }, store: [thread('p1', 'script.py', py, ...anchorOn(py, 'sum(xs) / len(xs)'))] });
  const editor = h.openDoc('script.py', py);
  h.seen.events.visible([editor]);
  await h.seen.handlers['marginalia.reload']();
  assert.deepStrictEqual([h.card('p1').line, h.card('p1').status], [1, 'exact']);
  assert.deepStrictEqual(h.tree.getChildren().map((n) => n.file), ['script.py']);
  assert.deepStrictEqual(h.marks.get('script.py'), []);
  assert.strictEqual(h.seen.providers.hover.provideHover(editor.document, { line: 1, character: 15 }), undefined);
  assert.deepStrictEqual(h.seen.watched, ['.comments.jsonl', '**/*.tex'], 'only enabled files are watched on disk');
});

test('a closed Markdown file with comments is redrawn when it changes on disk once Markdown is enabled', async (t) => {
  const v1 = 'First line of the notes.\nThe second experiment needs a larger sample.';
  const h = await setup({ files: { 'notes.md': v1 }, store: [thread('a1', 'notes.md', v1, ...anchorOn(v1, 'larger sample'))] });
  h.seen.config.files = ['**/*.tex', 'notes.md'];
  await h.seen.events.config({ affectsConfiguration: () => true });
  assert.deepStrictEqual(h.seen.watched.slice(-2), ['**/*.tex', 'notes.md']);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  fs.writeFileSync(path.join(h.dir, 'notes.md'), 'A new heading.\n\n' + v1);
  h.seen.events.filesChange(h.vscode.Uri.file(path.join(h.dir, 'notes.md')));
  t.mock.timers.tick(300);
  assert.strictEqual(h.card('a1').line, 3);
});

test('typing over the commented text keeps the whole new wording, not the first letters typed', async (t) => {
  const pre = 'Introduction paragraph with plenty of words before the claim we make here. ';
  const post = ' After that the paper continues with more text describing the method used.';
  const v1 = pre + 'Funding raises citations substantially.' + post;
  const h = await setup({ files: { 'main.tex': v1 }, store: [thread('a1', 'main.tex', v1, ...anchorOn(v1, 'Funding raises citations substantially.'))], open: ['main.tex'] });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let editor;
  for (const typed of ['G', 'Grants ', 'Grants increase citation counts modestly.']) {
    editor = h.openDoc('main.tex', pre + typed + post);
    h.seen.events.change({ document: editor.document, contentChanges: [{}] });
    t.mock.timers.tick(300);
  }
  h.seen.events.save(editor.document);
  assert.strictEqual(h.card('a1').exact, 'Grants increase citation counts modestly.');
});

test('deleting the commented text and pressing undo brings back the whole comment', async (t) => {
  const pre = 'Introduction paragraph with plenty of words before the claim we make here. ';
  const post = ' After that the paper continues with more text describing the method used.';
  const quote = 'Funding raises citations substantially.';
  const v1 = pre + quote + post;
  const h = await setup({ files: { 'main.tex': v1 }, store: [thread('a1', 'main.tex', v1, ...anchorOn(v1, quote))], open: ['main.tex'] });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let editor;
  for (const text of [pre + quote.slice(0, 3) + post, pre + post, v1]) {
    editor = h.openDoc('main.tex', text);
    h.seen.events.change({ document: editor.document, contentChanges: [{}] });
    t.mock.timers.tick(300);
  }
  h.seen.events.save(editor.document);
  assert.deepStrictEqual([h.card('a1').status, h.card('a1').exact], ['exact', quote]);
});

test('a comments file that is a link to another file is neither read nor written', async () => {
  const text = 'We conclude that targeted grants matter.';
  const h = await setup({ files: { 'main.tex': text } });
  const elsewhere = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mg-elsewhere-')), '.bashrc');
  fs.writeFileSync(elsewhere, 'export PS1=x\n');
  fs.rmSync(h.storePath);
  fs.symlinkSync(elsewhere, h.storePath);
  await h.seen.handlers['marginalia.reload']();
  assert.match(h.seen.warnings.pop(), /not a plain file/);
  h.openDoc('main.tex', text).selection = new Range(0, 17, 0, 32);
  await h.seen.handlers['marginalia.addOnSelection']();
  await h.send({ type: 'create', text: 'Cite something.' });
  assert.strictEqual(fs.readFileSync(elsewhere, 'utf8'), 'export PS1=x\n');
});

test('a commented file that is not a plain file is skipped instead of read', async () => {
  const text = 'We conclude that targeted grants matter.';
  const h = await setup({ store: [thread('a1', 'paper.tex', text, ...anchorOn(text, 'targeted grants'))] });
  fs.symlinkSync('/dev/zero', path.join(h.dir, 'paper.tex'));
  await h.seen.handlers['marginalia.reload']();
  assert.strictEqual(h.card('a1').status, 'detached');
});

test('a sentence rewritten outside VS Code keeps its comment after a restart', async (t) => {
  const v1 = 'Opening sentence of the paper here.\nThe estimate is large and significant in every specification.\nClosing words of the paper.';
  const v2 = v1.replace('large and significant', 'small but precise');
  const v3 = v2.replace('Opening sentence of the paper here.', 'A completely different first line now.');
  const h = await setup({ files: { 'main.tex': v1 }, store: [thread('a1', 'main.tex', v1, ...anchorOn(v1, 'The estimate is large and significant in every specification.'))] });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  fs.writeFileSync(path.join(h.dir, 'main.tex'), v2);
  h.seen.events.filesChange(h.vscode.Uri.file(path.join(h.dir, 'main.tex')));
  t.mock.timers.tick(300);
  t.mock.timers.reset();
  fs.writeFileSync(path.join(h.dir, 'main.tex'), v3);
  const later = await setup({ files: {}, store: h.stored() });
  fs.writeFileSync(path.join(later.dir, 'main.tex'), v3);
  await later.seen.handlers['marginalia.reload']();
  assert.deepStrictEqual([later.card('a1').status, later.card('a1').exact], ['exact', 'The estimate is small but precise in every specification.']);
});

test('renaming or moving a commented file in VS Code takes its comments along', async () => {
  const text = 'We conclude that targeted grants matter.';
  const h = await setup({ files: { 'main.tex': text, 'sections/a.tex': text }, store: [thread('a1', 'main.tex', text, ...anchorOn(text, 'targeted grants')), thread('b1', 'sections/a.tex', text, ...anchorOn(text, 'targeted grants'))] });
  fs.renameSync(path.join(h.dir, 'main.tex'), path.join(h.dir, 'intro.tex'));
  fs.renameSync(path.join(h.dir, 'sections'), path.join(h.dir, 'parts'));
  const uri = (rel) => h.vscode.Uri.file(path.join(h.dir, rel));
  h.seen.events.rename({ files: [{ oldUri: uri('main.tex'), newUri: uri('intro.tex') }, { oldUri: uri('sections'), newUri: uri('parts') }] });
  await h.seen.handlers['marginalia.reload']();
  assert.deepStrictEqual([h.card('a1').file, h.card('a1').status, h.card('b1').file, h.card('b1').status], ['intro.tex', 'exact', 'parts/a.tex', 'exact']);
});

test('a resolved comment follows edits like an open one', async () => {
  const v1 = 'Opening sentence of the paper here.\nThe estimate is large and significant in every specification.\nClosing words.';
  const v2 = v1.replace('large and significant', 'small but precise');
  const h = await setup({ files: { 'main.tex': v1 }, store: [thread('a1', 'main.tex', v1, ...anchorOn(v1, 'The estimate is large and significant in every specification.')), { t: 'status', id: 'a1', resolved: true }], open: ['main.tex'] });
  h.seen.events.save(h.openDoc('main.tex', v2).document);
  const anchors = h.stored().trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.t === 'anchor');
  assert.deepStrictEqual(anchors.map((e) => e.exact), ['The estimate is small but precise in every specification.']);
});

test('a comment being typed survives a settings change, and one that cannot be added is given back', async () => {
  const text = 'We conclude that targeted grants matter.';
  const h = await setup({ files: { 'main.tex': text }, open: ['main.tex'] });
  h.vscode.window.activeTextEditor.selection = new Range(0, 17, 0, 32);
  await h.seen.handlers['marginalia.addOnSelection']();
  await h.vscode.workspace.getConfiguration('marginalia').update('author', 'Someone Else');
  assert.strictEqual(h.state().compose.exact, 'targeted grants');
  await h.send({ type: 'cancel' });
  await h.send({ type: 'create', text: 'Cite something.' });
  assert.deepStrictEqual(h.posted.pop(), { type: 'restore', id: 'new', text: 'Cite something.' });
  assert.match(h.seen.infos.pop(), /could not be added/);
});
