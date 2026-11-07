# Changelog

## 0.1.3

- The Review panel now shows the comments on the file you're working on, and follows you as you switch files. Buttons at the top switch between **This file** and **All files**, with a count of open comments on each, and a link at the bottom says how many open comments are on other files. Glancing at a file that can't have comments, such as settings, leaves the panel where it was. In **All files**, the file you're working on comes first.

## 0.1.2

- Resolve and Delete in the Review panel now always respond to a click. Before, a click could be lost when the panel jumped back to a reply box as you clicked into it from the editor, or when the cards were redrawn while the mouse button was held down. The buttons also have a larger click area, so a click just beside the word no longer opens the comment instead.

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
