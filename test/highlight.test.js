// The editor overlay only lines up with the textarea if highlighting never adds, drops or moves a character.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { highlight, languageFor } from '../public/highlight.js';

const plain = (html) => html.replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const roundTrips = (text, p) => {
  const out = plain(highlight(text, p));
  const expect = text.endsWith('\n') || text === '' ? `${text} ` : text;
  assert.equal(out, expect, `${p} does not round-trip`);
};

const SAMPLES = {
  'a.md': [
    '', '\n', 'plain', '# Title\n\nSome **bold**, _em_, *em*, ~~gone~~, `code`, a [link](https://x.y "t") and ![img](a.png).',
    '---\ntitle: "Hi: there"\ndate: 2025-12-24\ndraft: false\ntags: ["a", "b"]\nmenu:\n  sidebar:\n    weight: 14\n---\nBody\n',
    '+++\ntitle = "x"\n[menu.sidebar]\nweight = 3\n+++\n',
    '``` shell {linenos=false}\nls\n```\n```bash\nkubectl get pods -n myminio --watch # comment\necho "$HOME ${X}"\n```\n',
    '```\nunclosed fence\nstill code', '~~~python\ndef f(x):\n    return "s" + 1\n~~~',
    '$$\n\\begin{bmatrix} 1 & 0 \\\\ 0 & 1 \\end{bmatrix}\n$$\ninline $a_b$ and $5 and 6$',
    '$A$ $$x^2$$ \\(a\\) \\[b\\] $$\n\\small{x} % c\n\\tag{1}$$ tail\n\\[\nx\n\\]\n$$ unclosed\nmath',
    '<video src="/mysite/public/files/x.mp4" width="100%" controls></video>\n{{< figure src="a.png" >}}\n{{% note %}}x{{% /note %}}',
    '> quote with **bold**\n- item\n  1. nested\n- [x] done\n\n| a | b |\n|---|:-:|\n| 1 | `2` |\n\n---\n***',
    'snake_case_word and 2*3*4 and a_b_c\n<!-- comment\nmulti -->\n[ref]: https://x.y\nline with < and > & amps',
    '<https://example.com> https://bare.example.com/path?q=1&x=2.', 'tab\tseparated\r\nwindows line',
  ],
  'hugo.yaml': ['baseURL: https://x/\nuglyURLs: true\nparams:\n  # comment\n  list:\n    - "a"\n    - b: 1\n  url: "http://a#b" # trailing\n'],
  'config.toml': ['[params]\nx = "y"\n[[menu.main]]\nweight = 1\n'],
  'data.json': ['{"a": [1, 2.5, true, null], "b": "x\\"y"}'],
  'x.html': ['<!doctype html><p class="a">x &amp; {{ .Title }}</p><!-- c -->'],
  'x.css': ['.a { color: #fff; --v: 2px; } @media (x) { b { margin: 0 } } $s: 1;'],
  'x.js': ['const a = `t ${x}`; // c\nfunction f() { return /re/g.test("s") }'],
  'notes.txt': ['<not> & highlighted'],
};

test('samples round-trip exactly', () => {
  for (const [p, list] of Object.entries(SAMPLES)) for (const t of list) roundTrips(t, p);
});

test('every text file in both real sites round-trips', () => {
  const roots = ['pradeepr.cloud', 'ananyareddy.com'].map((d) => path.join(os.homedir(), d)).filter((d) => fs.existsSync(d));
  let n = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (['node_modules', 'public', 'public copy', 'resources', '.git'].includes(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (languageFor(p) && fs.statSync(p).size < 2e6) {
        roundTrips(fs.readFileSync(p, 'utf8'), p);
        n++;
      }
    }
  };
  roots.forEach(walk);
  assert.ok(n > 20 || roots.length === 0, `only ${n} files checked`);
  console.log(`  ${n} real files round-tripped`);
});

test('the right things get coloured', () => {
  const h = highlight('---\ntitle: "x"\n---\n# Head\n**b** `c` [l](u)\n```go\nfunc main() {}\n```\n', 'p.md');
  for (const cls of ['fm-fence', 'key', 'string', 'heading', 'strong', 'code', 'linktext', 'url', 'keyword', 'func'])
    assert.match(h, new RegExp(`class="t-${cls}"`), cls);
  assert.doesNotMatch(highlight('snake_case_name', 'p.md'), /t-em/, 'no italics inside words');
  assert.doesNotMatch(highlight('costs $5 and $6', 'p.md'), /t-math/, 'dollar amounts are not math');
  const m = highlight('$A$ and $$\n\\frac{a}{b}_2 \\begin{cases} x \\end{cases}\n$$', 'p.md');
  for (const cls of ['math-fence', 'math', 'lx-cmd', 'lx-brace', 'lx-op', 'lx-env']) assert.match(m, new RegExp(`class="t-${cls}"`), cls);
  assert.match(highlight('<b>', 'notes.txt').replace(/<i class="ln"[^>]*><\/i>/g, ''), /^&lt;b&gt;$/);
  const marks = highlight('a\nb\n\nc', 'p.md').match(/data-l="(\d+)"/g).map((m) => Number(m.match(/\d+/)[0]));
  assert.deepEqual(marks, [0, 1, 2, 3], 'one marker per source line');
  assert.equal(languageFor('content/posts/x/index.md'), 'markdown');
  assert.equal(languageFor('.gitignore'), 'sh');
});

test('highlighting is fast enough to run on every keystroke', () => {
  const big = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8').repeat(20); // ~150 KB
  const t0 = performance.now();
  highlight(big, 'big.md');
  const ms = performance.now() - t0;
  console.log(`  ${(big.length / 1024).toFixed(0)} KB in ${ms.toFixed(1)} ms`);
  assert.ok(ms < 250, `${ms} ms`);
});
