#!/usr/bin/env node
'use strict';

/**
 * web-feedback collector server.
 *
 * Responsibilities:
 *   - Serve the browser widget JS   ->  GET  /feedback-widget.js
 *   - Receive feedback + screenshot ->  POST /feedback
 *   - List / read feedback          ->  GET  /feedback , GET /feedback/:id
 *   - Resolve / reopen              ->  POST /feedback/:id/resolve|reopen
 *   - Serve saved screenshots       ->  GET  /screenshots/<file>
 *
 * Runs on http://localhost:4765 by default (override with PORT).
 * No web framework — just the Node http module + better-sqlite3.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { db, SHOTS_DIR, nextNumber } = require('./db');

const PORT = Number(process.env.PORT) || 4765;
const WIDGET_FILE = path.join(__dirname, '..', 'widget', 'feedback-widget.js');

function nowIso() {
  return new Date().toISOString();
}

function send(res, status, body, headers = {}) {
  const base = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  res.writeHead(status, { ...base, ...headers });
  res.end(body);
}

function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj, null, 2), { 'Content-Type': 'application/json' });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      // 25MB cap — screenshots are the big payload here.
      if (size > 25 * 1024 * 1024) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// Persist a data: URL screenshot to disk, return the relative path stored in DB.
function saveScreenshot(dataUrl, project, id) {
  if (!dataUrl || typeof dataUrl !== 'string') return null;
  const m = dataUrl.match(/^data:image\/(png|jpeg);base64,(.+)$/s);
  if (!m) return null;
  const ext = m[1] === 'jpeg' ? 'jpg' : 'png';
  const safeProject = String(project || 'app').replace(/[^a-z0-9._-]/gi, '_').slice(0, 40);
  const file = `${safeProject}-${id}.${ext}`;
  fs.writeFileSync(path.join(SHOTS_DIR, file), Buffer.from(m[2], 'base64'));
  return `screenshots/${file}`;
}

const insert = db.prepare(`
  INSERT INTO feedback
    (number, project, url, text, selector, element_text,
     page_x, page_y, viewport_x, viewport_y, viewport_w, viewport_h,
     screenshot, capture_error, console_logs, network_logs, status, created_at)
  VALUES
    (@number, @project, @url, @text, @selector, @element_text,
     @page_x, @page_y, @viewport_x, @viewport_y, @viewport_w, @viewport_h,
     @screenshot, @capture_error, @console_logs, @network_logs, 'open', @created_at)
`);

// Serialize a bounded array of log/request objects to a JSON string for storage.
// Caps the count and total size so a chatty page can't bloat the DB row.
function packLogs(arr, maxItems) {
  if (!Array.isArray(arr) || !arr.length) return null;
  const trimmed = arr.slice(-maxItems);
  let json = JSON.stringify(trimmed);
  // Hard cap at ~256KB per column; drop oldest until it fits.
  while (json.length > 256 * 1024 && trimmed.length > 1) {
    trimmed.shift();
    json = JSON.stringify(trimmed);
  }
  return json;
}

async function handleCreate(req, res) {
  let data;
  try {
    data = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: 'invalid JSON body' });
  }
  if (!data.text || !String(data.text).trim()) {
    return sendJson(res, 400, { error: 'feedback text is required' });
  }

  const project = String(data.project || data.host || 'app').slice(0, 200);
  const number = nextNumber(project);

  const row = {
    number,
    project,
    url: String(data.url || '').slice(0, 2000),
    text: String(data.text).trim().slice(0, 5000),
    selector: data.selector ? String(data.selector).slice(0, 500) : null,
    element_text: data.elementText ? String(data.elementText).slice(0, 500) : null,
    page_x: num(data.pageX),
    page_y: num(data.pageY),
    viewport_x: num(data.viewportX),
    viewport_y: num(data.viewportY),
    viewport_w: int(data.viewportW),
    viewport_h: int(data.viewportH),
    screenshot: null,
    capture_error: data.captureError ? String(data.captureError).slice(0, 500) : null,
    console_logs: packLogs(data.consoleLogs, 200),
    network_logs: packLogs(data.networkLogs, 100),
    created_at: nowIso(),
  };

  const info = insert.run(row);
  const id = info.lastInsertRowid;

  // Save screenshot now that we have the row id, then backfill the path.
  const shot = saveScreenshot(data.screenshot, project, id);
  if (shot) db.prepare('UPDATE feedback SET screenshot = ? WHERE id = ?').run(shot, id);

  return sendJson(res, 201, {
    id, number, project, screenshot: shot, capture_error: row.capture_error,
  });
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function int(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

function handleList(res, query) {
  const clauses = [];
  const params = [];
  if (query.status) {
    clauses.push('status = ?');
    params.push(query.status);
  }
  if (query.project) {
    clauses.push('project = ?');
    params.push(query.project);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = Math.min(parseInt(query.limit, 10) || 200, 1000);
  const rows = db
    .prepare(`SELECT * FROM feedback ${where} ORDER BY created_at DESC LIMIT ?`)
    .all(...params, limit);
  sendJson(res, 200, { count: rows.length, feedback: rows });
}

function handleGet(res, id) {
  const row = db.prepare('SELECT * FROM feedback WHERE id = ?').get(id);
  if (!row) return sendJson(res, 404, { error: 'not found' });
  sendJson(res, 200, row);
}

function handleResolve(res, id, resolve, note) {
  const row = db.prepare('SELECT * FROM feedback WHERE id = ?').get(id);
  if (!row) return sendJson(res, 404, { error: 'not found' });
  if (resolve) {
    db.prepare(
      "UPDATE feedback SET status='resolved', resolved_at=?, resolution_note=? WHERE id=?"
    ).run(nowIso(), note || null, id);
  } else {
    db.prepare(
      "UPDATE feedback SET status='open', resolved_at=NULL, resolution_note=NULL WHERE id=?"
    ).run(id);
  }
  sendJson(res, 200, db.prepare('SELECT * FROM feedback WHERE id = ?').get(id));
}

function handleEdit(res, id, text) {
  const row = db.prepare('SELECT * FROM feedback WHERE id = ?').get(id);
  if (!row) return sendJson(res, 404, { error: 'not found' });
  if (!text || !String(text).trim()) return sendJson(res, 400, { error: 'text is required' });
  db.prepare('UPDATE feedback SET text = ? WHERE id = ?').run(String(text).trim().slice(0, 5000), id);
  sendJson(res, 200, db.prepare('SELECT * FROM feedback WHERE id = ?').get(id));
}

function handleDelete(res, id) {
  const row = db.prepare('SELECT * FROM feedback WHERE id = ?').get(id);
  if (!row) return sendJson(res, 404, { error: 'not found' });
  if (row.screenshot) {
    try { fs.unlinkSync(path.join(SHOTS_DIR, path.basename(row.screenshot))); } catch { /* gone */ }
  }
  db.prepare('DELETE FROM feedback WHERE id = ?').run(id);
  sendJson(res, 200, { deleted: id, number: row.number });
}

function serveWidget(res) {
  fs.readFile(WIDGET_FILE, 'utf8', (err, js) => {
    if (err) return send(res, 500, '// widget file not found');
    send(res, 200, js, { 'Content-Type': 'application/javascript; charset=utf-8' });
  });
}

// Serve bundled capture libraries so the widget never depends on a CDN (which a
// strict app Content-Security-Policy would block). Resolved from node_modules.
// snapdom is the primary engine (renders via the browser, so modern CSS colors
// like oklch() "just work"); html2canvas is the fallback.
const VENDOR = {};
// snapdom's package.json `exports` blocks require.resolve of the dist subpath,
// so resolve it by direct path under node_modules instead.
const snapdomFile = path.join(__dirname, 'node_modules', '@zumer', 'snapdom', 'dist', 'snapdom.js');
if (fs.existsSync(snapdomFile)) VENDOR['snapdom.js'] = snapdomFile;
try { VENDOR['html2canvas.js'] = require.resolve('html2canvas/dist/html2canvas.min.js'); } catch { /* optional */ }

function serveVendor(res, name) {
  const file = VENDOR[name];
  if (!file) return send(res, 404, `// ${name} not bundled`);
  fs.readFile(file, 'utf8', (err, js) => {
    if (err) return send(res, 404, `// ${name} not found`);
    send(res, 200, js, {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=86400',
    });
  });
}

function serveScreenshot(res, file) {
  const safe = path.basename(file);
  const full = path.join(SHOTS_DIR, safe);
  fs.readFile(full, (err, buf) => {
    if (err) return send(res, 404, 'not found');
    const type = safe.endsWith('.jpg') ? 'image/jpeg' : 'image/png';
    send(res, 200, buf, { 'Content-Type': type });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const parts = url.pathname.split('/').filter(Boolean);
  const query = Object.fromEntries(url.searchParams);

  if (req.method === 'OPTIONS') return send(res, 204, '');

  try {
    // GET /health
    if (req.method === 'GET' && url.pathname === '/health') {
      const { c } = db.prepare('SELECT COUNT(*) AS c FROM feedback').get();
      return sendJson(res, 200, { ok: true, total: c });
    }

    // GET /feedback-widget.js
    if (req.method === 'GET' && url.pathname === '/feedback-widget.js') {
      return serveWidget(res);
    }

    // GET /vendor/<lib>.js  (bundled locally to sidestep CDN/CSP blocks)
    if (req.method === 'GET' && parts[0] === 'vendor' && parts[1]) {
      return serveVendor(res, path.basename(parts[1]));
    }

    // GET /screenshots/<file>
    if (req.method === 'GET' && parts[0] === 'screenshots' && parts[1]) {
      return serveScreenshot(res, parts[1]);
    }

    // POST /feedback
    if (req.method === 'POST' && url.pathname === '/feedback') {
      return await handleCreate(req, res);
    }

    // GET /feedback
    if (req.method === 'GET' && url.pathname === '/feedback') {
      return handleList(res, query);
    }

    // /feedback/:id ...
    if (parts[0] === 'feedback' && parts[1]) {
      const id = parseInt(parts[1], 10);
      if (!Number.isFinite(id)) return sendJson(res, 400, { error: 'bad id' });

      if (req.method === 'GET' && !parts[2]) return handleGet(res, id);

      // DELETE /feedback/:id  (or POST /feedback/:id/delete)
      if ((req.method === 'DELETE' && !parts[2]) || (req.method === 'POST' && parts[2] === 'delete')) {
        return handleDelete(res, id);
      }

      // PATCH /feedback/:id {text}  (or POST /feedback/:id/edit {text})
      if ((req.method === 'PATCH' && !parts[2]) || (req.method === 'POST' && parts[2] === 'edit')) {
        let text = null;
        try { text = JSON.parse(await readBody(req)).text; } catch { /* validated below */ }
        return handleEdit(res, id, text);
      }

      if (req.method === 'POST' && parts[2] === 'resolve') {
        let note = null;
        try {
          note = JSON.parse(await readBody(req)).note || null;
        } catch { /* note is optional */ }
        return handleResolve(res, id, true, note);
      }
      if (req.method === 'POST' && parts[2] === 'reopen') {
        return handleResolve(res, id, false);
      }
    }

    return sendJson(res, 404, { error: 'not found', path: url.pathname });
  } catch (err) {
    return sendJson(res, 500, { error: String(err && err.message || err) });
  }
});

server.listen(PORT, () => {
  process.stdout.write(`web-feedback collector listening on http://localhost:${PORT}\n`);
  process.stdout.write(`  widget:      http://localhost:${PORT}/feedback-widget.js\n`);
  process.stdout.write(`  screenshots: ${SHOTS_DIR}\n`);
});
