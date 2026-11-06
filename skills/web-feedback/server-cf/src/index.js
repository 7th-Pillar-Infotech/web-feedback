/**
 * web-feedback collector — Cloudflare Worker edition.
 *
 * Same HTTP API as server/feedback-server.js, so the same widget and the same
 * feedback-cli (in remote mode) talk to it unchanged:
 *
 *   GET    /health
 *   GET    /feedback-widget.js          the browser widget
 *   GET    /vendor/snapdom.js           bundled capture engine
 *   POST   /feedback                    create (with screenshot + debug logs)
 *   GET    /feedback?status&project     list
 *   GET    /feedback/:id                one item
 *   PATCH  /feedback/:id  {text}        edit
 *   DELETE /feedback/:id                delete (+ screenshot)
 *   POST   /feedback/:id/resolve {note} resolve
 *   POST   /feedback/:id/reopen         reopen
 *   GET    /screenshots/<key>           the annotated PNG
 *
 * Storage: D1 for rows (binding DB), R2 for screenshots (binding SHOTS). If no
 * R2 bucket is bound, small screenshots are stored inline in D1 instead, so the
 * Worker still works on a D1-only setup.
 *
 * Auth: set the FEEDBACK_TOKEN secret (`wrangler secret put FEEDBACK_TOKEN`).
 * When set, every data route requires it via the X-Feedback-Token header or
 * ?token=. The widget/vendor/health routes stay public so the widget can load.
 */
import { WIDGET_JS, SNAPDOM_JS } from './assets.gen.js';

// D1 has a ~1MB limit per bound value; keep well under it when there's no R2.
const MAX_INLINE_SHOT = 700 * 1024;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Feedback-Token',
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });

const js = (body) =>
  new Response(body, {
    headers: {
      ...CORS,
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    },
  });

const nowIso = () => new Date().toISOString();
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const int = (v) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : null);
const str = (v, max) => (v == null ? null : String(v).slice(0, max));

// Bound JSON blob for the console/network debug capture.
function packLogs(arr, maxItems) {
  if (!Array.isArray(arr) || !arr.length) return null;
  const trimmed = arr.slice(-maxItems);
  let out = JSON.stringify(trimmed);
  while (out.length > 256 * 1024 && trimmed.length > 1) {
    trimmed.shift();
    out = JSON.stringify(trimmed);
  }
  return out;
}

function decodeDataUrl(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string') return null;
  const m = dataUrl.match(/^data:image\/(png|jpeg);base64,(.+)$/s);
  if (!m) return null;
  const binary = atob(m[2]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return { ext: m[1] === 'jpeg' ? 'jpg' : 'png', bytes, base64: m[2] };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);
    const method = request.method;

    if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    // Public routes: the widget bundle, the capture engine, health.
    const isPublic =
      url.pathname === '/health' || url.pathname === '/feedback-widget.js' || parts[0] === 'vendor';
    if (env.FEEDBACK_TOKEN && !isPublic) {
      const given = request.headers.get('X-Feedback-Token') || url.searchParams.get('token') || '';
      if (given !== env.FEEDBACK_TOKEN) return json({ error: 'unauthorized' }, 401);
    }

    try {
      if (method === 'GET' && url.pathname === '/feedback-widget.js') return js(WIDGET_JS);

      if (method === 'GET' && parts[0] === 'vendor') {
        if (parts[1] === 'snapdom.js' && SNAPDOM_JS) return js(SNAPDOM_JS);
        return new Response('// not bundled', { status: 404, headers: CORS });
      }

      if (method === 'GET' && url.pathname === '/health') {
        const row = await env.DB.prepare('SELECT COUNT(*) AS c FROM feedback').first();
        return json({ ok: true, total: row ? row.c : 0, storage: env.SHOTS ? 'r2' : 'd1-inline' });
      }

      if (method === 'GET' && parts[0] === 'screenshots' && parts[1]) {
        return serveShot(env, decodeURIComponent(parts[1]));
      }

      if (url.pathname === '/feedback' && method === 'POST') return create(request, env);
      if (url.pathname === '/feedback' && method === 'GET') return list(env, url);

      if (parts[0] === 'feedback' && parts[1]) {
        const id = parseInt(parts[1], 10);
        if (!Number.isFinite(id)) return json({ error: 'bad id' }, 400);

        if (method === 'GET' && !parts[2]) {
          const row = await env.DB.prepare('SELECT * FROM feedback WHERE id = ?').bind(id).first();
          return row ? json(row) : json({ error: 'not found' }, 404);
        }

        if ((method === 'DELETE' && !parts[2]) || (method === 'POST' && parts[2] === 'delete')) {
          return remove(env, id);
        }

        if ((method === 'PATCH' && !parts[2]) || (method === 'POST' && parts[2] === 'edit')) {
          const body = await request.json().catch(() => ({}));
          const text = (body.text || '').trim();
          if (!text) return json({ error: 'text is required' }, 400);
          const res = await env.DB.prepare('UPDATE feedback SET text = ? WHERE id = ?')
            .bind(text.slice(0, 5000), id)
            .run();
          if (!res.meta.changes) return json({ error: 'not found' }, 404);
          return json(await env.DB.prepare('SELECT * FROM feedback WHERE id = ?').bind(id).first());
        }

        if (method === 'POST' && parts[2] === 'resolve') {
          const body = await request.json().catch(() => ({}));
          return setStatus(env, id, true, body.note || null);
        }
        if (method === 'POST' && parts[2] === 'reopen') return setStatus(env, id, false, null);
      }

      return json({ error: 'not found', path: url.pathname }, 404);
    } catch (err) {
      return json({ error: String((err && err.message) || err) }, 500);
    }
  },
};

async function create(request, env) {
  const data = await request.json().catch(() => null);
  if (!data) return json({ error: 'invalid JSON body' }, 400);
  if (!data.text || !String(data.text).trim()) {
    return json({ error: 'feedback text is required' }, 400);
  }

  const project = String(data.project || data.host || 'app').slice(0, 200);
  const seq = await env.DB.prepare(
    'SELECT COALESCE(MAX(number), 0) AS n FROM feedback WHERE project = ?'
  )
    .bind(project)
    .first();
  const number = (seq ? seq.n : 0) + 1;

  const insert = await env.DB.prepare(
    `INSERT INTO feedback
       (number, project, url, text, selector, element_text,
        page_x, page_y, viewport_x, viewport_y, viewport_w, viewport_h,
        screenshot, capture_error, console_logs, network_logs, status, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'open',?)`
  )
    .bind(
      number,
      project,
      str(data.url, 2000) || '',
      String(data.text).trim().slice(0, 5000),
      str(data.selector, 500),
      str(data.elementText, 500),
      num(data.pageX),
      num(data.pageY),
      num(data.viewportX),
      num(data.viewportY),
      int(data.viewportW),
      int(data.viewportH),
      null,
      str(data.captureError, 500),
      packLogs(data.consoleLogs, 200),
      packLogs(data.networkLogs, 100),
      nowIso()
    )
    .run();

  const id = insert.meta.last_row_id;
  const stored = await saveShot(env, data.screenshot, project, id);
  if (stored.path) {
    await env.DB.prepare('UPDATE feedback SET screenshot = ? WHERE id = ?').bind(stored.path, id).run();
  } else if (stored.error) {
    await env.DB.prepare(
      'UPDATE feedback SET capture_error = COALESCE(capture_error, ?) WHERE id = ?'
    )
      .bind(stored.error, id)
      .run();
  }

  return json({ id, number, project, screenshot: stored.path, capture_error: stored.error }, 201);
}

// R2 when bound; otherwise inline base64 in D1 for anything small enough.
async function saveShot(env, dataUrl, project, id) {
  const decoded = decodeDataUrl(dataUrl);
  if (!decoded) return { path: null, error: null };
  const safeProject = String(project || 'app').replace(/[^a-z0-9._-]/gi, '_').slice(0, 40);
  const key = `${safeProject}-${id}.${decoded.ext}`;

  if (env.SHOTS) {
    await env.SHOTS.put(key, decoded.bytes, {
      httpMetadata: { contentType: decoded.ext === 'jpg' ? 'image/jpeg' : 'image/png' },
    });
    return { path: `screenshots/${key}`, error: null };
  }

  if (decoded.base64.length > MAX_INLINE_SHOT) {
    return {
      path: null,
      error: `screenshot dropped: ${Math.round(decoded.base64.length / 1024)}kB exceeds the D1 inline limit — bind an R2 bucket (SHOTS) to keep full-page captures.`,
    };
  }
  await env.DB.prepare('UPDATE feedback SET screenshot_data = ? WHERE id = ?')
    .bind(decoded.base64, id)
    .run();
  return { path: `screenshots/${key}`, error: null };
}

async function serveShot(env, key) {
  if (env.SHOTS) {
    const obj = await env.SHOTS.get(key);
    if (!obj) return new Response('not found', { status: 404, headers: CORS });
    return new Response(obj.body, {
      headers: {
        ...CORS,
        'Content-Type': obj.httpMetadata?.contentType || 'image/png',
        'Cache-Control': 'public, max-age=3600',
      },
    });
  }
  // Inline fallback: the key ends in -<id>.<ext>
  const m = key.match(/-(\d+)\.(png|jpg)$/);
  if (!m) return new Response('not found', { status: 404, headers: CORS });
  const row = await env.DB.prepare('SELECT screenshot_data FROM feedback WHERE id = ?')
    .bind(parseInt(m[1], 10))
    .first();
  if (!row || !row.screenshot_data) return new Response('not found', { status: 404, headers: CORS });
  const binary = atob(row.screenshot_data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Response(bytes, {
    headers: {
      ...CORS,
      'Content-Type': m[2] === 'jpg' ? 'image/jpeg' : 'image/png',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}

async function list(env, url) {
  const clauses = [];
  const params = [];
  const status = url.searchParams.get('status');
  const project = url.searchParams.get('project');
  if (status) { clauses.push('status = ?'); params.push(status); }
  if (project) { clauses.push('project = ?'); params.push(project); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = Math.min(parseInt(url.searchParams.get('limit'), 10) || 200, 1000);
  // screenshot_data is deliberately excluded — it would bloat every list call.
  const stmt = env.DB.prepare(
    `SELECT id, number, project, url, text, selector, element_text, page_x, page_y,
            viewport_x, viewport_y, viewport_w, viewport_h, screenshot, capture_error,
            console_logs, network_logs, status, created_at, resolved_at, resolution_note
       FROM feedback ${where} ORDER BY created_at DESC LIMIT ?`
  );
  const res = await stmt.bind(...params, limit).all();
  return json({ count: res.results.length, feedback: res.results });
}

async function setStatus(env, id, resolve, note) {
  const sql = resolve
    ? "UPDATE feedback SET status='resolved', resolved_at=?, resolution_note=? WHERE id=?"
    : "UPDATE feedback SET status='open', resolved_at=NULL, resolution_note=NULL WHERE id=?";
  const stmt = resolve
    ? env.DB.prepare(sql).bind(nowIso(), note, id)
    : env.DB.prepare(sql).bind(id);
  const res = await stmt.run();
  if (!res.meta.changes) return json({ error: 'not found' }, 404);
  return json(await env.DB.prepare('SELECT * FROM feedback WHERE id = ?').bind(id).first());
}

async function remove(env, id) {
  const row = await env.DB.prepare('SELECT id, number, screenshot FROM feedback WHERE id = ?')
    .bind(id)
    .first();
  if (!row) return json({ error: 'not found' }, 404);
  if (row.screenshot && env.SHOTS) {
    await env.SHOTS.delete(String(row.screenshot).replace(/^screenshots\//, ''));
  }
  await env.DB.prepare('DELETE FROM feedback WHERE id = ?').bind(id).run();
  return json({ deleted: id, number: row.number });
}
