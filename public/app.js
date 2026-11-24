// Hugo Site Manager — browser client (no build step, no dependencies).
import { highlight } from './highlight.js';
import { initMathAssist } from './mathedit.js';
import { initScrollSync } from './scrollsync.js';
import { renderMarkdown } from './markdown.js';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'html') e.innerHTML = v; // only ever used with constant strings
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) e.append(k instanceof Node ? k : String(k));
  return e;
}

async function api(method, url, body, { raw = false } = {}) {
  const opts = { method, headers: { 'X-HSM': '1' } };
  if (body instanceof Blob || body instanceof ArrayBuffer) opts.body = body;
  else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const r = await fetch(url, opts);
  if (r.status === 401 && !url.endsWith('/login')) {
    showLogin();
    throw new Error('Please sign in again');
  }
  const data = raw ? r : await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(data.error || `HTTP ${r.status}`);
    e.status = r.status;
    throw e;
  }
  return data;
}

function toast(msg, bad = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast${bad ? ' bad' : ''}`;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.add('hidden'), bad ? 7000 : 3000);
}

const fmtDate = (s) => (s ? new Date(s).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const ago = (s) => {
  if (!s) return 'never';
  const m = Math.round((Date.now() - new Date(s)) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)} h ago`;
  return `${Math.round(m / 1440)} days ago`;
};
const enc = encodeURIComponent;

// ------------------------------------------------------------------ state

const S = {
  sites: [],
  site: null,
  tab: 'write',
  file: null,        // {path, content, hash, binary}
  dirty: false,
  pages: [],
  treeOpen: new Set(JSON.parse(localStorage.getItem('hsm.treeOpen') || '[]')),
};
const sitePath = (p = '') => `/api/sites/${enc(S.site.id)}${p}`;

// ------------------------------------------------------------------ theme (dark by default)

const THEMES = [['dark', '☾ Dark'], ['light', '☀ Light'], ['system', '◐ System']];
function applyTheme(t) {
  if (t === 'dark') delete document.documentElement.dataset.theme; // CSS default
  else document.documentElement.dataset.theme = t;
  localStorage.setItem('hsm.theme', t);
  const b = $('#theme-toggle');
  b.textContent = THEMES.find(([k]) => k === t)[1];
  b.title = 'Theme — click to switch';
}
$('#theme-toggle').addEventListener('click', () => {
  const cur = localStorage.getItem('hsm.theme') || 'dark';
  applyTheme(THEMES[(THEMES.findIndex(([k]) => k === cur) + 1) % THEMES.length][0]);
});
applyTheme(THEMES.some(([k]) => k === localStorage.getItem('hsm.theme')) ? localStorage.getItem('hsm.theme') : 'dark');

// ------------------------------------------------------------------ auth

function showLogin() {
  $('#app').classList.add('hidden');
  $('#login').classList.remove('hidden');
  $('#login-form input[name=username]').focus();
}

$('#login-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = new FormData(ev.target);
  $('#login-error').textContent = '';
  try {
    await api('POST', '/api/login', { username: f.get('username'), password: f.get('password') });
    ev.target.reset();
    if (S.site) {
      // Session expired mid-edit: keep the open file and unsaved text.
      $('#login').classList.add('hidden');
      $('#app').classList.remove('hidden');
      toast('Signed in again — press Save to retry');
    } else boot();
  } catch (e) {
    $('#login-error').textContent = e.message;
  }
});

$('#logout').addEventListener('click', async () => {
  await api('POST', '/api/logout', {});
  location.reload();
});

// ------------------------------------------------------------------ dialog helper

function dialog(title, fields, okLabel = 'OK') {
  const d = $('#dialog');
  $('#dialog-title').textContent = title;
  const body = $('#dialog-body');
  body.replaceChildren();
  const inputs = {};
  for (const f of fields) {
    if (f.type === 'note') {
      body.append(el('p', { class: 'muted' }, f.text));
      continue;
    }
    let input;
    if (f.type === 'select') {
      input = el('select', { name: f.name }, f.options.map((o) => el('option', { value: o.value, selected: o.value === f.value }, o.label)));
    } else if (f.type === 'checkbox') {
      input = el('input', { type: 'checkbox', name: f.name, checked: !!f.value });
      body.append(el('label', { class: 'check' }, input, f.label));
      inputs[f.name] = input;
      continue;
    } else if (f.type === 'textarea') {
      input = el('textarea', { name: f.name, rows: 3 }, f.value || '');
    } else {
      input = el('input', { name: f.name, value: f.value || '', placeholder: f.placeholder || '', required: f.required });
    }
    inputs[f.name] = input;
    body.append(el('label', {}, f.label, input));
  }
  $('#dialog-ok').textContent = okLabel;
  return new Promise((resolve) => {
    d.onclose = () => {
      if (d.returnValue !== 'ok') return resolve(null);
      const out = {};
      for (const [k, i] of Object.entries(inputs)) out[k] = i.type === 'checkbox' ? i.checked : i.value;
      resolve(out);
    };
    d.returnValue = '';
    d.showModal();
    const first = body.querySelector('input:not([type=checkbox]), textarea, select');
    first?.focus();
  });
}

$('#dialog-cancel').addEventListener('click', () => $('#dialog').close('cancel'));

async function confirmBox(title, text, okLabel = 'Continue') {
  return !!(await dialog(title, [{ type: 'note', text }], okLabel));
}

// ------------------------------------------------------------------ jobs drawer

let drawerJob = null; // token of the job whose log the drawer shows
async function followJob(job, { onDone } = {}) {
  const tok = Symbol(job.id);
  drawerJob = tok;
  const log = $('#drawer-log');
  log.replaceChildren();
  $('#drawer').classList.remove('hidden');
  $('#drawer-title').textContent = job.title;
  let since = 0;
  for (;;) {
    // Keep polling to completion even if the drawer is closed or shows another job,
    // so the busy badge clears and onDone still runs; only the log rendering stops.
    const shown = () => drawerJob === tok;
    let j;
    try {
      j = await api('GET', `/api/jobs/${job.id}?since=${since}`);
    } catch (e) {
      toast(e.message, true);
      return null;
    }
    since = j.next;
    if (shown()) {
      const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 30;
      for (const l of j.lines) log.append(el('span', { class: l.s }, l.m + '\n'));
      if (atBottom) log.scrollTop = log.scrollHeight;
      const pill = $('#drawer-status');
      pill.textContent = j.status;
      pill.className = `pill ${j.status}`;
    }
    updateBusy(j.status === 'running' ? j.title : null);
    if (j.status !== 'running') {
      if (j.status === 'failed') toast(j.error, true);
      onDone?.(j);
      return j;
    }
    await new Promise((r) => setTimeout(r, 700));
  }
}
$('#drawer-close').addEventListener('click', () => {
  $('#drawer').classList.add('hidden');
  drawerJob = null;
});

function updateBusy(text) {
  const b = $('#busy');
  b.textContent = text || '';
  b.classList.toggle('hidden', !text);
}

async function runJob(method, url, body, opts = {}) {
  try {
    const job = await api(method, url, body);
    return followJob(job, opts);
  } catch (e) {
    toast(e.message, true);
    return null;
  }
}

// ------------------------------------------------------------------ tabs & sites

$('#tabs').addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-tab]');
  if (b) setTab(b.dataset.tab);
});

function setTab(tab) {
  S.tab = tab;
  $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $$('.tab').forEach((t) => t.classList.toggle('hidden', t.id !== `tab-${tab}`));
  history.replaceState(null, '', `#${S.site?.id || ''}/${tab}`);
  if (tab === 'publish') renderPublish();
  if (tab === 'backup') renderBackup();
  if (tab === 'hugo') renderHugo();
  if (tab === 'activity') renderActivity();
}

$('#site-select').addEventListener('change', async (ev) => {
  if (S.dirty && !(await confirmBox('Unsaved changes', 'Discard your unsaved edits?', 'Discard'))) {
    ev.target.value = S.site.id;
    return;
  }
  selectSite(ev.target.value);
});

async function selectSite(id) {
  S.site = S.sites.find((s) => s.id === id) || S.sites[0];
  localStorage.setItem('hsm.site', S.site.id);
  $('#site-select').value = S.site.id;
  closeFile();
  await loadTree();
  loadPages();
  setPreviewURL(`/preview/${S.site.id}/`);
  setTab(S.tab);
}

async function refreshSites() {
  S.sites = await api('GET', '/api/sites');
  if (S.site) S.site = S.sites.find((s) => s.id === S.site.id) || S.sites[0];
}

// ------------------------------------------------------------------ file tree

let treeData = [];
async function loadTree() {
  try {
    treeData = await api('GET', sitePath('/tree'));
  } catch (e) {
    toast(e.message, true);
    treeData = [];
  }
  if (!S.treeOpen.size) {
    S.treeOpen.add('content');
    S.treeOpen.add(`content/${S.site.postsSection}`);
  }
  renderTree();
}

function renderTree() {
  const filter = $('#tree-filter').value.trim().toLowerCase();
  const matches = (n) => !filter || n.path.toLowerCase().includes(filter) || (n.children || []).some(matches);
  const build = (nodes) =>
    el('ul', {}, nodes.filter(matches).map((n) => {
      const open = filter || S.treeOpen.has(n.path);
      const isBundle = n.type === 'dir' && (n.children || []).some((c) => c.name === 'index.md' || c.name === '_index.md');
      const label = el('div', {
        class: `node${S.file?.path === n.path ? ' selected' : ''}${n.type === 'file' && !n.text ? ' dim' : ''}`,
        title: n.path,
        onclick: () => (n.type === 'dir' ? toggleDir(n) : openFile(n.path)),
      },
      el('span', { class: 'ico' }, n.type === 'dir' ? (open ? '▾' : '▸') : n.name.endsWith('.md') ? '✎' : '·'),
      n.name,
      n.type === 'dir' ? el('span', { class: 'act', title: 'Upload into this folder', onclick: (e) => { e.stopPropagation(); pickUpload(n.path); } }, '⤒') : null,
      isBundle && n.type === 'dir' ? el('span', { class: 'act', title: 'Open index.md', onclick: (e) => { e.stopPropagation(); openFile(`${n.path}/${(n.children.find((c) => c.name === 'index.md') || n.children.find((c) => c.name === '_index.md')).name}`); } }, 'open') : null);
      return el('li', {}, label, n.type === 'dir' && open ? build(n.children || []) : null);
    }));
  $('#tree').replaceChildren(build(treeData));
}

function toggleDir(n) {
  if (S.treeOpen.has(n.path)) S.treeOpen.delete(n.path);
  else S.treeOpen.add(n.path);
  localStorage.setItem('hsm.treeOpen', JSON.stringify([...S.treeOpen]));
  renderTree();
}
$('#tree-filter').addEventListener('input', renderTree);
$('#refresh-tree').addEventListener('click', loadTree);

// ------------------------------------------------------------------ editor

const editor = $('#editor');
const editorWrap = $('#editor-wrap');
const hl = $('#editor-hl');

// Syntax colouring: a highlighted <pre> sits exactly behind the transparent textarea.
let hlOn = localStorage.getItem('hsm.colours') !== 'off';
let scrollSyncRef = null; // set once the preview section below is initialised
let hlFrame = 0;
function renderHighlight() {
  cancelAnimationFrame(hlFrame);
  hlFrame = requestAnimationFrame(() => {
    // Always rendered (invisible when colours are off): scroll sync measures headings in it.
    if (!S.file || S.file.binary) return;
    hl.innerHTML = highlight(editor.value, S.file.path);
    syncOverlay();
    scrollSyncRef?.invalidate();
  });
}
function syncOverlay() {
  // Match the textarea's content box (it may have a scrollbar the <pre> doesn't).
  hl.style.width = `${editor.clientWidth}px`;
  hl.style.height = `${editor.clientHeight}px`;
  hl.scrollTop = editor.scrollTop;
  hl.scrollLeft = editor.scrollLeft;
}
function setColours(on) {
  hlOn = on;
  localStorage.setItem('hsm.colours', on ? 'on' : 'off');
  editorWrap.classList.toggle('hl', on);
  $('#hl-toggle').checked = on;
  renderHighlight();
}
$('#hl-toggle').addEventListener('change', (e) => setColours(e.target.checked));
editor.addEventListener('scroll', () => {
  hl.scrollTop = editor.scrollTop;
  hl.scrollLeft = editor.scrollLeft;
});
new ResizeObserver(() => syncOverlay()).observe(editor);
setColours(hlOn);

// Undo-friendly text replacement (execCommand keeps the browser's undo stack; setRangeText doesn't).
function replaceRange(a, b, text) {
  editor.focus();
  editor.setSelectionRange(a, b);
  const expectLen = editor.value.length - (b - a) + text.length;
  let ok = false;
  try {
    ok = text ? document.execCommand('insertText', false, text) : a === b || document.execCommand('delete');
  } catch {}
  if (!ok || editor.value.length !== expectLen || editor.value.slice(a, a + text.length) !== text) {
    editor.setRangeText(text, a, b, 'end');
    editor.dispatchEvent(new Event('input'));
  }
}

const pref = (key, def) => (localStorage.getItem(key) ?? (def ? 'on' : 'off')) === 'on';
const bindToggle = (id, key, def, onChange) => {
  const el = $(id);
  el.checked = pref(key, def);
  el.addEventListener('change', () => {
    localStorage.setItem(key, el.checked ? 'on' : 'off');
    onChange?.(el.checked);
  });
  return () => el.checked;
};
const texOn = bindToggle('#tex-toggle', 'hsm.tex', true, (on) => !on && mathAssist.hide());
const syncOn = bindToggle('#sync-scroll', 'hsm.syncScroll', true, (on) => on && scrollSync.sync());

const mathAssist = initMathAssist({
  editor,
  wrap: editorWrap,
  paletteButton: $('#math-btn'),
  isMarkdown: () => !!S.file && !S.file.binary && /\.(md|markdown)$/i.test(S.file.path),
  enabled: texOn,
  replace: replaceRange,
  markdownEscapes: () => S.site?.mathMarkdownEscapes !== false,
});

function closeFile() {
  S.file = null;
  S.dirty = false;
  editor.value = '';
  syncDraftToggle();
  hl.textContent = '';
  mathAssist.hide();
  editorWrap.classList.add('hidden');
  $('#binary-view').classList.add('hidden');
  $('#editor-empty').classList.remove('hidden');
  $('#file-name').textContent = 'No file open';
  ['#save', '#file-rename', '#file-delete'].forEach((s) => ($(s).disabled = true));
  setSaveState('');
}

async function openFile(path) {
  if (S.dirty && S.file?.path !== path && !(await confirmBox('Unsaved changes', `Discard your unsaved edits to ${S.file.path}?`, 'Discard'))) return;
  let f;
  try {
    f = await api('GET', sitePath(`/file?path=${enc(path)}`));
  } catch (e) {
    return toast(e.message, true);
  }
  S.file = f;
  S.dirty = false;
  $('#file-name').textContent = path;
  $('#editor-empty').classList.add('hidden');
  $('#file-rename').disabled = false;
  $('#file-delete').disabled = false;
  if (f.binary) {
    editorWrap.classList.add('hidden');
    const bv = $('#binary-view');
    bv.classList.remove('hidden');
    const url = sitePath(`/raw?path=${enc(path)}`);
    bv.replaceChildren(
      /\.(png|jpe?g|gif|webp|avif|ico)$/i.test(path) ? el('img', { src: url, alt: path }) : el('p', {}, 'Binary file.'),
      el('p', { class: 'muted' }, `${(f.size / 1024).toFixed(1)} KB · `, el('a', { href: url, download: path.split('/').pop() }, 'download'),
        ' · reference it from Markdown as ', el('code', {}, `![](${path.split('/').pop()})`)),
    );
    $('#save').disabled = true;
    syncDraftToggle();
  } else {
    $('#binary-view').classList.add('hidden');
    editorWrap.classList.remove('hidden');
    editor.value = f.content;
    mathAssist.hide();
    renderHighlight();
    editor.scrollTop = 0;
    $('#save').disabled = false;
    syncDraftToggle();
  }
  setSaveState('');
  renderTree();
  showPane('editor');
  showPageInPreview();
  updatePreviewStatus();
  liveRender({ force: true });
}

function setSaveState(text, dirty = false) {
  const s = $('#save-state');
  s.textContent = text;
  s.classList.toggle('dirty', dirty);
}

editor.addEventListener('input', () => {
  renderHighlight();
  if (!S.file) return;
  S.dirty = editor.value !== S.file.content;
  setSaveState(S.dirty ? '● unsaved' : '', S.dirty);
  syncDraftToggle();
});

window.addEventListener('beforeunload', (e) => {
  if (S.dirty) e.preventDefault();
});

async function save({ force = false } = {}) {
  if (!S.file || S.file.binary) return;
  const content = editor.value;
  setSaveState('saving…');
  try {
    const r = await api('PUT', sitePath('/file'), { path: S.file.path, content, baseHash: S.file.hash, force });
    S.file.content = content;
    S.file.hash = r.hash;
    S.dirty = editor.value !== content;
    setSaveState(`saved ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
    if ($('#auto-preview').checked) buildPreview({ quiet: true });
  } catch (e) {
    setSaveState('● not saved', true);
    if (e.status === 409 && (await confirmBox('Conflict', e.message, 'Overwrite'))) return save({ force: true });
    toast(e.message, true);
  }
}
$('#save').addEventListener('click', () => save());

document.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key === 's') {
    e.preventDefault();
    save();
  } else if (mod && document.activeElement === editor && ['b', 'i', 'k'].includes(e.key)) {
    e.preventDefault();
    md({ b: 'bold', i: 'italic', k: 'link' }[e.key]);
  }
});

$('#file-delete').addEventListener('click', async () => {
  const p = S.file?.path;
  if (!p) return;
  const isIndex = /(^|\/)_?index(\.[a-z]+)?\.md$/.test(p);
  const target = isIndex ? p.slice(0, p.lastIndexOf('/')) : p;
  const choice = await dialog('Delete', [
    { type: 'note', text: `Moves to the app's trash folder on the server (recoverable).` },
    ...(isIndex ? [{ type: 'checkbox', name: 'whole', label: `Delete the whole folder "${target}" (post + images${p.endsWith('/_index.md') ? ' + every post in this section' : ''})`, value: !p.endsWith('/_index.md') }] : []),
  ], 'Delete');
  if (!choice) return;
  try {
    await api('DELETE', sitePath(`/file?path=${enc(choice.whole ? target : p)}`));
    S.dirty = false;
    closeFile();
    await loadTree();
    toast('Deleted');
  } catch (e) {
    toast(e.message, true);
  }
});

$('#file-rename').addEventListener('click', async () => {
  const p = S.file?.path;
  if (!p) return;
  const isIndex = /(^|\/)_?index(\.[a-z]+)?\.md$/.test(p);
  const from = isIndex ? p.slice(0, p.lastIndexOf('/')) : p;
  const r = await dialog(isIndex ? 'Rename / move post folder' : 'Rename / move file', [
    { name: 'to', label: 'New path', value: from, required: true },
    { type: 'note', text: 'Renaming a post folder changes its URL. The sidebar title comes from the front matter, not the folder name.' },
  ], 'Rename');
  if (!r || r.to === from) return;
  try {
    await api('POST', sitePath('/rename'), { from, to: r.to });
    const newPath = isIndex ? `${r.to}/${p.split('/').pop()}` : r.to;
    S.dirty = false;
    await loadTree();
    openFile(newPath);
  } catch (e) {
    toast(e.message, true);
  }
});

// markdown toolbar
function md(kind) {
  if (!S.file || S.file.binary) return;
  const { selectionStart: a, selectionEnd: b, value } = editor;
  const sel = value.slice(a, b);
  const wrap = (l, r = l, ph = 'text') => insert(a, b, `${l}${sel || ph}${r}`, l.length, (sel || ph).length);
  const linePrefix = (pre) => {
    const ls = value.lastIndexOf('\n', a - 1) + 1;
    const block = value.slice(ls, b) || '';
    const out = block.split('\n').map((line, i) => (typeof pre === 'function' ? pre(i) : pre) + line).join('\n');
    insert(ls, b, out, out.length, 0);
  };
  switch (kind) {
    case 'bold': return wrap('**');
    case 'italic': return wrap('_');
    case 'code': return wrap('`', '`', 'code');
    case 'codeblock': return wrap('\n```bash\n', '\n```\n', 'command');
    case 'math': return wrap('\n$$\n', '\n$$\n', 'E = mc^2');
    case 'link': return insert(a, b, `[${sel || 'link text'}](https://)`, (sel || 'link text').length + 3, 8);
    case 'h2': return linePrefix('## ');
    case 'ul': return linePrefix('- ');
    case 'ol': return linePrefix((i) => `${i + 1}. `);
    case 'quote': return linePrefix('> ');
    case 'image': return pickUpload(null);
  }
}
function insert(a, b, text, selOffset, selLen) {
  replaceRange(a, b, text); // fires 'input' itself
  editor.selectionStart = a + selOffset;
  editor.selectionEnd = a + selOffset + selLen;
}
$('#md-toolbar').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-md]');
  if (b) md(b.dataset.md);
});

// draft toggle edits the front matter directly
function frontMatterRange(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const start = m[0].indexOf(m[1]);
  return { start, end: start + m[1].length, body: m[1] };
}
function syncDraftToggle() {
  const t = $('#draft-toggle');
  const fm = S.file && !S.file.binary && S.file.path.endsWith('.md') ? frontMatterRange(editor.value) : null;
  t.parentElement.classList.toggle('hidden', !fm);
  if (fm) t.checked = /^draft:\s*true\s*$/m.test(fm.body);
}
$('#draft-toggle').addEventListener('change', (e) => {
  if (!S.file || S.file.binary) return;
  const fm = frontMatterRange(editor.value);
  if (!fm) return;
  let body = fm.body;
  if (/^draft:.*$/m.test(body)) body = body.replace(/^draft:.*$/m, `draft: ${e.target.checked}`);
  else body += `\ndraft: ${e.target.checked}`;
  const keep = [editor.selectionStart, editor.selectionEnd, editor.scrollTop];
  const delta = body.length - (fm.end - fm.start);
  replaceRange(fm.start, fm.end, body); // keeps undo history
  editor.setSelectionRange(keep[0] > fm.end ? keep[0] + delta : keep[0], keep[1] > fm.end ? keep[1] + delta : keep[1]);
  editor.scrollTop = keep[2];
});

// uploads: toolbar button, tree "⤒", paste and drag & drop
let uploadDir = null;
function currentDir() {
  if (S.file?.path.includes('/')) return S.file.path.slice(0, S.file.path.lastIndexOf('/'));
  return `content/${S.site.postsSection}`;
}
function pickUpload(dir) {
  uploadDir = dir;
  $('#image-input').click();
}
$('#image-input').addEventListener('change', async (e) => {
  await uploadFiles([...e.target.files], uploadDir);
  e.target.value = '';
});

async function uploadFiles(files, dir) {
  const target = dir || currentDir();
  const insertInto = !dir && S.file && !S.file.binary && /\.(md|markdown|html)$/.test(S.file.path);
  for (const f of files) {
    const name = f.name && f.name !== 'image.png' ? f.name : `image-${Date.now()}.${(f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`;
    try {
      const r = await api('POST', sitePath(`/upload?dir=${enc(target)}&name=${enc(name)}`), f);
      toast(`Uploaded ${r.name}`);
      if (insertInto) {
        const alt = r.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ');
        const isImg = /^image\//.test(f.type) || /\.(png|jpe?g|gif|webp|svg|avif)$/i.test(r.name);
        const snippet = isImg ? `![${alt}](${r.name})` : `[${r.name}](${r.name})`;
        insert(editor.selectionStart, editor.selectionEnd, `${snippet}\n`, snippet.length + 1, 0);
      }
    } catch (err) {
      toast(`${name}: ${err.message}`, true);
    }
  }
  loadTree();
}
editor.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) {
    e.preventDefault();
    uploadFiles(files, null);
  }
});
editor.addEventListener('dragover', (e) => {
  if ([...e.dataTransfer.types].includes('Files')) {
    e.preventDefault();
    editor.classList.add('dragover');
  }
});
editor.addEventListener('dragleave', () => editor.classList.remove('dragover'));
editor.addEventListener('drop', (e) => {
  editor.classList.remove('dragover');
  const files = [...e.dataTransfer.files];
  if (files.length) {
    e.preventDefault();
    uploadFiles(files, null);
  }
});
editor.addEventListener('keydown', (e) => {
  if (e.key === 'Tab' && !e.metaKey && !e.ctrlKey) {
    e.preventDefault();
    insert(editor.selectionStart, editor.selectionEnd, '  ', 2, 0);
  }
});

// new post / section
async function sectionOptions() {
  const secs = await api('GET', sitePath('/sections'));
  return secs.map((s) => ({ value: s.path, label: `${'— '.repeat(s.depth)}${s.path ? s.title : `${s.title} (top level)`}` }));
}
function defaultSection() {
  const m = S.file?.path.match(new RegExp(`^content/${S.site.postsSection}/(.*)/[^/]+/(_?index\\.md)$`));
  if (S.file?.path.endsWith('/_index.md')) return S.file.path.slice(`content/${S.site.postsSection}/`.length, -'/_index.md'.length);
  return m ? m[1] : '';
}
$('#new-post').addEventListener('click', async () => {
  const opts = await sectionOptions().catch((e) => toast(e.message, true));
  if (!opts) return;
  const r = await dialog('New post', [
    { name: 'title', label: 'Title', required: true, placeholder: 'e.g. 6. Eigenvalues and Eigenvectors' },
    { name: 'section', label: 'Section (sidebar parent)', type: 'select', options: opts, value: defaultSection() },
    { name: 'description', label: 'Description (optional)' },
    { name: 'tags', label: 'Tags (comma separated)' },
    { name: 'categories', label: 'Categories (comma separated)' },
    { type: 'checkbox', name: 'draft', label: 'Start as draft (hidden until you untick it and publish)', value: true },
  ], 'Create');
  if (!r) return;
  const split = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);
  try {
    const p = await api('POST', sitePath('/posts'), { ...r, tags: split(r.tags), categories: split(r.categories) });
    await loadTree();
    revealInTree(p.path);
    await openFile(p.path);
    editor.focus();
    editor.selectionStart = editor.selectionEnd = editor.value.length;
  } catch (e) {
    toast(e.message, true);
  }
});
$('#new-section').addEventListener('click', async () => {
  const opts = await sectionOptions().catch((e) => toast(e.message, true));
  if (!opts) return;
  const r = await dialog('New section', [
    { name: 'title', label: 'Section title', required: true, placeholder: 'e.g. Probability' },
    { name: 'section', label: 'Inside', type: 'select', options: opts, value: defaultSection() },
  ], 'Create');
  if (!r) return;
  try {
    const p = await api('POST', sitePath('/sections'), r);
    await loadTree();
    revealInTree(p.path);
    openFile(p.path);
  } catch (e) {
    toast(e.message, true);
  }
});
function revealInTree(p) {
  const parts = p.split('/');
  for (let i = 1; i < parts.length; i++) S.treeOpen.add(parts.slice(0, i).join('/'));
  localStorage.setItem('hsm.treeOpen', JSON.stringify([...S.treeOpen]));
}

// ------------------------------------------------------------------ preview

const frame = $('#preview-frame');
function setPreviewURL(url) {
  $('#preview-open').href = url;
  let here = null;
  try {
    here = decodeURIComponent(frame.contentWindow.location.pathname);
  } catch {}
  const want = decodeURIComponent(new URL(url, location.href).pathname);
  if (frame.dataset.src !== url || (here && here !== want)) {
    frame.dataset.src = url;
    frame.src = url;
  }
}
async function loadPages() {
  const site = S.site.id;
  const pages = await api('GET', sitePath('/pages')).catch(() => []);
  if (S.site.id !== site) return; // switched sites meanwhile
  S.pages = pages;
  S.pagesSite = site;
  $('#preview-status').textContent = S.pages.length
    ? 'Preview shows drafts. It is only visible to you.'
    : 'No preview built yet — click "Build preview".';
  if (S.file) {
    showPageInPreview();
    updatePreviewStatus();
  }
}
function pageFor(path) {
  return S.pages.find((p) => p.path === path);
}
function showPageInPreview(force = false) {
  if (!S.file) return;
  const pg = pageFor(S.file.path);
  if (pg) {
    if (force) frame.dataset.src = '';
    setPreviewURL(pg.url);
  } else if (force) {
    frame.contentWindow?.location.reload();
  }
}
let previewRunning = false;
async function buildPreview({ quiet = false } = {}) {
  if (previewRunning) return;
  previewRunning = true;
  $('#preview-status').textContent = 'Building preview…';
  try {
    const job = await api('POST', sitePath('/preview'));
    let j;
    if (quiet) {
      do {
        await new Promise((r) => setTimeout(r, 500));
        j = await api('GET', `/api/jobs/${job.id}?since=999999`);
      } while (j.status === 'running');
      if (j.status === 'failed') {
        $('#preview-status').textContent = `Preview failed: ${j.error}`;
        followJob(job);
        return;
      }
    } else {
      j = await followJob(job);
      if (j?.status !== 'succeeded') return;
    }
    await loadPages();
    $('#preview-status').textContent = `Preview updated ${new Date().toLocaleTimeString()}`;
    if (S.file) setTimeout(updatePreviewStatus, 2500);
    if (S.file) showPageInPreview(true);
    else {
      frame.dataset.src = '';
      setPreviewURL(`/preview/${S.site.id}/`);
    }
  } catch (e) {
    $('#preview-status').textContent = e.message;
    if (!quiet || e.status !== 409) toast(e.message, true);
  } finally {
    previewRunning = false;
    // a file opened while this build ran may still need its page shell
    if (S.file && !pageFor(S.file.path)) setTimeout(updatePreviewStatus, 0);
  }
}
$('#preview-build').addEventListener('click', () => buildPreview());

// ---- live preview: render the editor's Markdown into the built page's #post-content as you type
let previewMode = localStorage.getItem('hsm.previewMode') === 'built' ? 'built' : 'live';
$('#preview-mode').value = previewMode;
const focusOn = bindToggle('#focus-toggle', 'hsm.focus', true, () => scrollSync.focus());
const isMarkdownFile = () => !!S.file && !S.file.binary && /\.(md|markdown)$/i.test(S.file.path);

function isSamePage() {
  const pg = S.file && pageFor(S.file.path);
  if (!pg) return false;
  try {
    return decodeURIComponent(frame.contentWindow.location.pathname) === decodeURIComponent(new URL(pg.url, location.href).pathname);
  } catch {
    return false;
  }
}

/** Relative image/video paths are resolved against the post's folder and served from disk (always current). */
function liveUrl(u, kind) {
  if (!u || /^([a-z][a-z0-9+.-]*:|\/|#|\?)/i.test(u) || kind !== 'img') return u;
  const cut = u.search(/[?#]/);
  const rel = cut < 0 ? u : u.slice(0, cut);
  const suffix = cut < 0 ? '' : u.slice(cut); // e.g. clip.mp4#t=5 keeps its media fragment
  const dir = S.file.path.slice(0, S.file.path.lastIndexOf('/'));
  const parts = [];
  for (const raw of `${dir}/${rel}`.split('/')) {
    let seg = raw;
    try {
      seg = decodeURIComponent(raw); // ![](my%20pic.png) → "my pic.png" on disk
    } catch {}
    if (seg === '..') parts.pop();
    else if (seg && seg !== '.') parts.push(seg);
  }
  const hash = suffix.includes('#') ? suffix.slice(suffix.indexOf('#')) : '';
  return sitePath(`/raw?path=${enc(parts.join('/'))}`) + hash;
}

let lastLiveHtml = '';

/**
 * Update #post-content to `html` touching only blocks that changed. Unchanged blocks (keyed by
 * their HTML minus data-line) are kept — a playing <video> or a loaded image isn't reloaded on
 * every keystroke — and just get their new data-line.
 */
function patchBlocks(doc, pc, html) {
  const tpl = doc.createElement('template');
  tpl.innerHTML = html;
  const keyOf = (el) => el.outerHTML.replace(/ data-line="\d+"/, '');
  const pool = new Map();
  for (const el of [...pc.children]) {
    if (!el.__hsmKey) continue;
    if (!pool.has(el.__hsmKey)) pool.set(el.__hsmKey, []);
    pool.get(el.__hsmKey).push(el);
  }
  const wanted = [];
  for (const fresh of [...tpl.content.children]) {
    const key = keyOf(fresh);
    const reuse = pool.get(key)?.shift();
    if (reuse) {
      reuse.dataset.line = fresh.dataset.line;
      wanted.push(reuse);
    } else {
      fresh.__hsmKey = key;
      fixMedia(fresh);
      wanted.push(fresh);
    }
  }
  const keep = new Set(wanted);
  for (const el of [...pc.childNodes]) if (!keep.has(el)) el.remove();
  // insert/move into order with the fewest moves (a moved node keeps its state)
  wanted.forEach((el, i) => {
    if (pc.children[i] !== el) pc.insertBefore(el, pc.children[i] || null);
  });
}

/** Media written as raw HTML (<video src="clip.mp4">) gets the same relative-path treatment. */
function fixMedia(root) {
  const els = root.matches?.('img[src], video[src], source[src], audio[src]') ? [root] : [];
  for (const m of [...els, ...root.querySelectorAll('img[src], video[src], source[src], audio[src]')]) {
    const src = m.getAttribute('src');
    const fixed = liveUrl(src, 'img');
    if (fixed !== src) m.setAttribute('src', fixed);
  }
}
function liveRender({ force = false } = {}) {
  if (previewMode !== 'live' || !isMarkdownFile() || !isSamePage()) return;
  const doc = frame.contentDocument;
  const pc = doc?.getElementById('post-content');
  if (!pc) return;
  const html = renderMarkdown(editor.value, {
    katex: window.katex,
    escapes: S.site?.mathMarkdownEscapes !== false,
    url: liveUrl,
  });
  if (!force && html === lastLiveHtml && pc.dataset.hsmLive === '1') return;
  lastLiveHtml = html;
  patchBlocks(doc, pc, html);
  pc.dataset.hsmLive = '1';
  scrollSync.focusNow(); // before the browser paints the new blocks
  if (!doc.getElementById('hsm-katex-css')) {
    const l = doc.createElement('link');
    l.id = 'hsm-katex-css';
    l.rel = 'stylesheet';
    l.href = '/vendor/katex/katex.min.css';
    doc.head.append(l);
  }
  // keep the page title in step with the front matter (YAML or TOML, title line inside it only)
  const fm = editor.value.replace(/\r\n?/g, '\n').match(/^(---|\+\+\+)\n([\s\S]*?)\n\1(?:\n|$)/);
  const t = fm?.[2].match(/^title\s*[:=]\s*(["']?)(.*?)\1\s*$/m);
  const h1 = doc.querySelector('.page-content .title h1');
  if (t && h1 && h1.textContent !== t[2]) h1.textContent = t[2];
  scrollSync.watchMedia();
  scrollSync.sync();
}
let liveTimer = 0;
const liveRenderSoon = () => {
  clearTimeout(liveTimer);
  liveTimer = setTimeout(liveRender, 120);
};

const lineOf = (i) => {
  let n = 0;
  for (let k = editor.value.indexOf('\n'); k >= 0 && k < i; k = editor.value.indexOf('\n', k + 1)) n++;
  return n;
};

const scrollSync = initScrollSync({
  editor,
  overlay: hl,
  frame,
  enabled: syncOn,
  focusEnabled: () => focusOn() && previewMode === 'live',
  // the line being edited; null → whatever is in view
  caret: () => {
    if (document.activeElement !== editor) return null;
    const i = editor.selectionStart;
    const start = editor.value.lastIndexOf('\n', i - 1) + 1;
    const end = editor.value.indexOf('\n', i);
    return { line: lineOf(i), col: i - start, len: (end < 0 ? editor.value.length : end) - start };
  },
  isSamePage,
});
scrollSyncRef = scrollSync;

const shellTries = new Map(); // "site:path" → auto-build attempts
function updatePreviewStatus() {
  const st = $('#preview-status');
  if (!S.file || !isMarkdownFile()) return;
  if (!pageFor(S.file.path)) {
    st.textContent = previewRunning ? 'Building the page once so it can be previewed…' : 'This page has not been built yet.';
    // live preview needs the page's theme shell once; build it automatically (only once pages for
    // this site are known, and only when no other build is running — buildPreview re-checks after)
    const key = `${S.site.id}:${S.file.path}`;
    const tries = shellTries.get(key) || 0;
    if (previewMode === 'live' && S.pagesSite === S.site.id && !previewRunning && tries < 2) {
      shellTries.set(key, tries + 1);
      buildPreview({ quiet: true });
    }
    return;
  }
  st.textContent = previewMode === 'live'
    ? 'Live preview — updates as you type (drafts included, only visible to you).'
    : 'Built preview — the exact Hugo build as of the last save.';
}

editor.addEventListener('input', liveRenderSoon);
frame.addEventListener('load', () => {
  lastLiveHtml = '';
  liveRender({ force: true });
});
// placing the caret (click, arrows, PageUp/Down…) re-aligns the preview to it, not just scrolling
for (const ev of ['click', 'keyup', 'focus']) editor.addEventListener(ev, () => scrollSync.sync());
editor.addEventListener('blur', () => scrollSync.focus());
$('#preview-mode').addEventListener('change', (e) => {
  previewMode = e.target.value;
  localStorage.setItem('hsm.previewMode', previewMode);
  updatePreviewStatus();
  if (previewMode === 'built') showPageInPreview(true); // reload to drop the live DOM
  else liveRender({ force: true });
  scrollSync.focus();
});

// mobile pane switching
function showPane(name) {
  $$('.mobile-switch button').forEach((b) => b.classList.toggle('active', b.dataset.pane === name));
  $$('.write .pane').forEach((p) => p.classList.toggle('show', p.dataset.pane === name));
}
$('.mobile-switch').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-pane]');
  if (b) showPane(b.dataset.pane);
});

// ------------------------------------------------------------------ publish

async function renderPublish() {
  await refreshSites();
  const s = S.site;
  $('#pub-site-name').textContent = s.name;
  const facts = $('#pub-facts');
  facts.replaceChildren(
    el('dt', {}, 'Live site'), el('dd', {}, s.publicURL ? el('a', { href: s.publicURL, target: '_blank', rel: 'noopener' }, s.publicURL) : '—'),
    el('dt', {}, 'Built for'), el('dd', {}, el('code', {}, s.baseURL || 'not configured')),
    el('dt', {}, 'Uploads to'), el('dd', {}, s.deploy.type === 'mc' ? el('code', {}, `mc mirror → ${s.deploy.target}`) : s.deploy.type,
      s.deploy.removeExtraneous ? ' (removes files not in the build)' : ''),
    el('dt', {}, 'Last published'), el('dd', {}, s.state.lastDeploy ? `${fmtDate(s.state.lastDeploy)} (${ago(s.state.lastDeploy)})` : 'never from this app'),
    el('dt', {}, 'Last backup'), el('dd', {}, s.state.lastBackup ? `${fmtDate(s.state.lastBackup)} (${ago(s.state.lastBackup)})` : 'never from this app'),
  );
  $('#pub-backup').disabled = !s.git?.isRepo || !s.git?.remoteUrl;
  if ($('#pub-backup').disabled) $('#pub-backup').checked = false;
}
$('#pub-dry').addEventListener('click', () => runJob('POST', sitePath('/publish'), { dryRun: true }));
$('#pub-go').addEventListener('click', async () => {
  if (S.dirty) return toast('Save your open file first', true);
  if (!(await confirmBox('Publish live', `Build ${S.site.name} and upload it to ${S.site.deploy.target || S.site.deploy.type}? Drafts are not included.`, 'Publish'))) return;
  runJob('POST', sitePath('/publish'), { backupFirst: $('#pub-backup').checked }, { onDone: (j) => {
    if (j.status === 'succeeded') toast('Published 🎉');
    renderPublish();
  } });
});

// ------------------------------------------------------------------ backup

async function renderBackup() {
  const card = $('#git-card');
  card.replaceChildren(el('p', { class: 'muted' }, 'Loading…'));
  let g;
  try {
    g = await api('GET', sitePath('/git'));
  } catch (e) {
    return card.replaceChildren(el('p', { class: 'error' }, e.message));
  }
  const name = S.site.path.split('/').pop().replace(/[^A-Za-z0-9._-]/g, '-');
  if (!g.isRepo || !g.remoteUrl) {
    card.replaceChildren(
      el('h2', {}, `Back up ${S.site.name} to GitHub`),
      el('p', {}, g.isRepo ? 'This folder is a git repository but has no remote yet.' : 'This folder is not under git yet.'),
      el('p', { class: 'muted' }, 'Connecting writes a .gitignore (excluding public/, node_modules/, resources/_gen/ and .DS_Store) if there is none, runs git init, and adds the remote. Nothing is pushed until you click "Back up now".'),
      el('h3', {}, 'Create a new GitHub repository'),
      el('div', { class: 'row' },
        el('input', { id: 'new-repo', value: name, size: 30 }),
        el('label', { class: 'check' }, el('input', { type: 'checkbox', id: 'new-repo-private', checked: true }), 'Private'),
        el('button', { class: 'primary', onclick: () => connect({ createRepo: $('#new-repo').value, isPrivate: $('#new-repo-private').checked }) }, 'Create & connect')),
      el('h3', {}, '…or use an existing repository'),
      el('div', { class: 'row' },
        el('input', { id: 'repo-url', placeholder: 'git@github.com:you/repo.git', size: 40 }),
        el('button', { onclick: () => connect({ remoteUrl: $('#repo-url').value }) }, 'Connect')),
    );
    return;
  }
  const changes = g.changes || [];
  card.replaceChildren(
    el('h2', {}, `Back up ${S.site.name}`),
    el('dl', { class: 'facts' },
      el('dt', {}, 'Repository'), el('dd', {}, el('code', {}, g.remoteUrl)),
      el('dt', {}, 'Branch'), el('dd', {}, g.branch, g.ahead ? ` · ${g.ahead} commit(s) not pushed` : '', g.behind ? ` · ${g.behind} behind remote` : ''),
      el('dt', {}, 'Last backup'), el('dd', {}, S.site.state.lastBackup ? `${fmtDate(S.site.state.lastBackup)} (${ago(S.site.state.lastBackup)})` : 'never from this app')),
    el('h3', {}, changes.length ? `${changes.length} changed file(s)` : 'No uncommitted changes'),
    changes.length ? el('div', { class: 'changes' }, changes.slice(0, 300).map((c) => el('div', {}, `${c.code} ${c.path}`)), changes.length > 300 ? `… and ${changes.length - 300} more` : '') : null,
    el('div', { class: 'row' },
      el('input', { id: 'commit-msg', placeholder: 'Commit message (optional)', size: 44 }),
      el('button', { class: 'primary', onclick: () => runJob('POST', sitePath('/git/backup'), { message: $('#commit-msg').value }, { onDone: renderBackup }) }, 'Back up now'),
      el('button', { onclick: () => runJob('POST', sitePath('/git/pull'), undefined, { onDone: () => { renderBackup(); loadTree(); } }) }, 'Pull latest')),
    el('h3', {}, 'Recent commits'),
    el('table', { class: 'list' }, (g.commits || []).map((c) => el('tr', {}, el('td', {}, el('code', {}, c.hash)), el('td', {}, c.subject), el('td', { class: 'muted' }, ago(c.date))))),
  );
}
async function connect(body) {
  await runJob('POST', sitePath('/git/connect'), body, { onDone: renderBackup });
}

// ------------------------------------------------------------------ hugo

async function renderHugo() {
  const card = $('#hugo-card');
  let st;
  let rel = [];
  try {
    st = await api('GET', '/api/hugo');
  } catch (e) {
    return card.replaceChildren(el('p', { class: 'error' }, e.message));
  }
  let relErr = null;
  try {
    rel = await api('GET', '/api/hugo/releases');
  } catch (e) {
    relErr = e.message;
  }
  const cur = st.current.version;
  const latest = rel[0];
  const newer = latest && cur && cmp(latest.version, cur) > 0;
  card.replaceChildren(
    el('h2', {}, 'Hugo'),
    el('dl', { class: 'facts' },
      el('dt', {}, 'In use'), el('dd', {}, st.current.ok ? `v${cur}${st.current.flavor}` : el('span', { class: 'error' }, st.current.error), ' ', el('span', { class: 'muted' }, `(${st.active === 'system' ? `system: ${st.binary}` : 'managed by this app'})`)),
      el('dt', {}, 'Dart Sass'), el('dd', {}, st.sass || el('span', { class: 'muted' }, 'not installed — added automatically when a Hugo version needs it')),
      el('dt', {}, 'System hugo'), el('dd', {}, st.system.ok ? `v${st.system.version}${st.system.flavor}` : 'not found on PATH'),
      el('dt', {}, 'Latest release'), el('dd', {}, latest ? `v${latest.version} (${fmtDate(latest.publishedAt)})` : relErr || '—', newer ? el('span', { class: 'pill bad' }, ' update available') : latest ? el('span', { class: 'pill ok' }, ' up to date') : '')),
    st.pinnedByConfig ? el('p', { class: 'muted' }, 'hugo.binary is pinned in config.json, so the version switcher below is disabled.') : null,
    el('p', { class: 'muted' }, 'Upgrading downloads the official release from GitHub, verifies its checksum, then test-builds every site with it. It only becomes active if all test builds pass. Your Homebrew/system Hugo is never touched, and you can switch back at any time.'),
    el('h3', {}, 'Available versions'),
    el('table', { class: 'list' },
      el('tr', {}, el('th', {}, 'Version'), el('th', {}, 'Released'), el('th', {}, '')),
      el('tr', {}, el('td', {}, 'system', st.system.ok ? ` (v${st.system.version})` : ''), el('td', {}, ''),
        el('td', {}, st.active === 'system' ? el('span', { class: 'pill ok' }, 'active') : el('button', { class: 'small', disabled: st.pinnedByConfig, onclick: () => activate('system') }, 'Use'))),
      rel.slice(0, 8).map((r) => {
        const installed = st.installed.includes(r.version);
        const active = st.active === r.version;
        return el('tr', {},
          el('td', {}, `v${r.version}`, el('details', { class: 'notes' }, el('summary', { class: 'muted' }, 'release notes'), el('pre', {}, r.notes), el('a', { href: r.url, target: '_blank', rel: 'noopener' }, 'on GitHub ↗'))),
          el('td', { class: 'muted' }, fmtDate(r.publishedAt)),
          el('td', {},
            active ? el('span', { class: 'pill ok' }, 'active')
              : installed ? [el('button', { class: 'small', disabled: st.pinnedByConfig, onclick: () => activate(r.version) }, 'Use'), ' ', el('button', { class: 'small ghost danger', onclick: () => removeHugo(r.version) }, 'Remove')]
                : el('button', { class: `small${r === latest ? ' primary' : ''}`, disabled: st.pinnedByConfig, onclick: () => upgrade(r.version) }, r === latest ? 'Install & test' : 'Install & test')));
      }),
      st.installed.filter((v) => !rel.some((r) => r.version === v)).map((v) =>
        el('tr', {}, el('td', {}, `v${v}`), el('td', { class: 'muted' }, 'installed'),
          el('td', {}, st.active === v ? el('span', { class: 'pill ok' }, 'active') : [el('button', { class: 'small', onclick: () => activate(v) }, 'Use'), ' ', el('button', { class: 'small ghost danger', onclick: () => removeHugo(v) }, 'Remove')]))),
    ),
  );
  renderTheme();
}
function cmp(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}
async function upgrade(version) {
  const ok = await confirmBox(`Install Hugo ${version}`, 'Download it, test-build all your sites, and switch to it if they all build?', 'Install');
  if (ok) runJob('POST', '/api/hugo/upgrade', { version }, { onDone: renderHugo });
}
async function activate(version) {
  try {
    await api('POST', '/api/hugo/activate', { version });
    toast(`Now using Hugo ${version}`);
    renderHugo();
  } catch (e) {
    toast(e.message, true);
  }
}
async function removeHugo(version) {
  try {
    await api('DELETE', `/api/hugo/${enc(version)}`);
    renderHugo();
  } catch (e) {
    toast(e.message, true);
  }
}
function renderTheme() {
  $('#theme-card').replaceChildren(
    el('h2', {}, `Theme & modules — ${S.site.name}`),
    el('p', { class: 'muted' }, 'Runs hugo mod get -u, hugo mod tidy, hugo mod npm pack and npm install, then test-builds. If anything fails, go.mod/go.sum/package files are restored automatically. Back up to GitHub first so you can review the diff.'),
    el('div', { class: 'row' },
      el('button', { onclick: () => runJob('POST', sitePath('/theme/graph')) }, 'Show module versions'),
      el('button', { class: 'primary', onclick: async () => {
        if (await confirmBox('Update theme', `Update the Hugo modules (theme) for ${S.site.name}?`, 'Update')) runJob('POST', sitePath('/theme/update'));
      } }, 'Update theme')),
  );
}

// ------------------------------------------------------------------ activity

async function renderActivity() {
  const jobs = await api('GET', '/api/jobs');
  $('#jobs').replaceChildren(
    jobs.length ? el('table', { class: 'list' },
      el('tr', {}, el('th', {}, 'What'), el('th', {}, 'Status'), el('th', {}, 'Started')),
      jobs.map((j) => el('tr', { class: 'click', onclick: () => followJob(j) },
        el('td', {}, j.title), el('td', {}, el('span', { class: `pill ${j.status}` }, j.status)), el('td', { class: 'muted' }, fmtDate(j.startedAt)))))
      : el('p', { class: 'muted' }, 'Nothing has run since the server started.'),
  );
}

// ------------------------------------------------------------------ boot

async function boot() {
  try {
    await api('GET', '/api/me');
  } catch {
    return showLogin();
  }
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
  await refreshSites();
  const sel = $('#site-select');
  sel.replaceChildren(...S.sites.map((s) => el('option', { value: s.id, disabled: !s.exists }, s.name + (s.exists ? '' : ' (missing)'))));
  const [hashSite, hashTab] = location.hash.slice(1).split('/');
  if (hashTab) S.tab = hashTab;
  await selectSite(S.sites.find((s) => s.id === hashSite)?.id || localStorage.getItem('hsm.site') || S.sites[0]?.id);
  showPane('files');
}
boot();
