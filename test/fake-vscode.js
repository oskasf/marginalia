const fs = require('fs');
const path = require('path');
const Module = require('module');

// A stand-in for the parts of the vscode module the extension uses. It records what the extension does in `seen`.

class Range {
  constructor(a, b, c, d) {
    this.start = typeof a === 'object' ? a : { line: a, character: b };
    this.end = typeof b === 'object' ? b : { line: c, character: d };
  }
  get isEmpty() {
    return this.start.line === this.end.line && this.start.character === this.end.character;
  }
  contains(p) {
    const { start, end } = this;
    return (p.line > start.line || (p.line === start.line && p.character >= start.character)) && (end.line > p.line || (end.line === p.line && end.character >= p.character));
  }
}

class ThemeIcon {
  constructor(id) {
    this.id = id;
  }
}
ThemeIcon.File = new ThemeIcon('file');

class MarkdownString {
  constructor(value = '', supportThemeIcons = false) {
    this.value = value;
    this.supportThemeIcons = supportThemeIcons;
  }
  appendMarkdown(s) {
    this.value += s;
    return this;
  }
  appendText(s) {
    this.value += s;
    return this;
  }
}

const Uri = {
  file: (p) => ({ scheme: 'file', fsPath: p, toString: () => 'file://' + p }),
  joinPath: (uri, ...parts) => Uri.file(path.join(uri.fsPath, ...parts)),
};

function createFake(dir) {
  const seen = {
    config: { root: dir, author: 'Tester', files: ['**/*.tex'] },
    scopes: {},
    updates: [],
    context: {},
    watched: [],
    handlers: {},
    providers: {},
    views: {},
    viewObjects: {},
    events: {},
    revealed: [],
    executed: [],
    warnings: [],
    infos: [],
    errors: [],
    warningAnswer: 'Delete',
  };
  const hook = (name) => (cb) => {
    seen.events[name] = cb;
    return { dispose: () => delete seen.events[name] };
  };
  const vscode = {
    Range,
    Uri,
    ThemeIcon,
    MarkdownString,
    ThemeColor: class {
      constructor(id) {
        this.id = id;
      }
    },
    RelativePattern: class {
      constructor(base, pattern) {
        this.base = base.fsPath;
        this.pattern = pattern;
      }
    },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    OverviewRulerLane: { Right: 4 },
    Hover: class {
      constructor(contents, range) {
        this.contents = contents;
        this.range = range;
      }
    },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    TreeItem: class {
      constructor(label, collapsibleState) {
        this.label = label;
        this.collapsibleState = collapsibleState;
      }
    },
    EventEmitter: class {
      constructor() {
        this.event = (cb) => {
          this.cb = cb;
          return { dispose() {} };
        };
      }
      fire() {
        if (this.cb) this.cb();
      }
      dispose() {}
    },
    workspace: {
      isTrusted: true,
      workspaceFolders: [{ uri: Uri.file(dir) }],
      textDocuments: [],
      // like VS Code, opening a file that does not exist fails
      openTextDocument: async (uri) => {
        if (!fs.existsSync(uri.fsPath)) throw new Error('cannot open ' + uri.fsPath);
        return { uri };
      },
      // like VS Code, a change to the settings is announced to the extension, which here is awaited
      // seen.scopes holds what inspect returns, by section and key, such as 'latexComments.author'
      getConfiguration: (section) => ({
        get: (k) => seen.config[k] ?? '',
        inspect: (k) => seen.scopes[section + '.' + k],
        update: async (k, value, target) => {
          if (section === 'latexComments') throw new Error('the old settings are only read');
          seen.config[k] = value;
          seen.updates.push([k, value, target]);
          await seen.events.config?.({ affectsConfiguration: (section) => section === 'marginalia' });
        },
      }),
      createFileSystemWatcher: ({ pattern }) => {
        seen.watched.push(pattern);
        const name = pattern === '.comments.jsonl' ? 'store' : 'files';
        return { onDidChange: hook(name + 'Change'), onDidCreate: hook(name + 'Create'), onDidDelete: hook(name + 'Delete'), dispose() {} };
      },
      onDidChangeTextDocument: hook('change'),
      onDidOpenTextDocument: hook('open'),
      onDidCloseTextDocument: hook('close'),
      onDidSaveTextDocument: hook('save'),
      onDidChangeConfiguration: hook('config'),
      onDidGrantWorkspaceTrust: hook('trust'),
    },
    window: {
      activeTextEditor: undefined,
      visibleTextEditors: [],
      createOutputChannel: () => ({ appendLine: (s) => seen.log?.push(s), dispose() {} }),
      createTextEditorDecorationType: (options) => ({ options, dispose() {} }),
      createTreeView: (id, options) => {
        seen.views[id] = options;
        return (seen.viewObjects[id] = { badge: undefined, visible: true, dispose() {}, onDidChangeVisibility: hook('visibility:' + id) });
      },
      showTextDocument: async (doc, opts) => {
        seen.revealed.push({ doc, opts });
      },
      onDidChangeVisibleTextEditors: hook('visible'),
      onDidChangeActiveTextEditor: hook('activeEditor'),
      onDidChangeTextEditorSelection: hook('selection'),
      onDidChangeWindowState: hook('windowState'),
      registerWebviewViewProvider: (id, provider, options) => ((seen.providers[id] = provider), { dispose() {} }),
      showWarningMessage: async (m) => (seen.warnings.push(m), seen.warningAnswer),
      showInformationMessage: async (m) => seen.infos.push(m),
      showErrorMessage: async (m) => seen.errors.push(m),
    },
    languages: {
      registerHoverProvider: (selector, provider) => ((seen.hoverSelector = selector), (seen.providers.hover = provider), { dispose() {} }),
      // like VS Code's globs, * also matches names that start with a dot
      match: (selector, doc) =>
        selector.some(({ scheme, pattern }) => {
          const glob = pattern.pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\/|\*\*|\*|\?/g, (m) => ({ '**/': '(.*/)?', '**': '.*', '*': '[^/]*', '?': '[^/]' })[m]);
          return scheme === doc.uri.scheme && new RegExp('^' + glob + '$').test(path.relative(pattern.base, doc.uri.fsPath));
        })
          ? 10
          : 0,
    },
    commands: {
      registerCommand: (name, fn) => ((seen.handlers[name] = fn), { dispose() {} }),
      executeCommand: async (name, ...args) => (name === 'setContext' ? (seen.context[args[0]] = args[1]) : seen.executed.push(name)),
    },
  };
  return { vscode, seen };
}

// Activates a fresh copy of the extension against a fake from createFake, then opens its Review panel
async function activate({ vscode, seen }) {
  const load = Module._load;
  Module._load = function (request, ...rest) {
    return request === 'vscode' ? vscode : load.call(this, request, ...rest);
  };
  delete require.cache[require.resolve('../extension')];
  const extension = require('../extension');
  Module._load = load;
  const context = { subscriptions: [], extensionUri: Uri.file(path.join(__dirname, '..')) };
  await extension.activate(context);

  const posted = [];
  let receive;
  const panel = {
    visible: true,
    onDidChangeVisibility: () => ({ dispose() {} }),
    onDidDispose: (cb) => ((panel.dispose = cb), { dispose() {} }),
    webview: {
      cspSource: 'vscode-webview:',
      asWebviewUri: (uri) => 'webview://' + uri.fsPath,
      postMessage: (m) => posted.push(m),
      onDidReceiveMessage: (cb) => ((receive = cb), { dispose: () => (receive = null) }),
    },
  };
  seen.providers['marginalia.cards']?.resolveWebviewView(panel);
  const send = (m) => receive(m);
  if (receive) await send({ type: 'ready' });
  return { context, panel, posted, send };
}

module.exports = { createFake, activate, Range };
