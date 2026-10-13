const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createFake, activate, Range } = require('./fake-vscode');

const sentence = 'Our main estimate is a large increase in citations for treated papers.';
const original = ['We study how funding shapes research.', sentence, 'We conclude that targeted grants matter.'].join('\n');
const sliceByRange = (text, r) => {
  const lines = text.split('\n');
  const offset = (p) => lines.slice(0, p.line).reduce((n, l) => n + l.length + 1, 0) + p.character;
  return text.slice(offset(r.start), offset(r.end));
};

// Activates a fresh copy of the extension on a folder with main.tex and two stored comments, one of them hand-written without an id
async function setup(tweak) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-ext-'));
  const mainPath = path.join(dir, 'main.tex');
  const storePath = path.join(dir, '.comments.jsonl');
  fs.writeFileSync(mainPath, original);
  fs.writeFileSync(
    storePath,
    [
      JSON.stringify({ t: 'thread', id: 'a1', file: 'main.tex', exact: sentence, prefix: 'We study how funding shapes research.', suffix: 'We conclude that targeted grants matter.', author: 'Oska', text: 'Is this right?' }),
      JSON.stringify({ file: 'main.tex', exact: 'targeted grants matter', author: 'Claude (LLM)', text: 'Cite something.' }),
    ].join('\n') + '\n'
  );
  const fake = createFake(dir);
  const { vscode, seen } = fake;
  const makeDoc = (text, scheme = 'file') => ({
    uri: { scheme, fsPath: mainPath, toString: () => scheme + '://' + mainPath },
    getText: () => text,
    offsetAt: (p) => text.split('\n').slice(0, p.line).reduce((n, l) => n + l.length + 1, 0) + p.character,
    lineAt: (n) => ({ range: new Range(n, 0, n, text.split('\n')[n].length) }),
  });
  const editor = { document: makeDoc(original), selection: new Range(0, 0, 0, 0), marks: [] };
  editor.setDecorations = (type, ranges) => (editor.marks = ranges);
  vscode.workspace.textDocuments.push(editor.document);
  vscode.window.visibleTextEditors.push(editor);
  vscode.window.activeTextEditor = editor;
  if (tweak) tweak(seen, vscode);
  const { context, panel, posted, send } = await activate(fake);
  const lastState = () => posted.filter((m) => m.type === 'state').pop();
  const h = {
    dir,
    mainPath,
    storePath,
    seen,
    vscode,
    editor,
    makeDoc,
    context,
    panel,
    posted,
    send,
    stored: () => fs.readFileSync(storePath, 'utf8'),
    storedEvents: () => h.stored().trim().split('\n').map((l) => JSON.parse(l)),
    lastState,
    lastPost: () => posted[posted.length - 1],
    card: (id) => lastState().cards.find((c) => c.id === id),
    hoverAt: (line, character, doc = editor.document) => seen.providers.hover.provideHover(doc, { line, character }),
    tree: seen.views['marginalia.threads']?.treeDataProvider,
    storage: seen.views['marginalia.storage']?.treeDataProvider,
    sidebar: seen.viewObjects['marginalia.threads'],
  };
  h.handId = lastState()?.cards[1].id;
  return h;
}

test('stored comments are highlighted by their quote, including a hand-written one', async () => {
  const h = await setup();
  assert.deepStrictEqual(h.editor.marks.map((r) => sliceByRange(original, r)), [sentence, 'targeted grants matter']);
  assert.match(h.handId, /^[0-9a-f]{8}$/, 'the hand-written comment gets an id from its content');
});

test('the cards panel loads only its own script and gets every comment', async () => {
  const h = await setup();
  assert.ok(h.panel.webview.options.enableScripts);
  assert.match(h.panel.webview.html, /script-src 'nonce-[0-9a-f]{32}'/);
  assert.match(h.panel.webview.html, /src="webview:\/\/.*media\/cards\.js"/);
  assert.match(h.panel.webview.html, /href="webview:\/\/.*media\/cards\.css"/);
  for (const name of ['cards.js', 'cards.css']) assert.ok(fs.existsSync(path.join(__dirname, '..', 'media', name)), name + ' ships with the extension');
  assert.deepStrictEqual(h.lastState().cards.map((c) => [c.id, c.line]), [['a1', 1], [h.handId, 2]]);
  assert.strictEqual(h.card('a1').exact, sentence);
  assert.strictEqual(h.card('a1').messages[0].text, 'Is this right?');
  assert.strictEqual(h.lastState().compose, null);
});

test('the sidebar tree lists files and threads in text order with an open count', async () => {
  const h = await setup();
  const fileNodes = h.tree.getChildren();
  assert.deepStrictEqual(fileNodes.map((n) => n.file), ['main.tex']);
  const threadNodes = h.tree.getChildren(fileNodes[0]);
  assert.deepStrictEqual(threadNodes.map((n) => n.id), ['a1', h.handId]);
  const item = h.tree.getTreeItem(threadNodes[0]);
  assert.strictEqual(item.label, 'Is this right?');
  assert.match(item.description, /^L2 · Oska/);
  assert.strictEqual(item.contextValue, 'open');
  assert.deepStrictEqual(item.command.arguments, ['a1']);
  assert.strictEqual(h.sidebar.badge.value, 2);
});

test('the comments file view shows where comments are kept and who posts them', async () => {
  const h = await setup();
  const [fileRow, folderRow, sharingRow, authorRow] = h.storage.getChildren();
  assert.strictEqual(fileRow.label, '.comments.jsonl');
  assert.match(fileRow.description, /^2 threads · \d+\.\d KB$/);
  assert.strictEqual(fileRow.command.command, 'vscode.open');
  assert.strictEqual(folderRow.label, 'Folder');
  assert.strictEqual(folderRow.command.command, 'revealFileInOS');
  assert.strictEqual(sharingRow.label, 'Stays on this computer');
  assert.strictEqual(sharingRow.description, 'not in a git repository');
  assert.strictEqual(authorRow.description, 'Tester');
});

test('hovering commented text shows the comment with Resolve and Reply links', async () => {
  const h = await setup();
  const hover = h.hoverAt(1, 10);
  assert.strictEqual(sliceByRange(original, hover.range), sentence);
  assert.strictEqual(hover.contents.length, 1);
  const popup = hover.contents[0];
  assert.match(popup.value, /\*\*Oska\*\*/);
  assert.match(popup.value, /Is this right\?/);
  assert.match(popup.value, /\(command:marginalia\.resolve\?%5B%22a1%22%5D\)/);
  assert.match(popup.value, /\(command:marginalia\.reply\?%5B%22a1%22%5D\)/);
  assert.ok(popup.supportThemeIcons);
  assert.deepStrictEqual(popup.isTrusted.enabledCommands, ['marginalia.resolve', 'marginalia.reply'], 'the popup can only run those two commands');
  assert.strictEqual(h.hoverAt(0, 3), undefined, 'text without a comment shows nothing');
  assert.match(h.hoverAt(2, 20).contents[0].value, /Claude \(LLM\)/);
  assert.strictEqual(h.hoverAt(1, 10, h.makeDoc(original, 'git')), undefined, 'a git diff of the same file shows nothing');
  assert.deepStrictEqual(h.seen.hoverSelector, { scheme: 'file' });
});

test('Reply in the popup focuses that comment\'s reply box once the panel has loaded', async () => {
  const h = await setup();
  await h.seen.handlers['marginalia.reply']('a1');
  assert.deepStrictEqual(h.seen.executed, ['marginalia.cards.focus']);
  assert.strictEqual(h.lastState().focus, 'a1');
  assert.strictEqual(h.lastState().activeId, 'a1');
  await h.send({ type: 'ready' });
  assert.strictEqual(h.lastState().focus, null, 'the request is only sent once');
  const count = h.posted.length;
  h.seen.executed.length = 0;
  await h.seen.handlers['marginalia.reply']('nope');
  assert.strictEqual(h.posted.length, count, 'a comment that no longer exists is ignored');
  assert.deepStrictEqual(h.seen.executed, []);
  h.seen.providers['marginalia.cards'].resolveWebviewView(h.panel);
  await h.seen.handlers['marginalia.reply']('a1');
  assert.strictEqual(h.posted.length, count, 'nothing is sent to a panel that has not loaded yet');
  await h.send({ type: 'ready' });
  assert.strictEqual(h.lastState().focus, 'a1', 'the request waits until it has');
});

test('replies, resolve and reopen reach the store, cards, popup and tree', async () => {
  const h = await setup();
  await h.send({ type: 'reply', id: 'a1', text: 'Yes, see Table 2.' });
  assert.match(h.stored(), /"t":"reply","id":"a1","author":"Tester"/);
  assert.strictEqual(h.card('a1').messages.length, 2);
  assert.match(h.hoverAt(1, 10).contents[0].value, /Yes, see Table 2\./);
  assert.match(h.tree.getTreeItem({ kind: 'thread', id: 'a1' }).description, /1 reply/);

  let treeFires = 0;
  h.tree.onDidChangeTreeData(() => treeFires++);
  await h.seen.handlers['marginalia.resolve']('a1');
  assert.strictEqual(h.card('a1').resolved, true);
  assert.ok(treeFires > 0, 'the tree refreshes');
  assert.strictEqual(h.hoverAt(1, 10), undefined, 'resolved comments stop showing in the text');
  assert.strictEqual(h.editor.marks.length, 1, 'and lose their highlight');
  const nodes = h.tree.getChildren({ kind: 'file', file: 'main.tex' });
  assert.deepStrictEqual(nodes.map((n) => n.id), [h.handId, 'a1'], 'resolved threads sink below open ones');
  assert.strictEqual(h.tree.getTreeItem(nodes[1]).contextValue, 'resolved');
  assert.strictEqual(h.sidebar.badge.value, 1);
  await h.seen.handlers['marginalia.reopen']({ kind: 'thread', id: 'a1' });
  assert.strictEqual(h.card('a1').resolved, false, 'Reopen from the tree undoes it');
  assert.strictEqual(h.sidebar.badge.value, 2);

  await h.send({ type: 'reply', id: h.handId, text: '  Added.  ' });
  assert.match(h.stored(), new RegExp(`"t":"reply","id":"${h.handId}","author":"Tester","ts":"[^"]+","text":"Added\\."`), 'replies to a hand-written comment use its id');
  await h.send({ type: 'resolve', id: h.handId, resolved: true });
  assert.strictEqual(h.card(h.handId).resolved, true);
  await h.send({ type: 'resolve', id: h.handId, resolved: false });
  assert.strictEqual(h.card(h.handId).resolved, false);
});

test('messages from the panel that do not make sense change nothing', async () => {
  const h = await setup();
  const before = h.stored();
  for (const msg of [
    { type: 'reply', id: 'nope', text: 'x' },
    { type: 'reply', id: 'a1', text: '   ' },
    { type: 'reply', id: 'a1', text: 5 },
    { type: 'resolve', id: 'nope', resolved: true },
    { type: 'delete', id: 'nope' },
    { type: 'go', id: 'nope' },
    { type: 'create', text: 'no comment is being written' },
  ])
    await h.send(msg);
  assert.strictEqual(h.stored(), before);
});

test('clicking an entry jumps to the text and moving the cursor highlights the card', async () => {
  const h = await setup();
  await h.seen.handlers['marginalia.reveal']('a1');
  assert.strictEqual(h.seen.revealed[0].opts.selection.start.line, 1);
  assert.deepStrictEqual(h.lastPost(), { type: 'active', id: 'a1' });
  await h.send({ type: 'go', id: h.handId });
  assert.strictEqual(h.seen.revealed[1].opts.selection.start.line, 2);
  const cursorAt = (line, character) => h.seen.events.selection({ textEditor: h.editor, selections: [{ active: { line, character } }] });
  cursorAt(1, 10);
  assert.deepStrictEqual(h.lastPost(), { type: 'active', id: 'a1' });
  const count = h.posted.length;
  cursorAt(1, 11);
  assert.strictEqual(h.posted.length, count, 'nothing is sent while it stays inside');
  cursorAt(0, 3);
  assert.deepStrictEqual(h.lastPost(), { type: 'active', id: null });

  const count2 = h.posted.length;
  await h.send({ type: 'focus', id: 'a1' });
  assert.strictEqual(h.posted.length, count2, 'focusing a card in the panel does not send anything back');
  assert.deepStrictEqual(h.seen.revealed.length, 2, 'nor move the editor');
  cursorAt(0, 4);
  assert.deepStrictEqual(h.lastPost(), { type: 'active', id: null }, 'but the extension knows which card is active');
});

test('adding a comment opens a card for the selection, or the line when nothing is selected', async () => {
  const h = await setup();
  const before = h.stored();
  h.editor.selection = new Range(0, 13, 0, 27);
  await h.seen.handlers['marginalia.addOnSelection']();
  assert.ok(h.seen.executed.includes('marginalia.cards.focus'));
  assert.deepStrictEqual(h.lastState().compose, { file: 'main.tex', line: 0, exact: 'funding shapes' });
  await h.send({ type: 'create', text: '   ' });
  assert.strictEqual(h.stored(), before, 'an empty comment is not saved');
  assert.ok(h.lastState().compose, 'and the card stays open');
  await h.send({ type: 'cancel' });
  assert.strictEqual(h.lastState().compose, null);

  h.editor.selection = new Range(0, 5, 0, 5);
  await h.seen.handlers['marginalia.addOnSelection']();
  assert.strictEqual(h.lastState().compose.exact, 'We study how funding shapes research.');
  await h.send({ type: 'cancel' });
  h.editor.selection = new Range(0, 2, 0, 3);
  await h.seen.handlers['marginalia.addOnSelection']();
  assert.strictEqual(h.lastState().compose, null, 'selecting only a space does not start a comment');
  assert.match(h.seen.infos[0], /select some text/);

  h.vscode.window.activeTextEditor = { document: { uri: { scheme: 'file', fsPath: '/elsewhere/x.tex' } }, selection: new Range(0, 0, 0, 3) };
  await h.seen.handlers['marginalia.addOnSelection']();
  h.vscode.window.activeTextEditor = { document: h.makeDoc(original, 'untitled'), selection: new Range(0, 0, 0, 3) };
  await h.seen.handlers['marginalia.addOnSelection']();
  assert.strictEqual(h.seen.warnings.length, 2);
  assert.match(h.seen.warnings[0], /not saved inside the comments root/);
  assert.strictEqual(h.lastState().compose, null);
});

test('a new comment is saved, shown, and removed again after confirming Delete', async () => {
  const h = await setup();
  h.editor.selection = new Range(0, 13, 0, 27);
  await h.seen.handlers['marginalia.addOnSelection']();
  await h.send({ type: 'create', text: 'Say "public funding"?' });
  const added = h.storedEvents().find((e) => e.exact === 'funding shapes');
  assert.strictEqual(added.t, 'thread');
  assert.strictEqual(added.file, 'main.tex');
  assert.strictEqual(added.prefix, 'We study how');
  assert.strictEqual(added.author, 'Tester');
  assert.strictEqual(added.text, 'Say "public funding"?');
  assert.strictEqual(h.lastState().compose, null);
  assert.strictEqual(h.card(added.id).messages[0].text, 'Say "public funding"?');
  assert.strictEqual(h.lastState().activeId, added.id);
  assert.strictEqual(h.lastState().focus, added.id, 'the panel is asked to focus the new card');
  assert.ok(h.editor.marks.some((r) => sliceByRange(original, r) === 'funding shapes'));
  assert.match(h.hoverAt(0, 15).contents[0].value, /public funding/);

  h.seen.warningAnswer = undefined;
  await h.send({ type: 'delete', id: added.id });
  assert.match(h.seen.warnings[0], /Delete this comment thread/);
  assert.ok(h.card(added.id), 'cancelling the confirmation keeps it');
  h.seen.warningAnswer = 'Delete';
  await h.send({ type: 'delete', id: added.id });
  assert.strictEqual(h.card(added.id), undefined);
  assert.strictEqual(h.editor.marks.length, 2);
  assert.match(h.stored(), new RegExp(`"t":"delete","id":"${added.id}","author":"Tester"`));
  assert.ok(!h.tree.getChildren({ kind: 'file', file: 'main.tex' }).some((n) => n.id === added.id));
  assert.strictEqual(h.lastState().activeId, null);
});

test('a file reflowed on disk, as after a git pull, keeps its comments in place', async () => {
  const h = await setup();
  h.vscode.workspace.textDocuments.length = 0;
  h.vscode.window.visibleTextEditors.length = 0;
  const reflowed = original.replace(/\n/g, ' ').replace(/(.{30,}?) /g, '$1\n');
  fs.writeFileSync(h.mainPath, reflowed);
  await h.seen.handlers['marginalia.reload']();
  assert.strictEqual(h.card('a1').line, reflowed.slice(0, reflowed.indexOf('Our main')).split('\n').length - 1);
  h.editor.document = h.makeDoc(reflowed);
  h.vscode.workspace.textDocuments.push(h.editor.document);
  h.vscode.window.visibleTextEditors.push(h.editor);
  await h.seen.handlers['marginalia.reload']();
  assert.strictEqual(sliceByRange(reflowed, h.editor.marks[0]).replace(/\s+/g, ''), sentence.replace(/\s+/g, ''));
});

test('edited text is flagged until saved, and saving right away stores the new wording', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = await setup();
  const type = (text) => {
    h.editor.document = h.makeDoc(text);
    h.vscode.workspace.textDocuments[0] = h.editor.document;
    h.seen.events.change({ document: h.editor.document, contentChanges: [{}] });
  };
  const longer = original.replace('large increase', 'very large increase');
  type(longer);
  t.mock.timers.tick(300);
  assert.strictEqual(h.card('a1').status, 'edited');
  assert.match(h.hoverAt(1, 10).contents[0].value, /Commented text has changed/);
  assert.strictEqual(sliceByRange(longer, h.editor.marks[0]), sentence.replace('large increase', 'very large increase'));
  type(longer + ' ');
  t.mock.timers.tick(300);
  assert.strictEqual(h.card('a1').status, 'edited', 'it stays flagged after the next keystroke');

  const newest = original.replace('large increase', 'huge increase');
  type(newest);
  h.seen.events.save(h.editor.document);
  await h.seen.handlers['marginalia.reload']();
  const anchors = h.storedEvents().filter((e) => e.t === 'anchor');
  assert.strictEqual(anchors.length, 1);
  assert.match(anchors[0].exact, /^Our main estimate is a huge increase/, 'a save before the typing pause stores what is in the editor');
  assert.strictEqual(anchors[0].author, 'Tester');
  assert.strictEqual(h.card('a1').status, 'exact');
  assert.doesNotMatch(h.hoverAt(1, 10).contents[0].value, /changed/);
  h.seen.events.save(h.editor.document);
  assert.strictEqual(h.storedEvents().filter((e) => e.t === 'anchor').length, 1, 'saving again stores nothing new');
});

test('deleted text leaves a detached comment', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = await setup();
  h.editor.document = h.makeDoc(original.replace(sentence + '\n', ''));
  h.vscode.workspace.textDocuments[0] = h.editor.document;
  h.seen.events.change({ document: h.editor.document, contentChanges: [{}] });
  t.mock.timers.tick(300);
  assert.strictEqual(h.card('a1').status, 'detached');
  assert.strictEqual(h.card('a1').line, -1);
  assert.strictEqual(h.hoverAt(1, 5), undefined);
  const item = h.tree.getTreeItem({ kind: 'thread', id: 'a1' });
  assert.match(item.description, /detached/);
  assert.strictEqual(item.iconPath.id, 'warning');
});

test('a write of our own is not reloaded twice when the file watcher reports it', async () => {
  const h = await setup();
  await h.send({ type: 'reply', id: 'a1', text: 'once' });
  const count = h.posted.length;
  await h.seen.events.storeChange();
  assert.strictEqual(h.posted.length, count);
  fs.appendFileSync(h.storePath, JSON.stringify({ t: 'reply', id: 'a1', author: 'Sami', text: 'from a co-author' }) + '\n');
  await h.seen.events.storeChange();
  assert.strictEqual(h.card('a1').messages.length, 3, 'a change from outside is picked up');
});

test('settings under the old latexComments name are copied where the new one is unset, once', async () => {
  const scopes = {
    'latexComments.author': { globalValue: 'Old Name' },
    'latexComments.root': { workspaceValue: '.', workspaceFolderValue: '.' },
    'latexComments.files': { workspaceValue: ['**/*.md'] },
    'marginalia.files': { workspaceValue: ['**/*.txt'] },
  };
  const h = await setup((seen) => (seen.scopes = scopes));
  const { Global, Workspace } = h.vscode.ConfigurationTarget;
  assert.deepStrictEqual(h.seen.updates, [['root', '.', Workspace], ['author', 'Old Name', Global]], 'a value already set under the new name is kept, and a single folder is written once');
  assert.strictEqual(h.storage.getChildren()[3].description, 'Old Name', 'the copied setting is used straight away');
  scopes['marginalia.root'] = { workspaceValue: '.', workspaceFolderValue: '.' };
  scopes['marginalia.author'] = { globalValue: 'Old Name' };
  const again = await setup((seen) => (seen.scopes = scopes));
  assert.deepStrictEqual(again.seen.updates, [], 'nothing is copied a second time');
});

test('changing the author setting applies to the next comment', async () => {
  const h = await setup();
  h.seen.config.author = 'Renamed';
  await h.seen.events.config({ affectsConfiguration: (s) => s === 'marginalia' });
  assert.strictEqual(h.storage.getChildren()[3].description, 'Renamed');
  await h.send({ type: 'reply', id: 'a1', text: 'hi' });
  assert.match(h.stored(), /"author":"Renamed"/);
});

test('the comments file view tells whether git shares the file', async () => {
  const h = await setup();
  const gitIn = (...args) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: h.dir, stdio: 'ignore' });
  const sharing = async () => {
    await h.seen.events['visibility:marginalia.storage']({ visible: true });
    return h.storage.getChildren()[2];
  };
  gitIn('init', '-q');
  assert.strictEqual((await sharing()).label, 'Not shared yet');
  fs.writeFileSync(path.join(h.dir, '.gitignore'), '.comments.jsonl\n');
  assert.strictEqual((await sharing()).description, 'ignored by git');
  fs.unlinkSync(path.join(h.dir, '.gitignore'));
  gitIn('add', '.comments.jsonl');
  gitIn('commit', '-q', '-m', 'comments');
  assert.strictEqual((await sharing()).label, 'Shared through git');
  assert.strictEqual((await sharing()).description, 'committed');
  fs.appendFileSync(h.storePath, '{"file":"main.tex","exact":"funding shapes","text":"later"}\n');
  assert.strictEqual((await sharing()).description, 'new comments not committed yet');
});

test('git is not run in an untrusted folder', async () => {
  const h = await setup((seen, vscode) => {
    vscode.workspace.isTrusted = false;
    seen.config.author = '';
  });
  assert.strictEqual(h.storage.getChildren()[2].description, 'git is not checked in an untrusted folder');
  assert.strictEqual(h.storage.getChildren()[3].description, os.userInfo().username);
});

test('without a folder open the commands explain why they do nothing and the views do not keep loading', async () => {
  const h = await setup((seen, vscode) => (vscode.workspace.workspaceFolders = undefined));
  assert.deepStrictEqual(Object.keys(h.seen.handlers).sort(), ['addOnSelection', 'enableFileType', 'reload', 'reopen', 'reply', 'resolve', 'reveal'].map((n) => 'marginalia.' + n));
  await h.seen.handlers['marginalia.addOnSelection']();
  assert.match(h.seen.infos[0], /open a folder/);
  assert.deepStrictEqual(h.tree.getChildren(), []);
  assert.deepStrictEqual(h.storage.getChildren(), []);
  assert.match(h.panel.webview.html, /open a folder/);
});

test('a folder opened through a symlink inside a git repository still gets its comments', async () => {
  const h = await setup((seen, vscode) => {
    const real = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const link = real + '-link';
    execFileSync('git', ['init', '-q'], { cwd: real });
    fs.mkdirSync(path.join(real, 'sections'));
    fs.symlinkSync(real, link);
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(path.join(link, 'sections')) }];
    vscode.window.activeTextEditor.document.uri.fsPath = path.join(link, 'main.tex');
    seen.config.root = '';
  });
  assert.strictEqual(h.storage.getChildren()[1].tooltip.split('\n')[0], h.dir + '-link', 'the root is the top of the repository, spelled through the link');
  assert.strictEqual(h.editor.marks.length, 2);
  assert.match(h.hoverAt(1, 10).contents[0].value, /Is this right\?/);
});

test('closing the extension disposes what it created', async () => {
  const h = await setup();
  assert.ok(h.context.subscriptions.every((s) => typeof s.dispose === 'function'));
  for (const s of h.context.subscriptions) s.dispose();
});
