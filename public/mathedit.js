// Overleaf-style math assistance for the Markdown editor, rendered with the site's own KaTeX.
// Pure helpers (exported, tested in Node): mathAt, completions, expandSnippet.
// DOM part: initMathAssist().

// ---------------------------------------------------------------- finding math

/** Blank out regions where $ is not math (front matter, fenced code, inline code), keeping offsets. */
function maskNonMath(text) {
  const blank = (m) => m.replace(/[^\n]/g, ' ');
  let t = text.replace(/^(---|\+\+\+)\n[\s\S]*?\n\1(?=\n|$)/, blank);
  t = t.replace(/^( {0,3})(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n {0,3}\2[`~]*[ \t]*(?=\n|$)|$(?![\s\S]))/gm, blank);
  return t.replace(/`[^`\n]+`/g, blank);
}

/** True when `caret` sits in front matter, a fenced code block or an inline code span. */
export function inCodeAt(text, caret) {
  const fm = text.match(/^(---|\+\+\+)\n[\s\S]*?\n\1(?=\n|$)/);
  if (fm && caret <= fm[0].length) return true;
  const fence = /^( {0,3})(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n {0,3}\2[`~]*[ \t]*(?=\n|$)|$(?![\s\S]))/gm;
  for (let m; (m = fence.exec(text)); ) {
    if (caret > m.index && caret <= m.index + m[0].length) return true;
    if (!m[0]) fence.lastIndex++;
  }
  const lineStart = text.lastIndexOf('\n', caret - 1) + 1;
  const lineEnd = text.indexOf('\n', caret) < 0 ? text.length : text.indexOf('\n', caret);
  const line = text.slice(lineStart, lineEnd);
  const at = caret - lineStart;
  // inline code on this line: inside a closed `…` span, or after an odd number of backticks
  for (const m of line.matchAll(/`[^`\n]*`/g)) if (at > m.index && at < m.index + m[0].length) return true;
  return (line.slice(0, at).replace(/`[^`\n]*`/g, '').match(/`/g) || []).length % 2 === 1;
}

/**
 * The math region containing `caret`, if any:
 * { start, end, innerStart, innerEnd, display, open, close, closed }.
 * Delimiters follow the sites' KaTeX auto-render config: $$…$$, \[…\], $…$, \(…\).
 * An unclosed opener extends to the end of the text (useful while typing).
 */
export function mathAt(text, caret) {
  return mathRegions(text).find((r) => caret >= r.innerStart && caret <= r.innerEnd) || null;
}

export function mathRegions(text) {
  const t = maskNonMath(text);
  const out = [];
  const opener = /(?<!\\)\$\$|\\\[|\\\(|(?<![\\$])\$(?!\$)/g;
  for (let m; (m = opener.exec(t)); ) {
    const open = m[0];
    const innerStart = m.index + open.length;
    let closeRe;
    if (open === '$$') closeRe = /(?<!\\)\$\$/g;
    else if (open === '\\[') closeRe = /\\\]/g;
    else if (open === '\\(') closeRe = /\\\)/g;
    else closeRe = /(?<![\\$])\$(?!\$)|\n/g; // inline $ closes on the same line
    closeRe.lastIndex = innerStart;
    let c = closeRe.exec(t);
    // Markdown ends the paragraph at a blank line and KaTeX never matches across paragraphs,
    // so an opener with no closer before the next blank line is unclosed (not paired far below).
    const blank = /\n[ \t]*\n/g;
    blank.lastIndex = innerStart;
    const b = blank.exec(t);
    if (open !== '$' && b && (!c || b.index < c.index)) c = { index: b.index, 0: '\n', length: 1 };
    if (open === '$') {
      // "$5 and $6" isn't math; a lone $ at line end isn't either.
      if (!c || c[0] === '\n' || c.index === innerStart || /\s/.test(t[innerStart]) || /\s/.test(t[c.index - 1]) || /\d/.test(t[c.index + 1] || '')) {
        continue;
      }
    }
    const closed = !!c && c[0] !== '\n';
    // unclosed: runs to the paragraph break if there is one, else to the end of the text
    const innerEnd = c ? c.index : t.length;
    const end = closed ? c.index + c[0].length : innerEnd;
    out.push({ start: m.index, end, innerStart, innerEnd, display: open === '$$' || open === '\\[', open, close: closed ? c[0] : '', closed });
    opener.lastIndex = end;
  }
  return out;
}

// ---------------------------------------------------------------- Markdown escaping
// Without Hugo's passthrough extension, Markdown processes backslash escapes before KaTeX sees the
// math: "\\\\" → "\\" (row break), "\{" → "{", "\," → ",". The sites are written that way.

const ASCII_PUNCT_ESC = /\\([!-\/:-@[-`{-~])/g;
/** What KaTeX on the published page receives for this source. */
export const mdUnescape = (s) => s.replace(ASCII_PUNCT_ESC, '$1');
/** Write TeX so that, after Markdown's unescaping, KaTeX receives `tex`. */
// A run of backslashes is doubled when Markdown would eat it: before punctuation (\{ \, \|), or
// any run of two or more (the TeX row break \\ is written \\\\, as in the posts). \frac stays \frac.
export const mdEscapeTex = (tex) =>
  tex.replace(/(\\+)([\s\S]?)/g, (m, run, ch) => (run.length >= 2 || /[!-\/:-@[-`{-~]/.test(ch) ? run + run : run) + ch);

// ---------------------------------------------------------------- completions

// [command, snippet (${n} = tab stops, ${0} = final caret), example to render, description]
const C = (cmd, snip, ex, desc) => ({ cmd, snip: snip ?? cmd, ex: ex ?? cmd, desc: desc ?? '' });
const greek = 'alpha beta gamma delta epsilon varepsilon zeta eta theta vartheta iota kappa lambda mu nu xi pi varpi rho varrho sigma varsigma tau upsilon phi varphi chi psi omega Gamma Delta Theta Lambda Xi Pi Sigma Upsilon Phi Psi Omega Nu'
  .split(' ').map((g) => C(`\\${g}`, null, null, 'Greek'));
const sym = (list, desc) => list.split(' ').map((s) => C(`\\${s}`, null, null, desc));

export const COMMANDS = [
  C('\\frac', '\\frac{${1}}{${2}}${0}', '\\frac{a}{b}', 'fraction'),
  C('\\dfrac', '\\dfrac{${1}}{${2}}${0}', '\\dfrac{a}{b}', 'display fraction'),
  C('\\tfrac', '\\tfrac{${1}}{${2}}${0}', '\\tfrac{a}{b}', 'text fraction'),
  C('\\sqrt', '\\sqrt{${1}}${0}', '\\sqrt{x}', 'square root'),
  C('\\sqrt[]', '\\sqrt[${1}]{${2}}${0}', '\\sqrt[n]{x}', 'n-th root'),
  C('\\binom', '\\binom{${1}}{${2}}${0}', '\\binom{n}{k}', 'binomial'),
  C('\\vec', '\\vec{${1}}${0}', '\\vec{x}', 'vector arrow'),
  C('\\hat', '\\hat{${1}}${0}', '\\hat{x}', 'hat'),
  C('\\bar', '\\bar{${1}}${0}', '\\bar{x}', 'bar'),
  C('\\tilde', '\\tilde{${1}}${0}', '\\tilde{x}', 'tilde'),
  C('\\dot', '\\dot{${1}}${0}', '\\dot{x}', 'dot'),
  C('\\ddot', '\\ddot{${1}}${0}', '\\ddot{x}', 'double dot'),
  C('\\overline', '\\overline{${1}}${0}', '\\overline{AB}', 'overline'),
  C('\\underline', '\\underline{${1}}${0}', '\\underline{x}', 'underline'),
  C('\\overbrace', '\\overbrace{${1}}^{${2}}${0}', '\\overbrace{a+b}^{n}', 'overbrace'),
  C('\\underbrace', '\\underbrace{${1}}_{${2}}${0}', '\\underbrace{a+b}_{n}', 'underbrace'),
  C('\\mathbf', '\\mathbf{${1}}${0}', '\\mathbf{A}', 'bold'),
  C('\\boldsymbol', '\\boldsymbol{${1}}${0}', '\\boldsymbol{\\alpha}', 'bold symbol'),
  C('\\mathrm', '\\mathrm{${1}}${0}', '\\mathrm{d}x', 'roman'),
  C('\\mathbb', '\\mathbb{${1}}${0}', '\\mathbb{R}', 'blackboard'),
  C('\\mathcal', '\\mathcal{${1}}${0}', '\\mathcal{L}', 'calligraphic'),
  C('\\text', '\\text{${1}}${0}', '\\text{if } x', 'text'),
  C('\\textbf', '\\textbf{${1}}${0}', '\\textbf{bold}', 'bold text'),
  C('\\textit', '\\textit{${1}}${0}', '\\textit{italic}', 'italic text'),
  C('\\textrm', '\\textrm{${1}}${0}', '\\textrm{roman}', 'roman text'),
  C('\\texttt', '\\texttt{${1}}${0}', '\\texttt{mono}', 'monospace text'),
  C('\\textcolor', '\\textcolor{${1:blue}}{${2}}${0}', '\\textcolor{blue}{x}', 'coloured text'),
  C('\\boxed', '\\boxed{${1}}${0}', '\\boxed{x=1}', 'box'),
  C('\\fbox', '\\fbox{${1}}${0}', '\\fbox{text}', 'framed text'),
  C('\\colorbox', '\\colorbox{${1:yellow}}{${2}}${0}', '\\colorbox{yellow}{x}', 'highlight'),
  C('\\cancel', '\\cancel{${1}}${0}', '\\cancel{x}', 'strike out'),
  C('\\mathit', '\\mathit{${1}}${0}', '\\mathit{x}', 'italic'),
  C('\\mathsf', '\\mathsf{${1}}${0}', '\\mathsf{A}', 'sans-serif'),
  C('\\mathtt', '\\mathtt{${1}}${0}', '\\mathtt{A}', 'typewriter'),
  C('\\mathfrak', '\\mathfrak{${1}}${0}', '\\mathfrak{g}', 'fraktur'),
  C('\\overset', '\\overset{${1}}{${2}}${0}', '\\overset{!}{=}', 'symbol over'),
  C('\\underset', '\\underset{${1}}{${2}}${0}', '\\underset{x}{\\arg\\max}', 'symbol under'),
  C('\\stackrel', '\\stackrel{${1}}{${2}}${0}', '\\stackrel{?}{=}', 'stacked relation'),
  C('\\xrightarrow', '\\xrightarrow{${1}}${0}', '\\xrightarrow{f}', 'labelled arrow'),
  C('\\overrightarrow', '\\overrightarrow{${1}}${0}', '\\overrightarrow{AB}', 'arrow over'),
  C('\\widehat', '\\widehat{${1}}${0}', '\\widehat{xy}', 'wide hat'),
  C('\\phantom', '\\phantom{${1}}${0}', 'a\\phantom{b}c', 'invisible spacing'),
  C('\\operatorname', '\\operatorname{${1}}${0}', '\\operatorname{rank}', 'operator name'),
  C('\\color', '\\color{${1:blue}}{${2}}${0}', '\\color{blue}{x}', 'colour'),
  C('\\tag', '\\tag{${1}}${0}', 'x \\tag{1}', 'equation number (display only)'),
  C('\\small', null, '\\small x', 'smaller (switch)'),
  C('\\large', null, '\\large x', 'larger (switch)'),
  C('\\sum', '\\sum_{${1:i=1}}^{${2:n}} ${0}', '\\sum_{i=1}^{n}', 'sum'),
  C('\\prod', '\\prod_{${1:i=1}}^{${2:n}} ${0}', '\\prod_{i=1}^{n}', 'product'),
  C('\\int', '\\int_{${1:a}}^{${2:b}} ${3} \\,d${4:x}${0}', '\\int_a^b f\\,dx', 'integral'),
  C('\\iint', null, null, 'double integral'),
  C('\\oint', null, null, 'contour integral'),
  C('\\lim', '\\lim_{${1:x \\to \\infty}} ${0}', '\\lim_{x \\to \\infty}', 'limit'),
  C('\\left(', '\\left( ${1} \\right)${0}', '\\left( \\frac{a}{b} \\right)', 'scaled parentheses'),
  C('\\left[', '\\left[ ${1} \\right]${0}', '\\left[ \\frac{a}{b} \\right]', 'scaled brackets'),
  C('\\left\\{', '\\left\\{ ${1} \\right\\}${0}', '\\left\\{ \\frac{a}{b} \\right\\}', 'scaled braces'),
  C('\\left|', '\\left| ${1} \\right|${0}', '\\left| \\frac{a}{b} \\right|', 'scaled bars'),
  C('\\langle', '\\langle ${1} \\rangle${0}', '\\langle u, v \\rangle', 'angle brackets'),
  // opens the environment list right away, which then writes both \begin{…} and \end{…}
  C('\\begin', '\\begin{${0}', '\\begin{matrix} a \\end{matrix}', 'environment…'),
  ...greek,
  ...sym('infty partial nabla cdot times div pm mp ast star circ bullet oplus otimes', 'operator'),
  ...sym('leq geq neq approx equiv sim simeq cong propto ll gg perp parallel', 'relation'),
  ...sym('in notin subset subseteq supset supseteq cup cap setminus emptyset forall exists neg land lor', 'set / logic'),
  ...sym('to rightarrow leftarrow Rightarrow Leftarrow leftrightarrow Leftrightarrow mapsto longmapsto longrightarrow implies iff uparrow downarrow', 'arrow'),
  ...sym('ldots cdots vdots ddots dots dotsb dotsc quad qquad', 'spacing / dots'),
  ...sym('sin cos tan sec csc cot arcsin arccos arctan sinh cosh tanh log ln exp det dim ker max min arg sup inf deg gcd', 'function'),
  C('\\\\', '\\\\\n${0}', 'a \\\\ b', 'new line'),
];

export const ENVIRONMENTS = [
  ['bmatrix', 'a & b \\\\ c & d'], ['pmatrix', 'a & b \\\\ c & d'], ['vmatrix', 'a & b \\\\ c & d'],
  ['Vmatrix', 'a & b \\\\ c & d'], ['Bmatrix', 'a & b \\\\ c & d'], ['matrix', 'a & b \\\\ c & d'],
  ['cases', 'x & x \\geq 0 \\\\ -x & x < 0'], ['aligned', 'a &= b \\\\ c &= d'], ['array', null],
  ['gathered', 'a \\\\ b'], ['split', 'a &= b'], ['align', 'a &= b'], ['align*', 'a &= b'],
].map(([env, ex]) => ({
  cmd: env,
  // one line, like the posts ($$\begin{bmatrix}1 & 3 \\\\ 3 & 12\end{bmatrix}$$); Enter between them expands it
  snip: env === 'array' ? 'array}{${1:cc}}${2}\\end{array}${0}' : `${env}}\${1}\\end{${env}}\${0}`,
  ex: ex ? `\\begin{${env}} ${ex} \\end{${env}}` : '\\begin{array}{cc} a & b \\end{array}',
  desc: 'environment',
}));

/**
 * Placeholder for a new sub/superscript, from what it's attached to:
 * \sum_ → i=1, \sum_{i=1}^ → n, \int_ → a / ^ → b, \lim_ → x \to \infty, otherwise ^ → 2, _ → i.
 */
export function scriptDefault(before, key) {
  const m = before.match(/\\([A-Za-z]+)\s*(?:[_^]\{[^{}]*\})?\s*$/);
  const name = m?.[1];
  if (/^(sum|prod|coprod|bigcup|bigcap|bigoplus|bigotimes)$/.test(name)) return key === '_' ? 'i=1' : 'n';
  if (/^(int|iint|iiint|oint)$/.test(name)) return key === '_' ? 'a' : 'b';
  if (/^(lim|limsup|liminf)$/.test(name) && key === '_') return 'x \\to \\infty';
  if (/^(max|min|sup|inf|arg)$/.test(name) && key === '_') return 'x';
  return key === '^' ? '2' : 'i';
}

/** Snippet for a command whose arguments are braces right after the name (\boxed → \boxed{…}), else null. */
export function braceSnippet(name) {
  const c = COMMANDS.find((x) => x.cmd === `\\${name}`);
  return c && c.snip.startsWith(`\\${name}{`) ? c.snip : null;
}

/** Could the user still be typing a longer command (\text → \textbf, \dot → \dots)? */
export function isAmbiguous(name) {
  return COMMANDS.some((x) => x.cmd !== `\\${name}` && /^\\[A-Za-z]+$/.test(x.cmd) && x.cmd.startsWith(`\\${name}`));
}

/** Completion candidates for the text just before the caret, or null when not completing. */
export function completions(before) {
  let m = before.match(/\\begin\{([A-Za-z*]*)$/);
  if (m) {
    const p = m[1].toLowerCase();
    const items = ENVIRONMENTS.filter((e) => e.cmd.toLowerCase().startsWith(p));
    return items.length ? { from: before.length - m[1].length, items, env: true } : null;
  }
  // an odd run of backslashes starts a command; "\\\\" is a TeX line break, not a completion
  m = before.match(/(?<!\\)(?:\\\\)*\\([A-Za-z]*)$/);
  if (!m) return null;
  const p = m[1];
  const lower = p.toLowerCase();
  const items = COMMANDS.filter((c) => c.cmd.slice(1).toLowerCase().startsWith(lower))
    // exact-case matches first (\Delta vs \delta), then shorter commands
    .sort((a, b) => (b.cmd.slice(1).startsWith(p) - a.cmd.slice(1).startsWith(p)) || a.cmd.length - b.cmd.length)
    .slice(0, 50);
  return items.length ? { from: before.length - p.length - 1, items, env: false } : null;
}

/** "\\frac{${1}}{${2}}${0}" → { text: "\\frac{}{}", stops: [6, 8, 9] } (offsets into text). */
export function expandSnippet(snip) {
  const stops = [];
  const named = new Map();
  let text = '';
  let last = 0;
  const re = /\$\{(\d+)(?::([^}]*))?\}/g;
  for (let m; (m = re.exec(snip)); ) {
    text += snip.slice(last, m.index);
    const n = Number(m[1]);
    const def = m[2] ?? '';
    if (named.has(n) && n !== 0) {
      // a repeated stop (e.g. the environment name in \begin{x}…\end{x}) mirrors the first
      text += named.get(n).def;
    } else {
      named.set(n, { def });
      stops.push({ n, at: text.length, len: def.length });
      text += def;
    }
    last = m.index + m[0].length;
  }
  text += snip.slice(last);
  const ordered = stops.filter((s) => s.n !== 0).sort((a, b) => a.n - b.n);
  const zero = stops.find((s) => s.n === 0);
  return { text, stops: [...ordered, ...(zero ? [zero] : [{ n: 0, at: text.length, len: 0 }])] };
}

// ---------------------------------------------------------------- DOM

const PALETTE = [
  ['Structures', [
    ['$$ block', null], ['\\frac{${1}}{${2}}${0}', '\\frac{a}{b}'], ['\\sqrt{${1}}${0}', '\\sqrt{x}'], ['^{${1}}${0}', 'x^{n}'], ['_{${1}}${0}', 'x_{i}'],
    ['\\vec{${1}}${0}', '\\vec{v}'], ['\\hat{${1}}${0}', '\\hat{x}'], ['\\sum_{${1:i=1}}^{${2:n}} ${0}', '\\sum_{i=1}^{n}'],
    ['\\int_{${1:a}}^{${2:b}} ${3} \\,d${4:x}${0}', '\\int_a^b'], ['\\lim_{${1:x \\to \\infty}} ${0}', '\\lim_{x\\to\\infty}'],
    ['\\begin{bmatrix}\n  ${1:a} & ${2:b} \\\\\n  ${3:c} & ${4:d}\n\\end{bmatrix}${0}', '\\begin{bmatrix} a & b \\\\ c & d \\end{bmatrix}'],
    ['\\begin{pmatrix}\n  ${1}\n\\end{pmatrix}${0}', '\\begin{pmatrix} a \\\\ b \\end{pmatrix}'],
    ['\\begin{cases}\n  ${1} & ${2} \\\\\n  ${3} & ${4}\n\\end{cases}${0}', '\\begin{cases} a & x \\\\ b & y \\end{cases}'],
    ['\\text{${1}}${0}', '\\text{abc}'], ['\\mathbb{${1:R}}${0}', '\\mathbb{R}'],
  ]],
  ['Greek', 'alpha beta gamma delta epsilon theta lambda mu pi rho sigma tau phi psi omega Gamma Delta Theta Lambda Sigma Phi Omega'.split(' ').map((g) => [`\\${g}`, `\\${g}`])],
  ['Relations', 'leq geq neq approx equiv sim propto in notin subseteq subset cup cap'.split(' ').map((g) => [`\\${g} `, `\\${g}`])],
  ['Operators & arrows', 'times cdot div pm infty partial nabla to Rightarrow iff mapsto longmapsto forall exists ldots'.split(' ').map((g) => [`\\${g} `, `\\${g}`])],
];

/**
 * Wire math assistance into the editor.
 * opts: { editor, wrap, isMarkdown(): bool, replace(a, b, text) (undo-friendly insert), enabled(): bool,
 *         paletteButton }
 */
export function initMathAssist(opts) {
  const { editor, wrap, isMarkdown, replace, enabled, paletteButton } = opts;
  const escapes = opts.markdownEscapes || (() => true); // site renders math after Markdown escaping
  const katex = () => window.katex;
  const pop = Object.assign(document.createElement('div'), { className: 'math-pop hidden' });
  const ac = Object.assign(document.createElement('div'), { className: 'math-ac hidden', role: 'listbox' });
  const caretMirror = Object.assign(document.createElement('div'), { className: 'caret-mirror' });
  wrap.append(pop, ac, caretMirror);
  const palette = Object.assign(document.createElement('div'), { className: 'math-palette hidden' });
  paletteButton.parentElement.style.position = 'relative';
  paletteButton.parentElement.append(palette);

  let stops = []; // pending snippet tab stops: [{at, len}], absolute offsets
  let lastLen = editor.value.length;
  let acState = null; // { from, items, index, env }
  let mirror = null; // \begin{|}\end{}: { name, end } — the \end name follows the \begin name as you type
  let syncing = false;
  let justBraced = null; // caret right inside braces the editor just added (a typed "{" there is absorbed)
  let inlinePair = null; // { open } — position of an auto-paired inline $ (its closer follows the content)
  let raf = 0;

  const render = (el, tex, display) => {
    if (!katex()) {
      el.textContent = tex;
      return null;
    }
    try {
      katex().render(tex, el, { displayMode: display, throwOnError: true, strict: 'ignore', output: 'html' });
      return null;
    } catch (e) {
      try {
        katex().render(tex, el, { displayMode: display, throwOnError: false, strict: 'ignore', output: 'html' });
      } catch {
        el.textContent = tex;
      }
      return String(e.message || e).replace(/^KaTeX parse error: /, '');
    }
  };

  // Caret pixel position (relative to the textarea's visible box) via a mirror element.
  function caretXY(index) {
    const cs = getComputedStyle(editor);
    for (const p of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'tabSize', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'whiteSpace', 'overflowWrap', 'wordBreak', 'boxSizing']) {
      caretMirror.style[p] = cs[p];
    }
    caretMirror.style.width = `${editor.clientWidth}px`;
    caretMirror.textContent = editor.value.slice(0, index);
    const mark = document.createElement('span');
    mark.textContent = editor.value.slice(index, index + 1) || '.';
    caretMirror.append(mark);
    const lh = parseFloat(cs.lineHeight) || 22;
    const pos = { x: mark.offsetLeft - editor.scrollLeft, y: mark.offsetTop - editor.scrollTop, lh };
    caretMirror.textContent = ''; // don't leave a post-sized invisible box around
    return pos;
  }

  function place(el, index) {
    const { y, x, lh } = caretXY(index);
    el.style.maxWidth = `${Math.max(200, wrap.clientWidth - 40)}px`;
    const h = el.offsetHeight;
    const below = y + lh + 6;
    el.style.top = `${below + h > wrap.clientHeight && y - h - 6 > 0 ? y - h - 6 : below}px`;
    el.style.left = `${Math.min(Math.max(8, x - 12), Math.max(8, wrap.clientWidth - el.offsetWidth - 8))}px`;
  }

  // ---- live preview of the equation under the caret
  function updatePreview() {
    if (!enabled() || !isMarkdown() || editor.selectionStart !== editor.selectionEnd || document.activeElement !== editor) {
      pop.classList.add('hidden');
      return;
    }
    const r = mathAt(editor.value, editor.selectionStart);
    if (!r) {
      pop.classList.add('hidden');
      stops = [];
      return;
    }
    let raw = editor.value.slice(r.innerStart, r.innerEnd);
    const typing = commandBefore(editor.selectionStart);
    if (typing && typing.start >= r.innerStart) {
      // "\\box|" isn't an error yet — preview the equation without the half-typed command
      raw = editor.value.slice(r.innerStart, typing.start) + editor.value.slice(editor.selectionStart, r.innerEnd);
    }
    const tex = escapes() ? mdUnescape(raw) : raw; // what KaTeX on the published page gets
    pop.replaceChildren();
    const body = document.createElement('div');
    body.className = 'math-pop-body';
    pop.append(body);
    const err = tex.trim() ? render(body, tex, r.display) : (body.textContent = 'empty equation', null);
    if (err || !r.closed || !katex()) {
      const note = document.createElement('div');
      note.className = 'math-pop-err';
      note.textContent = !katex() ? 'KaTeX not loaded — preview unavailable' : err || `no closing ${r.open === '\\(' ? '\\)' : r.open === '\\[' ? '\\]' : r.open} yet`;
      pop.append(note);
    }
    pop.classList.remove('hidden');
    // sit under the last line of a display block, or under the caret for inline math
    place(pop, r.display && r.closed ? Math.min(r.end, editor.value.length) : editor.selectionStart);
  }

  // ---- autocomplete
  function closeAc() {
    acState = null;
    ac.classList.add('hidden');
  }
  function updateAc() {
    if (!enabled() || !isMarkdown()) return closeAc();
    const caret = editor.selectionStart;
    if (caret !== editor.selectionEnd || !mathAt(editor.value, caret)) return closeAc();
    const lineStart = editor.value.lastIndexOf('\n', caret - 1) + 1;
    const c = completions(editor.value.slice(lineStart, caret));
    if (!c) return closeAc();
    const keep = acState && acState.items[acState.index];
    acState = { ...c, from: lineStart + c.from, index: Math.max(0, keep ? c.items.indexOf(keep) : 0) };
    ac.replaceChildren(...c.items.map((it, i) => {
      const row = document.createElement('div');
      row.className = `math-ac-row${i === acState.index ? ' active' : ''}`;
      row.setAttribute('role', 'option');
      const glyph = document.createElement('span');
      glyph.className = 'math-ac-glyph';
      render(glyph, it.ex, false);
      const name = document.createElement('code');
      name.textContent = c.env ? `\\begin{${it.cmd}}` : it.cmd;
      const desc = document.createElement('span');
      desc.className = 'math-ac-desc';
      desc.textContent = it.desc;
      row.append(glyph, name, desc);
      row.addEventListener('mousedown', (e) => {
        e.preventDefault();
        acState.index = i;
        acceptAc();
      });
      return row;
    }));
    ac.classList.remove('hidden');
    place(ac, acState.from);
    ac.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  }
  function moveAc(d) {
    acState.index = (acState.index + d + acState.items.length) % acState.items.length;
    [...ac.children].forEach((r, i) => r.classList.toggle('active', i === acState.index));
    ac.children[acState.index]?.scrollIntoView({ block: 'nearest' });
  }
  function insertSnippet(from, to, snip) {
    const a = from ?? editor.selectionStart;
    const { text, stops: st } = expandSnippet(escapes() ? mdEscapeTex(snip) : snip);
    replace(a, to, text);
    // nested snippets (\sqrt inside \frac's numerator) keep the outer snippet's remaining stops,
    // which the synchronous input event inside replace() has already shifted
    stops = [...st.map((s) => ({ at: a + s.at, len: s.len })), ...stops];
    lastLen = editor.value.length;
    jump();
  }
  function liveCompletions() {
    const caret = editor.selectionStart;
    if (caret !== editor.selectionEnd || !mathAt(editor.value, caret)) return null;
    const lineStart = editor.value.lastIndexOf('\n', caret - 1) + 1;
    const before = editor.value.slice(lineStart, caret);
    const c = completions(before);
    return c && { from: lineStart + c.from, empty: /\\$/.test(before) };
  }

  function acceptAc() {
    const { from, env } = acState;
    const it = acState.items[acState.index];
    const v = editor.value;
    let end = editor.selectionStart;
    if (env && mirror && mirror.name === from && v.startsWith('\\end{', mirror.end)) {
      // replace "bm}\end{bm}" (the mirrored pair) with the full environment
      const close = v.indexOf('}', mirror.end + 5);
      if (close >= 0) end = close + 1;
    } else if (env && v[end] === '}') end++; // \begin{bm|} → swallow the auto-closed brace
    mirror = null;
    closeAc();
    insertSnippet(from, end, it.snip);
  }

  function jump() {
    const s = stops.shift();
    if (!s) return false;
    editor.setSelectionRange(s.at, s.at + s.len);
    return true;
  }

  // keep pending tab stops (and the mirrored \end) pointing at the same places as text is typed/deleted
  function shiftStops() {
    const delta = editor.value.length - lastLen;
    lastLen = editor.value.length;
    if (!delta) return;
    const p0 = delta > 0 ? editor.selectionStart - delta : editor.selectionStart;
    for (const s of stops) if (s.at >= p0) s.at += delta;
    if (mirror && mirror.end >= p0) mirror.end += delta;
  }

  function unpairMoney() {
    if (!inlinePair) return;
    const v = editor.value;
    const caret = editor.selectionStart;
    if (v[inlinePair.open] !== '$') { inlinePair = null; return; }
    const close = v.indexOf('$', inlinePair.open + 1);
    const content = close < 0 ? '' : v.slice(inlinePair.open + 1, close);
    if (close < 0 || caret < inlinePair.open + 1 || caret > close || content.includes('\n')) { inlinePair = null; return; }
    if (/^\d[\d.,]*\s$/.test(content) && caret === close) {
      // that was a dollar amount ("$5 "), not math
      inlinePair = null;
      syncing = true;
      editor.setRangeText('', close, close + 1, 'preserve');
      lastLen = editor.value.length;
      editor.dispatchEvent(new Event('input'));
      syncing = false;
      return;
    }
    if (!/^\d[\d.,]*$/.test(content)) inlinePair = null; // clearly math now; stop watching
  }

  /** \begin| → \begin{|}\end{} with the \end name mirroring what you type. */
  function beginMirror(caret) {
    replace(caret, caret, '{}\\end{}');
    editor.setSelectionRange(caret + 1, caret + 1);
    mirror = { name: caret + 1, end: caret + 2 };
    justBraced = caret + 1;
    lastLen = editor.value.length;
    schedule();
  }

  /** The \name being typed right before the caret (odd backslash run), or null. */
  function commandBefore(caret) {
    const v = editor.value;
    const lineStart = v.lastIndexOf('\n', caret - 1) + 1;
    const m = v.slice(lineStart, caret).match(/(?<!\\)(?:\\\\)*\\([A-Za-z]+)$/);
    return m ? { name: m[1], start: caret - m[1].length - 1 } : null;
  }

  function expandBraces(cmd, caret) {
    closeAc();
    insertSnippet(cmd.start, caret, braceSnippet(cmd.name));
    justBraced = editor.selectionStart;
  }

  /** On a typed letter that completes an unambiguous argument-taking command, add its braces. */
  function autoBraces(ev) {
    if (!enabled() || !isMarkdown() || ev?.inputType !== 'insertText' || !/^[A-Za-z]$/.test(ev.data || '')) return;
    const caret = editor.selectionStart;
    if (caret !== editor.selectionEnd || !mathAt(editor.value, caret)) return;
    const next = editor.value[caret] || '';
    if (/[A-Za-z{]/.test(next)) return; // mid-word, or braces already there
    const cmd = commandBefore(caret);
    if (!cmd) return;
    if (cmd.name === 'begin') return beginMirror(caret);
    if (braceSnippet(cmd.name) && !isAmbiguous(cmd.name)) expandBraces(cmd, caret);
  }

  function syncMirror() {
    if (!mirror || syncing) return;
    const v = editor.value;
    const nameEnd = v.indexOf('}', mirror.name);
    const ok = v.slice(mirror.name - 7, mirror.name) === '\\begin{' && nameEnd >= 0 && nameEnd <= mirror.end
      && !v.slice(mirror.name, nameEnd).includes('\n') && v.startsWith('\\end{', mirror.end);
    const caret = editor.selectionStart;
    if (!ok || caret < mirror.name || caret > nameEnd) {
      mirror = null; // finished (or the user went elsewhere)
      return;
    }
    const name = v.slice(mirror.name, nameEnd);
    const eStart = mirror.end + 5;
    const eEnd = v.indexOf('}', eStart);
    if (eEnd < 0 || v.slice(eStart, eEnd).includes('\n')) {
      mirror = null;
      return;
    }
    if (v.slice(eStart, eEnd) === name) return;
    syncing = true;
    editor.setRangeText(name, eStart, eEnd, 'preserve');
    lastLen = editor.value.length;
    editor.dispatchEvent(new Event('input')); // let the app re-highlight / mark dirty
    syncing = false;
  }

  // ---- keys: autocomplete navigation, tab stops, auto-pairs, auto-close environments/blocks
  editor.addEventListener('keydown', (e) => {
    if (!enabled() || !isMarkdown() || e.metaKey || e.ctrlKey || e.altKey) return;
    if (acState) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); moveAc(e.key === 'ArrowDown' ? 1 : -1); return; }
      if (e.key === 'Enter' || e.key === 'Tab') {
        const live = liveCompletions();
        // the caret may have moved without an input event (arrow keys, brace skip-over)
        if (!live || live.from !== acState.from || (e.key === 'Enter' && live.empty)) {
          closeAc();
        } else {
          e.preventDefault();
          e.stopImmediatePropagation();
          acceptAc();
          return;
        }
      }
      if (e.key === 'Escape') { e.preventDefault(); closeAc(); return; }
    }
    const caret = editor.selectionStart;
    const v = editor.value;
    if (e.key === 'Tab' && !e.shiftKey && stops.length && mathAt(v, caret)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      jump();
      return;
    }
    if (e.key === 'Escape') { stops = []; mirror = null; pop.classList.add('hidden'); return; }
    const single = caret === editor.selectionEnd;
    if (e.key === '$' && !single && !inCodeAt(v, caret) && !mathAt(v, caret)) {
      // a selection gets wrapped as inline math
      e.preventDefault();
      const sel = v.slice(caret, editor.selectionEnd);
      replace(caret, editor.selectionEnd, `$${sel}$`);
      editor.setSelectionRange(caret + 1, caret + 1 + sel.length);
      return;
    }
    if (e.key === '$' && single) {
      // $|$ + $ → $$|$$ (upgrade an empty inline pair to display math)
      // only for the empty pair the editor just made — not the middle of a closing $$
      if (inlinePair?.open === caret - 1 && v[caret - 1] === '$' && v[caret] === '$') {
        e.preventDefault();
        replace(caret, caret + 1, '$$$');
        editor.setSelectionRange(caret + 1, caret + 1);
        inlinePair = null;
        return;
      }
      // retyping the closing $ of inline math steps over it
      const here = mathAt(v, caret);
      if (here && here.open === '$' && here.closed && caret === here.innerEnd && v[caret] === '$') {
        e.preventDefault();
        editor.setSelectionRange(caret + 1, caret + 1);
        inlinePair = null;
        schedule();
        return;
      }
      // open inline math: $ → $|$, only at a word boundary and never in code or inside math already
      const prev = v[caret - 1];
      const next = v[caret];
      const boundaryBefore = caret === 0 || /[\s(\[{>"'*_~,;:]/.test(prev);
      const boundaryAfter = caret === v.length || /[\s.,;:!?)\]}<"'*_~]/.test(next);
      if (boundaryBefore && boundaryAfter && prev !== '\\' && !here && !inCodeAt(v, caret)) {
        e.preventDefault();
        replace(caret, caret, '$$');
        editor.setSelectionRange(caret + 1, caret + 1);
        inlinePair = { open: caret };
        return;
      }
      const rs = mathRegions(v);
      // retyping the closing $$ steps over it
      if (v[caret] === '$' && rs.some((r) => r.closed && r.close === '$$' && (caret === r.innerEnd || caret === r.innerEnd + 1))) {
        e.preventDefault();
        editor.setSelectionRange(caret + 1, caret + 1);
        schedule();
        return;
      }
      // the second $ of an opening $$ adds the closing $$: $$|$$
      if (v[caret - 1] === '$' && v[caret - 2] !== '$' && v[caret - 2] !== '\\') {
        const t2 = `${v.slice(0, caret)}$${v.slice(caret)}`;
        const r = mathRegions(t2).find((x) => x.start === caret - 1 && x.open === '$$');
        if (r && !r.closed) {
          e.preventDefault();
          replace(caret, caret, '$$$');
          editor.setSelectionRange(caret + 1, caret + 1);
          return;
        }
      }
    }
    if (e.key === 'Backspace' && single && inlinePair?.open === caret - 1 && v[caret - 1] === '$' && v[caret] === '$') {
      e.preventDefault(); // empty $|$ → remove both
      replace(caret - 1, caret + 1, '');
      inlinePair = null;
      return;
    }
    if (e.key === 'Backspace' && single && v.slice(caret - 2, caret) === '$$' && v.slice(caret, caret + 2) === '$$') {
      e.preventDefault(); // empty $$|$$ → remove both
      replace(caret - 2, caret + 2, '');
      return;
    }
    const region = mathAt(v, caret);
    if (e.key === '{' && single && justBraced === caret && v[caret - 1] === '{') {
      e.preventDefault(); // "\\boxed" already became "\\boxed{|}": the habitual "{" is absorbed
      justBraced = null;
      return;
    }
    justBraced = null;
    if (e.key === ' ' && region && single) {
      // \text could still become \textbf; a space settles it as \text{|}
      const cmd = commandBefore(caret);
      if (cmd && braceSnippet(cmd.name) && isAmbiguous(cmd.name)) {
        e.preventDefault();
        expandBraces(cmd, caret);
        return;
      }
    }
    if (region && single && ['(', '[', '|', '.'].includes(e.key) && commandBefore(caret)?.name === 'left') {
      // \left( alone is an error until its \right) exists: add it, caret in the middle
      e.preventDefault();
      const close = { '(': ')', '[': ']', '|': '|', '.': '.' }[e.key];
      replace(caret, caret, `${e.key}  \\right${close}`);
      editor.setSelectionRange(caret + 2, caret + 2);
      return;
    }
    if (region && single && e.key === '{') {
      const lb = v.slice(0, caret).match(/(?<!\\)(?:\\\\)*\\left(\\{1,2})$/);
      if (lb) {
        // \left\{ (or \left\\{ with Markdown escaping) → \left\{ | \right\}
        e.preventDefault();
        replace(caret, caret, `{  \\right${lb[1]}}`);
        editor.setSelectionRange(caret + 2, caret + 2);
        return;
      }
    }
    if ((e.key === '^' || e.key === '_') && region) {
      // x^ → x^{2} / x_ → x_{i} with the placeholder selected, so the formula never sits half-typed
      // (KaTeX: "Expected group after '^'"); typing replaces it, Tab or } steps out
      const prevRun = (v.slice(0, caret).match(/\\+$/) || [''])[0].length;
      if (prevRun % 2 === 0 && v[editor.selectionEnd] !== '{') {
        e.preventDefault();
        const sel = v.slice(caret, editor.selectionEnd);
        if (sel) {
          // wrap the selection verbatim: x [ij] + _ → x_{ij}|
          const text = `${e.key}{${sel}}`;
          replace(caret, editor.selectionEnd, text);
          editor.setSelectionRange(caret + text.length, caret + text.length);
        } else {
          insertSnippet(caret, caret, `${e.key}{\${1:${scriptDefault(v.slice(0, caret), e.key)}}}\${0}`);
        }
        return;
      }
    }
    if (e.key === '{' && region && single) {
      const lineStart = v.lastIndexOf('\n', caret - 1) + 1;
      if (/(?<!\\)(?:\\\\)*\\begin$/.test(v.slice(lineStart, caret))) {
        e.preventDefault();
        beginMirror(caret);
        return;
      }
    }
    if (e.key === '{' && region) {
      e.preventDefault();
      const sel = v.slice(caret, editor.selectionEnd);
      replace(caret, editor.selectionEnd, `{${sel}}`);
      editor.setSelectionRange(caret + 1, caret + 1 + sel.length);
      return;
    }
    if (e.key === '}' && region && v[caret] === '}' && caret === editor.selectionEnd) {
      e.preventDefault();
      editor.setSelectionRange(caret + 1, caret + 1);
      if (/\\begin\{(?:array|subarray)$/.test(v.slice(0, caret)) && v[caret + 1] !== '{') {
        // array needs a column spec or KaTeX errors: \begin{array}{|cc|} with "cc" selected
        mirror = null;
        insertSnippet(caret + 1, caret + 1, '{${1:cc}}${0}');
        return;
      }
      schedule(); // the caret moved without an input event
      return;
    }
    if (e.key === 'Backspace' && region && caret === editor.selectionEnd && v[caret - 1] === '{' && v[caret] === '}') {
      e.preventDefault();
      replace(caret - 1, caret + 1, '');
      return;
    }
    // Inside closed display math ($$…$$, \[…\]) Enter is a TeX row break, written the way the site
    // needs it (\\\\ with Markdown escaping, else \\), spaced like the posts: "1 & 3 \\\\ 3 & 12".
    // Shift+Enter is a real new line and does the smart expansions below instead.
    const rowBreakMode = !!region && region.closed; // display and inline math alike
    if (e.key === 'Enter' && rowBreakMode && !e.shiftKey && caret === editor.selectionEnd) {
      e.preventDefault();
      const brk = escapes() ? '\\\\\\\\' : '\\\\';
      const before = v[caret - 1];
      const after = v[caret];
      const text = `${before && !/\s/.test(before) ? ' ' : ''}${brk}${after && !/\s/.test(after) ? ' ' : ''}`;
      replace(caret, caret, text);
      const end = caret + text.length + (after === ' ' ? 1 : 0);
      editor.setSelectionRange(end, end);
      return;
    }
    if (e.key === 'Enter' && (rowBreakMode ? e.shiftKey : !e.shiftKey) && caret === editor.selectionEnd) {
      const lineStart = v.lastIndexOf('\n', caret - 1) + 1;
      const line = v.slice(lineStart, caret);
      const indent = line.match(/^\s*/)[0];
      // Enter between \begin{env}|\end{env} opens it onto its own lines
      const between = line.match(/\\begin\{([^}]+)\}(?:\{[^}]*\})?$/);
      if (between && region && v.startsWith(`\\end{${between[1]}}`, caret)) {
        e.preventDefault();
        replace(caret, caret, `\n${indent}  \n${indent}`);
        editor.setSelectionRange(caret + 1 + indent.length + 2, caret + 1 + indent.length + 2);
        return;
      }
      // Enter between $$|$$ opens a display block
      if (region && region.open === '$$' && v.slice(caret - 2, caret) === '$$' && v.slice(caret, caret + 2) === '$$') {
        e.preventDefault();
        replace(caret, caret, `\n${indent}\n${indent}`);
        editor.setSelectionRange(caret + 1 + indent.length, caret + 1 + indent.length);
        return;
      }
      const env = line.match(/\\begin\{([^}]+)\}(?:\{[^}]*\})?\s*$/);
      if (env && region) {
        const rest = v.slice(caret, region.closed ? region.innerEnd : v.length);
        const opens = (rest.match(new RegExp(`\\\\begin\\{${env[1].replace(/[*]/g, '\\*')}\\}`, 'g')) || []).length;
        const closes = (rest.match(new RegExp(`\\\\end\\{${env[1].replace(/[*]/g, '\\*')}\\}`, 'g')) || []).length;
        if (closes <= opens) {
          e.preventDefault();
          replace(caret, caret, `\n${indent}  \n${indent}\\end{${env[1]}}`);
          editor.setSelectionRange(caret + indent.length + 3, caret + indent.length + 3);
          return;
        }
      }
      if (/^\s*\$\$\s*$/.test(line) && region && region.display && !region.closed && region.open === '$$') {
        e.preventDefault();
        replace(caret, caret, `\n${indent}\n${indent}$$`);
        editor.setSelectionRange(caret + 1 + indent.length, caret + 1 + indent.length);
      }
    }
  }, true);

  const schedule = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      updatePreview();
      updateAc();
    });
  };
  editor.addEventListener('input', (ev) => {
    if (syncing) return;
    shiftStops();
    syncMirror();
    unpairMoney();
    autoBraces(ev);
    schedule();
  });
  editor.addEventListener('click', schedule);
  editor.addEventListener('keyup', (e) => {
    // Up/Down navigate the open completion list; every other caret key re-evaluates it
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(e.key) || (!acState && ['ArrowUp', 'ArrowDown'].includes(e.key))) schedule();
  });
  editor.addEventListener('scroll', () => {
    if (!pop.classList.contains('hidden') || acState) schedule();
  });
  editor.addEventListener('blur', () => setTimeout(() => {
    if (document.activeElement !== editor) {
      pop.classList.add('hidden');
      closeAc();
    }
  }, 150));

  // ---- symbol palette
  function buildPalette() {
    palette.replaceChildren(...PALETTE.map(([title, items]) => {
      const sec = document.createElement('div');
      sec.className = 'math-pal-sec';
      const h = document.createElement('div');
      h.className = 'math-pal-title';
      h.textContent = title;
      const grid = document.createElement('div');
      grid.className = 'math-pal-grid';
      for (const [snip, ex] of items) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'math-pal-btn';
        b.title = snip ? snip.replace(/\$\{\d+(?::([^}]*))?\}/g, '$1').trim() : 'display math block';
        if (ex) render(b, ex, false);
        else b.textContent = '$$ block';
        b.addEventListener('mousedown', (e) => e.preventDefault());
        b.addEventListener('click', () => {
          palette.classList.add('hidden');
          editor.focus();
          paletteInsert(snip);
        });
        grid.append(b);
      }
      sec.append(h, grid);
      return sec;
    }));
  }
  function paletteInsert(snip) {
    const a = editor.selectionStart;
    const b = editor.selectionEnd;
    const v = editor.value;
    if (!snip) {
      // display block on its own lines, wrapping any selection
      const sel = v.slice(a, b);
      const pre = a > 0 && v[a - 1] !== '\n' ? '\n' : '';
      if (sel) {
        // selected text goes in verbatim (not through the snippet parser)
        const text = `${pre}$$\n${sel}\n$$\n`;
        replace(a, b, text);
        editor.setSelectionRange(a + text.length, a + text.length);
      } else insertSnippet(a, b, `${pre}$$\n\${1}\n$$\n\${0}`);
      return;
    }
    if (mathAt(v, a)) insertSnippet(a, b, snip);
    // outside math: inline $…$ for one-liners; multi-line structures need a $$ block (inline $ can't span lines)
    else if (snip.includes('\n')) insertSnippet(a, b, `${a > 0 && v[a - 1] !== '\n' ? '\n' : ''}$$\n${snip.replace(/\$\{0\}/, '')}\n$$\n\${0}`);
    else insertSnippet(a, b, `$${snip.replace(/\$\{0\}/, '').trimEnd()}$\${0}`);
  }
  paletteButton.addEventListener('click', (e) => {
    e.preventDefault();
    if (palette.classList.toggle('hidden')) return;
    if (!palette.childElementCount) buildPalette();
  });
  document.addEventListener('mousedown', (e) => {
    if (!palette.contains(e.target) && e.target !== paletteButton) palette.classList.add('hidden');
  });

  return {
    refresh: schedule,
    hide() {
      pop.classList.add('hidden');
      closeAc();
      stops = [];
      mirror = null;
      inlinePair = null;
      lastLen = editor.value.length;
    },
  };
}
