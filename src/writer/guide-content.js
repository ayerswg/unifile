/**
 * Unifile Writer — the full user guide, as Markdown.
 *
 * Single source of truth for the documentation: rendered in-app (Guide sheet,
 * via marked) AND published on the website (build/render-site.mjs imports this
 * module and emits /writer/guide/).  Keep it dependency-free plain ESM so Node
 * can import it during the site build.
 */

export const GUIDE_TITLE = 'Unifile Writer — Guide';

export const GUIDE_MD = `
Unifile Writer is a distraction-free Markdown writing app in the spirit of
iA Writer, with two things most writing apps don't have: **built-in
git-style version history** and **EPUB export** — and it runs **fully
offline**. Nothing ever leaves your device: no server, no account, no sync,
no telemetry.

## The editor

You write plain Markdown. The text you see *is* the file — syntax markers
stay visible but are dimmed, headings are emphasised, and list items get a
proper **hanging indent**: when a bullet wraps onto a second line, the
wrapped text lines up under the item's text, not under the bullet.

The caret line's paragraph can be isolated with **Focus mode** (in the ⋯
menu): everything except the paragraph you are writing is dimmed.

The toolbar above the keyboard (or at the bottom of the window) has, in
order: undo · redo · heading · bold · italic · strikethrough · code ·
bullet list · numbered list · task list · quote · outdent · indent · link.
Every button works on the current selection or caret line. On a hardware
keyboard: **⌘B** bold, **⌘I** italic, **⌘K** link, **⌘Z / ⇧⌘Z** undo/redo,
**Tab / ⇧Tab** indent/outdent in lists.

Pressing **Return** inside a list continues it (numbered lists renumber,
task lists add a fresh \`[ ]\`). Pressing Return on an *empty* list item
exits the list. **⇧Return** inserts a plain line break without continuing
the list.

## Markdown reference

Writer supports the CommonMark + GFM constructs that map cleanly onto an
EPUB. This is the complete list — everything here survives the round trip
into an e-book:

### Headings

\`\`\`
# Chapter title        (h1 — starts a new EPUB chapter)
## Section             (h2 — listed in the EPUB table of contents)
### Subsection         (h3 … ###### h6)
\`\`\`

### Emphasis

\`\`\`
**bold**   __bold__
*italic*   _italic_
***bold italic***
~~strikethrough~~
\`inline code\`
\`\`\`

### Lists

\`\`\`
- bullet item
* also a bullet
+ also a bullet
1. numbered item
2) also numbered
- [ ] open task
- [x] done task
\`\`\`

Indent two spaces to nest. Wrapped lines hang-indent under the item text in
the editor and export as proper nested lists.

### Block elements

~~~
> blockquote
> > nested quote

\`\`\`js
a code block, fenced with three backticks (or three tildes)
\`\`\`

---            (horizontal rule / scene break)
~~~

### Links & images

\`\`\`
[link text](https://example.com)
![alt text](https://example.com/image.png)
\`\`\`

Images referenced by URL stay URLs in the EPUB — most readers won't load
them offline. Images pasted as \`data:\` URIs are extracted into real image
files inside the EPUB and work everywhere.

### Tables (GFM)

\`\`\`
| Name  | Value |
|-------|------:|
| alpha |     1 |
\`\`\`

Tables render in the preview and export into the EPUB as real tables.

## Document metadata (front matter)

An optional block at the very top of the document sets the book's
metadata. It must start on line 1:

\`\`\`
---
title: My Novel
author: Jane Doe
language: en
description: A short description for the book record.
identifier: urn:isbn:9780000000000
---
\`\`\`

All keys are optional. \`title\` falls back to the document title in the
top bar; \`language\` defaults to \`en\`; \`identifier\` defaults to a
generated UUID. \`description\` becomes the EPUB's description field.

## EPUB export

**⋯ menu → Export → EPUB.** The export is built entirely on your device
and handed to the browser/share sheet as a \`.epub\` file (on iOS, use
"Save to Files" or share it straight to Apple Books).

How the document maps to the book:

- Every \`#\` (level-1) heading starts a **new chapter** (its own XHTML
  file in the book, so readers paginate cleanly).
- Text before the first \`#\` becomes an untitled opening chapter.
- \`##\` headings appear as sections beneath their chapter in the reader's
  **table of contents**.
- A **title page** is generated from the metadata (title + author).
- The output is standard **EPUB 3** with an EPUB 2 fallback TOC, so it
  opens in Apple Books, Kindle (via Send-to-Kindle), Kobo, Calibre, and
  friends.

You can also export the raw **Markdown** (\`.md\`) at any time — your text
is never locked in.

## Version history

Writer keeps a git-style history *inside* the document. Open **⋯ menu →
History**:

- **Commit** snapshots the current text (a message is optional). Commits
  are stored as diffs, so history stays small.
- Tap any commit to **restore** its text into the editor. Restoring
  doesn't delete anything — it just puts the old text back as the current
  (uncommitted) state; commit it to make it the new tip.
- The dot on the History menu item shows there are uncommitted changes.

Set your author name for commits in **⋯ menu → Settings**.

## Where your text lives

- **App (PWA):** documents are stored in the browser's IndexedDB on your
  device and autosaved as you type. Use **Export → Data file
  (.unifile.json)** for a durable backup — it contains the full text *and*
  the complete history, and can be imported back on any device.
- **Single-file (.html):** the downloaded file *is* the app and the
  document in one. "Save a copy" regenerates the file with your latest
  text and history embedded.

Autosave is instant, but browsers can evict site data under storage
pressure — export a data file (or an EPUB) for anything you care about.

## iOS install

Open the Writer page in Safari → Share → **Add to Home Screen**. The app
then launches full-screen, works completely offline, and keeps your
documents on the device. The share sheet is used for all exports, so you
can save straight to Files, Books, or any app.

## Privacy

There is no server. The only network request the app ever makes is a
version check against \`unifile.app/version.json\` to offer updates. Your
text never leaves the device unless *you* export or share it.
`;
