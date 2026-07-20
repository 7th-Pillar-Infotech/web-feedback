#!/usr/bin/env node
'use strict';

/**
 * feedback-cli — the interface Claude uses to work through feedback.
 * Talks directly to the SQLite DB (works whether or not the server is running).
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
 * Screenshot paths are absolute so Claude can Read them directly.
 */

const fs = require('fs');
const path = require('path');
const { db, SHOTS_DIR } = require('./db');

const argv = process.argv.slice(2);
const cmd = argv[0];

function flag(name, def) {
  const i = argv.indexOf('--' + name);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : def;
}

function shotPath(row) {
  return row.screenshot ? path.join(SHOTS_DIR, path.basename(row.screenshot)) : null;
}

function parseJson(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return s; }
}

function out(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

function fmtRow(r) {
  const mark = r.status === 'resolved' ? '✓' : '○';
  const where = r.selector ? ` @ ${r.selector}` : '';
  return `${mark} #${r.number} [id ${r.id}] ${r.text.replace(/\s+/g, ' ').slice(0, 80)}${where}`;
}

switch (cmd) {
  case 'list': {
    const status = flag('status', 'open');
    const project = flag('project', null);
    const clauses = [];
    const params = [];
    if (status !== 'all') { clauses.push('status = ?'); params.push(status); }
    if (project) { clauses.push('project = ?'); params.push(project); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = db.prepare(`SELECT * FROM feedback ${where} ORDER BY number ASC`).all(...params);
    if (!rows.length) { process.stdout.write(`No ${status} feedback.\n`); break; }
    for (const r of rows) {
      process.stdout.write(fmtRow(r) + '\n');
      process.stdout.write(`    url: ${r.url}\n`);
      if (r.screenshot) process.stdout.write(`    shot: ${shotPath(r)}\n`);
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
    const r = db.prepare('SELECT * FROM feedback WHERE id = ?').get(id);
    if (!r) { process.stderr.write('not found\n'); process.exit(1); }
    // Expand the stored JSON log columns so Claude sees them structured, not as
    // an escaped string blob.
    out({
      ...r,
      screenshot_abs: shotPath(r),
      console_logs: parseJson(r.console_logs),
      network_logs: parseJson(r.network_logs),
    });
    break;
  }

  case 'next': {
    const project = flag('project', null);
    const where = project ? "WHERE status='open' AND project=?" : "WHERE status='open'";
    const r = db
      .prepare(`SELECT * FROM feedback ${where} ORDER BY number ASC LIMIT 1`)
      .get(...(project ? [project] : []));
    if (!r) { process.stdout.write('No open feedback.\n'); break; }
    out({
      ...r,
      screenshot_abs: shotPath(r),
      console_logs: parseJson(r.console_logs),
      network_logs: parseJson(r.network_logs),
    });
    break;
  }

  case 'resolve': {
    const id = parseInt(argv[1], 10);
    const note = argv.slice(2).join(' ') || null;
    const r = db.prepare('SELECT * FROM feedback WHERE id = ?').get(id);
    if (!r) { process.stderr.write('not found\n'); process.exit(1); }
    db.prepare("UPDATE feedback SET status='resolved', resolved_at=?, resolution_note=? WHERE id=?")
      .run(new Date().toISOString(), note, id);
    process.stdout.write(`Resolved #${r.number} (id ${id})${note ? ': ' + note : ''}\n`);
    break;
  }

  case 'reopen': {
    const id = parseInt(argv[1], 10);
    const r = db.prepare('SELECT * FROM feedback WHERE id = ?').get(id);
    if (!r) { process.stderr.write('not found\n'); process.exit(1); }
    db.prepare("UPDATE feedback SET status='open', resolved_at=NULL, resolution_note=NULL WHERE id=?").run(id);
    process.stdout.write(`Reopened #${r.number} (id ${id})\n`);
    break;
  }

  case 'edit': {
    const id = parseInt(argv[1], 10);
    const text = argv.slice(2).join(' ').trim();
    const r = db.prepare('SELECT * FROM feedback WHERE id = ?').get(id);
    if (!r) { process.stderr.write('not found\n'); process.exit(1); }
    if (!text) { process.stderr.write('usage: edit <id> <new text...>\n'); process.exit(1); }
    db.prepare('UPDATE feedback SET text = ? WHERE id = ?').run(text.slice(0, 5000), id);
    process.stdout.write(`Edited #${r.number} (id ${id})\n  was: ${r.text}\n  now: ${text}\n`);
    break;
  }

  case 'delete': {
    const id = parseInt(argv[1], 10);
    const r = db.prepare('SELECT * FROM feedback WHERE id = ?').get(id);
    if (!r) { process.stderr.write('not found\n'); process.exit(1); }
    if (r.screenshot) { try { fs.unlinkSync(shotPath(r)); } catch { /* already gone */ } }
    db.prepare('DELETE FROM feedback WHERE id = ?').run(id);
    process.stdout.write(`Deleted #${r.number} (id ${id}): ${r.text.replace(/\s+/g, ' ').slice(0, 80)}\n`);
    break;
  }

  case 'clear': {
    // Bulk delete — requires --yes so it can't fire by accident.
    if (!argv.includes('--yes')) {
      process.stderr.write('refusing to bulk-delete without --yes\n');
      process.exit(1);
    }
    const project = flag('project', null);
    const status = flag('status', null);
    const clauses = [];
    const params = [];
    if (project) { clauses.push('project = ?'); params.push(project); }
    if (status && status !== 'all') { clauses.push('status = ?'); params.push(status); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = db.prepare(`SELECT * FROM feedback ${where}`).all(...params);
    for (const r of rows) {
      if (r.screenshot) { try { fs.unlinkSync(shotPath(r)); } catch { /* already gone */ } }
    }
    const info = db.prepare(`DELETE FROM feedback ${where}`).run(...params);
    process.stdout.write(`Deleted ${info.changes} item(s)${project ? ` for project ${project}` : ''}${status && status !== 'all' ? ` (status ${status})` : ''}.\n`);
    break;
  }

  case 'stats': {
    const project = flag('project', null);
    const where = project ? 'WHERE project=?' : '';
    const params = project ? [project] : [];
    const rows = db.prepare(`SELECT status, COUNT(*) c FROM feedback ${where} GROUP BY status`).all(...params);
    const stats = { open: 0, resolved: 0 };
    for (const r of rows) stats[r.status] = r.c;
    out(stats);
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
`
    );
}
