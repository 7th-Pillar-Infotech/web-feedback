# Deploying the collector

The widget always talks to **one collector**. Where that collector runs decides who
can leave feedback:

| Target | Who can leave feedback | Data lives | Use when |
|---|---|---|---|
| **Local** (default) | only you, on your machine | `server/feedback.db` + `server/screenshots/` | you're the one testing, app runs on localhost |
| **VPS** | anyone who can load the app | the droplet's disk | testers/clients use a deployed UAT site; you already have a server |
| **Cloudflare Worker** | anyone who can load the app | D1 (rows) + R2 (screenshots) | you want no server to babysit |

Whichever you pick, the widget is configured entirely from its `<script>` tag —
the collector base URL is derived from where the widget itself was loaded from:

```html
<script src="https://feedback.example.com/feedback-widget.js?project=admin-app&token=SECRET" defer></script>
```

Query params: `project` (grouping key), `token` (shared secret, if the collector
requires one), `server` (only if the API lives somewhere other than where the
widget is served from).

---

## 1. Local

```bash
bash "$SKILL_DIR/server/ensure-running.sh"
```

Listens on `http://localhost:4765`. Env overrides: `PORT`, `HOST` (use
`HOST=127.0.0.1` to keep it off your LAN), `FEEDBACK_DB`, `FEEDBACK_DIR`.

No token needed — nothing outside your machine can reach it.

---

## 2. VPS (systemd + nginx + TLS)

The collector is plain Node + SQLite; it needs ~50MB of RAM and no build step.

**Copy the skill to the server** (only `server/` and `widget/` matter):

```bash
rsync -av --exclude node_modules --exclude 'feedback.db*' --exclude screenshots \
  "$SKILL_DIR/" root@YOUR_HOST:/opt/web-feedback/
ssh root@YOUR_HOST 'cd /opt/web-feedback/server && npm install --omit=dev'
```

**Pick a token** (this is what stops the internet writing to your DB):

```bash
openssl rand -hex 24    # keep the output
```

**Create the service** — `/etc/systemd/system/web-feedback.service`:

```ini
[Unit]
Description=web-feedback collector
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/web-feedback/server
ExecStart=/usr/bin/node /opt/web-feedback/server/feedback-server.js
Environment=PORT=4765
Environment=HOST=127.0.0.1
Environment=FEEDBACK_TOKEN=PASTE_THE_TOKEN
Environment=FEEDBACK_DB=/var/lib/web-feedback/feedback.db
Environment=FEEDBACK_DIR=/var/lib/web-feedback/screenshots
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

```bash
mkdir -p /var/lib/web-feedback
systemctl daemon-reload && systemctl enable --now web-feedback
systemctl status web-feedback --no-pager
```

`HOST=127.0.0.1` keeps the port private; nginx is the only way in.

**nginx** — `/etc/nginx/sites-available/feedback`:

```nginx
server {
    server_name feedback.example.com;
    # Screenshots are full-page PNGs; the default 1MB body limit is far too small.
    client_max_body_size 30M;

    location / {
        proxy_pass http://127.0.0.1:4765;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
ln -s /etc/nginx/sites-available/feedback /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
certbot --nginx -d feedback.example.com      # TLS — required, the widget runs on https pages
```

**Verify:**

```bash
curl https://feedback.example.com/health
curl -s https://feedback.example.com/feedback -H 'X-Feedback-Token: THE_TOKEN' | head
```

TLS matters beyond hygiene: a widget on an `https://` page cannot POST to an
`http://` collector — the browser blocks it as mixed content.

---

## 3. Cloudflare Worker (D1 + R2)

```bash
cd "$SKILL_DIR/server-cf"
npm install

npx wrangler d1 create web-feedback          # paste database_id into wrangler.toml
npx wrangler r2 bucket create web-feedback-shots
npm run migrate                              # creates the feedback table on D1

npx wrangler secret put FEEDBACK_TOKEN       # paste `openssl rand -hex 24`
npm run deploy                               # runs build.mjs, then wrangler deploy
```

`build.mjs` bakes the widget and the snapdom capture engine into the Worker (a
Worker has no filesystem), so **re-run `npm run deploy` after every widget change**.

You get `https://web-feedback-collector.<subdomain>.workers.dev` — or attach a
custom domain in the Cloudflare dashboard (Workers → your worker → Domains).

**R2 is recommended, not required.** Without the bucket bound, screenshots under
~700kB are stored inline in D1 and larger ones are dropped with an explanatory
`capture_error` — full-page captures of a real app routinely exceed that, so bind
R2 unless you're only smoke-testing.

**Verify:**

```bash
curl https://YOUR_WORKER_URL/health
# → {"ok":true,"total":0,"storage":"r2"}
```

---

## Pointing Claude's CLI at a hosted collector

The CLI defaults to the local SQLite file. For a remote collector, set two env
vars (or pass `--server` / `--token`):

```bash
export FEEDBACK_SERVER=https://feedback.example.com
export FEEDBACK_TOKEN=THE_TOKEN

node "$SKILL_DIR/server/feedback-cli.js" list --status open
node "$SKILL_DIR/server/feedback-cli.js" show 12       # downloads the PNG locally to Read
node "$SKILL_DIR/server/feedback-cli.js" resolve 12 "Fixed the contrast"
```

Remote `show`/`list` cache screenshots under `server/screenshots/remote/`, so
`screenshot_abs` is always a real path you can Read.

---

## Security notes worth saying out loud

- The token lives in the page source of any app that embeds the widget. It stops
  drive-by writes and scanners; it is **not** a secret from your testers. Don't
  put a collector holding sensitive screenshots on a public URL without one.
- Screenshots capture whatever was on screen — customer data, tokens in the UI,
  internal dashboards. A hosted collector means those PNGs sit on that host.
  Prefer a private/staging-only deployment, and `clear` old feedback when a
  round of testing is done.
- The collector sends `Access-Control-Allow-Origin: *` so any app origin can post
  to it. That's deliberate (you decide who embeds the widget), and the token is
  what actually gates writes.
