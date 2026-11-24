// Drives initMathAssist() with simulated keystrokes against a minimal fake DOM,
// so the auto-close/mirroring flows are tested without a browser.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

function el() {
  const e = {
    style: {}, children: [], textContent: '', className: '', offsetHeight: 0, offsetLeft: 0, offsetTop: 0, offsetWidth: 0,
    classList: { set: new Set(), add(c) { this.set.add(c); }, remove(c) { this.set.delete(c); }, toggle(c, on) { (on ?? !this.set.has(c)) ? this.set.add(c) : this.set.delete(c); return this.set.has(c); }, contains(c) { return this.set.has(c); } },
    append(...k) { e.children.push(...k); }, replaceChildren(...k) { e.children = k; }, addEventListener() {}, setAttribute() {},
    querySelector: () => null, scrollIntoView() {}, contains: () => false,
  };
  return e;
}

function makeEditor(initial = '') {
  const listeners = {};
  const ed = {
    value: initial, selectionStart: initial.length, selectionEnd: initial.length, scrollTop: 0, scrollLeft: 0, clientWidth: 600,
    addEventListener(t, f, capture) { (listeners[t] ||= []).push({ f, capture }); },
    dispatchEvent(ev) { for (const { f } of [...(listeners[ev.type] || [])].sort((a, b) => b.capture - a.capture)) { f(ev); if (ev._stop) break; } },
    setSelectionRange(a, b) { ed.selectionStart = a; ed.selectionEnd = b; },
    setRangeText(text, a, b, mode) {
      const s0 = ed.selectionStart, s1 = ed.selectionEnd;
      ed.value = ed.value.slice(0, a) + text + ed.value.slice(b);
      if (mode === 'end') ed.setSelectionRange(a + text.length, a + text.length);
      else if (mode === 'preserve') {
        const d = text.length - (b - a);
        ed.setSelectionRange(s0 > b ? s0 + d : s0, s1 > b ? s1 + d : s1);
      }
    },
  };
  return ed;
}

let ed;
let caretMarker;
async function setup(initial) {
  globalThis.document = { createElement: el, addEventListener() {}, get activeElement() { return ed; } };
  globalThis.window = {}; // no katex: preview falls back to text
  globalThis.getComputedStyle = () => ({});
  globalThis.requestAnimationFrame = (f) => { f(); return 0; };
  globalThis.cancelAnimationFrame = () => {};
  const { initMathAssist } = await import('../public/mathedit.js');
  const i = initial.indexOf('|');
  ed = makeEditor(initial.replace('|', ''));
  ed.setSelectionRange(i, i);
  const replace = (a, b, text) => {
    ed.setRangeText(text, a, b, 'end');
    ed.dispatchEvent({ type: 'input' });
  };
  const btn = el();
  btn.parentElement = el();
  initMathAssist({ editor: ed, wrap: el(), paletteButton: btn, isMarkdown: () => true, enabled: () => true, replace, markdownEscapes: () => true });
  caretMarker = () => `${ed.value.slice(0, ed.selectionStart)}|${ed.value.slice(ed.selectionStart)}`;
}

/** Type keys like a user: keydown first; if not prevented, the browser's default edit + input. */
function type(keys) {
  for (let key of keys) {
    const shiftKey = key.startsWith('S-');
    if (shiftKey) key = key.slice(2);
    const ev = { type: 'keydown', key, metaKey: false, ctrlKey: false, altKey: false, shiftKey, _prevented: false, _stop: false,
      preventDefault() { this._prevented = true; }, stopImmediatePropagation() { this._stop = true; } };
    ed.dispatchEvent(ev);
    if (ev._prevented) continue;
    const a = ed.selectionStart, b = ed.selectionEnd;
    if (key === 'Backspace') ed.setRangeText('', a === b ? a - 1 : a, b, 'end');
    else if (key === 'Enter') ed.setRangeText('\n', a, b, 'end');
    else if (key.length === 1) ed.setRangeText(key, a, b, 'end');
    else continue;
    // like a browser: typed characters are insertText with data, deletions are deleteContentBackward
    ed.dispatchEvent({ type: 'input', inputType: key === 'Backspace' ? 'deleteContentBackward' : key === 'Enter' ? 'insertLineBreak' : 'insertText', data: key.length === 1 ? key : null });
    ed.dispatchEvent({ type: 'keyup', key });
  }
}
const chars = (s) => [...s];

test('typing $$ adds the closing $$ and leaves the caret between', async () => {
  await setup('Intro\n\n|\n\nLets visualize our journey.');
  type(chars('$$'));
  assert.equal(caretMarker(), 'Intro\n\n$$|$$\n\nLets visualize our journey.');
});

test('the screenshot flow: $$ then \\begin{bmatrix} gives a closed, one-line environment', async () => {
  await setup('|\n\nLets visualize our journey.\n\nlater $$x$$');
  type(chars('$$\\begin{bmatrix}'));
  assert.equal(caretMarker(), '$$\\begin{bmatrix}|\\end{bmatrix}$$\n\nLets visualize our journey.\n\nlater $$x$$');
  type(chars('1 & 3 \\\\\\\\ 3 & 12'));
  assert.equal(caretMarker(), '$$\\begin{bmatrix}1 & 3 \\\\\\\\ 3 & 12|\\end{bmatrix}$$\n\nLets visualize our journey.\n\nlater $$x$$', 'row break \\\\\\\\ does not trigger completion');
});

test('the \\end name mirrors the \\begin name while typing, including edits', async () => {
  await setup('$$|$$');
  type(chars('\\begin{'));
  assert.equal(caretMarker(), '$$\\begin{|}\\end{}$$');
  type(chars('pmatx'));
  assert.equal(ed.value, '$$\\begin{pmatx}\\end{pmatx}$$');
  type(['Backspace', ...chars('rix')]);
  assert.equal(caretMarker(), '$$\\begin{pmatrix|}\\end{pmatrix}$$');
  type(['}']);
  assert.equal(caretMarker(), '$$\\begin{pmatrix}|\\end{pmatrix}$$', '} steps over the auto-inserted brace');
  type(chars('a'));
  assert.equal(ed.value, '$$\\begin{pmatrix}a\\end{pmatrix}$$', 'mirroring stops once the name is done');
});

test('Shift+Enter between \\begin{env}|\\end{env} and between $$|$$ opens them up', async () => {
  await setup('$$\\begin{cases}|\\end{cases}$$');
  type(['S-Enter']);
  assert.equal(caretMarker(), '$$\\begin{cases}\n  |\n\\end{cases}$$');
  await setup('$$|$$');
  type(['S-Enter']);
  assert.equal(caretMarker(), '$$\n|\n$$');
  await setup('$$a &= b|$$');
  type(['S-Enter']);
  assert.equal(caretMarker(), '$$a &= b\n|$$', 'otherwise Shift+Enter is a plain new line');
});

test('Enter inside $$…$$ is a TeX row break, written \\\\\\\\ and spaced like the posts', async () => {
  await setup('$$\\begin{bmatrix}1 & 3|\\end{bmatrix}$$');
  type(['Enter', ...'3 & 12'.split('')]);
  assert.equal(caretMarker(), '$$\\begin{bmatrix}1 & 3 \\\\\\\\ 3 & 12|\\end{bmatrix}$$');
  await setup('$$x &= 1 |$$');
  type(['Enter']);
  assert.equal(caretMarker(), '$$x &= 1 \\\\\\\\ |$$', 'no doubled space when one is already there');
  await setup('$$\\begin{cases} x &= 57| \\end{cases}$$');
  type(['Enter']);
  assert.equal(caretMarker(), '$$\\begin{cases} x &= 57 \\\\\\\\ |\\end{cases}$$', 'caret lands after the existing space');
  await setup('Para text|\n\nmore');
  type(['Enter']);
  assert.equal(caretMarker(), 'Para text\n|\n\nmore', 'outside math Enter is untouched');
  await setup('typing $$x|');
  type(['Enter']);
  assert.equal(ed.value, 'typing $$x\n', 'an unclosed $$ keeps normal Enter');
});

test('retyping the closing $$ steps over it; Backspace in empty $$|$$ removes both', async () => {
  await setup('$$x^2|$$ after');
  type(chars('$$'));
  assert.equal(caretMarker(), '$$x^2$$| after');
  await setup('a $$|$$ b');
  type(['Backspace']);
  assert.equal(caretMarker(), 'a | b');
});

test('choosing an environment from the list after \\begin{ replaces the mirrored pair', async () => {
  await setup('$$|$$');
  type(chars('\\begin{bm'));
  assert.equal(ed.value, '$$\\begin{bm}\\end{bm}$$');
  type(['Enter']); // accept "bmatrix"
  assert.equal(caretMarker(), '$$\\begin{bmatrix}|\\end{bmatrix}$$');
});

test('dollar amounts and closing an existing block are left alone', async () => {
  await setup('costs |');
  type(chars('$5 '));
  assert.equal(caretMarker(), 'costs $5 |', 'a dollar amount drops the auto-added $ once you type a space');
  await setup('costs |');
  type(chars('$4.99 and up'));
  assert.equal(ed.value, 'costs $4.99 and up');
  await setup('$$\n\\frac{a}{b}\n|');
  type(chars('$$'));
  assert.equal(ed.value, '$$\n\\frac{a}{b}\n$$', 'typing the closer of an open block adds nothing');
});

test('inline math: $ pairs, closing $ steps over, $$ upgrades, Backspace removes the pair', async () => {
  await setup('vectors |in space');
  type(chars('$'));
  assert.equal(caretMarker(), 'vectors $|in space', 'no pairing right before a word');
  await setup('vectors | in space');
  type(chars('$\\vec{u}'));
  assert.equal(caretMarker(), 'vectors $\\vec{u}|$ in space', 'pairs at a word boundary; { is auto-closed inside');
  type(chars('$'));
  assert.equal(caretMarker(), 'vectors $\\vec{u}$| in space', 'retyping $ steps over the closer');
  await setup('see |');
  type(chars('$$'));
  assert.equal(caretMarker(), 'see $$|$$', '$ then $ becomes a display pair');
  await setup('see |.');
  type(['$', 'Backspace']);
  assert.equal(caretMarker(), 'see |.', 'Backspace in an empty $|$ removes both');
  await setup('$$x^2$|$ tail');
  type(['Backspace']);
  assert.equal(caretMarker(), '$$x^2|$ tail', 'a $|$ that is really the middle of $$ is a normal Backspace');
});

test('inline math never pairs in code, front matter, after a letter or an escape', async () => {
  for (const doc of ['```bash\necho |\n```', 'run `echo |` now', '---\ntitle: "cost |"\n---\n', 'US|', 'escaped \\|']) {
    await setup(doc);
    const before = ed.value;
    type(['$']);
    assert.equal(ed.value.length, before.length + 1, `exactly one $ typed in: ${JSON.stringify(doc)}`);
  }
});

test('inline math: Enter is a row break, \\begin mirrors, a selection is wrapped', async () => {
  await setup('a $\\begin{smallmatrix}1 & 2|\\end{smallmatrix}$ b');
  type(['Enter']);
  assert.equal(caretMarker(), 'a $\\begin{smallmatrix}1 & 2 \\\\\\\\ |\\end{smallmatrix}$ b');
  await setup('x | y');
  type(chars('$\\begin{pmatrix}'));
  assert.equal(caretMarker(), 'x $\\begin{pmatrix}|\\end{pmatrix}$ y');
  await setup('make E=mc^2 math');
  ed.setSelectionRange(5, 11);
  type(['$']);
  assert.equal(ed.value, 'make $E=mc^2$ math');
});

test('commands that take an argument get their braces as soon as the name is typed (the \\boxed screenshot)', async () => {
  await setup('as below $|$');
  type(chars('\\boxed'));
  assert.equal(caretMarker(), 'as below $\\boxed{|}$');
  type(chars('{x=1}'));
  assert.equal(caretMarker(), 'as below $\\boxed{x=1}|$', 'the habitual { is absorbed and } steps over');
  await setup('$|$');
  type(chars('\\frac'));
  assert.equal(caretMarker(), '$\\frac{|}{}$');
  type(chars('a'));
  type(['Tab']);
  type(chars('b'));
  assert.equal(caretMarker(), '$\\frac{a}{b|}$', 'Tab moves to the second argument');
});

test('ambiguous names wait: \\text + space, or keep typing to \\textbf', async () => {
  await setup('$|$');
  type(chars('\\text '));
  assert.equal(caretMarker(), '$\\text{|}$');
  await setup('$|$');
  type(chars('\\textbf'));
  assert.equal(caretMarker(), '$\\textbf{|}$');
  await setup('$|$');
  type(chars('\\dots'));
  assert.equal(caretMarker(), '$\\dots|$', '\\dot did not grab braces on the way to \\dots');
});

test('\\begin becomes \\begin{|}\\end{} as soon as it is typed; typing { then is absorbed', async () => {
  await setup('$$|$$');
  type(chars('\\begin{bmatrix}'));
  assert.equal(caretMarker(), '$$\\begin{bmatrix}|\\end{bmatrix}$$');
});

test('no braces for switches, sums, outside math, or when backspacing into a name', async () => {
  for (const [doc, keys, want] of [
    ['$|$', '\\small', '$\\small|$'],
    ['$|$', '\\sum', '$\\sum|$'],
    ['plain \\box| text', 'ed', 'plain \\boxed| text'],
    ['$\\vec|$', '{', '$\\vec{|}$'],
  ]) {
    await setup(doc);
    type(chars(keys));
    assert.equal(caretMarker(), want, `${doc} + ${keys}`);
  }
  await setup('$\\boxedx|$');
  type(['Backspace']);
  assert.equal(caretMarker(), '$\\boxed|$', 'deleting back to \\boxed leaves it alone');
});

const selected = () => ed.value.slice(ed.selectionStart, ed.selectionEnd);

test('^ and _ get braces with a selected placeholder (the E=mc^ screenshot)', async () => {
  await setup('$\\boxed{E = mc|}$');
  type(['^']);
  assert.equal(ed.value, '$\\boxed{E = mc^{2}}$');
  assert.equal(selected(), '2', 'placeholder is selected');
  type(chars('3'));
  assert.equal(caretMarker(), '$\\boxed{E = mc^{3|}}$', 'typing replaces it');
  type(['Tab']);
  assert.equal(caretMarker(), '$\\boxed{E = mc^{3}|}$', 'Tab steps out');
  await setup('$x|$');
  type(['_']);
  assert.equal(selected(), 'i');
  await setup('$x |ij$');
  ed.setSelectionRange(3, 5);
  type(['_']);
  assert.equal(caretMarker(), '$x _{ij}|$', 'a selection is wrapped');
  await setup('$a^|{b}$');
  type(['^']);
  assert.equal(ed.value, '$a^^{b}$', 'left alone when a group already follows');
  await setup('text x| here');
  type(['^']);
  assert.equal(ed.value, 'text x^ here', 'outside math nothing happens');
});

test('placeholders follow what the script is attached to', async () => {
  await setup('$$|$$');
  type(chars('\\sum_'));
  assert.equal(selected(), 'i=1');
  type(['Tab', '^']);
  assert.equal(selected(), 'n');
  assert.equal(ed.value, '$$\\sum_{i=1}^{n}$$');
  await setup('$$\\int|$$');
  type(['_']);
  assert.equal(selected(), 'a');
  await setup('$$\\lim|$$');
  type(['_']);
  assert.equal(selected(), 'x \\to \\infty');
});

test('\\left( adds its \\right), including the escaped \\left\\\\{', async () => {
  await setup('$$|$$');
  type(chars('\\left('));
  assert.equal(caretMarker(), '$$\\left( | \\right)$$');
  await setup('$$|$$');
  type(chars('\\left['));
  assert.equal(caretMarker(), '$$\\left[ | \\right]$$');
  await setup('$$|$$');
  type(chars('\\left\\\\{'));
  assert.equal(caretMarker(), '$$\\left\\\\{ | \\right\\\\}$$', 'Markdown-escaped braces stay escaped');
});

test('\\begin{array} gets a selected column spec', async () => {
  await setup('$$|$$');
  type(chars('\\begin{array}'));
  assert.equal(ed.value, '$$\\begin{array}{cc}\\end{array}$$');
  assert.equal(selected(), 'cc');
  type(chars('cc|c'));
  type(['Tab']);
  assert.equal(caretMarker(), '$$\\begin{array}{cc|c}|\\end{array}$$');
});
