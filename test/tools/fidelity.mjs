// Compare the live-preview renderer with Hugo's real output for every post of a site.
// Usage: node test/tools/fidelity.mjs <site-dir> [--verbose]
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { execFileSync } from 'node:child_process';
import { renderMarkdown } from '../../public/markdown.js';
const site = process.argv[2]; const verbose = process.argv.includes('--verbose');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'hsm-fid-'));
execFileSync('hugo', ['--source', site, '--destination', out, '--buildDrafts', '--baseURL', '/p/', '--logLevel', 'error'], { stdio: 'ignore' });
const csv = execFileSync('hugo', ['list', 'all', '--source', site], { env: { ...process.env, HUGO_BASEURL: '/p/' } }).toString().trim().split('\n').slice(1);
const decode = (s) => s.replace(/<[^>]+>/g, ' ').replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(n)).replace(/&#x([\da-f]+);/gi, (m, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&quot;/g, '"').replace(/&#39;|&rsquo;|&lsquo;/g, "'").replace(/&ldquo;|&rdquo;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
  .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();
// top-level blocks of an HTML fragment: [{tag, text}]
function blocks(html) {
  const res = []; let i = 0;
  const re = /<(h[1-6]|p|ul|ol|blockquote|table|pre|div|hr|video|img|iframe)\b[^>]*>/gi;
  while (i < html.length) {
    re.lastIndex = i; const m = re.exec(html); if (!m) break;
    const t = m[1].toLowerCase(); let end;
    if (t === 'hr' || t === 'img') end = m.index + m[0].length;
    else { let depth = 0; const r2 = new RegExp(`<(/?)${t}\\b[^>]*>`, 'gi'); r2.lastIndex = m.index;
      for (let x; (x = r2.exec(html)); ) { depth += x[1] ? -1 : 1; if (!depth) { end = x.index + x[0].length; break; } } end ??= html.length; }
    const kind = t === 'div' && /class="highlight/.test(m[0]) ? 'pre' : t === 'div' && /hsm-html/.test(m[0]) ? 'html' : t;
    const chunk = html.slice(m.index, end);
    // inside code, tags are token spans: drop them without inserting spaces
    res.push({ tag: kind, text: decode(kind === 'pre' ? chunk.replace(/<[^>]+>/g, '') : chunk) }); i = end;
  }
  return res;
}
let total = 0, matched = 0, posts = 0; const misses = [];
for (const row of csv) {
  const cols = row.match(/("([^"]|"")*"|[^,]*)(,|$)/g).map((c) => c.replace(/,$/, '').replace(/^"|"$/g, '').replace(/""/g, '"'));
  const [file, , , , , , , permalink, kind] = cols;
  if (kind !== 'page' || path.isAbsolute(file) || !file.endsWith('.md')) continue;
  const htmlPath = path.join(out, decodeURIComponent(permalink.replace(/^\/p\//, '')));
  if (!fs.existsSync(htmlPath)) continue;
  const page = fs.readFileSync(htmlPath, 'utf8');
  const a = page.indexOf('id="post-content"'); if (a < 0) continue;
  const start = page.indexOf('>', a) + 1; const stop = page.indexOf('btn-improve-page', start);
  const hugoBlocks = blocks(page.slice(start, stop).replace(/<div class="row[\s\S]*$/, ''));
  const mine = blocks(renderMarkdown(fs.readFileSync(path.join(site, file), 'utf8')));
  posts++;
  // in-order matching of (tag, text)
  let j = 0;
  for (const h of hugoBlocks) {
    total++;
    const k = mine.findIndex((b, idx) => idx >= j && b.text === h.text && (b.tag === h.tag || b.tag === 'html'));
    if (k >= 0) { matched++; j = k + 1; } else { misses.push(`${path.basename(path.dirname(file))}: <${h.tag}> ${h.text.slice(0, 90)}  ≠  ${(mine[j] ? `<${mine[j].tag}> ${mine[j].text.slice(0, 90)}` : '(none)')}`); if (process.env.DEBUG) { const b = mine.find((x) => x.text.slice(0, 40) === h.text.slice(0, 40)); console.log("HUGO:", JSON.stringify(h.text.slice(-160)), "\nMINE:", JSON.stringify(b?.text.slice(-160)), b?.tag); } }
  }
}
console.log(`${path.basename(site)}: ${posts} posts, ${matched}/${total} Hugo blocks reproduced exactly (${(100 * matched / Math.max(1, total)).toFixed(1)}%)`);
(verbose ? misses : misses.slice(0, 12)).forEach((m) => console.log('  miss ' + m));
fs.rmSync(out, { recursive: true, force: true });
