---
name: web-feedback
description: >-
  Visual feedback loop for any Claude-generated website or web app. Use when the
  user wants to leave in-browser feedback (Shift+click to comment on a spot),
  when starting or running ANY web-based project in development, or when the user
  asks to "check feedback", "work on the feedback", "resolve feedback", or mentions
  the feedback widget/collector. Every web project should embed the dev-only
  widget; Claude fetches pending feedback (with screenshots), fixes each item, and
  marks it resolved.
---

# Web Feedback

A drop-in feedback loop between a running web app and Claude.

**In the browser:** the user holds **Shift** and clicks any spot on the page, types
a comment, and submits. The widget screenshots the page, draws a numbered pin at the
click point, and sends everything to a local collector.

**On disk:** the collector writes a row to a **SQLite** table (`feedback`) — text,
page URL, project, click coordinates, CSS selector of the clicked element, the
path to the annotated screenshot PNG, and a **debug snapshot** (recent console
logs + network requests captured live when the note was left). A live counter badge
sits in the corner — **collapsed to a small chip** (just 💬 and the open count) so it
barely intrudes on the page, expanding on hover (or tap, for touch) to reveal the hint
and its controls, and draggable so it never blocks app buttons. Expanded it reads
`N open · M total`. Numbered pins
are **per-URL**: each pin shows only on the page it was left on, and is re-rendered
on reload and on SPA (client-side) navigation.
**Clicking a pin** reopens that feedback to **edit, resolve/reopen, or delete** it
directly in the browser.

**Resolved items stay where they were left, in green.** A resolved pin is *not*
removed — it turns green (open pins are red) and keeps its position so a human can
verify the fix in place before the item is really retired. Clicking a green pin
offers **Reopen** if the fix didn't land. This is deliberate: resolving is a
"ready for verification" signal, not an erasure.

**The badge has two controls** (visible once it's expanded):
- **👁 / 🙈 — hide/show markers.** Pins can cover the very UI you want to look at,
  so visibility is a one-click toggle, remembered across reloads (localStorage).
  Being taken to a pin from the panel un-hides them automatically.
- **☰ — the issues panel.** A right-hand side panel listing **every** item for the
  project, filterable by **Open / Resolved / All** and grouped by the page it was
  left on (the current page first, marked "● This page"). Each row shows the number,
  the text (struck through when resolved), how long ago it was left, the resolution
  note, and a one-click ✓ resolve / ↺ reopen button. **Clicking a row takes you to
  the issue**: same page → scrolls to the pin and flashes it; another page →
  navigates there and flashes the pin on arrival. The panel stays open across those
  jumps so a list can be worked through end to end.

**Screenshots are robust by default.** The widget captures with **snapdom**, served
by the collector (`/vendor/snapdom.js`) — it renders through the browser's own engine,
so modern CSS color functions (`oklch()`/`oklab()`/`lab()`/`color()` — Tailwind v4
emits these everywhere) just work. This replaced html2canvas, which throws on `oklch()`
and cannot be reliably worked around; html2canvas (`/vendor/html2canvas.js`, then the
CDN) remains only as a fallback. Serving the engine from the collector also means a
strict app Content-Security-Policy that blocks CDNs no longer breaks capture. The
numbered pin is drawn at the exact click point (accounting for devicePixelRatio), and
the widget's own UI is excluded from the shot. If capture ever fails it is **never
silent**: the feedback still saves and a `capture_error` reason is stored and logged.

**Console + network capture (for debugging).** From page load the widget keeps two
ring buffers — console output (`log`/`info`/`warn`/`error`/`debug`, plus uncaught
errors and unhandled promise rejections) and network requests (`fetch` + `XMLHttpRequest`,
with method, URL, status, duration, and errors). A recent slice of each is attached to
every submission, so Claude can debug with the exact console errors and failing
requests that were live when the user flagged the issue. The widget's own traffic to
the collector is excluded.

The comment box and pin dialogs render as native `<dialog>`s in the browser top layer
and isolate their own events, so they work correctly over app modals and sidebars —
focus is kept, and Submit/Save stays clickable even when the app disables the page with
`body { pointer-events: none }` while its modal is open (the Radix/Vaul/Headless UI
pattern), which would otherwise make the widget's own buttons dead.

**In Claude:** you fetch open feedback, Read each screenshot, fix the issue, and mark
it **resolved** in the same table.

Files (this skill directory):
- `server/ensure-running.sh` — idempotent auto-start (installs deps + starts collector); run this first
- `server/feedback-server.js` — collector on `http://localhost:4765` (also serves the widget)
- `server/feedback-cli.js` — the CLI you use to list / show / resolve feedback (local **or** remote)
- `server/db.js` — shared SQLite schema (table `feedback`)
- `server-cf/` — the same collector as a Cloudflare Worker (D1 + R2)
- `widget/feedback-widget.js` — the browser widget
- `DEPLOY.md` — hosting the collector: local, VPS (systemd + nginx), or Cloudflare

`SKILL_DIR` below = the directory containing this file.

---

## Setting the skill up on a project: ask where the collector runs

The **first** time you wire this skill into a project, ask the user where the
collector should live — it decides who can leave feedback, and you can't infer it
from the code:

| Answer | What it means | Setup |
|---|---|---|
| **Local** (default) | only the user, on their own machine, app on localhost | `bash "$SKILL_DIR/server/ensure-running.sh"` |
| **VPS** | testers/clients on a deployed (UAT/staging) site | `DEPLOY.md` § VPS — systemd + nginx + certbot, `FEEDBACK_TOKEN` |
| **Cloudflare Worker** | same, with no server to maintain | `DEPLOY.md` § Cloudflare — D1 + R2, `wrangler deploy` |

Then **give them the deployment steps** from `DEPLOY.md` for the target they chose
(and run the parts you can). If they just want to try it, default to Local and say
that moving to a hosted collector later is only a URL change in the embed.

For anything other than Local, also:
- generate a token (`openssl rand -hex 24`) and set it on the collector — a public
  collector without one is writable by anyone who finds it;
- point the CLI at it with `FEEDBACK_SERVER` / `FEEDBACK_TOKEN` (see below);
- tell the user the screenshots now live on that host, not their laptop.

---

## Rule: every web project embeds the widget in development, never in production

Whenever you scaffold, run, or preview **any** web-based project (plain HTML, Vite,
Next.js, Astro, SvelteKit, CRA, etc.), embed the feedback widget **in the development
build only** and ensure it is **absent from production builds**. The widget must never
ship to end users.

The exception is a **deliberate UAT/staging deployment with a hosted collector** —
that's the point of the VPS/Cloudflare targets. Gate that on an explicit env var
(e.g. `NEXT_PUBLIC_FEEDBACK_SERVER`) that is set for the UAT environment and unset
in production, so real production builds still render nothing.

The widget is served by the collector, so embedding is a single tag pointed at
`<collector>/feedback-widget.js`. Gate it behind a dev-only condition:

**Plain HTML (dev file only):**
```html
<!-- DEV ONLY — feedback widget. Do not include in production. -->
<script src="http://localhost:4765/feedback-widget.js" defer></script>
```

**Vite / any `import.meta.env`:**
```js
if (import.meta.env.DEV) {
  const s = document.createElement('script');
  s.src = 'http://localhost:4765/feedback-widget.js';
  s.defer = true;
  document.head.appendChild(s);
}
```

**Next.js** (`app/layout.tsx` or `_document`):
```tsx
{process.env.NODE_ENV !== 'production' && (
  <script src="http://localhost:4765/feedback-widget.js" defer />
)}
```

**Generic guard for any bundler:** only inject when `NODE_ENV !== 'production'`.

### Configuring the widget from its own script tag

Everything can ride on the `<script src>` query string, which is all a hosted
collector needs — no inline config block:

```html
<script src="https://feedback.example.com/feedback-widget.js?project=admin-app&token=SECRET" defer></script>
```

| Param | Meaning |
|---|---|
| `project` | grouping key for the `project` column (defaults to `location.host`) |
| `token` | shared secret, sent as `X-Feedback-Token`; required if the collector has `FEEDBACK_TOKEN` set |
| `server` | API base URL — only needed if the API isn't where the widget was served from |

The collector base URL is otherwise **derived from the widget's own `src`**, so
pointing an app at a different collector is a one-line change. The inline form
still works and takes precedence:

```html
<script>window.FEEDBACK_CONFIG = { project: 'my-app', server: 'https://feedback.example.com', token: 'SECRET' };</script>
```

For a hosted collector, drive the URL from an env var so the same code is dev-safe
and UAT-capable — e.g. in Next.js:

```tsx
const feedbackServer =
  process.env.NEXT_PUBLIC_FEEDBACK_SERVER ||
  (process.env.NODE_ENV !== "production" ? "http://localhost:4765" : "");
...
{feedbackServer && (
  <script src={`${feedbackServer}/feedback-widget.js?project=my-app`} defer />
)}
```

When preparing a production build, confirm the widget tag/injection is stripped or
guarded. Never leave an unconditional widget `<script>` in shipped code.

---

## Start the collector (automatic)

Whenever this skill is used, **first run the auto-start script**. It is idempotent:
it installs the dependency on first run, does nothing if the collector is already
healthy, and otherwise starts it detached so it keeps collecting after the turn ends.

```bash
bash "$SKILL_DIR/server/ensure-running.sh"
```

That is the only startup step — do not start `feedback-server.js` by hand. The
collector listens on `http://localhost:4765`, serves the widget at
`/feedback-widget.js`, stores screenshots under `server/screenshots/`, and logs to
`server/collector.log`. Override the port with `PORT=... bash …/ensure-running.sh`.

Env vars the collector understands: `PORT`, `HOST` (bind address — `127.0.0.1` to
keep it off the network), `FEEDBACK_TOKEN` (require a shared secret on every data
route), `FEEDBACK_DB`, `FEEDBACK_DIR`.

**If the project uses a hosted collector, skip this** — nothing to start locally.
Point the CLI at it instead:

```bash
export FEEDBACK_SERVER=https://feedback.example.com
export FEEDBACK_TOKEN=THE_TOKEN
```

Then make sure the running app embeds the widget (see the rule above) and tell the
user: **hold Shift and click anywhere on the page to leave feedback.**

---

## Working through feedback (the resolve loop)

Use the CLI (`node "$SKILL_DIR/server/feedback-cli.js" …`). By default it reads/writes
the local SQLite DB directly, so it works even if the server process is stopped. Set
`FEEDBACK_SERVER` (+ `FEEDBACK_TOKEN`), or pass `--server` / `--token`, and the same
commands run against a hosted collector over HTTP — remote screenshots are downloaded
to `server/screenshots/remote/` so `screenshot_abs` is still a file you can Read.

1. **List what's open** (optionally scope to one project):
   ```bash
   node "$SKILL_DIR/server/feedback-cli.js" list --status open
   # node "$SKILL_DIR/server/feedback-cli.js" list --status open --project my-app
   ```

2. **Open one item in full** — gives you the text, the exact page URL, the CSS
   `selector` of the element, click coordinates, `screenshot_abs`, and the debug
   snapshot (`console_logs`, `network_logs`, and `capture_error` if the screenshot
   failed):
   ```bash
   node "$SKILL_DIR/server/feedback-cli.js" show <id>
   ```
   **Read the `screenshot_abs` PNG** with the Read tool — the numbered pin marks
   exactly where the user clicked. Combine the screenshot, the selector, and the URL
   to locate the relevant code and make the fix. Check `console_logs` for errors and
   `network_logs` for failed/slow requests (e.g. a `500` on `/api/...`) — these often
   pinpoint the bug directly. If `screenshot` is null, `capture_error` explains why.

3. **Fix the issue** in the codebase.

4. **Mark it resolved**, with a short note on what you changed:
   ```bash
   node "$SKILL_DIR/server/feedback-cli.js" resolve <id> "Fixed contrast on the hero CTA"
   ```

5. Repeat for each open item. `stats` shows remaining counts; `reopen <id>` undoes a
   resolve if the fix didn't land.

Work items in order (`list` is sorted by feedback number). Resolve an item **only
after** the fix is actually in place — resolving is the signal that the feedback is
handled. The pin stays on the page in **green** after you resolve it, so the user can
verify your fix at the exact spot it was reported and `reopen` it if it isn't right.

## Editing and deleting feedback

- **Edit** an item's text (e.g. to clarify or correct a note):
  ```bash
  node "$SKILL_DIR/server/feedback-cli.js" edit <id> "New feedback text"
  ```
- **Delete** a single item permanently (also removes its screenshot file):
  ```bash
  node "$SKILL_DIR/server/feedback-cli.js" delete <id>
  ```
- **Bulk-clear** — `--yes` is required so it can't fire by accident. Optionally scope
  by `--project` and/or `--status`:
  ```bash
  node "$SKILL_DIR/server/feedback-cli.js" clear --project my-app --status resolved --yes
  node "$SKILL_DIR/server/feedback-cli.js" clear --yes   # wipe everything
  ```

Delete is permanent — prefer `resolve` for handled items so the history stays intact,
and reserve `delete`/`clear` for genuine junk or a fresh start. Confirm with the user
before a bulk `clear`.

## HTTP alternative

If you'd rather use HTTP than the CLI, the collector exposes:
`GET /feedback?status=open`, `GET /feedback/:id`,
`POST /feedback/:id/resolve` (body `{"note":"…"}`), `POST /feedback/:id/reopen`,
`PATCH /feedback/:id` (body `{"text":"…"}`, edit), `DELETE /feedback/:id`,
`GET /screenshots/<file>`, `GET /vendor/snapdom.js` & `GET /vendor/html2canvas.js`
(bundled capture engines), `GET /health`.
