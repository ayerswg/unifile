/**
 * A tiny XML reader for OOXML parts (pure, no DOM — the .xlsx importer runs
 * in Node tests too).  Elements, attributes, text and entities; namespace
 * prefixes are ignored when matching names (`c:f` matches `f`).
 */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITIES[e] ?? m;
  });
}

/** @returns {{ name, attrs, children, text }} the root element */
export function parseXml(src) {
  const root = { name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  const re = /<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\/([^\s>]+)\s*>|<([^\s/>]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(src))) {
    const top = stack[stack.length - 1];
    if (m[1] != null) { top.text += m[1]; top.children.push({ name: '#text', text: m[1], attrs: {}, children: [] }); continue; }
    if (m[2]) { if (stack.length > 1) stack.pop(); continue; }
    if (m[3]) {
      const attrs = {};
      const am = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
      let a;
      while ((a = am.exec(m[4] ?? ''))) attrs[local(a[1])] = decodeEntities(a[2] ?? a[3] ?? '');
      const el = { name: local(m[3]), attrs, children: [], text: '' };
      top.children.push(el);
      if (!m[5]) stack.push(el);
      continue;
    }
    if (m[6] != null) {
      if (!m[6].trim() && !top.attrs['xml:space']) continue;
      const t = decodeEntities(m[6]);
      top.text += t;
      top.children.push({ name: '#text', text: t, attrs: {}, children: [] });
    }
  }
  return root.children.find(c => c.name !== '#text') ?? root;
}

const local = (name) => (name.includes(':') ? name.slice(name.indexOf(':') + 1) : name);

export function child(el, name) { return el?.children.find(c => c.name === name) ?? null; }
export function children(el, name) { return el ? el.children.filter(c => c.name === name) : []; }
/** Every descendant named `name`, in document order. */
export function descendants(el, name) {
  const out = [];
  const walk = (n) => { for (const c of n.children) { if (c.name === name) out.push(c); if (c.children.length) walk(c); } };
  if (el) walk(el);
  return out;
}
/** The concatenated text of an element (descendant text nodes). */
export function textOf(el) {
  if (!el) return '';
  let s = '';
  const walk = (n) => { for (const c of n.children) { if (c.name === '#text') s += c.text; else walk(c); } };
  walk(el);
  return s;
}
