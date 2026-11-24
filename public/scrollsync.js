// Editor → preview scroll sync. Pure helpers are exported for tests; the DOM part is initScrollSync().

/** Normalise heading text so "## 2. Matrices **as** maps" matches the rendered "2. Matrices as maps". */
export function norm(s) {
  return String(s)
    .replace(/\{#[^}]*\}\s*$/, '') // {#custom-id}
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_~]/g, '')
    .replace(/\$[^$]*\$/g, ' ') // math renders to something else entirely
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Match editor headings to preview headings in document order (greedy, skipping misses). */
export function pairAnchors(editorHeads, previewHeads) {
  const pairs = [];
  let j = 0;
  for (const e of editorHeads) {
    const key = norm(e.text);
    if (!key) continue;
    for (let k = j; k < previewHeads.length; k++) {
      if (norm(previewHeads[k].text) === key) {
        pairs.push({ e: e.y, p: previewHeads[k].y });
        j = k + 1;
        break;
      }
    }
  }
  return pairs;
}

/** Piecewise-linear map from editor scrollTop to preview scrollTop through the anchor pairs. */
export function mapScroll(y, anchors) {
  const pts = anchors.filter((a, i) => i === 0 || a.e > anchors[i - 1].e).sort((a, b) => a.e - b.e);
  if (!pts.length) return 0;
  if (y <= pts[0].e) return pts[0].p;
  for (let i = 1; i < pts.length; i++) {
    if (y <= pts[i].e) {
      const a = pts[i - 1];
      const b = pts[i];
      return a.p + ((y - a.e) / (b.e - a.e || 1)) * (b.p - a.p);
    }
  }
  return pts.at(-1).p;
}

/**
 * Preview scrollTop that puts the preview's counterpart of the editor's reference point (the caret,
 * or a reading line) at the same relative height on screen.
 *  anchors: [{e, p}] editor content y ↔ preview content y (monotonic)
 *  editor: { scrollTop, height, maxScroll, refY }  refY = reference point in editor content coords
 *  preview: { height, maxScroll, minRef } minRef keeps the point below a fixed navbar
 */
export function scrollTarget(anchors, editor, preview) {
  if (editor.scrollTop <= 0 && editor.refY - editor.scrollTop < editor.height * 0.5) {
    // at the very top the preview is at the top too (title, hero image)
    if (mapScroll(editor.refY, anchors) < preview.height * 0.5) return 0;
  }
  if (editor.scrollTop >= editor.maxScroll - 1 && editor.maxScroll > 0) return preview.maxScroll;
  const onScreen = editor.refY - editor.scrollTop; // where the reference sits in the editor viewport
  const frac = Math.min(0.9, Math.max(0, onScreen / Math.max(1, editor.height)));
  const at = Math.max(preview.minRef ?? 0, frac * preview.height);
  const target = mapScroll(editor.refY, anchors) - at;
  return Math.min(preview.maxScroll, Math.max(0, target));
}

// ---------------------------------------------------------------- DOM

function scrollerFor(doc, el) {
  for (let n = el?.parentElement; n && n !== doc.body; n = n.parentElement) {
    const st = doc.defaultView.getComputedStyle(n);
    if (/(auto|scroll)/.test(st.overflowY) && n.scrollHeight > n.clientHeight + 4) return n;
  }
  return doc.scrollingElement || doc.documentElement;
}

/** Index of the last element of sorted `arr` with key <= x (binary search), or -1. */
function floorIndex(arr, x, key) {
  let lo = 0, hi = arr.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (key(arr[mid]) <= x) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

const FOCUS_CSS = `
#post-content.hsm-focus > [data-line] { transition: opacity .18s ease; }
#post-content.hsm-focus > [data-line]:not(.hsm-on) { opacity: .28; }
#post-content.hsm-focus > .hsm-on { box-shadow: -4px 0 0 0 rgba(255, 92, 147, .55); }
`;

/**
 * Keep the preview iframe aligned with the editor, and (optionally) spotlight the section being edited.
 * editor: textarea; overlay: highlighted <pre> with <i class="ln" data-l=N> line markers;
 * isSamePage(): iframe shows the open file's page; caret(): { line, col, len } of the caret when the
 * editor has focus (else null) — alignment follows the caret, or a reading line a third down.
 */
export function initScrollSync({ editor, overlay, frame, isSamePage, enabled, focusEnabled, caret }) {
  let raf = 0;
  let lines = null; // [{ n, y }] from the overlay's line markers
  const NAV_OFFSET = 80; // Toha's fixed navbar

  const lineMarks = () => (lines ??= [...overlay.querySelectorAll('i.ln')].map((m) => ({ n: Number(m.dataset.l), y: m.offsetTop })));
  const lineY = (n) => {
    const L = lineMarks();
    const k = floorIndex(L, n, (x) => x.n);
    return k < 0 ? 0 : L[k].y;
  };
  /** Source line at an editor y (for "where am I reading" when the caret isn't in view). */
  const lineAtY = (y) => {
    const L = lineMarks();
    const k = floorIndex(L, y, (x) => x.y);
    return k < 0 ? 0 : L[k].n;
  };

  function editorHeads() {
    return [...overlay.querySelectorAll('.t-heading-mark')].map((m) => ({
      y: m.offsetTop,
      text: m.nextElementSibling?.classList.contains('t-heading') ? m.nextElementSibling.textContent : '',
    }));
  }

  /** Cheap part (no layout): what's in the preview. */
  function previewBlocks() {
    const doc = frame.contentDocument;
    if (!doc?.body) return null;
    const content = doc.getElementById('post-content');
    const blocks = content ? [...content.querySelectorAll(':scope > [data-line]')] : [];
    return { doc, content, blocks };
  }

  /** Layout part: scroller and positions (forces style/layout, so focus classes go on first). */
  function previewState(pb = previewBlocks()) {
    if (!pb) return null;
    const { doc, content, blocks } = pb;
    const probe = blocks.at(-1) || [...doc.querySelectorAll('h1, h2, h3, h4, h5, h6')].at(-1) || doc.body;
    const scroller = scrollerFor(doc, probe);
    const isRoot = scroller === doc.scrollingElement || scroller === doc.documentElement;
    const base = isRoot ? 0 : scroller.getBoundingClientRect().top;
    const top = isRoot ? doc.defaultView.scrollY : scroller.scrollTop;
    const yOf = (el) => el.getBoundingClientRect().top - base + top; // content y (scroll-independent)
    const max = Math.max(0, scroller.scrollHeight - (isRoot ? doc.defaultView.innerHeight : scroller.clientHeight));
    const height = isRoot ? doc.defaultView.innerHeight : scroller.clientHeight;
    return { doc, content, blocks, scroller, isRoot, yOf, max, height, total: scroller.scrollHeight, win: doc.defaultView };
  }

  /** Editor content y of the caret, wrapping included (interpolated across a wrapped line). */
  function caretY(c) {
    const y0 = lineY(c.line);
    const L = lineMarks();
    const k = floorIndex(L, c.line + 1, (x) => x.n);
    const y1 = k >= 0 && L[k].n === c.line + 1 ? L[k].y : y0 + (parseFloat(getComputedStyle(editor).lineHeight) || 22);
    return y0 + (c.len ? (y1 - y0) * (c.col / c.len) : 0);
  }
  /** The caret, if the editor has focus and the caret is on screen. */
  function visibleCaret() {
    const c = caret?.();
    if (!c) return null;
    const y = caretY(c) - editor.scrollTop;
    return y >= 0 && y <= editor.clientHeight ? { ...c, y: y + editor.scrollTop } : null;
  }

  function anchorsFor(pv) {
    let pairs;
    if (pv.blocks.length) {
      // live preview: every block knows its source line → dense anchors (images/videos/math line up)
      pairs = pv.blocks.map((b) => ({ e: lineY(Number(b.dataset.line)), p: pv.yOf(b) }));
    } else {
      // built preview: match headings by text
      const hs = [...pv.doc.querySelectorAll('h1, h2, h3, h4, h5, h6')].map((h) => ({ y: pv.yOf(h), text: h.textContent }));
      pairs = pairAnchors(editorHeads(), hs);
    }
    // content ↔ content: top ↔ top, each block's source line ↔ that block's top, end ↔ end; monotonic
    const mono = [{ e: 0, p: 0 }]; // front matter ↔ title/hero: straight line to the first block
    for (const a of pairs) if (a.e > mono.at(-1).e && a.p >= mono.at(-1).p) mono.push(a);
    const end = { e: editor.scrollHeight, p: pv.total };
    if (end.e > mono.at(-1).e) mono.push(end);
    return mono;
  }

  function focus(pv) {
    if (!pv?.content) return;
    const on = focusEnabled() && pv.blocks.length > 0;
    pv.content.classList.toggle('hsm-focus', on);
    if (!on) return;
    if (!pv.doc.getElementById('hsm-focus-css')) {
      const st = pv.doc.createElement('style');
      st.id = 'hsm-focus-css';
      st.textContent = FOCUS_CSS;
      pv.doc.head.append(st);
    }
    const c = visibleCaret();
    const line = c ? c.line : lineAtY(editor.scrollTop + editor.clientHeight / 3);
    // the section = from the heading at/above the line to the next heading
    const isHead = (b) => /^H[1-6]$/.test(b.tagName);
    let from = 0;
    let to = Infinity;
    for (const b of pv.blocks) {
      const l = Number(b.dataset.line);
      if (isHead(b) && l <= line) from = l;
      if (isHead(b) && l > line) { to = l; break; }
    }
    for (const b of pv.blocks) {
      const l = Number(b.dataset.line);
      b.classList.toggle('hsm-on', l >= from && l < to);
    }
  }

  function run({ scroll = true } = {}) {
    if (!isSamePage()) return;
    const pb = previewBlocks();
    if (!pb) return;
    // classes first: measuring forces style resolution, and doing it before would start the
    // opacity transition on freshly inserted blocks (the edited section "fading in" every render)
    focus(pb);
    if (scroll && enabled()) {
      const pv = previewState(pb);
      const c = visibleCaret();
      const target = scrollTarget(anchorsFor(pv), {
        scrollTop: editor.scrollTop,
        height: editor.clientHeight,
        maxScroll: Math.max(0, editor.scrollHeight - editor.clientHeight),
        refY: c ? c.y : editor.scrollTop + editor.clientHeight / 3,
      }, { height: pv.height, maxScroll: pv.max, minRef: NAV_OFFSET + 12 });
      if (pv.isRoot) pv.win.scrollTo({ top: target, behavior: 'instant' });
      else pv.scroller.scrollTop = target;
    }
  }

  // one rAF; a focus-only request must not cancel a pending scroll sync
  let pending = null;
  const schedule = ({ scroll = true } = {}) => {
    pending = { scroll: scroll || !!pending?.scroll };
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      const opts = pending;
      pending = null;
      run(opts);
    });
  };
  editor.addEventListener('scroll', () => schedule());
  frame.addEventListener('load', () => {
    schedule();
    setTimeout(() => schedule(), 400);
    setTimeout(() => schedule(), 1500);
  });
  new ResizeObserver(() => { lines = null; schedule(); }).observe(editor);

  /** Re-align when images/videos in the preview finish loading (they change the page height). */
  function watchMedia() {
    const doc = frame.contentDocument;
    if (!doc) return;
    for (const m of doc.querySelectorAll('#post-content img, #post-content video, #post-content iframe')) {
      if (m.dataset.hsmWatched) continue;
      m.dataset.hsmWatched = '1';
      m.addEventListener(m.tagName === 'VIDEO' ? 'loadedmetadata' : 'load', () => schedule(), { once: true });
    }
  }

  return {
    sync: () => schedule(),
    focus: () => schedule({ scroll: false }),
    /** Apply focus classes right now (used right after the live preview inserts new blocks). */
    focusNow: () => isSamePage() && focus(previewBlocks()),
    invalidate: () => { lines = null; },
    watchMedia,
  };
}
