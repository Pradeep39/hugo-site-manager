# Hugo Site Manager

A small web app for running one or more [Hugo](https://gohugo.io) websites from a browser:

- **Write** – file tree for `content/`, `data/`, `static/`…; a Markdown editor with syntax colouring
  (Markdown, front matter, code blocks, Hugo shortcodes, HTML, LaTeX), image paste/drop into the post's
  folder, new posts/sections with Toha-style `menu.sidebar` front matter (right `parent`, next `weight`),
  draft toggle, rename/move, delete to a trash folder. Dark theme by default (Dark / Light / System).
- **Math (Overleaf-style)** – rendered with the site's own KaTeX and delimiters (`$$…$$`, `\[…\]`,
  `$…$`, `\(…\)`): live equation preview under the caret with errors as you type, `\` autocomplete with
  rendered symbols and Tab-able snippets, auto-closing `$…$`/`$$…$$`/`{}`/`\left(…\right)`,
  `\begin{env}` → `\end{env}` mirroring, braces added as soon as `\boxed`/`\frac`/… is typed, `^`/`_`
  with selected placeholders (`\sum_{i=1}^{n}`), Enter = row break inside math, a symbol palette.
  Markdown's backslash escaping is honoured (`\\\\` is a row break on goldmark sites without passthrough).
- **Preview** – *Live*: the editor's Markdown is rendered in the browser into the real Toha page shell
  as you type (block-for-block identical to Hugo on the sites it was built for), with only changed blocks
  redrawn so videos keep playing. *Built*: the exact Hugo build with drafts. Scroll sync aligns the
  caret's block at the same screen height in both panes (dense per-block anchors, re-aligned when images
  and videos load); *Focus* dims everything but the section being edited.
- **Publish** – production build (no drafts) for the site's real URL, fixes links so they work out of a
  MinIO/S3 bucket, then uploads with `mc mirror`. Optional "back up to GitHub first". Dry-run button.
- **Backup** – commit + push to GitHub; one-click "create a private repo and connect" for sites that
  aren't in git yet; refuses files over GitHub's 100 MB limit before pushing; "Pull latest" for working
  from several machines.
- **Hugo** – shows your version vs. the latest release, downloads a release from GitHub, verifies its
  sha256, **test-builds every site with it, and only switches if they all pass**. Switch back any time.
  Separately, "Update theme" runs `hugo mod get -u / tidy / npm pack / npm install` and auto-restores
  `go.mod`/`package*.json` if the test build fails.

No npm dependencies — Node ≥ 20 and the tools you already use (`hugo`, `git`, `mc`, `go`, `npm`).

## Run it on your Mac

```sh
cd ~/hugo-site-manager
npm run set-password          # writes a scrypt hash into ~/.hugo-site-manager/config.json
npm start                     # http://127.0.0.1:8787
```

`~/.hugo-site-manager/config.json` already lists both sites. To use it from your phone on the home
network, set `"listen": {"host": "0.0.0.0"}`. For use from anywhere, run it on the cluster (below),
since that gives you TLS and doesn't depend on the Mac being awake.

Everything the app owns lives in `~/.hugo-site-manager/` (override with `HSM_DATA_DIR`):
`config.json`, `state.json` (last publish/backup times, active Hugo), `hugo/<version>/hugo`
(managed Hugo binaries), `preview/`, `build/`, `trash/`, `snapshots/` (pre-theme-update copies).

## How publishing replaces `generate-and-publish.sh`

The old script ran `hugo server`, waited 15 s, and patched the output with `sed`. The app instead runs
a normal `hugo --baseURL <build.baseURL>` into `~/.hugo-site-manager/build/<site>/` and then:

| old `sed` line                                     | what the app does                                                      |
|----------------------------------------------------|------------------------------------------------------------------------|
| `http://localhost:1313/` → `/`                     | `relativizeHTML`: `href/src="https://host/prefix/…"` → `"/prefix/…"`    |
| `/posts`, `/search`, `/tags`, `/notes`, `#anchors` | `directoryIndexLinks`: **any** link to a folder that has an `index.html` in the build gets `/index.html` appended — new sections need no new sed lines |
| `sitemap.xml` localhost → `https://minio…`         | absolute `baseURL` makes RSS/sitemap correct to begin with              |

Side effects of the change: the published pages no longer include Hugo's `livereload.js` (the old
flow shipped the dev server's output), and home-page anchors become `index.html#about` on both sites.
Your site's own `public/` folder is left alone (set `deploy.syncPublicDir: true` if you want it updated).

Then `mc mirror --overwrite <build>/ <deploy.target>/`. Set `deploy.removeExtraneous: true` to also
delete files in the bucket that are no longer in the build (old hashed `application.*.js` bundles pile
up otherwise) — leave it off until you've confirmed nothing else lives under that prefix.

## Site config reference

```jsonc
{
  "id": "pradeepr-cloud",               // URL-safe id
  "name": "Pradeep's Cloud Blog",
  "path": "~/pradeepr.cloud",           // Hugo project root
  "publicURL": "https://…",             // just for the "live site" link
  "postsSection": "posts",              // where "New post" puts things
  "frontMatterStyle": "toha",           // "toha" adds menu.sidebar {name, identifier, parent, weight}; or "plain"
  "editable": ["content","data","static","assets","archetypes","layouts","i18n"],
  "rootFiles": ["hugo.yaml", "README.md", ".gitignore"],
  "build":  { "baseURL": "https://minio.pradeepr.cloud/mysite/public/", "environment": "production", "args": [] },
  "postProcess": { "relativizeHTML": true, "directoryIndexLinks": true },
  "deploy": { "type": "mc", "target": "minio/mysite/public", "removeExtraneous": false },
  //         or { "type": "command", "command": "rsync -a \"$HSM_BUILD_DIR/\" host:/srv/site/" }  ($HSM_DRY_RUN=1 on dry runs)
  //         or { "type": "none" }
  "git": { "remote": "origin", "branch": "main",
           "author": { "name": "…", "email": "…" },  // optional commit identity
           "cloneUrl": "https://github.com/…" }      // container mode: cloned on first start if path is missing
}
```

Top level: `listen`, `auth.username`, `auth.passwordHash`, `auth.sessionHours`, `secureCookies`
(set true behind HTTPS), `trustProxy` (use `X-Forwarded-For` for login throttling behind ingress),
`hugo.binary` (pin a specific binary and disable the switcher).

Environment overrides: `HSM_DATA_DIR`, `HSM_CONFIG`, `HSM_HOST`, `HSM_PORT`, `HSM_USERNAME`,
`HSM_PASSWORD_HASH`, `HSM_SESSION_SECRET`, `HSM_SECURE_COOKIES`, `HSM_TRUST_PROXY`, `HSM_HUGO_BINARY`,
`GITHUB_TOKEN` (HTTPS push + repo creation; without it git uses your SSH key and repo creation uses `gh`).
`mc` reads `MC_HOST_<alias>=https://ACCESS:SECRET@host` if you don't want an `~/.mc/config.json`.

## Run it on the cluster (edit from anywhere)

`deploy/k8s/cluster.yaml` runs it **without building an image**: the stock `node:24-bookworm` image,
the app code shipped as a tarball in a ConfigMap, Hugo + Go downloaded once onto the PVC by an init
container, and the site folders on the PVC. Ship code changes with:

```sh
tar --no-mac-metadata -czf /tmp/app.tgz package.json server.js lib bin public
kubectl -n myminio create configmap hugo-site-manager-app --from-file=app.tgz=/tmp/app.tgz --dry-run=client -o yaml | kubectl apply -f -
kubectl -n myminio rollout restart deploy/hugo-site-manager
```

Secrets are created separately (never in git): `hugo-site-manager-auth` holds `HSM_PASSWORD_HASH`
(`npm run -s set-password -- --print`), `hugo-site-manager` holds `GITHUB_TOKEN`, `MC_HOST_minio`
and `HSM_SESSION_SECRET` (see `deploy/k8s/secret.example.sh`). `mc` is copied onto the PVC from the
running MinIO pod (`minio/mc` and Quay's MinIO images are no longer publicly pullable). An Ingress with
a cert-manager `Issuer` gives HTTPS; an optional MetalLB `LoadBalancer` gives a plain-HTTP LAN address
(`trustProxy` is a CIDR list so LAN clients can't spoof `X-Forwarded-For`).

In the cluster the app works on its own copies of the sites, so **GitHub is the hand-off point**
between machines: back up where you last edited, "Pull latest" on the other side.

A `Dockerfile` is included too if you'd rather build an image (`docker buildx build --platform linux/arm64 …`).

## Security notes

Anyone who logs in can change and publish your sites, so: a long password (scrypt-hashed, ≥10 chars
enforced), HttpOnly + SameSite=Strict session cookie (+ `Secure` behind TLS), every mutating request
must carry an `X-HSM` header (blocks cross-site form posts), 10 failed logins per 15 min per IP, writes
confined to the editable folders, path traversal and symlink escapes rejected, uploads never
overwrite, deleted files go to `trash/`. Commands run without a shell (except `deploy.type: command`,
which is yours). Secrets like `GITHUB_TOKEN` are redacted from job logs. Preview pages run your theme's
JavaScript on the app's origin — fine for your own theme, but don't point the app at untrusted sites.

## Tests

```sh
npm test   # ~60 tests; copies ~/pradeepr.cloud to a temp dir — nothing touches a real site, bucket or repo
```

- API end to end through an in-process harness (no sockets needed): auth/CSRF, path traversal, editing,
  preview, publish link fix-up, git backup to a temp bare repo, Hugo upgrades against a stubbed GitHub.
- The editor: highlighting round-trips every real file character for character; math-assist keystrokes
  are driven against a fake textarea (`test/mathkeys.test.js`); KaTeX renders every equation in the posts.
- `node test/tools/fidelity.mjs <site>` compares the live-preview renderer with Hugo's own output for
  every post (also run by `npm test`).
