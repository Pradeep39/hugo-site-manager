---
name: hugo-site-manager
description: Work on Hugo Site Manager — the zero-dependency Node web app that edits, live-previews, publishes (MinIO via mc), backs up (GitHub) and upgrades Hugo for Pradeep's Toha-themed sites pradeepr.cloud and ananyareddy.com, deployed on the homelab k3s/kubeadm Pi cluster at sites.pradeepr.cloud. Use when changing the app (editor, math/KaTeX assist, live preview, scroll sync, publish/backup/Hugo upgrade), deploying it to the cluster, or troubleshooting the sites' build/publish.
---

# Hugo Site Manager

Repo: https://github.com/Pradeep39/hugo-site-manager (local checkout usually `~/hugo-site-manager`).
Live: **https://sites.pradeepr.cloud** (user `pradeep`, password set by the user — never set or change it yourself)
and **http://192.168.86.7** on the home LAN.

## What it is

- `server.js` — plain `node:http` server, no npm dependencies. Routes under `/api/*` (cookie session +
  required `X-HSM: 1` header on non-GET for CSRF), `/preview/<site>/…` (the Hugo preview build),
  `/vendor/katex/*` (served from a site's `node_modules/katex/dist`), and production asset paths like
  `/mysite/public/…` mapped to the preview build (signed-in only).
- `lib/` — `config.js` (config + `state.json`), `auth.js` (scrypt, HMAC cookie, login throttle), `content.js`
  (file ops confined to editable dirs, trash instead of delete, Toha front matter for new posts/sections),
  `build.js` (hugo preview/production builds, MinIO link fix-up, `mc mirror` deploy, theme module update),
  `git.js` (backup/pull/connect, refuses >95 MB files), `hugo.js` (managed Hugo installs + Dart Sass), `jobs.js`.
- `public/` — vanilla JS UI: `app.js`, `highlight.js` (overlay syntax colouring), `mathedit.js` (math assist),
  `markdown.js` (live-preview renderer), `scrollsync.js`, `style.css` (dark default via `[data-theme]`).
- Config: `~/.hugo-site-manager/config.json` locally (never commit it); in the cluster a ConfigMap.

## Run, test

```sh
npm run set-password   # only if the user asks; prompts on stderr, writes a scrypt hash
npm start              # 127.0.0.1:8787
npm test               # ~60 tests, all must pass before deploying
```

- Sandboxed sessions often **cannot open listening sockets or launch Chrome**. Don't fight it: the API is
  tested in-process (`test/harness.js` drives `requestListener` with mock req/res), math-assist keystrokes
  run against a fake textarea (`test/mathkeys.test.js`), and `node test/tools/fidelity.mjs <site>` checks the
  live renderer against Hugo's real output (currently 342/342 blocks).
- Browser-only code (DOM, iframe, events) can't be executed here: after non-trivial UI changes, get an
  independent review of the DOM/event paths before deploying — every review so far found real bugs.
- Node's `fetch` ignores `HTTPS_PROXY` unless `http.setGlobalProxyFromEnv()` / `NODE_USE_ENV_PROXY=1`;
  `release-assets.githubusercontent.com` may be blocked in sandboxes (the cluster can reach it).

## Deploy to the cluster

kubeconfig `~/Downloads/config` (API at the house's public IP :8443), namespace **`myminio`**, manifest
`deploy/k8s/cluster.yaml`. No custom image: stock `node:24-bookworm`, code = ConfigMap tarball.

```sh
export KUBECONFIG=~/Downloads/config
tar --no-mac-metadata -czf /tmp/app.tgz package.json server.js lib bin public
kubectl -n myminio create configmap hugo-site-manager-app --from-file=app.tgz=/tmp/app.tgz --dry-run=client -o yaml | kubectl apply -f -
kubectl -n myminio rollout restart deploy/hugo-site-manager && kubectl -n myminio rollout status deploy/hugo-site-manager
```

- PVC `/data`: `/data/sites/{pradeepr.cloud,ananyareddy.com}` (seeded by tar from the Mac, not cloned),
  `/data/tools` (hugo 0.162.1 + go 1.27.1 from the init container, `bin/mc`), `/data/app` (state, previews,
  managed Hugo — **0.170.1 active**, Dart Sass 1.108.2).
- Secrets (never print, never overwrite `hugo-site-manager-auth`): `hugo-site-manager-auth` =
  `HSM_PASSWORD_HASH` (the user's); `hugo-site-manager` = `GITHUB_TOKEN` (Pradeep39's `gh auth token`; the user
  OKs using that account), `MC_HOST_minio` (`http://KEY:SECRET@minio.myminio.svc`, from `~/.mc/config.json`),
  `HSM_SESSION_SECRET`.
- `minio/mc` is gone from Docker Hub and `quay.io/minio/*` returns 401 — `mc` was copied out of the running
  MinIO pod: `kubectl exec myminio-pool-0-0 -c minio -- cat /usr/bin/mc | kubectl exec -i deploy/hugo-site-manager -c app -- sh -c 'cat > /data/tools/bin/mc && chmod +x /data/tools/bin/mc'`.
  Consequence the user knows about: the MinIO tenant image can't be re-pulled (cached only on worker04).
- Ingress `sites.pradeepr.cloud` (DNS CNAME → pradeepr.cloud → public IP), cert from the **namespaced
  `letsencrypt-prod` Issuer** (`cert-manager.io/issuer`, not cluster-issuer). LAN Service
  `hugo-site-manager-lan` on MetalLB `192.168.86.7` with `externalTrafficPolicy: Local`; config
  `trustProxy: ["10.244.0.0/16"]` (pod CIDR) so only ingress pods' `X-Forwarded-*` are believed, and the
  session cookie is `Secure` only for requests that came through HTTPS.
- Checking things from inside the cluster: short-lived pods (`kubectl run … --rm -i --restart=Never`) work
  for DNS (`nslookup` against the authoritative `dns1.registrar-servers.com`) and egress tests.

## The sites (facts that matter)

- Both: Hugo + Toha v4 (pradeepr.cloud v4.13, ananyareddy.com v4.9) as Hugo modules, `uglyURLs: true` — the
  user decided to **keep ugly URLs** (switching would change 35 page URLs; navigation works either way now).
- Served straight out of MinIO buckets: `minio/mysite/public` (https://minio.pradeepr.cloud/mysite/public/index.html)
  and `minio/site/public` (https://ananyareddy.com/). Publishing = `hugo --baseURL <prod>` + post-process
  (relativize hrefs, append `index.html` to folder links — MinIO has no directory index) + `mc mirror --overwrite`.
  The old `generate-and-publish.sh` (hugo server + sed) shipped livereload.js; the app's build doesn't.
- goldmark **without passthrough**: Markdown eats backslash escapes before KaTeX, so a TeX row break is
  written `\\\\`, `\{` must be `\\{`. The editor's preview applies `mdUnescape`, snippets are written with
  `mdEscapeTex` (site setting `mathMarkdownEscapes`, default true). KaTeX delimiters: `$$ \[ $ \(`. Math never
  spans a blank line (paragraph break). Post style: one-line matrices, `$$\begin{bmatrix}…\end{bmatrix}$$`.
- Hugo ≥0.16x release builds dropped LibSass; Toha needs **Dart Sass** — the app's Hugo upgrade installs it.
  Toha emits ~380 Sass deprecation warnings (harmless for now).
- pradeepr.cloud's first GitHub backup is blocked by an unused 130 MB `static/files/linalg/System_Equations.gif`
  (the user decides: delete or .gitignore). ananyareddy.com isn't in git yet (Backup → "Create & connect").
  Content typo: Part 3 post line 115 has `"http://…/index.html".` which linkify turns into a broken link.
- Mac and cluster copies of the sites diverge; GitHub (Backup / Pull latest) is the sync point.

## Editor behaviours (don't regress)

Math assist in `mathedit.js`, all inside math only and never in code/front matter:
`$`→`$|$` (word boundary only; `$5 ` un-pairs), `$$`→`$$|$$`, retyped closers step over, Backspace removes
editor-made empty pairs, `{}` auto-pair, `\begin`→`\begin{|}\end{}` with mirrored name, `\begin{array}` adds a
selected `{cc}`, unambiguous arg commands get braces immediately (`\boxed`→`\boxed{|}`, `\frac`→`\frac{|}{}`),
ambiguous ones (`\text`/`\textbf`, `\dot`/`\dots`, `\color`/`\colorbox`) on space, a habitual `{` after auto
braces is absorbed, `^`/`_` insert `{2}`/`{i}` selected (context: `\sum`→`i=1`/`n`, `\int`→`a`/`b`,
`\lim`→`x \to \infty`), `\left(`→`\left( | \right)`, Enter = ` \\\\ ` row break, Shift+Enter = newline and the
multi-line expansions. `\\` never opens autocomplete. The preview ignores a half-typed command.

Live preview patches only changed blocks (keyed by HTML minus `data-line`) so videos don't restart; scroll
sync maps editor content y (line markers `<i class="ln">` in the overlay) ↔ preview content y (`data-line`
blocks) and puts the caret's block at the caret's screen height (`scrollTarget`).

## Working agreements

- Check what's on the cluster before changing it; don't delete resources you didn't create.
- Never commit `config.json`, tokens, password hashes, or MinIO keys; the public repo uses the GitHub noreply
  address (`16216080+Pradeep39@users.noreply.github.com`) instead of the personal email.
- Don't edit the user's site content without asking; if you create a probe file in a site, delete it at once
  and say so.
- Publishing to the live buckets and pushing site repos are the user's calls — dry-run first.
