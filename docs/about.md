---
layout: page
title: About
permalink: /about/
---

Unifile started as a question: what if a document knew what kind of content it contained?

Most tools force you to pick one format — a Markdown editor, a diagramming tool, a music notation app. Unifile lets you mix them freely, treating each section of your file as its own little program.

The whole thing is a single `.html` file you can save, share, and open anywhere. No build step for end users, no cloud dependency, no account required.

## The format

A Unifile document is plain text. Sections are separated by shebang lines that declare which DSL handles them:

```
#!markdown
# My document

#!mermaid
sequenceDiagram
  Alice->>Bob: Hello
```

Sections without a shebang default to Markdown.

## Who made this

Built by [Will Ayers](https://unifile.app).
