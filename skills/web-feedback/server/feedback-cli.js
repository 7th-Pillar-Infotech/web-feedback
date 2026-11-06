#!/usr/bin/env node
'use strict';

/**
 * feedback-cli — the interface Claude uses to work through feedback.
 *
 * Two backends, same commands:
 *   local  (default)  talks straight to the SQLite DB — works whether or not the
 *                     collector process is running.
 *   remote            talks HTTP to a hosted collector (VPS or Cloudflare Worker).
 *                     Enabled by FEEDBACK_SERVER=https://… (or --server URL).
 *                     Auth with FEEDBACK_TOKEN=… (or --token …) when the
 *                     collector requires one.
 *
 * Commands:
 *   list [--status open|resolved|all] [--project NAME]   list feedback (default: open)
 *   show <id>                                            full detail for one item (+ screenshot path)
 *   next [--project NAME]                                the oldest open item, as JSON
 *   resolve <id> [note...]                               mark an item resolved
 *   reopen <id>                                          move a resolved item back to open
 *   edit <id> <new text...>                              replace an item's feedback text
 *   delete <id>                                          permanently remove an item (+ its screenshot)
 *   clear [--project NAME] [--status ...] --yes          bulk-delete items (guarded by --yes)
 *   stats [--project NAME]                               counts of open/resolved
 *
 * Screenshot paths are absolute so Claude can Read them directly. In remote mode
 * screenshots are downloaded to a local cache first, so `screenshot_abs` is
 * always a real file on disk.
 */

const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const cmd = argv[0];

function flag(name, def) {
  const i = argv.indexOf('--' + name);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : def;
}

const SERVER = (flag('server', process.env.FEEDBACK_SERVER || '') || '').replace(/\/+$/, '');
const TOKEN = flag('token', process.env.FEEDBACK_TOKEN || '');
const REMOTE = Boolean(SERVER);

function parseJson(s) {
  if (!s || typeof s !== 'string') return s || null;
  try { return JSON.parse(s); } catch { return s; }
}

function out(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

function die(msg) {
  process.stderr.write(msg + '\n');
  process.exit(1);
}

function fmtRow(r) {
  const mark = r.status === 'resolved' ? '✓' : '○';
  const where = r.selector ? ` @ ${r.selector}` : '';
  return `${mark} #${r.number} [id ${r.id}] ${String(r.text).replace(/\s+/g, ' ').slice(0, 80)}${where}`;
}

// ---------------------------------------------------------------------------
// Backends. Both expose the same async surface so the commands below don't care
// where the feedback actually lives.
// ---------------------------------------------------------------------------

function localStore() {
  const { db, SHOTS_DIR } = require('./db');

  const shotPath = (row) =>
    row.screenshot ? path.join(SHOTS_DIR, path.basename(row.screenshot)) : null;

  const where = (project, status) => {
    const clauses = [];
    const params = [];
    if (status && status !== 'all') { clauses.push('status = ?'); params.push(status); }
    if (project) { clauses.push('project = ?'); params.push(project); }
    return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
  };

  return {
    label: 'local SQLite',
    async list(project, status) {
      const w = where(project, status);
      return db.prepare(`SELECT * FROM feedback ${w.sql} ORDER BY number ASC`).all(...w.params);
    },
    async get(id) {
      return db.prepare('SELECT * FROM feedback WHERE id = ?').get(id) || null;
    },
    async setStatus(id, resolve, note) {
      if (resolve) {
        db.prepare("UPDATE feedback SET status='resolved', resolved_at=?, resolution_note=? WHERE id=?")
          .run(new Date().toISOString(), note || null, id);
      } else {
        db.prepare("UPDATE feedback SET status='open', resolved_at=NULL, resolution_note=NULL WHERE id=?")
          .run(id);
      }
    },
    async edit(id, text) {
      db.prepare('UPDATE feedback SET text = ? WHERE id = ?').run(text.slice(0, 5000), id);
    },
    async remove(row) {
      if (row.screenshot) { try { fs.unlinkSync(shotPath(row)); } catch { /* already gone */ } }
      db.prepare('DELETE FROM feedback WHERE id = ?').run(row.id);
    },
    // Screenshots are already local files.
    async localShot(row) {
      return shotPath(row);
    },
  };
}

function remoteStore() {
  // Cache remote screenshots next to the local ones so Claude can Read them.
  const CACHE = path.join(__dirname, 'screenshots', 'remote');

  async function call(pathname, opts = {}) {
    const headers = Object.assign({}, opts.headers);
    if (TOKEN) headers['X-Feedback-Token'] = TOKEN;
    const res = await fetch(SERVER + pathname, { ...opts, headers });
    if (res.status === 401) die(`401 unauthorized from ${SERVER} — set FEEDBACK_TOKEN (or --token).`);
    if (!res.ok) die(`HTTP ${res.status} from ${SERVER}${pathname}`);
    return res;
  }

  return {
    label: `remote ${SERVER}`,
    async list(project, status) {
      const q = new URLSearchParams({ limit: '1000' });
      if (project) q.set('project', project);
      if (status && status !== 'all') q.set('status', status);
      const data = await (await call('/feedback?' + q)).json();
      return (data.feedback || []).sort((a, b) => (a.number || 0) - (b.number || 0));
    },
    async get(id) {
      const res = await fetch(SERVER + '/feedback/' + id, {
        headers: TOKEN ? { 'X-Feedback-Token': TOKEN } : {},
      });
      if (res.status === 404) return null;
      if (!res.ok) die(`HTTP ${res.status} fetching item ${id}`);
      return res.json();
    },
    async setStatus(id, resolve, note) {
      await call(`/feedback/${id}/${resolve ? 'resolve' : 'reopen'}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: note || null }),
      });
    },
    async edit(id, text) {
      await call('/feedback/' + id, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
    },
    async remove(row) {
      await call('/feedback/' + row.id, { method: 'DELETE' });
    },
    // Download the PNG once so `screenshot_abs` points at a real local file.
    async localShot(row) {
      if (!row.screenshot) return null;
      fs.mkdirSync(CACHE, { recursive: true });
      const file = path.join(CACHE, path.basename(row.screenshot));
      if (!fs.existsSync(file)) {
        const res = await fetch(SERVER + '/' + String(row.screenshot).replace(/^\/+/, ''), {
          headers: TOKEN ? { 'X-Feedback-Token': TOKEN } : {},
        });
        if (!res.ok) return null;
        fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
      }
      return file;
    },
  };
}

const store = REMOTE ? remoteStore() : localStore();

async function detail(r) {
  return {
    ...r,
    screenshot_abs: await store.localShot(r),
    console_logs: parseJson(r.console_logs),
    network_logs: parseJson(r.network_logs),
  };
}

async function main() {
  switch (cmd) {
    case 'list': {
      const status = flag('status', 'open');
      const project = flag('project', null);
      const rows = await store.list(project, status);
      if (!rows.length) { process.stdout.write(`No ${status} feedback.\n`); break; }
      for (const r of rows) {
        process.stdout.write(fmtRow(r) + '\n');
        process.stdout.write(`    url: ${r.url}\n`);
        if (r.screenshot) process.stdout.write(`    shot: ${await store.localShot(r)}\n`);
        else if (r.capture_error) process.stdout.write(`    ⚠ no screenshot: ${r.capture_error}\n`);
        const nlogs = parseJson(r.network_logs);
        const clogs = parseJson(r.console_logs);
        const errs = Array.isArray(clogs) ? clogs.filter((l) => l.level === 'error').length : 0;
        const bits = [];
        if (Array.isArray(clogs)) bits.push(`${clogs.length} console${errs ? ` (${errs} err)` : ''}`);
        if (Array.isArray(nlogs)) bits.push(`${nlogs.length} network`);
        if (bits.length) process.stdout.write(`    debug: ${bits.join(', ')} — see \`show ${r.id}\`\n`);
      }
      break;
    }

    case 'show': {
      const id = parseInt(argv[1], 10);
      const r = await store.get(id);
      if (!r) die('not found');
      // Expand the stored JSON log columns so Claude sees them structured, not
      // as an escaped string blob.
      out(await detail(r));
      break;
    }

    case 'next': {
      const project = flag('project', null);
      const rows = await store.list(project, 'open');
      if (!rows.length) { process.stdout.write('No open feedback.\n'); break; }
      out(await detail(rows[0]));
      break;
    }

    case 'resolve': {
      const id = parseInt(argv[1], 10);
      const note = argv.slice(2).filter((a) => !a.startsWith('--')).join(' ') || null;
      const r = await store.get(id);
      if (!r) die('not found');
      await store.setStatus(id, true, note);
      process.stdout.write(`Resolved #${r.number} (id ${id})${note ? ': ' + note : ''}\n`);
      break;
    }

    case 'reopen': {
      const id = parseInt(argv[1], 10);
      const r = await store.get(id);
      if (!r) die('not found');
      await store.setStatus(id, false);
      process.stdout.write(`Reopened #${r.number} (id ${id})\n`);
      break;
    }

    case 'edit': {
      const id = parseInt(argv[1], 10);
      const text = argv.slice(2).join(' ').trim();
      const r = await store.get(id);
      if (!r) die('not found');
      if (!text) die('usage: edit <id> <new text...>');
      await store.edit(id, text);
      process.stdout.write(`Edited #${r.number} (id ${id})\n  was: ${r.text}\n  now: ${text}\n`);
      break;
    }

    case 'delete': {
      const id = parseInt(argv[1], 10);
      const r = await store.get(id);
      if (!r) die('not found');
      await store.remove(r);
      process.stdout.write(`Deleted #${r.number} (id ${id}): ${String(r.text).replace(/\s+/g, ' ').slice(0, 80)}\n`);
      break;
    }

    case 'clear': {
      // Bulk delete — requires --yes so it can't fire by accident.
      if (!argv.includes('--yes')) die('refusing to bulk-delete without --yes');
      const project = flag('project', null);
      const status = flag('status', null);
      const rows = await store.list(project, status);
      for (const r of rows) await store.remove(r);
      process.stdout.write(
        `Deleted ${rows.length} item(s)${project ? ` for project ${project}` : ''}` +
          `${status && status !== 'all' ? ` (status ${status})` : ''}.\n`
      );
      break;
    }

    case 'stats': {
      const project = flag('project', null);
      const rows = await store.list(project, 'all');
      const stats = { open: 0, resolved: 0 };
      for (const r of rows) stats[r.status] = (stats[r.status] || 0) + 1;
      out({ ...stats, source: store.label });
      break;
    }

    default:
      process.stdout.write(
        `feedback-cli commands:
  list [--status open|resolved|all] [--project NAME]
  show <id>
  next [--project NAME]
  resolve <id> [note...]
  reopen <id>
  edit <id> <new text...>
  delete <id>
  clear [--project NAME] [--status open|resolved] --yes
  stats [--project NAME]

Backend: ${store.label}
  Remote:  FEEDBACK_SERVER=https://feedback.example.com (or --server URL)
           FEEDBACK_TOKEN=…                            (or --token …)
`
      );
  }
}

main().catch((err) => die(String((err && err.stack) || err)));
