---
title: Why one file?
pinned: true
---

The file is the unit of trust on the internet. You can email it, version it with git, drag it into a chat, attach it to a ticket. The moment you need a server to mediate access to your document, you've introduced a dependency that will eventually fail.

Unifile is a bet that the file format is the right primitive — not the cloud service, not the account, not the workspace.

## The tradeoffs are real

A single HTML file can't do real-time collaboration out of the box. It can't sync across devices automatically. These are genuine limitations, not oversights.

But for a huge class of work — personal notes, drafts, technical specs, presentations you'll give once — these tradeoffs are fine. You don't need a server watching your every keystroke.

## What you gain

When your document is a file, you own it completely. You can back it up with any tool that copies files. You can diff it. You can put it in git. You can open it in ten years on a computer that doesn't have Unifile installed, because the renderer is embedded in the file itself.

That last part is the strange trick: Unifile documents are self-rendering. The viewer is inside the file.
