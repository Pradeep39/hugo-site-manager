// Live-preview Markdown renderer: approximates Hugo's goldmark (as configured on these sites:
// unsafe HTML, linkify, typographer, GFM tables/strikethrough/tasklists) closely enough to drop
// into the Toha page shell, and tags every block with data-line="<source line>" for scroll sync.
// Pure: no DOM. Math is rendered with an injected KaTeX (after Markdown's backslash unescaping,
// like the published page); without KaTeX, math is left as text.

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const PUNCT = /[!-\/:-@[-`{-~]/;
const unescapeMd = (s) => s.replace(/\\([!-\/:-@[-`{-~])/g, '$1');

/** goldmark's auto heading ID: lowercase, spaces → "-", drop most punctuation. */
export function headingId(text, used) {
  let id = text.toLowerCase().trim()
    .replace(/<[^>]+>/g, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
  if (!id) id = 'heading';
  if (used) {
    const base = id;
    for (let i = 1; used.has(id); i++) id = `${base}-${i}`;
    used.add(id);
  }
  return id;
}

// ---------------------------------------------------------------- inline

const MATH_RE = /(?<!\\)\$\$([\s\S]+?)(?<!\\)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|(?<![\\$\w])\$(?=[^\s$])((?:[^$\n\\]|\\[\s\S])*?[^\s$\\])\$(?![$\d])/g;

function smart(s) {
  // goldmark typographer (text only)
  return s
    .replace(/---/g, '—').replace(/--/g, '–').replace(/\.\.\./g, '…')
    .replace(/(^|[\s(\[{"'—–])"(?=\S)/g, '$1“').replace(/"/g, '”')
    .replace(/(^|[\s(\[{"“—–])'(?=\S)/g, '$1‘').replace(/'/g, '’')
    .replace(/&lt;&lt;/g, '«').replace(/&gt;&gt;/g, '»');
}

// Toha's link render hook opens external links in a new tab.
const link = (href, inner, extra = '') =>
  `<a href="${esc(encodeURI(decodeURI(href)).replace(/%25([0-9A-F]{2})/gi, '%$1'))}"${extra}${/^https?:/i.test(href) ? ' target="_blank" rel="noopener"' : ''}>${inner}</a>`;

function renderInline(src, ctx) {
  const slots = [];
  const keep = (html) => `\u0000${slots.push(html) - 1}\u0000`;
  let s = src;
  // 1. code spans
  s = s.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (m, ticks, code) => keep(`<code>${esc(code.replace(/^ (.*) $/s, '$1').replace(/\n/g, ' '))}</code>`));
  // 2. math (protected from Markdown, like KaTeX auto-render sees it after escaping)
  s = s.replace(MATH_RE, (m, dd, br, pa, d) => {
    const display = dd !== undefined || br !== undefined;
    const tex = dd ?? br ?? pa ?? d;
    const texForKatex = ctx.escapes ? unescapeMd(tex) : tex;
    if (ctx.katex) {
      try {
        return keep(ctx.katex.renderToString(texForKatex, { displayMode: display, throwOnError: false, strict: 'ignore', output: 'html' }));
      } catch {}
    }
    // no KaTeX: show what the page's KaTeX would receive, delimiters included
    return keep(esc(ctx.escapes ? unescapeMd(m) : m));
  });
  // 3. raw inline HTML (unsafe: true)
  s = s.replace(/<\/?[A-Za-z][A-Za-z0-9-]*(?:\s+[^<>]*?)?\/?>|<!--[\s\S]*?-->/g, (m) => keep(m));
  // 4. autolinks <https://…>
  s = s.replace(/<(https?:\/\/[^\s>]+)>/g, (m, u) => keep(link(ctx.url(u), esc(u))));
  // 5. backslash escapes
  s = s.replace(/\\([!-\/:-@[-`{-~])/g, (m, c) => keep(esc(c)));
  // 6. hard breaks
  s = s.replace(/(?: {2,}|\\)\n/g, () => keep('<br>\n'));
  // 7. images and links (images first)
  const linkRe = /(!?)\[((?:[^\[\]]|\[[^\]]*\])*)\]\(\s*<?([^\s)>]*)>?(?:\s+"([^"]*)")?\s*\)/g;
  s = s.replace(linkRe, (m, bang, text, url, title) => {
    const t = title ? ` title="${esc(title)}"` : '';
    if (bang) return keep(`<img src="${esc(ctx.url(url, 'img'))}" alt="${esc(unescapeMd(text).replace(/\u0000\d+\u0000/g, ''))}"${t}>`);
    return keep(link(ctx.url(url), renderInline(text, { ...ctx, inLink: true }), t));
  });
  // 8. linkify bare URLs like goldmark: may follow a quote, and swallows a closing quote into the URL
  //    (so a typo like "http://x/y". shows up as the same broken link the published page has)
  if (!ctx.inLink) {
    s = s.replace(/(^|[\s("'*_~])((?:https?:\/\/|www\.)[^\s<\u0000]+?)(?=[.,:;!?)]*(?:\s|$|\u0000))/g, (m, lead, u) =>
      lead + keep(link(ctx.url(u.startsWith('www.') ? `http://${u}` : u), esc(u))));
  }
  // 9. emphasis, strong, strikethrough (on escaped text)
  s = esc(s)
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '<strong>$2</strong>')
    .replace(/(?<![\w*])\*(?=\S)([\s\S]*?\S)\*(?![\w*])/g, '<em>$1</em>')
    .replace(/(?<![\w_])_(?=\S)([\s\S]*?\S)_(?![\w_])/g, '<em>$1</em>')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');
  if (ctx.typographer !== false) s = s.split(/(<[^>]+>|\u0000\d+\u0000)/).map((p, i) => (i % 2 ? p : smart(p))).join('');
  // restore protected pieces (nested slots resolve because each slot was rendered fully)
  for (let i = 0; i < 4 && /\u0000\d+\u0000/.test(s); i++) s = s.replace(/\u0000(\d+)\u0000/g, (m, n) => slots[n]);
  return s;
}

// ---------------------------------------------------------------- blocks

const RE = {
  blank: /^\s*$/,
  atx: /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/,
  hr: /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/,
  fence: /^( {0,3})(`{3,}|~{3,})[ \t]*([^`\s]*)[^`]*$/,
  quote: /^ {0,3}> ?/,
  list: /^( {0,3})([-*+]|\d{1,9}[.)])([ \t]+|$)/,
  html: /^ {0,3}<(?:\/?(?:address|article|aside|blockquote|details|dialog|div|dl|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|iframe|li|main|nav|ol|p|pre|section|table|tbody|td|tfoot|th|thead|tr|ul|video|audio|source|center|picture|svg|canvas|script|style|textarea)\b|!--)/i,
  tableSep: /^ {0,3}\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/,
  setext: /^ {0,3}(=+|-+)[ \t]*$/,
};

function splitRow(line) {
  let l = line.trim();
  if (l.startsWith('|')) l = l.slice(1);
  if (l.endsWith('|') && !l.endsWith('\\|')) l = l.slice(0, -1);
  const cells = [];
  let cur = '';
  for (let i = 0; i < l.length; i++) {
    if (l[i] === '\\' && l[i + 1] === '|') { cur += '|'; i++; continue; }
    if (l[i] === '|') { cells.push(cur.trim()); cur = ''; continue; }
    cur += l[i];
  }
  cells.push(cur.trim());
  return cells;
}

/**
 * Render Markdown to HTML.
 * opts: { katex, escapes = true, url(u, kind) → resolved URL, lineOffset }
 */
export function renderMarkdown(text, opts = {}) {
  const ctx = { katex: opts.katex || null, escapes: opts.escapes !== false, url: opts.url || ((u) => u), typographer: opts.typographer, ids: new Set() };
  let lines = text.replace(/\r\n?/g, '\n').split('\n');
  let offset = opts.lineOffset || 0;
  // front matter is not part of the post body
  const fm = lines[0]?.match(/^(---|\+\+\+)\s*$/);
  if (fm) {
    const close = lines.findIndex((l, k) => k > 0 && l.trim() === fm[1]);
    if (close > 0) {
      lines = lines.slice(close + 1);
      offset += close + 1;
    }
  }
  return renderBlocks(lines, offset, ctx, true);
}

function renderBlocks(lines, offset, ctx, top) {
  const out = [];
  const tag = (n) => (top ? ` data-line="${offset + n}"` : '');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (RE.blank.test(line)) { i++; continue; }
    let m;
    // fenced code
    if ((m = line.match(RE.fence))) {
      const indent = m[1].length;
      const marker = m[2];
      const lang = m[3];
      const body = [];
      let k = i + 1;
      const closeRe = new RegExp(`^ {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}[ \\t]*$`);
      for (; k < lines.length && !closeRe.test(lines[k]); k++) body.push(lines[k].replace(new RegExp(`^ {0,${indent}}`), ''));
      if (lang) {
        // Hugo highlights fenced code with a language (monokai, inline styles) …
        out.push(`<div class="highlight"${tag(i)}><pre tabindex="0" style="color:#f8f8f2;background-color:#272822;-moz-tab-size:4;-o-tab-size:4;tab-size:4;"><code class="language-${esc(lang)}" data-lang="${esc(lang)}">${esc(body.join('\n'))}\n</code></pre></div>`);
      } else {
        // … and leaves fences without one as a plain block
        out.push(`<pre tabindex="0"${tag(i)}><code>${esc(body.join('\n'))}\n</code></pre>`);
      }
      i = k + 1;
      continue;
    }
    // ATX heading
    if ((m = line.match(RE.atx))) {
      const level = m[1].length;
      const raw = (m[2] || '').replace(/\s*\{#([^}]+)\}\s*$/, '');
      const custom = (m[2] || '').match(/\{#([^}]+)\}\s*$/);
      const inner = renderInline(raw, ctx);
      const id = custom ? custom[1] : headingId(inner, ctx.ids);
      out.push(`<h${level} id="${esc(id)}"${tag(i)}>${inner}</h${level}>`);
      i++;
      continue;
    }
    if (RE.hr.test(line)) { out.push(`<hr${tag(i)}>`); i++; continue; }
    // blockquote
    if (RE.quote.test(line)) {
      const body = [];
      let k = i;
      for (; k < lines.length && !RE.blank.test(lines[k]) ; k++) body.push(lines[k].replace(RE.quote, ''));
      out.push(`<blockquote${tag(i)}>\n${renderBlocks(body, offset + i, ctx, false)}</blockquote>`);
      i = k;
      continue;
    }
    // raw HTML block (unsafe: true): until a blank line
    if (RE.html.test(line)) {
      let k = i;
      const body = [];
      for (; k < lines.length && !RE.blank.test(lines[k]); k++) body.push(lines[k]);
      out.push(top ? `<div class="hsm-html"${tag(i)}>${body.join('\n')}</div>` : body.join('\n'));
      i = k;
      continue;
    }
    // list
    if ((m = line.match(RE.list))) {
      const { html, next } = renderList(lines, i, offset, ctx, top);
      out.push(html);
      i = next;
      continue;
    }
    // table
    if (line.includes('|') && i + 1 < lines.length && RE.tableSep.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const head = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? 'center' : /^-+:$/.test(c) ? 'right' : /^:-+$/.test(c) ? 'left' : ''));
      const al = (j) => (aligns[j] ? ` style="text-align:${aligns[j]}"` : '');
      let k = i + 2;
      const rows = [];
      for (; k < lines.length && !RE.blank.test(lines[k]) && lines[k].includes('|'); k++) rows.push(splitRow(lines[k]));
      out.push(`<table${tag(i)}>\n<thead>\n<tr>\n${head.map((c, j) => `<th${al(j)}>${renderInline(c, ctx)}</th>`).join('\n')}\n</tr>\n</thead>\n`
        + (rows.length ? `<tbody>\n${rows.map((r) => `<tr>\n${head.map((_, j) => `<td${al(j)}>${renderInline(r[j] ?? '', ctx)}</td>`).join('\n')}\n</tr>`).join('\n')}\n</tbody>\n` : '')
        + '</table>');
      i = k;
      continue;
    }
    // paragraph (with setext heading support)
    const para = [];
    let k = i;
    for (; k < lines.length; k++) {
      const l = lines[k];
      if (RE.blank.test(l)) break;
      if (k > i && (RE.atx.test(l) || RE.fence.test(l) || RE.quote.test(l) || RE.hr.test(l) || RE.html.test(l))) break;
      if (k > i && RE.list.test(l) && !/^\s*\d/.test(l)) break;
      if (k > i && RE.setext.test(l)) {
        const level = l.trim()[0] === '=' ? 1 : 2;
        const inner = renderInline(para.join('\n').trim(), ctx);
        out.push(`<h${level} id="${esc(headingId(inner, ctx.ids))}"${tag(i)}>${inner}</h${level}>`);
        para.length = 0;
        k++;
        break;
      }
      para.push(l.replace(/^ {0,3}/, ''));
    }
    if (para.length) out.push(`<p${tag(i)}>${renderInline(para.join('\n').replace(/[ \t]+$/, ''), ctx)}</p>`);
    i = k;
  }
  return out.join('\n') + (out.length ? '\n' : '');
}

function renderList(lines, start, offset, ctx, top) {
  const first = lines[start].match(RE.list);
  const ordered = /\d/.test(first[2]);
  const baseIndent = first[1].length;
  const items = [];
  let i = start;
  let loose = false;
  while (i < lines.length) {
    const m = lines[i].match(RE.list);
    if (!m || m[1].length !== baseIndent || /\d/.test(m[2]) !== ordered) break;
    const contentIndent = m[1].length + m[2].length + Math.min(4, m[3].length || 1);
    const body = [lines[i].slice(contentIndent)];
    const startLine = i;
    let k = i + 1;
    let sawBlank = false;
    for (; k < lines.length; k++) {
      const l = lines[k];
      if (RE.blank.test(l)) { sawBlank = true; body.push(''); continue; }
      const indent = l.match(/^\s*/)[0].length;
      if (indent >= contentIndent) { body.push(l.slice(contentIndent)); if (sawBlank) loose = true; sawBlank = false; continue; }
      if (!sawBlank && !RE.list.test(l) && !RE.atx.test(l) && !RE.fence.test(l) && !RE.hr.test(l) && !RE.quote.test(l)) { body.push(l.trim()); continue; } // lazy continuation
      break;
    }
    while (body.length && RE.blank.test(body.at(-1))) body.pop();
    if (k < lines.length && sawBlank && lines[k].match(RE.list)?.[1].length === baseIndent) loose = true;
    items.push({ body, startLine });
    i = k;
    while (i < lines.length && RE.blank.test(lines[i])) {
      const nx = lines.slice(i).find((l) => !RE.blank.test(l));
      if (nx && nx.match(RE.list)?.[1].length === baseIndent) { i++; loose = true; } else break;
    }
  }
  const startNum = ordered ? parseInt(first[2], 10) : 1;
  const tagName = ordered ? 'ol' : 'ul';
  const attrs = (ordered && startNum !== 1 ? ` start="${startNum}"` : '') + (top ? ` data-line="${offset + start}"` : '');
  const lis = items.map(({ body, startLine }) => {
    let task = '';
    if (/^\[[ xX]\]\s/.test(body[0])) {
      task = `<input${/^\[[xX]\]/.test(body[0]) ? ' checked=""' : ''} disabled="" type="checkbox"> `;
      body[0] = body[0].slice(4);
    }
    let inner = renderBlocks(body, offset + startLine, ctx, false);
    if (!loose) inner = inner.replace(/^<p>([\s\S]*?)<\/p>\n?/, '$1\n').replace(/\n<p>([\s\S]*?)<\/p>\n?/g, '\n$1\n');
    return `<li>${task}${inner.trim()}</li>`;
  });
  return { html: `<${tagName}${attrs}>\n${lis.join('\n')}\n</${tagName}>`, next: i };
}

export const _test = { renderInline: (s, o = {}) => renderInline(s, { escapes: true, url: (u) => u, ids: new Set(), ...o }), smart };
