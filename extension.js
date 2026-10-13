const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { promisify } = require('util');
const { execFile } = require('child_process');
const { parse, append } = require('./store');
const { squash, makeAnchor, findAnchor, toPos } = require('./anchor');

const exec = promisify(execFile);

async function activate(context) {
  const folder = vscode.workspace.workspaceFolders?.find((f) => f.uri.scheme === 'file')?.uri.fsPath;
  if (!folder) {
    const why = 'Marginalia: open a folder on this computer to use comments.';
    for (const name of ['addOnSelection', 'enableFileType', 'reload', 'reveal', 'reply', 'resolve', 'reopen']) {
      context.subscriptions.push(vscode.commands.registerCommand('marginalia.' + name, () => void vscode.window.showInformationMessage(why)));
    }
    // empty views, so the sidebar shows its welcome text instead of loading forever
    for (const id of ['marginalia.threads', 'marginalia.storage']) {
      context.subscriptions.push(vscode.window.createTreeView(id, { treeDataProvider: { getChildren: () => [], getTreeItem: (item) => item } }));
    }
    context.subscriptions.push(vscode.window.registerWebviewViewProvider('marginalia.cards', { resolveWebviewView: (panel) => (panel.webview.html = `<meta http-equiv="Content-Security-Policy" content="default-src 'none';"><p>${why}</p>`) }));
    return;
  }

  // git is never run in an untrusted folder, since its config can run programs
  const git = (cwd, ...args) => (vscode.workspace.isTrusted ? exec('git', args, { cwd }).then((r) => r.stdout.trim(), () => null) : Promise.resolve(null));
  let root = folder;
  let storePath = path.join(root, '.comments.jsonl');
  let author = os.userInfo().username;
  let watchers = [];
  let selector = []; // one filter per glob in the marginalia.files setting

  const out = vscode.window.createOutputChannel('Marginalia');
  const highlight = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('marginalia.highlightBackground'),
    overviewRulerColor: new vscode.ThemeColor('marginalia.overviewRuler'),
    overviewRulerLane: vscode.OverviewRulerLane.Right,
  });

  let data = new Map(); // id -> thread as read from .comments.jsonl
  let lastText; // the text data was parsed from, null when the file does not exist
  const live = new Map(); // id -> where the comment currently sits and its refreshed anchor
  const shown = new Map(); // id -> what was last sent to the sidebar, so we only update on change
  let sharing = { label: 'Checking', note: '', icon: 'loading~spin' };

  const relOf = (uri) => {
    if (uri.scheme !== 'file') return null;
    const rel = path.relative(root, uri.fsPath).split(path.sep).join('/');
    return rel === '..' || rel.startsWith('../') || path.isAbsolute(rel) ? null : rel;
  };
  const enabled = (doc) => vscode.languages.match(selector, doc) > 0;
  const covers = (t, rel, pos) => !t.resolved && t.file === rel && live.get(t.id)?.range?.contains(pos);
  // Adds one line to the store and says whether that worked, telling the user when it did not
  const write = (t, id, extra) => {
    try {
      append(storePath, { t, id, author, ts: new Date().toISOString(), ...extra });
      return true;
    } catch (e) {
      vscode.window.showErrorMessage(`Marginalia: could not save to ${storePath}: ${e.message}`);
      return false;
    }
  };
  const record = (t, id, extra) => write(t, id, extra) && reload();

  let cardsPanel; // the Review cards webview, once VS Code has opened it
  let cardsReady = false; // true once its script has loaded and asked for the comments
  let activeId = null; // the open comment the cursor is inside
  let pending = null; // a new comment being typed in the Review panel: { file, line, anchor, offset }
  let focusReply = null; // id of a card whose reply box the panel should focus the next time it is updated
  const pushCards = () => {
    if (!cardsPanel || !cardsReady) return;
    const cards = [...data.values()].map((t) => {
      const lv = live.get(t.id) || { status: 'detached', line: -1 };
      return { id: t.id, file: t.file, line: lv.line, status: lv.status, resolved: t.resolved, exact: t.exact, messages: t.messages };
    });
    const compose = pending ? { file: pending.file, line: pending.line, exact: pending.anchor.exact } : null;
    cardsPanel.webview.postMessage({ type: 'state', cards, activeId, compose, focus: focusReply });
    focusReply = null;
  };

  let changed = false;
  const treeChanged = new vscode.EventEmitter();
  const provider = {
    onDidChangeTreeData: treeChanged.event,
    getChildren: (node) => {
      const threads = [...data.values()];
      if (!node) return [...new Set(threads.map((t) => t.file))].sort().map((file) => ({ kind: 'file', file }));
      if (node.kind !== 'file') return [];
      return threads
        .filter((t) => t.file === node.file)
        .map((t) => [t, live.get(t.id)?.line ?? -1])
        .sort(([x, a], [y, b]) => x.resolved - y.resolved || (a < 0) - (b < 0) || a - b)
        .map(([t]) => ({ kind: 'thread', id: t.id }));
    },
    getTreeItem: (node) => {
      if (node.kind === 'file') {
        const open = [...data.values()].filter((t) => t.file === node.file && !t.resolved).length;
        const item = new vscode.TreeItem(node.file, vscode.TreeItemCollapsibleState.Expanded);
        item.id = 'file:' + node.file;
        item.description = open ? `${open} open` : 'all resolved';
        item.resourceUri = vscode.Uri.file(path.join(root, node.file));
        item.iconPath = vscode.ThemeIcon.File;
        return item;
      }
      const t = data.get(node.id);
      if (!t) return new vscode.TreeItem('');
      const lv = live.get(t.id) || {};
      const first = [...(t.messages[0]?.text ?? t.exact).split('\n')[0]]; // whole characters, so an emoji is never cut in half
      const replies = t.messages.length - 1;
      const item = new vscode.TreeItem(first.length > 70 ? first.slice(0, 67).join('') + '...' : first.join(''), vscode.TreeItemCollapsibleState.None);
      item.id = 'thread:' + t.id;
      item.description = [
        lv.line >= 0 ? 'L' + (lv.line + 1) : null,
        t.messages[0]?.author,
        replies > 0 ? `${replies} ${replies === 1 ? 'reply' : 'replies'}` : null,
        lv.status === 'edited' ? 'text changed' : null,
        lv.status === 'detached' ? 'detached' : null,
      ]
        .filter(Boolean)
        .join(' · ');
      item.tooltip = `"${t.exact}"\n\n` + t.messages.map((m) => `${m.author}: ${m.text}`).join('\n\n');
      item.iconPath = new vscode.ThemeIcon(t.resolved ? 'check' : lv.status === 'detached' ? 'warning' : 'comment');
      item.contextValue = t.resolved ? 'resolved' : 'open';
      item.command = { command: 'marginalia.reveal', title: 'Open comment', arguments: [t.id] };
      return item;
    },
  };
  const view = vscode.window.createTreeView('marginalia.threads', { treeDataProvider: provider });

  const storageChanged = new vscode.EventEmitter();
  const storageView = vscode.window.createTreeView('marginalia.storage', {
    treeDataProvider: {
      onDidChangeTreeData: storageChanged.event,
      getTreeItem: (item) => item,
      getChildren: () => {
        const exists = lastText != null;
        const file = new vscode.TreeItem('.comments.jsonl');
        file.iconPath = new vscode.ThemeIcon('file');
        file.tooltip = storePath;
        file.description = exists ? `${data.size} thread${data.size === 1 ? '' : 's'} · ${(Buffer.byteLength(lastText) / 1024).toFixed(1)} KB` : 'not created yet';
        if (exists) file.command = { command: 'vscode.open', title: 'Open comments file', arguments: [vscode.Uri.file(storePath)] };

        const place = new vscode.TreeItem('Folder');
        place.iconPath = new vscode.ThemeIcon('folder');
        place.description = root === os.homedir() || root.startsWith(os.homedir() + path.sep) ? '~' + root.slice(os.homedir().length) : root;
        place.tooltip = `${root}\nClick to show it in your file manager`;
        place.command = { command: 'revealFileInOS', title: 'Show in file manager', arguments: [vscode.Uri.file(exists ? storePath : root)] };

        const row = new vscode.TreeItem(sharing.label);
        row.iconPath = new vscode.ThemeIcon(sharing.icon);
        row.description = sharing.note;
        row.tooltip = 'Comments are only a text file in your project. Co-authors see them when the file is committed and pushed.';

        const who = new vscode.TreeItem('Posting as');
        who.iconPath = new vscode.ThemeIcon('account');
        who.description = author;
        who.tooltip = 'Taken from git config user.name. Click to change it in settings.';
        who.command = { command: 'workbench.action.openSettings', title: 'Open settings', arguments: ['marginalia.author'] };

        return [file, place, row, who];
      },
    },
  });

  function render(onlyFile) {
    try {
      const marks = new Map();
      const files = new Map();
      for (const t of data.values()) {
        if (onlyFile && t.file !== onlyFile) continue;
        if (!files.has(t.file)) {
          const open = vscode.workspace.textDocuments.find((d) => relOf(d.uri) === t.file);
          let text = null;
          try {
            text = open ? open.getText() : fs.readFileSync(path.join(root, t.file), 'utf8');
          } catch {}
          files.set(t.file, text === null ? null : { text, sq: squash(text) });
        }
        const file = files.get(t.file);
        const prev = live.get(t.id);
        const hint = prev?.start ?? t.offset;
        // when the live anchor is lost, the stored one may still fit, e.g. after a co-author's re-anchor arrives with git pull
        const found = file && (findAnchor(file.sq, prev?.anchor ?? t, hint) || (prev && findAnchor(file.sq, t, hint)));

        let lv;
        if (found) {
          const a = toPos(file.text, found.start);
          const b = toPos(file.text, found.end);
          const anchor = makeAnchor(file.text, found.start, found.end);
          // edited until the new wording is saved to the store
          const status = squash(anchor.exact).s === squash(t.exact).s ? 'exact' : 'edited';
          lv = { start: found.start, line: a.line, range: new vscode.Range(a.line, a.character, b.line, b.character), anchor, status };
          if (!t.resolved) marks.set(t.file, [...(marks.get(t.file) || []), lv.range]);
        } else {
          lv = { start: hint, line: -1, range: undefined, anchor: prev?.anchor ?? t, status: 'detached' };
        }
        live.set(t.id, lv);

        const sig = [t.messages.length, t.resolved, lv.status, lv.line].join('|');
        if (shown.get(t.id) !== sig) {
          shown.set(t.id, sig);
          changed = true;
        }
      }

      for (const editor of vscode.window.visibleTextEditors) {
        const rel = relOf(editor.document.uri);
        if (!onlyFile || rel === onlyFile) editor.setDecorations(highlight, enabled(editor.document) ? marks.get(rel) || [] : []);
      }

      if (changed) {
        changed = false;
        treeChanged.fire();
        const open = [...data.values()].filter((t) => !t.resolved).length;
        view.badge = open ? { value: open, tooltip: `${open} open comment${open === 1 ? '' : 's'}` } : undefined;
        pushCards();
      }
    } catch (e) {
      out.appendLine(e.stack);
    }
  }

  // Rereads the store when it changed (or when forced), then refreshes
  async function reload(force) {
    try {
      const text = fs.existsSync(storePath) ? fs.readFileSync(storePath, 'utf8') : null;
      if (text === lastText && force !== true) return;
      lastText = text;
      data = text === null ? new Map() : parse(text);
      for (const id of [...shown.keys()]) {
        if (data.has(id)) continue;
        shown.delete(id);
        live.delete(id);
        if (activeId === id) activeId = null;
        changed = true;
      }
    } catch (e) {
      out.appendLine(e.stack);
    }
    return refresh();
  }

  // Redraws the comments from the files as they are now and rechecks whether git shares the store, without rereading it
  async function refresh() {
    render();
    if (!storageView.visible) return;
    let [label, note, icon] = ['Stays on this computer', 'not in a git repository', 'device-desktop'];
    const inRepo = lastText !== null && (await git(root, 'rev-parse', '--is-inside-work-tree')) !== null;
    if (lastText === null) [label, note, icon] = ['Nothing saved yet', 'created with your first comment', 'circle-outline'];
    else if (!vscode.workspace.isTrusted) note = 'git is not checked in an untrusted folder';
    else if (inRepo && (await git(root, 'check-ignore', '-q', '.comments.jsonl')) !== null) note = 'ignored by git';
    else if (inRepo && (await git(root, 'ls-files', '--error-unmatch', '.comments.jsonl')) !== null) {
      label = 'Shared through git';
      note = (await git(root, 'diff', '--quiet', 'HEAD', '--', '.comments.jsonl')) !== null ? 'committed' : 'new comments not committed yet';
      icon = 'source-control';
    } else if (inRepo) [label, note, icon] = ['Not shared yet', 'git add and commit it so co-authors can see it', 'info'];
    sharing = { label, note, icon };
    storageChanged.fire();
  }

  // Works out the root and author from settings and git, then reads that root's store
  let runs = 0;
  async function configure(e) {
    if (e && !e.affectsConfiguration('marginalia')) return;
    const run = ++runs;
    const config = vscode.workspace.getConfiguration('marginalia');
    // --show-cdup keeps the folder's path as VS Code spells it, where --show-toplevel would resolve a symlink in it
    const top = path.resolve(folder, config.get('root') || (await git(folder, 'rev-parse', '--show-cdup')) || '.');
    const name = config.get('author') || (await git(top, 'config', 'user.name')) || os.userInfo().username;
    if (run !== runs) return; // a newer run has started
    root = top;
    storePath = path.join(root, '.comments.jsonl');
    author = name;
    watchers.forEach((w) => w.dispose());
    const store = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(root), '.comments.jsonl'));
    store.onDidChange(reload);
    store.onDidCreate(reload);
    store.onDidDelete(reload);
    selector = [config.get('files')].flat().filter((glob) => glob && typeof glob === 'string').map((glob) => ({ scheme: 'file', pattern: new vscode.RelativePattern(vscode.Uri.file(root), glob) }));
    // so a file that is not open is redrawn when it changes on disk, as after a git pull
    const files = selector.map(({ pattern }) => vscode.workspace.createFileSystemWatcher(pattern));
    for (const w of files) {
      w.onDidChange(touch);
      w.onDidCreate(touch);
      w.onDidDelete(touch);
    }
    watchers = [store, ...files];
    setFileKey(vscode.window.activeTextEditor);
    live.clear();
    shown.clear();
    pending = null;
    activeId = null;
    changed = true;
    out.appendLine(`root: ${root}`);
    out.appendLine(`author: ${author}`);
    await reload(true);
    out.appendLine(`threads loaded: ${data.size}`);
  }

  async function reveal(id) {
    const t = data.get(id);
    if (!t) return;
    activeId = id;
    if (cardsPanel) cardsPanel.webview.postMessage({ type: 'active', id });
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, t.file))).catch(() => null);
    if (!doc) return vscode.window.showWarningMessage(`Marginalia: cannot open ${t.file}, it may have been moved or deleted.`);
    const at = live.get(id)?.range?.start;
    await vscode.window.showTextDocument(doc, { selection: at ? new vscode.Range(at, at) : undefined });
  }

  const cardsProvider = {
    resolveWebviewView(panel) {
      cardsPanel = panel;
      cardsReady = false;
      const media = vscode.Uri.joinPath(context.extensionUri, 'media');
      const nonce = crypto.randomBytes(16).toString('hex');
      panel.webview.options = { enableScripts: true, localResourceRoots: [media] };
      panel.webview.html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${panel.webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'cards.css'))}">
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'cards.js'))}"></script>
</body>
</html>`;

      const listeners = [
        panel.webview.onDidReceiveMessage(async (msg) => {
          if (msg.type === 'ready') {
            cardsReady = true;
            return pushCards();
          }
          if (msg.type === 'cancel') {
            pending = null;
            return pushCards();
          }
          if (msg.type === 'create') {
            if (!pending || typeof msg.text !== 'string' || !msg.text.trim()) return;
            const id = crypto.randomBytes(4).toString('hex');
            const { file, anchor, offset } = pending;
            if (!write('thread', id, { file, ...anchor, offset, text: msg.text.trim() })) return panel.webview.postMessage({ type: 'restore', id: 'new', text: msg.text });
            pending = null;
            activeId = id;
            focusReply = id;
            return reload();
          }
          if (!data.has(msg.id)) return;
          if (msg.type === 'focus') {
            activeId = msg.id;
            return;
          }
          if (msg.type === 'go') return reveal(msg.id);
          if (msg.type === 'resolve') return record('status', msg.id, { resolved: msg.resolved === true });
          if (msg.type === 'reply' && typeof msg.text === 'string' && msg.text.trim()) return record('reply', msg.id, { text: msg.text.trim() }) || panel.webview.postMessage({ type: 'restore', id: msg.id, text: msg.text });
          if (msg.type === 'delete') {
            const answer = await vscode.window.showWarningMessage('Delete this comment thread?', { modal: true, detail: 'It is removed for everyone who gets this comments file.' }, 'Delete');
            if (answer === 'Delete') return record('delete', msg.id);
          }
        }),
        // a hidden panel is unloaded, and asks for the comments again when it is shown
        panel.onDidChangeVisibility(() => {
          if (!panel.visible) cardsReady = false;
        }),
      ];
      panel.onDidDispose(() => {
        listeners.forEach((l) => l.dispose());
        if (cardsPanel === panel) cardsPanel = undefined;
      });
    },
  };

  // lets menus and the keybinding tell whether comments are on for the file in the editor
  const setFileKey = (editor) => vscode.commands.executeCommand('setContext', 'marginalia.enabledFile', !!editor && enabled(editor.document));

  const dirty = new Set();
  let timer;
  const touch = (uri) => {
    const rel = relOf(uri);
    if (!rel) return;
    dirty.add(rel);
    clearTimeout(timer);
    timer = setTimeout(() => {
      for (const f of dirty) render(f);
      dirty.clear();
    }, 300);
  };

  context.subscriptions.push(
    out,
    highlight,
    view,
    storageView,
    treeChanged,
    storageChanged,
    { dispose: () => clearTimeout(timer) },
    { dispose: () => watchers.forEach((w) => w.dispose()) }
  );

  // the extension used to be latex-comments: copy each old setting to the new name at every scope where the new one is unset
  const folderUri = vscode.Uri.file(folder);
  const scopes = { globalValue: vscode.ConfigurationTarget.Global, workspaceValue: vscode.ConfigurationTarget.Workspace, workspaceFolderValue: vscode.ConfigurationTarget.WorkspaceFolder };
  for (const key of ['files', 'root', 'author']) {
    const was = vscode.workspace.getConfiguration('latexComments', folderUri).inspect(key) || {};
    const now = vscode.workspace.getConfiguration('marginalia', folderUri).inspect(key) || {};
    for (const [scope, target] of Object.entries(scopes)) {
      // in a single-folder window the folder's settings are also the workspace's, so they are copied once
      if (was[scope] === undefined || now[scope] !== undefined || (scope === 'workspaceFolderValue' && was[scope] === was.workspaceValue)) continue;
      await vscode.workspace.getConfiguration('marginalia', folderUri).update(key, was[scope], target).then(
        () => out.appendLine(`copied setting latexComments.${key} to marginalia.${key}`),
        (e) => out.appendLine(`could not copy setting latexComments.${key}: ${e.message}`)
      );
    }
  }

  // nothing below runs before the root is known
  await configure();

  context.subscriptions.push(
    storageView.onDidChangeVisibility((e) => e.visible && refresh()),
    vscode.window.onDidChangeWindowState((e) => e.focused && refresh()),
    vscode.workspace.onDidChangeConfiguration(configure),
    vscode.workspace.onDidGrantWorkspaceTrust(() => configure()),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.contentChanges.length) touch(e.document.uri);
    }),
    vscode.workspace.onDidOpenTextDocument((d) => touch(d.uri)),
    vscode.workspace.onDidCloseTextDocument((d) => touch(d.uri)),
    vscode.window.onDidChangeVisibleTextEditors((editors) => editors.forEach((e) => touch(e.document.uri))),
    vscode.window.onDidChangeActiveTextEditor(setFileKey),
    vscode.languages.registerHoverProvider(
      { scheme: 'file' },
      {
        provideHover(doc, position) {
          if (!enabled(doc)) return;
          const rel = relOf(doc.uri);
          const here = [...data.values()].filter((t) => covers(t, rel, position));
          if (!here.length) return;
          const cards = here.map((t) => {
            const md = new vscode.MarkdownString('', true);
            md.isTrusted = { enabledCommands: ['marginalia.resolve', 'marginalia.reply'] };
            const arg = encodeURIComponent(JSON.stringify([t.id]));
            t.messages.forEach((m, i) => {
              const d = new Date(m.ts);
              if (i) md.appendMarkdown('\n\n');
              md.appendMarkdown('**').appendText(m.author).appendMarkdown('** ');
              md.appendText(isNaN(d) ? '' : d.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }));
              if (!i) md.appendMarkdown(`&nbsp;&nbsp;[$(check) Resolve](command:marginalia.resolve?${arg})`);
              md.appendMarkdown('\n\n').appendText(m.text);
            });
            if (live.get(t.id).status === 'edited') md.appendMarkdown('\n\n_Commented text has changed_');
            return md.appendMarkdown(`\n\n[$(reply) Reply](command:marginalia.reply?${arg})`);
          });
          return new vscode.Hover(cards, live.get(here[0].id).range);
        },
      }
    ),
    vscode.window.registerWebviewViewProvider('marginalia.cards', cardsProvider),
    vscode.window.onDidChangeTextEditorSelection((e) => {
      const rel = relOf(e.textEditor.document.uri);
      if (!rel || !enabled(e.textEditor.document)) return;
      const cursor = e.selections[0].active;
      const current = data.get(activeId);
      const id = current && covers(current, rel, cursor) ? activeId : ([...data.values()].find((t) => covers(t, rel, cursor))?.id ?? null);
      if (id === activeId) return;
      activeId = id;
      if (cardsPanel) cardsPanel.webview.postMessage({ type: 'active', id });
    }),

    vscode.workspace.onDidSaveTextDocument((d) => {
      const rel = relOf(d.uri);
      if (!rel) return;
      // render now so a save right after typing does not store the anchor from before the debounce
      dirty.delete(rel);
      render(rel);
      let wrote = false;
      for (const t of data.values()) {
        const lv = live.get(t.id);
        if (t.file === rel && !t.resolved && lv?.status === 'edited') wrote = write('anchor', t.id, { ...lv.anchor, offset: lv.start }) || wrote;
      }
      if (wrote) reload();
    }),

    vscode.commands.registerCommand('marginalia.reload', () => reload(true)),
    vscode.commands.registerCommand('marginalia.reveal', reveal),

    vscode.commands.registerCommand('marginalia.addOnSelection', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const doc = editor.document;
      const rel = relOf(doc.uri);
      if (!rel) {
        vscode.window.showWarningMessage(`Marginalia: this file is not saved inside the comments root (${root}).`);
        return;
      }
      if (!enabled(doc)) {
        vscode.window.showInformationMessage('Marginalia: comments are off for this file type. Right-click in the file and choose "Enable comments for this file type".');
        return;
      }
      let range = editor.selection;
      if (range.isEmpty) range = doc.lineAt(range.start.line).range;
      const offset = doc.offsetAt(range.start);
      const anchor = makeAnchor(doc.getText(), offset, doc.offsetAt(range.end));
      if (!anchor.exact.trim()) {
        vscode.window.showInformationMessage('Marginalia: select some text to comment on.');
        return;
      }
      pending = { file: rel, line: range.start.line, anchor, offset }; // offset tells apart copies of the text with the same surroundings
      await vscode.commands.executeCommand('marginalia.cards.focus');
      pushCards();
    }),

    vscode.commands.registerCommand('marginalia.enableFileType', async () => {
      const doc = vscode.window.activeTextEditor?.document;
      const ext = doc && relOf(doc.uri) && path.extname(doc.uri.fsPath);
      if (!ext) {
        vscode.window.showInformationMessage(`Marginalia: open a file inside ${root} whose name ends in an extension, such as notes.md.`);
        return;
      }
      const globs = selector.map((filter) => filter.pattern.pattern);
      if (!globs.includes('**/*' + ext)) await vscode.workspace.getConfiguration('marginalia').update('files', [...globs, '**/*' + ext], vscode.ConfigurationTarget.Workspace);
      vscode.window.showInformationMessage(`Marginalia: comments are on for ${ext} files.`);
    }),

    ...[
      ['resolve', true],
      ['reopen', false],
    ].map(([name, resolved]) =>
      vscode.commands.registerCommand(`marginalia.${name}`, (arg) => {
        const id = typeof arg === 'string' ? arg : arg?.id;
        if (data.has(id)) return record('status', id, { resolved });
      })
    ),

    vscode.commands.registerCommand('marginalia.reply', async (arg) => {
      const id = typeof arg === 'string' ? arg : arg?.id;
      if (!data.has(id)) return;
      activeId = id;
      focusReply = id;
      await vscode.commands.executeCommand('marginalia.cards.focus');
      pushCards();
    })
  );
}

module.exports = { activate };
