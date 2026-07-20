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
(draggable, so it never blocks app buttons) shows the running count. Numbered pins
are **per-URL**: each pin shows only on the page it was left on, is re-rendered on
reload and on SPA (client-side) navigation, and disappears once the item is resolved.
**Clicking a pin** reopens that feedback to **edit, resolve, or delete** it directly
in the browser.

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
- `server/feedback-cli.js` — the CLI you use to list / show / resolve feedback
- `server/db.js` — shared SQLite schema (table `feedback`)
- `widget/feedback-widget.js` — the browser widget

`SKILL_DIR` below = the directory containing this file.

---

## Rule: every web project embeds the widget in development, never in production

Whenever you scaffold, run, or preview **any** web-based project (plain HTML, Vite,
Next.js, Astro, SvelteKit, CRA, etc.), embed the feedback widget **in the development
build only** and ensure it is **absent from production builds**. The widget must never
ship to end users.

The widget is served by the collector, so embedding is a single tag pointed at
`http://localhost:4765/feedback-widget.js`. Gate it behind a dev-only condition:

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

Optional per-project grouping — set before the script loads so feedback is filtered
by a stable name instead of the host:
```html
<script>window.FEEDBACK_CONFIG = { project: 'my-app' };</script>
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
`/feedback-widget.js`, and keeps its database, screenshots, and log in a persistent
per-user directory (`~/.web-feedback/` by default) so feedback survives updates.
Override the port with `PORT=... bash …/ensure-running.sh`; relocate the data dir
with `FEEDBACK_HOME=/some/path` (or `FEEDBACK_DB` / `FEEDBACK_DIR` individually).

Then make sure the running app embeds the widget (see the rule above) and tell the
user: **hold Shift and click anywhere on the page to leave feedback.**

---

## Working through feedback (the resolve loop)

Use the CLI (`node "$SKILL_DIR/server/feedback-cli.js" …`). It reads/writes the SQLite
DB directly, so it works even if the server process is stopped.

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
handled.

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
