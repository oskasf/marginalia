---
name: marginalia-feedback
description: Give feedback on a document as Marginalia comments anchored to the exact text, to review in VS Code. Use when asked to review, critique, proofread or comment on a file in a project that uses Marginalia (.comments.jsonl).
---

# Feedback as Marginalia comments

Read the document and leave feedback as comments on the exact passages, like a co-author would in Overleaf. The user then works through them in VS Code.

## Steps

1. Save the helper (see below) and run `list` for the file, so you know what is already being discussed.
2. Read the whole document before commenting, including files it `\input`s if they are relevant.
3. Write the comments to a JSON file and run `add`.
4. In chat, say how many comments you left and give the two or three most important points in a sentence each. Overall remarks that don't belong to one passage go here too.

## What good feedback looks like

- Do not edit the document. In this mode you only add comments.
- Follow the focus the user gives (clarity, argument, maths, typos, "as a referee", a word limit…). With no focus, give a general review: correctness and argument first, then clarity and structure, then wording and typos.
- One point per comment, in one to three sentences. Be specific about what is wrong and why. When a rewording helps, give it as `Suggest: …`.
- Quote the shortest passage that pins down the spot, usually a phrase or a sentence, never a whole paragraph.
- Prioritise. Unless asked for more, leave at most about 15 comments per file, and group repeated small issues (e.g. one comment saying "inconsistent tense throughout this section").
- Don't repeat a point already raised in an open thread. If someone has replied to one of your earlier comments, answer them in that thread with `reply` rather than starting a new one.
- Never resolve or delete threads in this mode.

## The comment file and the helper

Marginalia keeps every comment in one file, `.comments.jsonl`, at the top of the git repository (or the folder set in the `marginalia.root` VS Code setting). Each line is one event: a new comment thread, a reply, or a resolve. VS Code shows changes to the file straight away.

Never edit, reorder or delete lines in `.comments.jsonl` yourself. Use the helper at the end of this file, which reads the file exactly as the extension does and only ever appends lines. First save it:

```bash
awk '/^```python marginalia.py$/{f=1;next} /^```$/{f=0} f' "<this skill's folder>/SKILL.md" > /tmp/marginalia.py
```

If that fails, write the code block out to `/tmp/marginalia.py` yourself. Run it from inside the project; file paths can be relative to where you run it.

- `python3 /tmp/marginalia.py list [--all] [FILE...]` prints open threads (all with `--all`): the id, file and line, the quoted text, then each message as `author: text`.
- `python3 /tmp/marginalia.py add < comments.json` adds new threads. The input is a JSON list of `{"file": ..., "quote": ..., "text": ...}`. `quote` is copied from the document exactly, LaTeX commands included; spaces and line breaks don't need to match. If the quote appears more than once, add `"near": <line number>` or quote more words.
- `python3 /tmp/marginalia.py reply < replies.json` adds replies. The input is a JSON list of `{"id": ..., "text": ...}`, with `"resolved": true` or `false` to resolve or reopen a thread.

Write the JSON with your file tool (e.g. `/tmp/mg.json`), not with `echo`, so backslashes survive. If the helper reports a problem it writes nothing at all, so fix the input and run it again. New lines are signed "Claude"; set `MARGINALIA_AUTHOR` to change that.

VS Code only shows comments in file types listed in the `marginalia.files` setting (`**/*.tex` by default). For other files, tell the user to run "Marginalia: Enable comments for this file type".

## Helper code

```python marginalia.py
#!/usr/bin/env python3
# Reads and adds Marginalia comments (.comments.jsonl) the same way the VS Code extension does. It only ever appends lines.
# Usage: marginalia.py list [--all] [FILE...]  |  marginalia.py add < comments.json  |  marginalia.py reply < replies.json
import hashlib, json, os, posixpath, re, secrets, subprocess, sys
from datetime import datetime, timezone

CONTEXT = 48


def js_str(v):
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return "null" if v is None else str(v)


def text_of(v):
    return v if isinstance(v, str) else ""


def clean_file(v):
    if not text_of(v):
        return None
    f = posixpath.normpath(v.replace("\\", "/"))
    if posixpath.isabs(f) or re.match(r"^[a-z]:", f, re.I) or f == ".." or f.startswith("../"):
        return None
    return f


def is_int(v):
    return (isinstance(v, int) and not isinstance(v, bool)) or (isinstance(v, float) and v.is_integer())


def find_root():
    if os.environ.get("MARGINALIA_ROOT"):
        return os.path.abspath(os.environ["MARGINALIA_ROOT"])
    try:
        with open(".vscode/settings.json") as fh:
            setting = re.search(r'"marginalia\.root"\s*:\s*"([^"]+)"', fh.read())
        if setting:
            return os.path.abspath(setting.group(1))
    except OSError:
        pass
    git = subprocess.run(["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True)
    return git.stdout.strip() if git.returncode == 0 else os.getcwd()


def parse(text):
    threads = {}
    for line in text.split("\n"):
        s = line.strip()
        if not s.startswith("{"):
            continue
        try:
            ev = json.loads(s)
        except ValueError:
            continue
        if not isinstance(ev, dict):
            continue
        msg = {"author": text_of(ev.get("author")) or "unknown", "text": text_of(ev.get("text"))}
        kind = ev.get("t")
        if kind in ("reply", "status", "anchor", "delete", "move"):
            t = threads.get(js_str(ev.get("id")))
            if not t:
                continue
            if kind == "reply" and msg["text"]:
                t["messages"].append(msg)
            if kind == "status" and isinstance(ev.get("resolved"), bool):
                t["resolved"] = ev["resolved"]
            if kind == "delete":
                del threads[t["id"]]
            if kind == "move" and clean_file(ev.get("file")):
                t["file"] = clean_file(ev["file"])
            if kind == "anchor" and text_of(ev.get("exact")).strip():
                t.update(exact=ev["exact"], prefix=text_of(ev.get("prefix")), suffix=text_of(ev.get("suffix")), offset=int(ev["offset"]) if is_int(ev.get("offset")) else 0)
            continue
        f = clean_file(ev.get("file"))
        if not f or not text_of(ev.get("exact")).strip():
            continue
        if ev.get("id") is None:
            key = json.dumps([ev.get(k) for k in ("file", "exact", "text", "ts", "author")], ensure_ascii=False, separators=(",", ":"))
            tid = hashlib.sha1(key.encode()).hexdigest()[:8]
        else:
            tid = js_str(ev["id"])
        if not re.fullmatch(r"[\w-]+", tid, re.ASCII) or tid in threads:
            continue
        threads[tid] = {"id": tid, "file": f, "exact": ev["exact"], "prefix": text_of(ev.get("prefix")), "suffix": text_of(ev.get("suffix")),
                        "offset": int(ev["offset"]) if is_int(ev.get("offset")) else 0, "messages": [msg] if msg["text"] else [], "resolved": False}
    return threads


def squash(text):
    keep = [i for i, c in enumerate(text) if not c.isspace()]
    return "".join(text[i] for i in keep), keep


def occurrences(s, quote):
    found, i = [], s.find(quote)
    while i != -1:
        found.append(i)
        i = s.find(quote, i + 1)
    return found


def line_of(text, offset):
    return text.count("\n", 0, offset) + 1


def locate(text, t):
    s, keep = squash(text)
    quote = squash(t["exact"])[0]
    before, after = squash(t["prefix"])[0][-8:], squash(t["suffix"])[0][:8]
    best = None
    for i in occurrences(s, quote):
        score = (bool(before) and s[:i].endswith(before)) + (bool(after) and s[i + len(quote):].startswith(after))
        rank = (-score, abs(keep[i] - t["offset"]))
        if best is None or rank < best[0]:
            best = (rank, keep[i])
    return None if best is None else line_of(text, best[1])


def make_anchor(text, start, end):
    tidy = lambda x: re.sub(r"\s+", " ", x).strip()
    lo, n = start, 0
    while lo > 0 and n < CONTEXT:
        n += not text[lo - 1].isspace()
        lo -= 1
    hi, n = end, 0
    while hi < len(text) and n < CONTEXT:
        n += not text[hi].isspace()
        hi += 1
    return {"exact": tidy(text[start:end]), "prefix": tidy(text[lo:start]), "suffix": tidy(text[end:hi]), "offset": start}


def read_store(path):
    if not os.path.lexists(path):
        return ""
    if os.path.islink(path) or not os.path.isfile(path):
        sys.exit(f"{path} is not a plain file, so it is not used")
    with open(path, encoding="utf-8") as fh:
        return fh.read()


def append(path, events):
    current = read_store(path)
    lead = "\n" if current and not current.endswith("\n") else ""
    fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o644)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(lead + "".join(json.dumps(e, ensure_ascii=False) + "\n" for e in events))


root = find_root()
store = os.path.join(root, ".comments.jsonl")
author = os.environ.get("MARGINALIA_AUTHOR", "Claude")
now = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
threads = parse(read_store(store))
command = sys.argv[1] if len(sys.argv) > 1 else ""


def rel(f):
    return posixpath.normpath(os.path.relpath(os.path.abspath(f), root).replace(os.sep, "/"))


def doc_text(f):
    with open(os.path.join(root, f), encoding="utf-8") as fh:
        return fh.read()


if command == "list":
    show_all = "--all" in sys.argv
    only = {rel(f) for f in sys.argv[2:] if f != "--all"}
    print(f"store: {store}")
    for t in threads.values():
        if (t["resolved"] and not show_all) or (only and t["file"] not in only):
            continue
        try:
            line = locate(doc_text(t["file"]), t)
        except OSError:
            line = None
        where = f"{t['file']}:{line}" if line else f"{t['file']} (text no longer found)"
        print(f"\n[{t['id']}] {where} {'resolved' if t['resolved'] else 'open'}\n  on: \"{t['exact']}\"")
        for m in t["messages"]:
            print(f"  {m['author']}: {m['text']}")
elif command == "add":
    events, problems = [], []
    for item in json.load(sys.stdin):
        f, quote, body = rel(item["file"]), item["quote"], item["text"].strip()
        try:
            text = doc_text(f)
        except OSError as e:
            problems.append(f"{f}: {e.strerror}")
            continue
        s, keep = squash(text)
        q = squash(quote)[0]
        hits = occurrences(s, q) if q else []
        if not hits:
            problems.append(f'{f}: quote not found: "{quote}"')
            continue
        if len(hits) > 1 and "near" not in item:
            problems.append(f'{f}: quote appears {len(hits)} times (lines {", ".join(str(line_of(text, keep[i])) for i in hits)}), add "near": <line> or quote more words: "{quote}"')
            continue
        i = min(hits, key=lambda h: abs(line_of(text, keep[h]) - item.get("near", 0)))
        anchor = make_anchor(text, keep[i], keep[i + len(q) - 1] + 1)
        events.append({"t": "thread", "id": secrets.token_hex(4), "author": author, "ts": now, "file": f, **anchor, "text": body})
    if problems:
        sys.exit("Nothing was written. Fix these and run again:\n" + "\n".join(problems))
    append(store, events)
    for e in events:
        print(f"added [{e['id']}] {e['file']}:{line_of(doc_text(e['file']), e['offset'])} on \"{e['exact'][:60]}\"")
elif command == "reply":
    items = json.load(sys.stdin)
    missing = [str(it["id"]) for it in items if str(it["id"]) not in threads]
    if missing:
        sys.exit("Nothing was written. No thread with id: " + ", ".join(missing))
    events = []
    for it in items:
        if it.get("text", "").strip():
            events.append({"t": "reply", "id": str(it["id"]), "author": author, "ts": now, "text": it["text"].strip()})
        if isinstance(it.get("resolved"), bool):
            events.append({"t": "status", "id": str(it["id"]), "author": author, "ts": now, "resolved": it["resolved"]})
    append(store, events)
    print(f"wrote {len(events)} line(s) to {store}")
else:
    sys.exit("Usage: marginalia.py list [--all] [FILE...] | add < comments.json | reply < replies.json")
```
