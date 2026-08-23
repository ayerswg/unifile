/**
 * EPUB 3 export — Markdown → .epub, fully client-side.
 *
 * Pipeline per chapter:  marked (GFM) → DOMPurify → DOM transforms →
 * XMLSerializer (well-formed XHTML for EPUB content documents).
 *
 * Structure of the produced archive:
 *   mimetype                     (MUST be first + stored — see zip.js)
 *   META-INF/container.xml
 *   OEBPS/package.opf            metadata + manifest + spine
 *   OEBPS/nav.xhtml              EPUB 3 nav (chapters + their h2 sections)
 *   OEBPS/toc.ncx                EPUB 2 fallback toc for older readers
 *   OEBPS/css/style.css
 *   OEBPS/text/titlepage.xhtml
 *   OEBPS/text/ch001.xhtml …     one file per `#` (h1) chapter
 *   OEBPS/images/img001.png …    images extracted from data: URIs
 *
 * Chapters split on level-1 headings (`# Title`) outside code fences.  Content
 * before the first `#` becomes an untitled leading chapter.  Document metadata
 * (title/author/language/…) comes from the optional leading front-matter block
 * (core/front-matter.js) with the app-level title as fallback.
 *
 * Remote (http…) image URLs are passed through untouched — most readers won't
 * load them offline; data: URIs are converted into real image files inside the
 * archive so they work everywhere.
 */

import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { parseGlobalFrontMatter } from '../core/front-matter.js';
import { buildZip } from './zip.js';

const XHTML_NS = 'http://www.w3.org/1999/xhtml';

function escXml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** Strip inline Markdown markers for plain-text titles (nav/toc/metadata). */
export function plainTitle(s) {
  return String(s)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*\*|___|\*\*|__|~~|`)/g, '')
    .replace(/(^|\s)[*_](\S(?:.*?\S)?)[*_](?=\s|$)/g, '$1$2')
    .trim();
}

/** Filesystem-safe slug for the suggested filename. */
export function slugify(s) {
  const slug = String(s).toLowerCase().normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'untitled';
}

/**
 * Split the Markdown body into chapters at `# ` headings outside code fences.
 * @returns {Array<{ title: string|null, md: string }>}
 */
export function splitChapters(body) {
  const lines = body.split('\n');
  const chapters = [];
  let cur = { title: null, start: 0 };
  let inFence = false;
  let fenceMark = '';

  const flush = (end) => {
    const md = lines.slice(cur.start, end).join('\n');
    if (cur.title !== null || md.trim()) chapters.push({ title: cur.title, md });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const f = /^(\s{0,3})(```+|~~~+)(.*)$/.exec(line);
    if (f) {
      if (!inFence) { inFence = true; fenceMark = f[2]; }
      else if (f[2][0] === fenceMark[0] && f[2].length >= fenceMark.length && !f[3].trim()) inFence = false;
      continue;
    }
    if (inFence) continue;
    const h = /^#\s+(.*)$/.exec(line);
    if (h) {
      flush(i);
      cur = { title: h[1].trim(), start: i };
    }
  }
  flush(lines.length);
  return chapters.length ? chapters : [{ title: null, md: '' }];
}

/** data: URI → { bytes, ext, mime } (null if unparsable). */
function decodeDataUri(uri) {
  const m = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/.exec(uri);
  if (!m) return null;
  const mime = m[1] || 'application/octet-stream';
  try {
    let bytes;
    if (m[2]) {
      const bin = atob(m[3]);
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    } else {
      bytes = new TextEncoder().encode(decodeURIComponent(m[3]));
    }
    const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif',
                  'image/svg+xml': 'svg', 'image/webp': 'webp' }[mime] || 'bin';
    return { bytes, ext, mime };
  } catch { return null; }
}

/**
 * Render one chapter's Markdown into a well-formed XHTML document string.
 * Mutates `images` (extracted data-URI files) and `usedIds` (heading id dedupe).
 * @returns {{ xhtml: string, sections: Array<{id, title}> }} h2 sections for the nav
 */
function chapterToXhtml(mdSource, chapterTitle, images, usedIds) {
  const rawHtml = marked.parse(mdSource, { gfm: true, breaks: false, async: false });
  const safeHtml = DOMPurify.sanitize(rawHtml, { USE_PROFILES: { html: true } });

  const host = document.implementation.createHTMLDocument('');
  host.body.innerHTML = safeHtml;

  // GFM task-list checkboxes → text glyphs (forms are not valid EPUB content).
  for (const input of [...host.body.querySelectorAll('input[type="checkbox"]')]) {
    const glyph = host.createElement('span');
    glyph.setAttribute('class', input.checked ? 'task done' : 'task');
    glyph.textContent = input.checked ? '☑ ' : '☐ ';
    input.replaceWith(glyph);
  }

  // Extract embedded data: URI images into real archive files.
  for (const img of [...host.body.querySelectorAll('img')]) {
    const src = img.getAttribute('src') || '';
    if (src.startsWith('data:')) {
      const decoded = decodeDataUri(src);
      if (decoded) {
        const name = `img${String(images.length + 1).padStart(3, '0')}.${decoded.ext}`;
        images.push({ name, ...decoded });
        img.setAttribute('src', `../images/${name}`);
      } else {
        img.remove();
      }
    }
    if (!img.getAttribute('alt')) img.setAttribute('alt', '');
  }

  // Stable, unique ids on h1/h2 so the nav can deep-link sections.
  const sections = [];
  for (const el of [...host.body.querySelectorAll('h1, h2')]) {
    const text = el.textContent.trim();
    let id = slugify(text);
    while (usedIds.has(id)) id += '-';
    usedIds.add(id);
    el.setAttribute('id', id);
    if (el.tagName === 'H2') sections.push({ id, title: text });
  }

  // Serialize into a real XHTML document so void elements self-close, entities
  // are escaped, and the xmlns lands once on the root.
  const shell =
    '<?xml version="1.0" encoding="utf-8"?>' +
    `<html xmlns="${XHTML_NS}"><head><title>t</title>` +
    '<link rel="stylesheet" type="text/css" href="../css/style.css"/></head><body/></html>';
  const xdoc = new DOMParser().parseFromString(shell, 'application/xhtml+xml');
  xdoc.getElementsByTagName('title')[0].textContent = chapterTitle || 'Untitled';
  const xbody = xdoc.getElementsByTagName('body')[0];
  for (const node of [...host.body.childNodes]) {
    xbody.appendChild(xdoc.importNode(node, true));
  }
  let xhtml = new XMLSerializer().serializeToString(xdoc);
  if (!xhtml.startsWith('<?xml')) xhtml = '<?xml version="1.0" encoding="utf-8"?>\n' + xhtml;
  return { xhtml, sections };
}

const BOOK_CSS = `/* unifile writer — epub stylesheet */
body { margin: 5% 6%; line-height: 1.6; }
h1, h2, h3, h4, h5, h6 { line-height: 1.25; font-weight: 600; }
h1 { margin: 1.8em 0 0.8em; font-size: 1.7em; }
h2 { margin: 1.5em 0 0.6em; font-size: 1.35em; }
h3 { font-size: 1.15em; }
p { margin: 0 0 0.9em; }
blockquote { margin: 1em 0 1em 1em; padding-left: 1em; border-left: 3px solid #999; color: #444; }
code { font-family: monospace; font-size: 0.92em; }
pre { padding: 0.7em 0.9em; background: #f2f2f2; overflow-x: auto; border-radius: 4px; }
pre code { background: none; }
ul, ol { margin: 0 0 0.9em; padding-left: 1.6em; }
li { margin: 0.15em 0; }
img { max-width: 100%; }
hr { border: 0; border-top: 1px solid #bbb; margin: 2em auto; width: 40%; }
table { border-collapse: collapse; margin: 1em 0; }
th, td { border: 1px solid #999; padding: 0.3em 0.6em; }
.task { font-family: monospace; }
.titlepage { text-align: center; margin-top: 30%; }
.titlepage h1 { font-size: 2em; border: 0; }
.titlepage .author { margin-top: 2em; font-size: 1.1em; color: #444; }
`;

/**
 * Build an EPUB 3 from a writer document.
 *
 * @param {object} opts
 * @param {string} opts.content   full document text (may start with front matter)
 * @param {string} [opts.title]   fallback title (front matter `title:` wins)
 * @param {string} [opts.author]  fallback author (front matter `author:` wins)
 * @returns {{ bytes: Uint8Array, filename: string, title: string }}
 */
export function buildEpub({ content, title, author }) {
  const { meta, bodyFrom } = parseGlobalFrontMatter(content);
  const body = content.slice(bodyFrom);

  const bookTitle = String(meta.title || title || 'Untitled').trim() || 'Untitled';
  const bookAuthor = String(meta.author || author || '').trim();
  const language = String(meta.language || meta.lang || 'en').trim() || 'en';
  const description = String(meta.description || '').trim();
  const identifier = String(meta.identifier || '').trim() ||
    ('urn:uuid:' + (crypto.randomUUID ? crypto.randomUUID()
      : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
          const r = Math.random() * 16 | 0;
          return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
        })));

  const now = new Date();
  const modified = now.toISOString().replace(/\.\d+Z$/, 'Z');

  const chapters = splitChapters(body);
  const images = [];
  const usedIds = new Set();
  const files = [];      // { id, name (within OEBPS), media, xhtml }
  const navEntries = []; // { href, title, sections }

  chapters.forEach((ch, idx) => {
    const name = `text/ch${String(idx + 1).padStart(3, '0')}.xhtml`;
    const chTitle = ch.title ? plainTitle(ch.title) : (idx === 0 ? bookTitle : 'Untitled');
    const { xhtml, sections } = chapterToXhtml(ch.md, chTitle, images, usedIds);
    files.push({ id: `ch${idx + 1}`, name, media: 'application/xhtml+xml', data: xhtml });
    navEntries.push({ href: name, title: chTitle, sections });
  });

  const titlepage =
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    `<html xmlns="${XHTML_NS}"><head><title>${escXml(bookTitle)}</title>` +
    '<link rel="stylesheet" type="text/css" href="../css/style.css"/></head>' +
    `<body><div class="titlepage"><h1>${escXml(bookTitle)}</h1>` +
    (bookAuthor ? `<p class="author">${escXml(bookAuthor)}</p>` : '') +
    '</div></body></html>';

  const nav =
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    `<html xmlns="${XHTML_NS}" xmlns:epub="http://www.idpf.org/2007/ops">` +
    `<head><title>${escXml(bookTitle)}</title></head><body>` +
    '<nav epub:type="toc" id="toc"><h1>Contents</h1><ol>' +
    navEntries.map(e =>
      `<li><a href="${escXml(e.href)}">${escXml(e.title)}</a>` +
      (e.sections.length
        ? '<ol>' + e.sections.map(s =>
            `<li><a href="${escXml(e.href)}#${escXml(s.id)}">${escXml(s.title)}</a></li>`).join('') + '</ol>'
        : '') +
      '</li>').join('') +
    '</ol></nav></body></html>';

  const ncx =
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">' +
    `<head><meta name="dtb:uid" content="${escXml(identifier)}"/></head>` +
    `<docTitle><text>${escXml(bookTitle)}</text></docTitle><navMap>` +
    navEntries.map((e, i) =>
      `<navPoint id="np${i + 1}" playOrder="${i + 1}">` +
      `<navLabel><text>${escXml(e.title)}</text></navLabel>` +
      `<content src="${escXml(e.href)}"/></navPoint>`).join('') +
    '</navMap></ncx>';

  const manifest = [
    '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
    '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>',
    '<item id="css" href="css/style.css" media-type="text/css"/>',
    '<item id="titlepage" href="text/titlepage.xhtml" media-type="application/xhtml+xml"/>',
    ...files.map(f => `<item id="${f.id}" href="${escXml(f.name)}" media-type="${f.media}"/>`),
    ...images.map((im, i) => `<item id="img${i + 1}" href="images/${im.name}" media-type="${im.mime}"/>`),
  ].join('');

  const spine =
    '<itemref idref="titlepage"/>' +
    files.map(f => `<itemref idref="${f.id}"/>`).join('');

  const opf =
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">' +
    '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">' +
    `<dc:identifier id="uid">${escXml(identifier)}</dc:identifier>` +
    `<dc:title>${escXml(bookTitle)}</dc:title>` +
    `<dc:language>${escXml(language)}</dc:language>` +
    (bookAuthor ? `<dc:creator id="creator">${escXml(bookAuthor)}</dc:creator>` : '') +
    (description ? `<dc:description>${escXml(description)}</dc:description>` : '') +
    `<meta property="dcterms:modified">${modified}</meta>` +
    '</metadata>' +
    `<manifest>${manifest}</manifest>` +
    `<spine toc="ncx">${spine}</spine>` +
    '</package>';

  const container =
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">' +
    '<rootfiles><rootfile full-path="OEBPS/package.opf" media-type="application/oebps-package+xml"/>' +
    '</rootfiles></container>';

  const entries = [
    { name: 'mimetype', data: 'application/epub+zip' },   // MUST stay first
    { name: 'META-INF/container.xml', data: container },
    { name: 'OEBPS/package.opf', data: opf },
    { name: 'OEBPS/nav.xhtml', data: nav },
    { name: 'OEBPS/toc.ncx', data: ncx },
    { name: 'OEBPS/css/style.css', data: BOOK_CSS },
    { name: 'OEBPS/text/titlepage.xhtml', data: titlepage },
    ...files.map(f => ({ name: `OEBPS/${f.name}`, data: f.data })),
    ...images.map(im => ({ name: `OEBPS/images/${im.name}`, data: im.bytes })),
  ];

  return {
    bytes: buildZip(entries, now),
    filename: slugify(bookTitle) + '.epub',
    title: bookTitle,
  };
}
