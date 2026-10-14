const vscode = acquireVsCodeApi();
const root = document.getElementById('root');
let state = { cards: [], activeId: null, compose: null };
const saved = vscode.getState() || {};
const drafts = saved.drafts || {};
let composeKey = saved.composeKey || null;
let resolvedOpen = saved.resolvedOpen || false;
let composing = false;
let deferred = false;
let lastBox = null; // the reply box that last had focus, to give it back when VS Code refocuses the panel
const save = () => vscode.setState({ drafts, composeKey, resolvedOpen });

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const ago = (ts) => {
  const seconds = (Date.now() - new Date(ts).getTime()) / 1000;
  if (!ts || isNaN(seconds)) return '';
  if (seconds < 60) return 'now';
  if (seconds < 3600) return Math.floor(seconds / 60) + 'm';
  if (seconds < 86400) return Math.floor(seconds / 3600) + 'h';
  if (seconds < 86400 * 30) return Math.floor(seconds / 86400) + 'd';
  return new Date(ts).toLocaleDateString();
};

const fit = (box) => {
  box.style.height = 'auto';
  box.style.height = box.scrollHeight + 2 + 'px';
};

function makeCard(c) {
  const card = el('div', 'card' + (c.resolved ? ' resolved' : '') + (c.id === state.activeId ? ' active' : '') + (drafts[c.id] ? ' hasdraft' : ''));
  card.dataset.id = c.id;
  const first = c.messages[0] || { author: 'unknown', text: '' };

  const head = el('div', 'head');
  head.append(el('span', 'author', first.author), el('span', 'meta', ago(first.ts)), el('span', 'spacer'));
  if (c.line >= 0) head.append(el('span', 'meta', 'L' + (c.line + 1)));
  for (const [label, className, title, message] of [
    ['Delete', 'link del', 'Delete this comment and its replies', { type: 'delete', id: c.id }],
    c.resolved
      ? ['Reopen', 'link', 'Mark this comment as open again', { type: 'resolve', id: c.id, resolved: false }]
      : ['Resolve', 'link', 'Mark this comment as resolved', { type: 'resolve', id: c.id, resolved: true }],
  ]) {
    const button = el('button', className, label);
    button.title = title;
    button.dataset.focus = message.type;
    button.addEventListener('click', (e) => {
      e.stopPropagation();
      vscode.postMessage(message);
    });
    head.append(button);
  }
  const quote = el('div', 'quote', c.exact);
  quote.tabIndex = 0;
  quote.dataset.focus = 'quote';
  quote.setAttribute('role', 'button');
  quote.setAttribute('aria-label', 'Go to commented text: ' + c.exact);
  card.append(head, quote);

  if (c.status === 'edited') card.append(el('div', 'note', 'Text changed since this comment'));
  if (c.status === 'detached') card.append(el('div', 'note warn', 'Text not found in the file'));
  if (first.text) card.append(el('div', 'body', first.text));
  for (const m of c.messages.slice(1)) {
    const reply = el('div', 'reply');
    reply.append(el('span', 'author', m.author), el('span', 'meta', ago(m.ts)), el('div', 'body', m.text));
    card.append(reply);
  }

  const box = el('textarea', 'replybox');
  box.rows = 1;
  box.placeholder = 'Reply (Enter to send)';
  box.setAttribute('aria-label', 'Reply to the comment by ' + first.author);
  box.value = drafts[c.id] || '';
  box.dataset.replyFor = c.id;
  card.append(box);

  card.addEventListener('click', (e) => e.target === box || vscode.postMessage({ type: 'go', id: c.id }));
  return card;
}

function makeCompose(c) {
  const card = el('div', 'card compose active');
  const head = el('div', 'head');
  head.append(el('span', 'author', 'New comment'), el('span', 'spacer'), el('span', 'meta', c.file + ' · L' + (c.line + 1)));
  card.append(head, el('div', 'quote', c.exact));

  const box = el('textarea', 'replybox');
  box.rows = 2;
  box.placeholder = 'Write a comment (Enter to post, Esc to cancel)';
  box.setAttribute('aria-label', 'New comment');
  box.value = drafts.new || '';
  box.dataset.replyFor = 'new';
  card.append(box);
  return card;
}

root.addEventListener('focusin', (e) => {
  if (e.target.dataset.replyFor) lastBox = e.target.dataset.replyFor;
  const card = e.target.closest('.card[data-id]');
  if (!card || card.dataset.id === state.activeId || !e.target.matches(':focus-visible')) return;
  state.activeId = card.dataset.id;
  markActive(false);
  vscode.postMessage({ type: 'focus', id: state.activeId });
});

root.addEventListener('input', (e) => {
  const box = e.target;
  drafts[box.dataset.replyFor] = box.value;
  box.closest('.card').classList.toggle('hasdraft', box.value !== '');
  fit(box);
  save();
});

root.addEventListener('compositionstart', () => (composing = true));
root.addEventListener('compositionend', () => {
  composing = false;
  if (deferred) draw();
  deferred = false;
});

root.addEventListener('keydown', (e) => {
  const target = e.target;
  const id = target.dataset.replyFor;
  if (target.classList.contains('quote') && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    vscode.postMessage({ type: 'go', id: target.closest('.card').dataset.id });
  }
  if (!id) return;
  if (e.key === 'Escape' && id !== 'new') target.blur();
  if (e.key === 'Escape' && id === 'new') {
    delete drafts.new;
    save();
    vscode.postMessage({ type: 'cancel' });
  }
  if (e.key !== 'Enter' || e.shiftKey || e.isComposing || e.keyCode === 229) return;
  e.preventDefault();
  const text = target.value.trim();
  if (!text) return;
  delete drafts[id];
  save();
  target.closest('.card').classList.remove('hasdraft');
  target.value = '';
  fit(target);
  vscode.postMessage(id === 'new' ? { type: 'create', text } : { type: 'reply', id, text });
});

function markActive(scroll) {
  for (const card of root.querySelectorAll('.card[data-id]')) card.classList.toggle('active', card.dataset.id === state.activeId);
  const active = root.querySelector('.card.active');
  if (active && scroll && active.parentElement.tagName === 'DETAILS') active.parentElement.open = true;
  const typing = document.activeElement && document.activeElement.tagName === 'TEXTAREA';
  if (active && scroll && !typing) active.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function draw() {
  const old = document.activeElement;
  const focused = root.contains(old) ? old.dataset.replyFor : undefined;
  const focusKind = root.contains(old) ? old.dataset.focus : undefined;
  const oldCard = focusKind && old.closest('.card[data-id]');
  const oldIndex = oldCard ? [...root.querySelectorAll('.card[data-id]')].filter((card) => card.checkVisibility()).indexOf(oldCard) : -1;
  const selection = focused && [old.selectionStart, old.selectionEnd, old.scrollTop];
  root.textContent = '';

  const key = state.compose ? [state.compose.file, state.compose.line, state.compose.exact].join('|') : null;
  const freshCompose = key !== null && key !== composeKey;
  if (freshCompose) delete drafts.new;
  if (key !== composeKey) {
    composeKey = key;
    save();
  }
  if (state.compose) root.append(makeCompose(state.compose));
  if (!state.cards.length && !state.compose) {
    root.append(el('div', 'empty', `No comments yet. Select text in a .tex file and press ${/Mac/.test(navigator.platform) ? 'Cmd+K Cmd+M' : 'Ctrl+K Ctrl+M'}, or right-click and choose "Add comment on selection". For other files, such as Markdown, right-click in one and choose "Enable comments for this file type".`));
  }

  const cards = [...state.cards].sort((a, b) => a.file.localeCompare(b.file) || (a.line < 0) - (b.line < 0) || a.line - b.line);
  let lastFile = null;
  for (const c of cards.filter((x) => !x.resolved)) {
    if (c.file !== lastFile) {
      root.append(el('div', 'file', c.file));
      lastFile = c.file;
    }
    root.append(makeCard(c));
  }

  const done = cards.filter((x) => x.resolved);
  if (done.length) {
    const group = el('details', 'resolvedgroup');
    group.open = resolvedOpen || done.some((c) => c.id === state.focus);
    group.addEventListener('toggle', () => {
      resolvedOpen = group.open;
      save();
    });
    group.append(el('summary', '', `Resolved (${done.length})`));
    for (const c of done) group.append(makeCard(c));
    root.append(group);
  }

  for (const box of root.querySelectorAll('textarea')) {
    if (box.value) fit(box);
  }
  let target = state.focus || (freshCompose ? 'new' : focused);
  if (target === 'new' && !state.compose) target = state.activeId;
  const box = target && root.querySelector(`textarea[data-reply-for="${CSS.escape(target)}"]`);
  if (box) {
    box.focus();
    lastBox = target;
    if (target === focused && !state.focus && !freshCompose) {
      box.setSelectionRange(selection[0], selection[1]);
      box.scrollTop = selection[2];
    } else {
      box.setSelectionRange(box.value.length, box.value.length);
    }
    box.scrollIntoView({ block: state.focus ? 'center' : 'nearest' });
  } else if (oldCard) {
    const cards = [...root.querySelectorAll('.card[data-id]')].filter((card) => card.checkVisibility());
    const same = cards.find((card) => card.dataset.id === oldCard.dataset.id);
    const card = same || cards[Math.min(oldIndex, cards.length - 1)];
    const next = card ? card.querySelector(`[data-focus="${focusKind}"]`) : root.querySelector('summary');
    if (next) next.focus();
  }
  markActive(false);
}

window.addEventListener('message', (event) => {
  const msg = event.data;
  if (msg.type === 'state') {
    state = msg;
    if (composing) deferred = true;
    else draw();
  }
  if (msg.type === 'active') {
    state.activeId = msg.id;
    markActive(true);
  }
  if (msg.type === 'restore') {
    drafts[msg.id] = msg.text;
    save();
    draw();
  }
});

// VS Code may move focus out of the webview and back while opening it, which leaves nothing focused
window.addEventListener('focus', () => {
  if (document.activeElement && document.activeElement !== document.body) return;
  const box = lastBox && root.querySelector(`textarea[data-reply-for="${CSS.escape(lastBox)}"]`);
  if (box) box.focus();
});

vscode.postMessage({ type: 'ready' });
