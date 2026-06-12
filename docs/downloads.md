---
layout: page
title: Downloads
permalink: /downloads/
pinned: true
---

Everything is offline-first. **Downloads** are a single `.html` file you save and open in any browser — no install, no server. **Apps** install as offline Progressive Web Apps.

<ul class="app-list">
{% for app in site.data.apps %}
  <li>
    <a href="{{ app.url | relative_url }}">{{ app.title }}</a>
    <span class="app-kind app-kind--{{ app.kind }}">{{ app.kind }}</span>
    <span class="app-desc">{{ app.excerpt }}</span>
  </li>
{% endfor %}
</ul>

Tip: anywhere on the site, just start typing in the command bar (`>`) to jump straight to any of these.
