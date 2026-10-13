# Changelog

## Unreleased

- New logo and sidebar icon. Commented text, the active card's outline and the scrollbar marks are now purple to match.
- Renamed from latex-comments to Marginalia. Commands, views, colours and settings are now under `marginalia.*`. Settings you had under `latexComments.*` are copied to the new names when the extension starts, at the same level (user, workspace or folder), wherever the new name is not set yet; the old ones are left in place. `.comments.jsonl` keeps its name and format.
- Comments can be turned on for other file types with "Enable comments for this file type" or the `marginalia.files` setting. `.tex` files stay the default.
- The extension also starts in any folder that has a `.comments.jsonl`.

## 0.0.1

- Comment threads on selected text in `.tex` files, stored in `.comments.jsonl` in the project root.
- Review cards in the sidebar, hover popups with Resolve and Reply, a tree list and a "Comments file" status view.
- Comments follow their text through edits, reflows and git pulls, and edited anchors are saved with the file.
