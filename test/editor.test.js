// Pure logic behind the editor's math assistant and scroll sync (DOM parts are exercised in the browser).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mathAt, mathRegions, completions, expandSnippet, COMMANDS, ENVIRONMENTS } from '../public/mathedit.js';
import { norm, pairAnchors, mapScroll } from '../public/scrollsync.js';

const at = (doc) => {
  const i = doc.indexOf('|');
  return [doc.slice(0, i) + doc.slice(i + 1), i];
};

test('mathAt finds the math around the caret for every delimiter', () => {
  let [t, c] = at('text $a_|b$ more');
  assert.deepEqual((({ open, display, closed }) => ({ open, display, closed }))(mathAt(t, c)), { open: '$', display: false, closed: true });
  [t, c] = at('para\n$$\n\\frac{a}{|b}\n$$\nafter');
  let r = mathAt(t, c);
  assert.equal(r.open, '$$');
  assert.equal(r.display, true);
  assert.equal(t.slice(r.innerStart, r.innerEnd), '\n\\frac{a}{b}\n');
  [t, c] = at('see \\(x|\\) and \\[y\\]');
  assert.equal(mathAt(t, c).open, '\\(');
  [t, c] = at('see \\(x\\) and \\[|y\\]');
  assert.equal(mathAt(t, c).display, true);
  [t, c] = at('typing $$\n\\begin{bmatrix}|');
  r = mathAt(t, c);
  assert.equal(r.closed, false, 'unclosed opener still counts while typing');
});

test('mathAt ignores things that are not math', () => {
  for (const doc of ['costs $5 and |$6', 'plain | text', '`$x|$` in code', '```\n$$\nx|\n$$\n```', '---\ntitle: "$a|$"\n---\nbody', 'a $ b | c', 'escaped \\$x|\\$']) {
    const [t, c] = at(doc);
    assert.equal(mathAt(t, c), null, doc);
  }
});

test('regions found in every real post match the delimiters', () => {
  const root = path.join(os.homedir(), 'pradeepr.cloud', 'content');
  if (!fs.existsSync(root)) return;
  let n = 0;
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
    const p = path.join(d, e.name);
    if (e.isDirectory()) return walk(p);
    if (!p.endsWith('.md')) return;
    const t = fs.readFileSync(p, 'utf8');
    for (const r of mathRegions(t)) {
      assert.equal(t.slice(r.start, r.innerStart), r.open, p);
      if (r.closed) assert.equal(t.slice(r.innerEnd, r.end), r.close, p);
      n++;
    }
  });
  walk(root);
  assert.ok(n > 100, `found only ${n} math regions`);
  console.log(`  ${n} math regions in real posts`);
});

test('completions: commands by prefix, case-aware, environments after \\begin{', () => {
  let c = completions('x + \\fr');
  assert.equal(c.items[0].cmd, '\\frac');
  assert.equal(c.from, 4);
  c = completions('\\De');
  assert.equal(c.items[0].cmd, '\\Delta', 'exact case first');
  c = completions('\\begin{bm');
  assert.equal(c.env, true);
  assert.equal(c.items[0].cmd, 'bmatrix');
  assert.equal(completions('no backslash'), null);
  assert.equal(completions('\\zzzz'), null);
  for (const used of ['\\vec', '\\text', '\\small', '\\longmapsto', '\\hat', '\\tag', '\\color', '\\Nu', '\\Sigma'])
    assert.ok(COMMANDS.some((x) => x.cmd === used), `${used} (used in the posts) is offered`);
  for (const env of ['bmatrix', 'cases', 'array', 'pmatrix', 'Vmatrix']) assert.ok(ENVIRONMENTS.some((e) => e.cmd === env), env);
});

test('expandSnippet: tab stops, defaults, mirrored stops, final caret', () => {
  assert.deepEqual(expandSnippet('\\frac{${1}}{${2}}${0}'), {
    text: '\\frac{}{}', stops: [{ n: 1, at: 6, len: 0 }, { n: 2, at: 8, len: 0 }, { n: 0, at: 9, len: 0 }],
  });
  const s = expandSnippet('\\sum_{${1:i=1}}^{${2:n}} ${0}');
  assert.equal(s.text, '\\sum_{i=1}^{n} ');
  assert.deepEqual(s.stops.map((x) => [x.at, x.len]), [[6, 3], [12, 1], [15, 0]]);
  const env = expandSnippet('\\begin{${1:x}}\n  ${2}\n\\end{${1:x}}${0}');
  assert.equal(env.text, '\\begin{x}\n  \n\\end{x}');
  assert.equal(expandSnippet('\\alpha').stops.at(-1).at, 6, 'no stops → caret at end');
  // every built-in snippet expands without leftover markers
  for (const x of [...COMMANDS, ...ENVIRONMENTS]) assert.doesNotMatch(expandSnippet(x.snip).text, /\$\{/, x.cmd);
});

test('scroll sync: heading matching and piecewise mapping', () => {
  assert.equal(norm('## 2. Matrices **as** `maps` {#m}'), '2 matrices as maps');
  assert.equal(norm('Least Squares — Approximation'), norm('least squares approximation'));
  const pairs = pairAnchors(
    [{ y: 100, text: ' Intro' }, { y: 500, text: ' Not rendered' }, { y: 900, text: ' Two' }],
    [{ y: 50, text: 'Title' }, { y: 300, text: 'Intro' }, { y: 1200, text: 'Two' }],
  );
  assert.deepEqual(pairs, [{ e: 100, p: 300 }, { e: 900, p: 1200 }]);
  const a = [{ e: 0, p: 0 }, ...pairs, { e: 1000, p: 2000 }];
  assert.equal(mapScroll(0, a), 0);
  assert.equal(mapScroll(100, a), 300);
  assert.equal(mapScroll(500, a), 750);
  assert.equal(mapScroll(950, a), 1600);
  assert.equal(mapScroll(5000, a), 2000);
});

test('a TeX line break "\\\\" never opens autocomplete (matrix/cases rows)', () => {
  assert.equal(completions('a & b \\\\'), null);
  assert.equal(completions('x \\\\\\\\'), null, 'two line breaks in a row');
  const c = completions('a \\\\ \\fr');
  assert.equal(c.items[0].cmd, '\\frac', 'commands after a line break still complete');
  assert.equal(completions('\\\\\\fr').items[0].cmd, '\\frac', 'odd run: \\\\ then \\fr');
});

test('math stops at a paragraph break, like KaTeX on the page (no swallowing the post)', async () => {
  const { mathRegions: regions } = await import('../public/mathedit.js');
  // the screenshot case: a half-typed $$ block followed by paragraphs and a later $$
  const doc = '$$\\begin{bmatrix}\n\nLets visualize our journey.\n\n<video src="x.mp4"></video>\n\nsee $$x$$ here';
  const r = mathAt(doc, 3);
  assert.equal(r.closed, false);
  assert.equal(doc.slice(r.innerStart, r.innerEnd), '\\begin{bmatrix}', 'only the formula, not the following paragraphs');
  const later = regions(doc).find((x) => doc.slice(x.innerStart, x.innerEnd) === 'x');
  assert.ok(later && later.closed, 'the later $$x$$ is its own region');
  // a closed multi-line block inside one paragraph still works
  const ok = mathAt('$$\n\\frac{a}{b}\n$$', 4);
  assert.equal(ok.closed, true);
});

test('Markdown escaping: preview sees what the page sees; snippets are written escaped', async () => {
  const { mdUnescape, mdEscapeTex } = await import('../public/mathedit.js');
  // from a real Hugo build of these sites (goldmark, no passthrough)
  assert.equal(mdUnescape('a \\\\\\\\ b \\\\ c \\{ d \\} e \\, f \\_ g x_1'), 'a \\\\ b \\ c { d } e , f _ g x_1');
  assert.equal(mdEscapeTex('a & b \\\\ c'), 'a & b \\\\\\\\ c', 'row break → \\\\\\\\');
  assert.equal(mdEscapeTex('\\left\\{ x \\right\\} \\, \\frac{a}{b}'), '\\left\\\\{ x \\right\\\\} \\\\, \\frac{a}{b}');
  for (const tex of ['\\begin{bmatrix} a & b \\\\ c & d \\end{bmatrix}', '\\left\\{ \\frac{1}{2} \\right\\}', 'a \\, b \; c \\! d', '\\text{x}_{i}^{2}'])
    assert.equal(mdUnescape(mdEscapeTex(tex)), tex, `round trip: ${tex}`);
  // the real posts' matrices preview correctly
  assert.equal(mdUnescape('\\begin{bmatrix}1 & 3 \\\\\\\\ 3 & 12\\end{bmatrix}'), '\\begin{bmatrix}1 & 3 \\\\ 3 & 12\\end{bmatrix}');
});

test('environment completions are one line, matching the posts', () => {
  const env = ENVIRONMENTS.find((e) => e.cmd === 'bmatrix');
  assert.equal(expandSnippet(env.snip).text, 'bmatrix}\\end{bmatrix}');
});

test('calibrated scroll: the caret’s block lands at the caret’s height in the preview, around tall media', async () => {
  const { scrollTarget, mapScroll: map } = await import('../public/scrollsync.js');
  // editor: 22px lines. Source: heading(line 10), paragraph(11), image(13), video(15), heading(17), para(18)
  // preview: the image is 600px tall and the video 450px, so preview positions run far ahead of the editor
  const L = (n) => n * 22;
  const anchors = [
    { e: 0, p: 0 },
    { e: L(10), p: 400 }, { e: L(11), p: 460 }, { e: L(13), p: 560 }, { e: L(15), p: 1180 },
    { e: L(17), p: 1650 }, { e: L(18), p: 1710 },
    { e: 2000, p: 4000 },
  ];
  const editor = { scrollTop: 100, height: 600, maxScroll: 1400 };
  const preview = { height: 800, maxScroll: 3200, minRef: 92 };
  // caret on the heading after the video, 274px down the editor viewport (fraction .457)
  const refY = L(17);
  const t = scrollTarget(anchors, { ...editor, refY }, preview);
  const onScreenPreview = 1650 - t; // where that heading appears in the preview viewport
  assert.ok(Math.abs(onScreenPreview / preview.height - (refY - editor.scrollTop) / editor.height) < 0.01,
    `heading at ${onScreenPreview}px of 800 vs caret at ${refY - editor.scrollTop}px of 600`);
  // caret inside the image line maps inside the image, not past it
  assert.ok(map(L(14), anchors) > 560 && map(L(14), anchors) < 1180);
  // top and bottom
  assert.equal(scrollTarget(anchors, { ...editor, scrollTop: 0, refY: 10 }, preview), 0);
  assert.equal(scrollTarget(anchors, { ...editor, scrollTop: 1400, refY: 1700 }, preview), 3200);
  // the reference never hides under the navbar
  const top = scrollTarget(anchors, { ...editor, refY: editor.scrollTop + 2 }, preview);
  assert.ok(map(editor.scrollTop + 2, anchors) - top >= 92);
});
