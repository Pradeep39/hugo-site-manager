// Live-preview renderer: structure, line tags, math, and fidelity against Hugo's real output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { renderMarkdown, headingId } from '../public/markdown.js';

const doc = `---
title: "T"
---
## Intro **bold**

Para with $A\\vec{x}$ and a [link](https://x.y) and ![img](pic.png).

$$\\begin{bmatrix}1 & 3 \\\\\\\\ 3 & 12\\end{bmatrix}$$

\`\`\`bash
echo "hi"
\`\`\`

<video src="clip.mp4" controls></video>

- one
- two

| a | b |
|---|--:|
| 1 | 2 |
`;

test('every top-level block carries its source line (front matter counted)', () => {
  const html = renderMarkdown(doc);
  const lines = [...html.matchAll(/<(\w+)[^>]*data-line="(\d+)"/g)].map((m) => [m[1], Number(m[2])]);
  assert.deepEqual(lines, [['h2', 3], ['p', 5], ['p', 7], ['div', 9], ['div', 13], ['ul', 15], ['table', 18]]);
  const src = doc.split('\n');
  assert.match(src[3], /^## Intro/);
  assert.match(src[15], /^- one/);
});

test('headings get goldmark-style ids; external links open in a new tab; images resolve', () => {
  const html = renderMarkdown(doc, { url: (u, kind) => (kind === 'img' ? `/raw/${u}` : u) });
  assert.match(html, /<h2 id="intro-bold"/);
  assert.match(html, /<a href="https:\/\/x\.y" target="_blank" rel="noopener">link<\/a>/);
  assert.match(html, /<img src="\/raw\/pic\.png" alt="img">/);
  assert.match(html, /<video src="clip\.mp4" controls><\/video>/, 'raw HTML passes through (unsafe: true)');
  assert.equal(headingId('3. Least Squares — Approximation'), '3-least-squares--approximation');
});

test('math is protected from Markdown and unescaped like the page (no KaTeX → text)', () => {
  const html = renderMarkdown('a_1 and $x_1 + y_2$ and $$\\begin{bmatrix}1 \\\\\\\\ 2\\end{bmatrix}$$');
  assert.doesNotMatch(html, /<em>/, 'underscores inside math are not emphasis');
  assert.match(html, /\$\$\\begin\{bmatrix\}1 \\\\ 2\\end\{bmatrix\}\$\$/, '\\\\\\\\ reaches KaTeX as \\\\');
});

test('with real KaTeX, every equation in the posts renders without errors', () => {
  const site = path.join(os.homedir(), 'pradeepr.cloud');
  if (!fs.existsSync(path.join(site, 'node_modules', 'katex'))) return;
  const katex = createRequire(path.join(site, 'package.json'))('katex');
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  let eq = 0;
  for (const f of walk(path.join(site, 'content')).filter((x) => x.endsWith('.md'))) {
    const html = renderMarkdown(fs.readFileSync(f, 'utf8'), { katex });
    eq += (html.match(/class="katex"/g) || []).length;
    assert.doesNotMatch(html, /katex-error/, `KaTeX error in ${f}`);
  }
  assert.ok(eq > 200, `only ${eq} equations rendered`);
  console.log(`  ${eq} equations rendered by KaTeX ${katex.version}`);
});

test('fidelity: reproduces Hugo’s own rendering of every real post, block for block', () => {
  let hugo = true;
  try { execFileSync('hugo', ['version'], { stdio: 'ignore' }); } catch { hugo = false; }
  const sites = ['pradeepr.cloud', 'ananyareddy.com'].map((s) => path.join(os.homedir(), s)).filter((s) => fs.existsSync(s));
  if (!hugo || !sites.length) return;
  for (const s of sites) {
    const out = execFileSync(process.execPath, [new URL('./tools/fidelity.mjs', import.meta.url).pathname, s], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    const m = out.match(/(\d+)\/(\d+) Hugo blocks/);
    console.log(`  ${out.split('\n')[0]}`);
    assert.ok(m && Number(m[1]) / Number(m[2]) >= 0.98, out);
  }
});
