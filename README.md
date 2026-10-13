<img src="images/logo.png" width="128" alt="Marginalia logo">

# Marginalia

**Overleaf-style comments for your LaTeX projects, right inside VS Code.**

Select some text, leave a comment, and it shows up as a card in the margin. Co-authors can reply to it and resolve it, just as they would on Overleaf. Your papers stay in your own editor and repository, and nothing is uploaded anywhere.

- **Comment threads** with replies and Resolve, shown as cards beside your text
- **Stored in your repo** as one plain text file, so comments are shared through git
- **Robust to editing**: comments follow their text when you rewrite, reflow or pull changes
- **Not just LaTeX**: you can turn it on for Markdown, code or any other text file

![Review cards beside a LaTeX file](images/review-sidebar.png)

## Getting started

1. Install Marginalia and open your paper's folder.
2. Select some text in a `.tex` file, then right-click and choose **Add comment on selection** (or press Ctrl+K Ctrl+M, Cmd+K Cmd+M on a Mac). Type your comment and press Enter.
3. Commented text is highlighted. Hover over it to read, reply or resolve. Click the Marginalia icon in the activity bar to see every comment as a card.

Tip: drag the Marginalia icon to the right-hand side of the window to keep the cards next to your text.

![Adding a comment on a selected line](images/add-comment.png)

![Hovering over commented text shows the comment with Resolve and Reply](images/hover.png)

## Where comments are stored

Comments live in one file, `.comments.jsonl`, at the top of your git repository. If there's no repository, the file goes in the folder you opened. To use a different folder, set `marginalia.root`.

Comments are attached to the text they quote, not to a line number, so they survive edits elsewhere in the file and reflowed paragraphs. If the commented text itself changes, the comment follows it and its card says so.

## Sharing with co-authors

Commit `.comments.jsonl` like any other file, and your co-authors see your comments when they pull. So that two people commenting at the same time never get a merge conflict, add this line to `.gitattributes`:

    .comments.jsonl merge=union

To keep your comments private, add `.comments.jsonl` to `.gitignore` instead.

## Other file types

Comments are on for `.tex` files by default. To use them in another kind of file, right-click in it and choose **Enable comments for this file type**. The `marginalia.files` setting holds the full list.

## Settings

| Setting | What it does |
|---|---|
| `marginalia.author` | The name shown on your comments. Defaults to your git `user.name`. |
| `marginalia.root` | The folder that holds `.comments.jsonl`. Defaults to the top of your git repository. |
| `marginalia.files` | Which files can have comments. Defaults to `["**/*.tex"]`. |

To change the colours, use `marginalia.highlightBackground` and `marginalia.overviewRuler` under `workbench.colorCustomizations`. If something isn't working, open View > Output and choose "Marginalia".

## File format

Each line of `.comments.jsonl` is one JSON object. People and LLMs can add comments by writing a single `thread` line:

    {"t":"thread","id":"a1b2c3d4","file":"sections/intro.tex","exact":"the commented text","author":"Name","text":"The comment"}
    {"t":"reply","id":"a1b2c3d4","author":"Name","text":"A reply"}
    {"t":"status","id":"a1b2c3d4","resolved":true}

- A thread needs `file` (relative to the root) and `exact` (the text to attach to). `id` is optional, and may only use letters, digits, `_` and `-`.
- `prefix`, `suffix` and `offset` are optional. They tell apart copies of the same words.
- The extension also writes `ts` timestamps, `anchor` lines (which move a comment to edited text) and `delete` lines.
- Lines that aren't valid JSON are skipped. This includes git conflict markers.

## Development

Press F5 in this folder to try changes in a second VS Code window. Run `npm test` for the tests, and `npm run package` to build a `.vsix` you can install locally.

## License

MIT
