// Syntax highlighter for the editor overlay. Pure (no DOM), so it can be tested in Node.
// Invariant: stripping the tags from highlight(text) and unescaping entities gives back
// `text` exactly; the overlay only lines up with the textarea if not a character moves.

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const span = (cls, s) => (s ? `<span class="t-${cls}">${esc(s)}</span>` : '');

/** Apply an ordered list of [className, regex] rules to a string, left to right. */
function tokenize(text, rules) {
  if (!text) return '';
  const re = new RegExp(rules.map(([, r]) => `(${r.source})`).join('|'), 'gm');
  let out = '';
  let last = 0;
  for (let m; (m = re.exec(text)); ) {
    if (m[0] === '') { re.lastIndex++; continue; }
    out += esc(text.slice(last, m.index));
    const i = m.slice(1).findIndex((g) => g !== undefined);
    const [cls] = rules[i];
    out += typeof cls === 'function' ? cls(m[0]) : span(cls, m[0]);
    last = m.index + m[0].length;
  }
  return out + esc(text.slice(last));
}

// ---------------------------------------------------------------- languages

const KW = {
  js: 'async await break case catch class const continue default delete do else export extends finally for from function if import in instanceof let new of return static super switch this throw try typeof var void while yield null undefined true false',
  py: 'and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield self',
  go: 'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var nil true false',
  sh: 'if then else elif fi for while until do done case esac in function return export local readonly set unset echo exit source sudo',
  java: 'abstract boolean break byte case catch char class const continue default do double else enum extends final finally float for if implements import instanceof int interface long native new package private protected public return short static super switch synchronized this throw throws try void volatile while null true false var',
  sql: 'select from where and or not insert into values update set delete create table alter drop index join left right inner outer on group by order having limit as distinct union null is in like between',
  c: 'auto break case char const continue default do double else enum extern float for goto if int long register return short signed sizeof static struct switch typedef union unsigned void volatile while include define',
  rust: 'as async await break const continue crate else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while',
};
const ALIAS = {
  javascript: 'js', jsx: 'js', ts: 'js', typescript: 'js', tsx: 'js', mjs: 'js', node: 'js',
  python: 'py', python3: 'py', golang: 'go',
  bash: 'sh', shell: 'sh', zsh: 'sh', console: 'sh', shellsession: 'sh', dockerfile: 'sh', makefile: 'sh',
  kotlin: 'java', scala: 'java', csharp: 'java', cs: 'java',
  cpp: 'c', 'c++': 'c', h: 'c', hpp: 'c', rs: 'rust',
  yml: 'yaml', htm: 'html', xml: 'html', svg: 'html', scss: 'css', sass: 'css', less: 'css', jsonc: 'json',
  postgres: 'sql', mysql: 'sql', psql: 'sql', ini: 'toml', conf: 'toml', properties: 'toml', md: 'markdown', markdown: 'markdown',
};

function codeRules(lang) {
  const words = KW[lang];
  const hash = ['py', 'sh', 'rust'].includes(lang) ? lang !== 'rust' : false;
  const rules = [];
  if (lang === 'sql') rules.push(['comment', /--[^\n]*/]);
  if (hash) rules.push(['comment', /#[^\n]*/]);
  if (lang !== 'sh' && lang !== 'py') rules.push(['comment', /\/\*[\s\S]*?\*\/|\/\/[^\n]*/]);
  if (lang === 'py') rules.push(['string', /"""[\s\S]*?"""|'''[\s\S]*?'''/]);
  rules.push(['string', /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/]);
  if (lang === 'sh') rules.push(['variable', /\$\{[^}\n]*\}|\$[A-Za-z_][\w]*|\$[0-9@#?*!$-]/], ['flag', /(?<=\s)--?[A-Za-z][\w-]*/]);
  rules.push(['number', /\b(?:0x[\da-fA-F]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?)\b/]);
  // Flags are dropped when rules are combined, so SQL gets both cases spelled out.
  const list = lang === 'sql' ? words.split(' ').flatMap((w) => [w, w.toUpperCase()]) : words?.split(' ');
  if (list) rules.push(['keyword', new RegExp(`\\b(?:${list.join('|')})\\b`)]);
  rules.push(['func', /\b[A-Za-z_]\w*(?=\()/]);
  return rules;
}

const yamlLine = (line) => {
  // key: value  |  - item  |  # comment
  const m = line.match(/^(\s*)(-\s+)?([\w.$@"' -]+?)(:)(\s|$)(.*)$/);
  if (m && !/^\s*#/.test(line)) {
    return esc(m[1]) + span('punct', m[2] || '') + span('key', m[3]) + span('punct', m[4]) + esc(m[5]) + yamlValue(m[6]);
  }
  const li = line.match(/^(\s*)(-)(\s+)(.*)$/);
  if (li) return esc(li[1]) + span('punct', li[2]) + esc(li[3]) + yamlValue(li[4]);
  return yamlValue(line);
};
const yamlValue = (v) => tokenize(v, [
  ['comment', /(?:^|(?<=\s))#[^\n]*/],
  ['string', /"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'/],
  ['keyword', /\b(?:true|false|null|yes|no|on|off|True|False|Yes|No)\b(?=\s*(?:#|,|\]|$))/],
  ['number', /(?<![\w.-])-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?(?![\w.:-])/],
  ['date', /\b\d{4}-\d\d-\d\d(?:[T ][\d:.]+(?:Z|[+-]\d\d:?\d\d)?)?\b/],
  ['punct', /[[\]{},|>]/],
]);
const tomlLine = (line) => {
  if (/^\s*\[\[?[^\]]*\]\]?\s*$/.test(line)) return span('heading', line);
  const m = line.match(/^(\s*)([\w.\-"']+)(\s*=\s*)(.*)$/);
  if (m) return esc(m[1]) + span('key', m[2]) + span('punct', m[3]) + yamlValue(m[4]);
  return yamlValue(line);
};
const jsonText = (t) => tokenize(t, [
  ['key', /"(?:[^"\\\n]|\\.)*"(?=\s*:)/],
  ['string', /"(?:[^"\\\n]|\\.)*"/],
  ['keyword', /\b(?:true|false|null)\b/],
  ['number', /-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/],
  ['comment', /\/\/[^\n]*|\/\*[\s\S]*?\*\//],
]);
const htmlTag = (t) => {
  // <tag attr="v">  — split into pieces so every character is kept
  const m = t.match(/^(<\/?)([\w:-]*)([\s\S]*?)(\/?>)$/);
  if (!m) return span('tag', t);
  const attrs = tokenize(m[3], [['attr', /[\w:@.-]+(?==)/], ['string', /"[^"]*"|'[^']*'/], ['punct', /=/]]);
  return span('punct', m[1]) + span('tag', m[2]) + attrs + span('punct', m[4]);
};
const htmlText = (t) => tokenize(t, [
  ['comment', /<!--[\s\S]*?-->/],
  [hugoTemplate, /\{\{[\s\S]*?\}\}/],
  [htmlTag, /<\/?[A-Za-z!][^<>]*>/],
  ['entity', /&[#\w]+;/],
]);
const cssText = (t) => tokenize(t, [
  ['comment', /\/\*[\s\S]*?\*\/|\/\/[^\n]*/],
  ['string', /"[^"\n]*"|'[^'\n]*'/],
  ['variable', /\$[\w-]+|--[\w-]+/],
  ['keyword', /@[\w-]+/],
  ['key', /[\w-]+(?=\s*:[^;{}]*[;}])/],
  ['number', /#[\da-fA-F]{3,8}\b|-?\d*\.?\d+(?:px|em|rem|%|vh|vw|s|ms|deg|fr)?\b/],
  ['tag', /[.#]?[A-Za-z][\w-]*(?=[^{};]*\{)/],
]);
function hugoTemplate(t) {
  return span('shortcode', t);
}

function highlightCode(text, lang) {
  lang = ALIAS[lang] || lang;
  if (lang === 'yaml') return text.split('\n').map(yamlLine).join('\n');
  if (lang === 'toml') return text.split('\n').map(tomlLine).join('\n');
  if (lang === 'json') return jsonText(text);
  if (lang === 'html') return htmlText(text);
  if (lang === 'css') return cssText(text);
  if (lang === 'markdown') return highlightMarkdown(text);
  if (KW[lang] || lang === 'generic') return tokenize(text, codeRules(lang));
  return tokenize(text, codeRules('generic'));
}

// ---------------------------------------------------------------- LaTeX (inside math)

const latexRules = [
  ['lx-comment', /%[^\n]*/],
  ['lx-env', /\\(?:begin|end)\{[^}\n]*\}/],
  ['lx-cmd', /\\[A-Za-z]+\*?|\\[^A-Za-z\n]/],
  ['lx-brace', /[{}]/],
  ['lx-op', /[_^&]/],
  ['number', /\d+(?:\.\d+)?/],
];
export const latex = (s) => tokenize(s, latexRules);
const mathSpan = (body) => (body ? `<span class="t-math">${latex(body)}</span>` : '');
/** Inline math with its delimiters dimmed: $…$, \(…\), \[…\] */
function inlineMath(t) {
  const open = t.startsWith('$') ? (t.startsWith('$$') ? '$$' : '$') : t.slice(0, 2);
  const close = open === '$' || open === '$$' ? open : t.slice(-2);
  return span('math-fence', open) + mathSpan(t.slice(open.length, t.length - close.length)) + span('math-fence', close);
}

// ---------------------------------------------------------------- markdown

const inlineRules = [
  ['code', /`[^`\n]+`/],
  [inlineMath, /(?<![\\$])\$\$(?=\S)[^$\n]*?\$\$|\\\([^\n]*?\\\)|\\\[[^\n]*?\\\]|(?<![\\$\w])\$(?=[^\s$])(?:[^$\n]*?[^\s$\\])?\$(?![$\d])/],
  [hugoTemplate, /\{\{[<%][\s\S]*?[%>]\}\}/],
  [(t) => imageOrLink(t, true), /!\[[^\]\n]*\]\([^)\n]*\)/],
  [(t) => imageOrLink(t, false), /\[[^\]\n]*\]\([^)\n]*\)|\[[^\]\n]+\]\[[^\]\n]*\]/],
  ['url', /<https?:\/\/[^>\s]+>|https?:\/\/[^\s)<>"]+/],
  ['strong', /\*\*(?=\S)[^*\n]*?\S\*\*|__(?=\S)[^_\n]*?\S__/],
  ['em', /(?<![\w*])\*(?=\S)[^*\n]*?\S\*(?!\*)|(?<![\w_])_(?=\S)[^_\n]*?\S_(?![\w_])/],
  ['strike', /~~(?=\S)[^~\n]*?\S~~/],
  [htmlTag, /<\/?[A-Za-z][^<>\n]*>/],
  ['punct', /\\[\\`*_{}[\]()#+\-.!|$]/],
];
function imageOrLink(t, image) {
  const m = t.match(/^(!?\[)([^\]]*)(\][([])([^)\]]*)([)\]])$/);
  if (!m) return span('link', t);
  return span('punct', m[1]) + span(image ? 'image' : 'linktext', m[2]) + span('punct', m[3]) + span('url', m[4]) + span('punct', m[5]);
}
const inline = (s) => tokenize(s, inlineRules);

function mdLine(line) {
  let m;
  if ((m = line.match(/^(\s{0,3}#{1,6})(\s.*|$)/))) return span('heading-mark', m[1]) + `<span class="t-heading">${inline(m[2])}</span>`;
  if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) return span('punct', line);
  if ((m = line.match(/^(\s*>+\s?)(.*)$/))) return span('quote-mark', m[1]) + `<span class="t-quote">${inline(m[2])}</span>`;
  if ((m = line.match(/^(\s*)([-*+]|\d+[.)])(\s+)(\[[ xX]\]\s)?(.*)$/))) {
    return esc(m[1]) + span('list', m[2]) + esc(m[3]) + span('keyword', m[4] || '') + inline(m[5]);
  }
  if (/^\s*\|.*\|\s*$/.test(line)) {
    if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) return span('punct', line);
    return line.split(/(\|)/).map((p) => (p === '|' ? span('punct', p) : inline(p))).join('');
  }
  if ((m = line.match(/^(\s*\[[^\]]+\]:)(\s*)(\S*)(.*)$/))) return span('linktext', m[1]) + esc(m[2]) + span('url', m[3]) + inline(m[4]);
  return inline(line);
}

/**
 * Does this line open display math that continues onto later lines? Either a line starting with
 * \[ (no closing \]), or an odd number of unescaped $$ (the last one opens). Returns
 * [line, before, delimiter, after] (like a regex match) or null.
 */
function openDisplayMath(line) {
  const br = line.match(/^(\s*)(\\\[)(.*)$/);
  if (br && !/\\\]/.test(br[3])) return br;
  const code = line.replace(/`[^`\n]*`/g, (m) => ' '.repeat(m.length)); // ignore $$ inside inline code
  const at = [...code.matchAll(/(?<!\\)\$\$/g)].map((m) => m.index);
  if (at.length % 2 === 0) return null;
  const p = at.at(-1);
  return [line, line.slice(0, p), '$$', line.slice(p + 2)]; // same shape as a regex match
}

/** Markdown with front matter, fenced code, math blocks and Hugo shortcodes. */
function highlightMarkdown(text) {
  const lines = text.split('\n');
  const out = [];
  let i = 0;
  // front matter
  const fm = lines[0]?.match(/^(---|\+\+\+)\s*$/);
  if (fm) {
    const close = lines.findIndex((l, k) => k > 0 && l.trim() === fm[1]);
    if (close > 0) {
      out.push(span('fm-fence', lines[0]));
      for (i = 1; i < close; i++) out.push(`<span class="t-fm">${fm[1] === '---' ? yamlLine(lines[i]) : tomlLine(lines[i])}</span>`);
      out.push(span('fm-fence', lines[close]));
      i = close + 1;
    }
  }
  for (; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(/^(\s{0,3})(`{3,}|~{3,})(\s*)([\w+#.-]*)(.*)$/);
    if (fence) {
      const marker = fence[2];
      const lang = fence[4].toLowerCase();
      let end = lines.findIndex((l, k) => k > i && new RegExp(`^\\s{0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}\\s*$`).test(l));
      if (end < 0) end = lines.length;
      out.push(esc(fence[1]) + span('fence', marker) + esc(fence[3]) + span('lang', fence[4]) + span('fence', fence[5]));
      const body = lines.slice(i + 1, end).join('\n');
      if (end > i + 1) out.push(`<span class="t-codeblock">${highlightCode(body, lang || 'generic')}</span>`);
      if (end < lines.length) out.push(span('fence', lines[end]));
      i = end;
      continue;
    }
    const mopen = openDisplayMath(line);
    if (mopen) {
      // Multi-line display math. The closing delimiter may end a line that also has content.
      const closeRe = mopen[2] === '$$' ? /^(.*?)(\$\$)(.*)$/ : /^(.*?)(\\\])(.*)$/;
      // like KaTeX on the page, display math can't run past the end of the paragraph (a blank line)
      let end = lines.findIndex((l, k) => k > i && (closeRe.test(l) || /^\s*$/.test(l)));
      const closed = end >= 0 && closeRe.test(lines[end]);
      if (end < 0) end = lines.length;
      out.push(inline(mopen[1]) + span('math-fence', mopen[2]) + mathSpan(mopen[3]));
      if (end > i + 1) out.push(mathSpan(lines.slice(i + 1, end).join('\n')));
      if (closed) {
        const c = lines[end].match(closeRe);
        out.push(mathSpan(c[1]) + span('math-fence', c[2]) + inline(c[3]));
        i = end;
      } else {
        i = end - 1; // the blank line (if any) is rendered normally
      }
      continue;
    }
    if (/^\s*<!--/.test(line)) {
      let end = i;
      while (end < lines.length && !lines[end].includes('-->')) end++;
      if (end >= lines.length) end = lines.length - 1;
      out.push(span('comment', lines.slice(i, end + 1).join('\n')));
      i = end;
      continue;
    }
    // Block-level HTML (e.g. <video ...>, <div>) and lone shortcodes are highlighted as such.
    if (/^\s*<\/?[A-Za-z][^>]*>?\s*/.test(line) && !/^\s*<https?:/.test(line)) {
      out.push(htmlText(line));
      continue;
    }
    out.push(mdLine(line));
  }
  return out.join('\n');
}

const EXT_LANG = {
  md: 'markdown', markdown: 'markdown', yaml: 'yaml', yml: 'yaml', toml: 'toml', json: 'json',
  html: 'html', htm: 'html', xml: 'html', svg: 'html', css: 'css', scss: 'css', sass: 'css',
  js: 'js', mjs: 'js', ts: 'js', sh: 'sh', py: 'py', go: 'go', gitignore: 'sh',
};

export function languageFor(path) {
  const name = path.split('/').pop().toLowerCase();
  const ext = name.includes('.') ? name.split('.').pop() : name.replace(/^\./, '');
  return EXT_LANG[ext] || null;
}

/** HTML for the overlay. Unknown file types come back escaped but uncoloured. */
export function highlight(text, path = 'x.md') {
  const lang = languageFor(path);
  let html = lang ? highlightCode(text, lang) : esc(text);
  // Empty line markers (no text, so alignment is unaffected) let scroll sync find the pixel
  // position of any source line, wrapping included. Tags never contain "\n", so every "\n" here is a real line break.
  let n = 0;
  html = `<i class="ln" data-l="0"></i>${html.replace(/\n/g, () => `\n<i class="ln" data-l="${++n}"></i>`)}`;
  // A trailing newline needs a character after it, or the overlay is one line short.
  return text.endsWith('\n') || text === '' ? `${html} ` : html;
}
