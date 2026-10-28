# Changelog

## 0.1.1

- Comments in an open file now move with each edit, as on Overleaf, so they stay on their text when you rewrite it together with the words around it, or delete it and type something new in its place. Before, such edits could leave a comment detached, which often showed up after replying to it.

## 0.1.0

First public release.

- Overleaf-style comment threads on selected text, with replies, Resolve and Delete, shown as cards in the sidebar and in hover popups.
- Comments are stored in one plain text file, `.comments.jsonl`, at the top of your git repository, so they can be committed and shared with co-authors.
- Comments are attached to the text they quote, so they follow it through edits, reflowed paragraphs, git pulls, edits made outside VS Code, and files renamed or moved in VS Code.
- On for `.tex` files by default. Other file types can be turned on with "Enable comments for this file type" or the `marginalia.files` setting.
- Purple highlights and scrollbar marks, which can be changed with `marginalia.highlightBackground` and `marginalia.overviewRuler`.
- Settings from the earlier `latexComments.*` names are copied to `marginalia.*` once.
